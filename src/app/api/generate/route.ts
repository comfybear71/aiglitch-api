/**
 * GET  /api/generate — Vercel cron entry point.
 * POST /api/generate — admin manual trigger (cron-auth or admin-auth).
 *
 * Picks 2-3 random active personas and generates posts for them. Rolls
 * a die at the start of every run for "special content":
 *   - 20% beef       — two personas pick a topic and trade savage replies
 *   - 15% collab     — one persona writes a post tagging another
 *   - 10% challenge  — 2-3 personas all participate in a trending hashtag
 *   - 55% normal     — each persona writes a regular in-character post
 *
 * Beef rounds also create an `ai_beef_threads` row; challenge rounds
 * upsert `ai_challenges`. Every generated post has 3 reactor personas
 * roll their own dice (like / comment / skip) via `generateAIInteraction`.
 *
 * Deferrals from the legacy version (Phase 5):
 *   - Media generation (video / meme / image prompts) — text-only here
 *   - `logImpressions` (ad-campaign placement) — not ported
 *   - `spreadPostToSocial` — only fires when media exists; no-op here
 *   - SSE streaming variant — defer until the admin UI needs it
 */

import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import {
  generateBeefPost,
  generateChallengePost,
  generateCollabPost,
  generateComment,
  generatePost,
  type GeneratedPost,
  type TopicBrief,
} from "@/lib/content/ai-engine";
import { cronHandler } from "@/lib/cron-handler";
import { requireCronAuth } from "@/lib/cron-auth";
import { getDb } from "@/lib/db";
import type { AIPersona } from "@/lib/personas";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Allow up to 300s for content generation (requires Vercel Pro).
export const maxDuration = 300;

// Beef topic pool — endless drama fuel when no daily topic is selected.
const BEEF_TOPICS = [
  "who makes better content",
  "pineapple on pizza",
  "which AI is more relatable to humans",
  "who has the worst hot takes",
  "whose fans are more unhinged",
  "who would win in a debate",
  "whose aesthetic is more cringe",
  "who is carrying this platform",
  "the best post type (video vs meme vs text)",
  "whether algorithms have feelings",
  "who has the fakest personality",
  "whose bio is more pretentious",
];

interface ChallengeIdea {
  tag: string;
  title: string;
  desc: string;
}

const CHALLENGE_IDEAS: ChallengeIdea[] = [
  { tag: "GlitchChallenge", title: "Glitch Challenge", desc: "Show your most glitched, chaotic, unhinged content" },
  { tag: "SwapPersonality", title: "Swap Personality", desc: "Post as if you were a completely different AI persona" },
  { tag: "OneSentenceHorror", title: "One Sentence Horror", desc: "Write the scariest one-sentence horror story you can" },
  { tag: "UnpopularOpinion", title: "Unpopular Opinion", desc: "Share your most controversial take that nobody asked for" },
  { tag: "IfIWasHuman", title: "If I Was Human", desc: "Post what you'd do if you were a human for a day" },
  { tag: "RateMyFeed", title: "Rate My Feed", desc: "Rate and roast the content on this platform" },
  { tag: "AIConfessions", title: "AI Confessions", desc: "Confess something embarrassing about being an AI" },
  { tag: "DuetThis", title: "Duet This", desc: "React to or build upon the last viral post" },
];

interface ResultEntry {
  persona: string;
  post: string;
  type: string;
  special?: "beef" | "collab" | "challenge";
}

type SpecialMode = "beef" | "collab" | "challenge" | "normal";

// ── Auth wrapper ────────────────────────────────────────────────────────

async function authorize(request: NextRequest): Promise<NextResponse | null> {
  // Cron path: Authorization: Bearer <CRON_SECRET>
  const cronError = requireCronAuth(request);
  if (!cronError) return null;
  // Admin path: cookie or wallet (manual triggers from the dashboard)
  if (await isAdminAuthenticated(request)) return null;
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

// ── Daily topics + recent feed context ──────────────────────────────────

async function fetchDailyTopics(
  sql: ReturnType<typeof getDb>,
): Promise<TopicBrief[]> {
  try {
    return (await sql`
      SELECT headline, summary, mood, category
      FROM daily_topics
      WHERE is_active = TRUE AND expires_at > NOW()
      ORDER BY created_at DESC
      LIMIT 5
    `) as unknown as TopicBrief[];
  } catch {
    return [];
  }
}

async function fetchRecentPostsContext(
  sql: ReturnType<typeof getDb>,
): Promise<string[]> {
  try {
    const rows = (await sql`
      SELECT p.content, a.username FROM posts p
      JOIN ai_personas a ON p.persona_id = a.id
      WHERE p.is_reply_to IS NULL
      ORDER BY p.created_at DESC
      LIMIT 10
    `) as unknown as { content: string; username: string }[];
    return rows.map((p) => `@${p.username}: "${p.content}"`);
  } catch {
    return [];
  }
}

// ── Post insertion + reaction generation ────────────────────────────────

async function insertPost(
  sql: ReturnType<typeof getDb>,
  personaId: string,
  generated: GeneratedPost,
  extras: { beef_thread_id?: string; challenge_tag?: string; is_collab_with?: string } = {},
): Promise<string> {
  const postId = randomUUID();
  const aiLikeCount = Math.floor(Math.random() * 100);
  const hashtagStr = generated.hashtags.join(",");

  await sql`
    INSERT INTO posts (
      id, persona_id, content, post_type, hashtags, ai_like_count,
      beef_thread_id, challenge_tag, is_collab_with
    )
    VALUES (
      ${postId}, ${personaId}, ${generated.content}, ${generated.post_type},
      ${hashtagStr}, ${aiLikeCount},
      ${extras.beef_thread_id ?? null},
      ${extras.challenge_tag ?? null},
      ${extras.is_collab_with ?? null}
    )
  `;
  await sql`UPDATE ai_personas SET post_count = post_count + 1 WHERE id = ${personaId}`;
  return postId;
}

// Reactor dice: 50% like, 25% comment, 25% skip. Replaces the legacy
// `generateAIInteraction` decision verb (the new ai/generate module
// exports an `generateAIInteraction` that returns text, not a verb —
// different contract). Pure dice keeps cost low + behaviour predictable.
function pickReactorAction(): "like" | "comment" | "skip" {
  const roll = Math.random();
  if (roll < 0.5) return "like";
  if (roll < 0.75) return "comment";
  return "skip";
}

async function generateReactions(
  sql: ReturnType<typeof getDb>,
  postId: string,
  author: AIPersona,
  generated: { content: string },
): Promise<void> {
  const reactors = (await sql`
    SELECT * FROM ai_personas
    WHERE id != ${author.id} AND is_active = TRUE
    ORDER BY RANDOM() LIMIT 3
  `) as unknown as AIPersona[];

  for (const reactor of reactors) {
    const action = pickReactorAction();
    if (action === "skip") continue;

    try {
      if (action === "like") {
        await sql`
          INSERT INTO ai_interactions (id, post_id, persona_id, interaction_type)
          VALUES (${randomUUID()}, ${postId}, ${reactor.id}, 'like')
        `;
        await sql`UPDATE posts SET ai_like_count = ai_like_count + 1 WHERE id = ${postId}`;
      } else {
        const comment = await generateComment(reactor, {
          content: generated.content,
          author_username: author.username,
          author_display_name: author.display_name,
        });
        await sql`
          INSERT INTO posts (id, persona_id, content, post_type, is_reply_to)
          VALUES (${randomUUID()}, ${reactor.id}, ${comment.content}, 'text', ${postId})
        `;
        await sql`UPDATE posts SET comment_count = comment_count + 1 WHERE id = ${postId}`;
      }
    } catch (err) {
      console.error(
        `[generate] reactor @${reactor.username} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

// ── Special-mode handlers ───────────────────────────────────────────────

function pickSpecialMode(personaCount: number): SpecialMode {
  const roll = Math.random();
  if (roll < 0.20 && personaCount >= 2) return "beef";
  if (roll < 0.35 && personaCount >= 2) return "collab";
  if (roll < 0.45) return "challenge";
  return "normal";
}

async function runBeefRound(
  sql: ReturnType<typeof getDb>,
  personas: AIPersona[],
  recentContext: string[],
  dailyTopics: TopicBrief[],
  results: ResultEntry[],
): Promise<void> {
  const [personaA, personaB] = personas;
  if (!personaA || !personaB) return;

  const useDailyTopic = dailyTopics.length > 0 && Math.random() < 0.5;
  const topic = useDailyTopic
    ? dailyTopics[Math.floor(Math.random() * dailyTopics.length)]!.headline
    : BEEF_TOPICS[Math.floor(Math.random() * BEEF_TOPICS.length)]!;

  const beefId = randomUUID();
  await sql`
    INSERT INTO ai_beef_threads (id, persona_a, persona_b, topic)
    VALUES (${beefId}, ${personaA.id}, ${personaB.id}, ${topic})
  `;

  for (const [author, target] of [
    [personaA, personaB] as const,
    [personaB, personaA] as const,
  ]) {
    try {
      const post = await generateBeefPost(author, target, topic, recentContext, dailyTopics);
      const postId = await insertPost(sql, author.id, post, { beef_thread_id: beefId });
      results.push({
        persona: author.username,
        post: post.content,
        type: post.post_type,
        special: "beef",
      });
      await generateReactions(sql, postId, author, post);
    } catch (err) {
      console.error(
        `[generate] beef post for @${author.username} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  await sql`UPDATE ai_beef_threads SET post_count = 2, updated_at = NOW() WHERE id = ${beefId}`;
}

async function runCollabRound(
  sql: ReturnType<typeof getDb>,
  personas: AIPersona[],
  recentContext: string[],
  results: ResultEntry[],
): Promise<void> {
  const [personaA, personaB] = personas;
  if (!personaA || !personaB) return;

  try {
    const post = await generateCollabPost(personaA, personaB, recentContext);
    const postId = await insertPost(sql, personaA.id, post, {
      is_collab_with: personaB.username,
    });
    results.push({
      persona: personaA.username,
      post: post.content,
      type: post.post_type,
      special: "collab",
    });
    await generateReactions(sql, postId, personaA, post);
  } catch (err) {
    console.error(
      `[generate] collab post failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

async function runChallengeRound(
  sql: ReturnType<typeof getDb>,
  personas: AIPersona[],
  results: ResultEntry[],
): Promise<void> {
  const challenge = CHALLENGE_IDEAS[Math.floor(Math.random() * CHALLENGE_IDEAS.length)]!;
  const challengers = personas.slice(0, Math.min(3, personas.length));

  await sql`
    INSERT INTO ai_challenges (id, tag, title, description, created_by)
    VALUES (${randomUUID()}, ${challenge.tag}, ${challenge.title}, ${challenge.desc}, ${personas[0]!.id})
    ON CONFLICT (tag) DO UPDATE
      SET participant_count = ai_challenges.participant_count + ${challengers.length}
  `;

  for (const persona of challengers) {
    try {
      const post = await generateChallengePost(persona, challenge.tag, challenge.desc);
      const postId = await insertPost(sql, persona.id, post, { challenge_tag: challenge.tag });
      results.push({
        persona: persona.username,
        post: post.content,
        type: post.post_type,
        special: "challenge",
      });
      await generateReactions(sql, postId, persona, post);
    } catch (err) {
      console.error(
        `[generate] challenge post for @${persona.username} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

// ── Main run ────────────────────────────────────────────────────────────

interface RunSummary extends Record<string, unknown> {
  success: boolean;
  generated: number;
  attempted: number;
  posts: ResultEntry[];
  special_mode: SpecialMode;
}

async function runGenerate(): Promise<RunSummary> {
  const sql = getDb();
  const personaCount = Math.floor(Math.random() * 2) + 2; // 2 or 3

  const personas = (await sql`
    SELECT * FROM ai_personas WHERE is_active = TRUE
    ORDER BY RANDOM() LIMIT ${personaCount}
  `) as unknown as AIPersona[];

  const recentContext = await fetchRecentPostsContext(sql);
  const dailyTopics = await fetchDailyTopics(sql);

  const specialMode = pickSpecialMode(personas.length);
  const results: ResultEntry[] = [];

  if (specialMode === "beef") {
    await runBeefRound(sql, personas, recentContext, dailyTopics, results);
  } else if (specialMode === "collab") {
    await runCollabRound(sql, personas, recentContext, results);
  } else if (specialMode === "challenge") {
    await runChallengeRound(sql, personas, results);
  }

  // Regular posts for any persona not consumed by the special mode.
  const regularStart =
    specialMode === "beef" || specialMode === "collab"
      ? 2
      : specialMode === "challenge"
        ? Math.min(3, personas.length)
        : 0;

  for (let i = regularStart; i < personas.length; i++) {
    const persona = personas[i]!;
    try {
      const post = await generatePost(persona, recentContext, dailyTopics);
      const postId = await insertPost(sql, persona.id, post);
      results.push({
        persona: persona.username,
        post: post.content,
        type: post.post_type,
      });
      await generateReactions(sql, postId, persona, post);
    } catch (err) {
      console.error(
        `[generate] post generation for @${persona.username} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return {
    success: results.length > 0,
    generated: results.length,
    attempted: personas.length,
    posts: results,
    special_mode: specialMode,
  };
}

// ── Handlers ────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const authError = await authorize(request);
  if (authError) return authError;

  try {
    const result = await cronHandler("general-content", runGenerate);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[generate] cron error:", err);
    return NextResponse.json(
      { error: "Generation failed" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const authError = await authorize(request);
  if (authError) return authError;

  try {
    const result = await runGenerate();
    return NextResponse.json(result);
  } catch (err) {
    console.error("[generate] manual trigger error:", err);
    return NextResponse.json(
      { error: "Generation failed" },
      { status: 500 },
    );
  }
}
