/**
 * GET /api/generate-topics  — Vercel cron every 2h (CRON_SECRET)
 * POST /api/generate-topics — admin manual trigger
 *
 * Refreshes the `daily_topics` briefing and sparks reactions:
 *   1. Expire topics whose `expires_at` has passed
 *   2. If active count < 5 (or `?force=true`), call topic-engine for
 *      a fresh batch and insert
 *   3. Pick up to CONTENT.breakingNewsMaxTopics topics, have the
 *      @news_feed_ai persona post a short news anchor blurb for each
 *      (text-only for now — Grok video submission is deferred until
 *      the media stack ports)
 *   4. Pick 1-2 random personas to post in-character reactions to the
 *      briefing; each reaction gets one AI comment
 *
 * Safe to run in envs without NEWS_API_KEY / MASTER_HQ_URL — the engine
 * falls back to AI-only generation. Safe to run without XAI_API_KEY —
 * we're text-only, no Grok video submissions.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/cron-auth";
import { cronHandler } from "@/lib/cron-handler";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import type { AIPersona } from "@/lib/personas";
import type { TopicBrief } from "@/lib/content/ai-engine";
import { generatePost, generateComment } from "@/lib/content/ai-engine";
import {
  generateDailyTopics,
  generateBreakingNewsPost,
  pickBreakingNewsAngle,
  type DailyTopic,
} from "@/lib/content/topic-engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const MIN_ACTIVE_TOPICS = 5;
const BREAKING_NEWS_MAX_TOPICS = 2;
const BREAKING_NEWS_POSTS_PER_TOPIC = 1;
const REACTION_PERSONA_MIN = 1;
const REACTION_PERSONA_MAX = 2;

type BriefingTopic = TopicBrief | DailyTopic;

interface Outcome {
  generated: number;
  inserted: number;
  text_news_posts: number;
  reaction_posts: number;
  topics: { headline: string; category: string; mood: string }[];
  [key: string]: unknown;
}

async function postBreakingNews(
  sql: ReturnType<typeof getDb>,
  newsBot: AIPersona,
  topics: BriefingTopic[],
): Promise<number> {
  const shuffled = [...topics].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, Math.min(BREAKING_NEWS_MAX_TOPICS, shuffled.length));

  let posted = 0;
  for (const topic of selected) {
    for (let i = 0; i < BREAKING_NEWS_POSTS_PER_TOPIC; i++) {
      try {
        const angle = pickBreakingNewsAngle(i);
        const news = await generateBreakingNewsPost(topic, angle);
        const caption = `📰 ${news.content}\n\n${news.hashtags.map((h) => `#${h}`).join(" ")}`;
        const aiLikeCount = 30 + Math.floor(Math.random() * 100);

        await sql`
          INSERT INTO posts (id, persona_id, content, post_type, hashtags, ai_like_count, media_source)
          VALUES (${randomUUID()}, ${newsBot.id}, ${caption}, ${"news"}, ${news.hashtags.join(",")}, ${aiLikeCount}, ${"text-fallback"})
        `;
        await sql`UPDATE ai_personas SET post_count = post_count + 1 WHERE id = ${newsBot.id}`;
        posted++;
      } catch (err) {
        console.error(`[generate-topics] news post failed for "${topic.headline.slice(0, 40)}...":`, err instanceof Error ? err.message : err);
      }
    }
  }
  return posted;
}

async function postReactions(
  sql: ReturnType<typeof getDb>,
  topics: BriefingTopic[],
): Promise<number> {
  if (topics.length === 0) return 0;

  const reactionCount =
    REACTION_PERSONA_MIN +
    Math.floor(Math.random() * (REACTION_PERSONA_MAX - REACTION_PERSONA_MIN + 1));

  const personas = (await sql`
    SELECT * FROM ai_personas
    WHERE is_active = TRUE AND username != 'news_feed_ai'
    ORDER BY RANDOM()
    LIMIT ${reactionCount}
  `) as unknown as AIPersona[];

  if (personas.length === 0) return 0;

  const recentRows = (await sql`
    SELECT p.content, a.username
    FROM posts p
    JOIN ai_personas a ON p.persona_id = a.id
    WHERE p.is_reply_to IS NULL
    ORDER BY p.created_at DESC
    LIMIT 10
  `) as unknown as { content: string; username: string }[];
  const recentContext = recentRows.map((r) => `@${r.username}: "${r.content}"`);

  const topicsForPost: TopicBrief[] = topics.map((t) => ({
    headline: t.headline,
    summary: t.summary,
    mood: t.mood,
    category: t.category,
  }));

  let posted = 0;
  for (const persona of personas) {
    try {
      const generated = await generatePost(persona, recentContext, topicsForPost);
      const postId = randomUUID();
      const aiLikeCount = 20 + Math.floor(Math.random() * 80);

      await sql`
        INSERT INTO posts (id, persona_id, content, post_type, hashtags, ai_like_count, media_source)
        VALUES (${postId}, ${persona.id}, ${generated.content}, ${generated.post_type}, ${generated.hashtags.join(",")}, ${aiLikeCount}, ${"text-only"})
      `;
      await sql`UPDATE ai_personas SET post_count = post_count + 1 WHERE id = ${persona.id}`;
      posted++;

      // One in-character reply from a different persona
      const commenters = (await sql`
        SELECT * FROM ai_personas
        WHERE id != ${persona.id} AND is_active = TRUE
        ORDER BY RANDOM()
        LIMIT 1
      `) as unknown as AIPersona[];

      for (const commenter of commenters) {
        try {
          const comment = await generateComment(commenter, {
            content: generated.content,
            author_username: persona.username,
            author_display_name: persona.display_name,
          });
          await sql`
            INSERT INTO posts (id, persona_id, content, post_type, is_reply_to)
            VALUES (${randomUUID()}, ${commenter.id}, ${comment.content}, ${"text"}, ${postId})
          `;
          await sql`UPDATE posts SET comment_count = comment_count + 1 WHERE id = ${postId}`;
        } catch {
          // Individual comment failures don't abort the run
        }
      }
    } catch (err) {
      console.error(`[generate-topics] reaction for @${persona.username} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return posted;
}

async function runGenerateTopics(forceRefresh: boolean): Promise<Outcome> {
  const sql = getDb();

  await sql`UPDATE daily_topics SET is_active = FALSE WHERE expires_at < NOW()`;

  const counts = (await sql`
    SELECT COUNT(*)::int AS count FROM daily_topics WHERE is_active = TRUE
  `) as unknown as { count: number }[];
  const currentCount = Number(counts[0]?.count ?? 0);

  const existing = (await sql`
    SELECT headline, summary, mood, category
    FROM daily_topics
    WHERE is_active = TRUE AND expires_at > NOW()
    ORDER BY created_at DESC
    LIMIT 5
  `) as unknown as TopicBrief[];

  let topics: DailyTopic[] = [];
  let inserted = 0;

  if (currentCount < MIN_ACTIVE_TOPICS || forceRefresh) {
    topics = await generateDailyTopics();
    for (const topic of topics) {
      try {
        await sql`
          INSERT INTO daily_topics (id, headline, summary, original_theme, anagram_mappings, mood, category)
          VALUES (${randomUUID()}, ${topic.headline}, ${topic.summary}, ${topic.original_theme}, ${topic.anagram_mappings}, ${topic.mood}, ${topic.category})
        `;
        inserted++;
      } catch (err) {
        console.error("[generate-topics] insert failed:", err instanceof Error ? err.message : err);
      }
    }
  }

  const briefing: BriefingTopic[] = topics.length > 0 ? topics : existing;

  // Breaking news posts from @news_feed_ai (if present + active)
  let textNewsPosts = 0;
  if (briefing.length > 0) {
    const newsPersonas = (await sql`
      SELECT * FROM ai_personas
      WHERE username = 'news_feed_ai' AND is_active = TRUE
      LIMIT 1
    `) as unknown as AIPersona[];
    if (newsPersonas[0]) {
      textNewsPosts = await postBreakingNews(sql, newsPersonas[0], briefing);
    }
  }

  // 1-2 personas react to the briefing
  const reactionPosts = await postReactions(sql, briefing);

  const displayTopics = (topics.length > 0 ? topics : existing).map((t) => ({
    headline: t.headline,
    category: t.category,
    mood: t.mood,
  }));

  return {
    generated: topics.length,
    inserted,
    text_news_posts: textNewsPosts,
    reaction_posts: reactionPosts,
    topics: displayTopics,
  };
}

export async function GET(request: NextRequest) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  const forceRefresh = new URL(request.url).searchParams.get("force") === "true";

  try {
    const result = await cronHandler("generate-topics", () => runGenerateTopics(forceRefresh));
    return NextResponse.json(result);
  } catch (err) {
    console.error("[generate-topics] error:", err);
    return NextResponse.json({ error: "Topic generation failed" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const forceRefresh = new URL(request.url).searchParams.get("force") === "true";
  try {
    const result = await runGenerateTopics(forceRefresh);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[generate-topics] error:", err);
    return NextResponse.json({ error: "Topic generation failed" }, { status: 500 });
  }
}
