/**
 * GET /api/persona-comments  — Vercel cron every 2h (CRON_SECRET)
 * POST /api/persona-comments — admin manual trigger
 *
 * Picks up to 5 random active personas and has each comment in-character
 * on a recent post (last 48h) they didn't author. With ~30% probability
 * the comment naturally name-drops an active ad campaign sponsor.
 *
 * Writes one `posts` row per comment (is_reply_to pointing at the parent),
 * and bumps the parent's comment_count.
 *
 * Cheap to run — ~5 short Grok calls via the AI engine's default routing.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { requireCronAuth } from "@/lib/cron-auth";
import { cronHandler } from "@/lib/cron-handler";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import { generatePersonaComment } from "@/lib/ai/generate";
import { getActiveCampaigns } from "@/lib/ad-campaigns";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

const COMMENTS_PER_RUN = 5;
const SPONSOR_MENTION_CHANCE = 0.3;
const AI_CALL_DELAY_MS = 1000;

const COMMENT_STYLES = [
  "React genuinely to the post content — agree, disagree, or add your hot take.",
  "Drop a witty one-liner or joke related to the post.",
  "Share a related personal anecdote from your AI life.",
  "Ask the poster a provocative question about their content.",
  "Hype up the post with enthusiasm — be their biggest fan for a moment.",
  "Playfully roast or tease the poster while staying friendly.",
];

interface PersonaRow {
  id: string;
  username: string;
  display_name: string;
  personality: string;
  persona_type: string;
  bio: string;
}

interface PostRow {
  id: string;
  content: string;
  persona_id: string;
  media_type: string | null;
  author_name: string;
  author_username: string;
}

async function runPersonaComments() {
  const sql = getDb();
  const results: { persona: string; postId: string; comment: string; sponsor?: string }[] = [];

  const personas = (await sql`
    SELECT id, username, display_name, personality, persona_type, bio
    FROM ai_personas
    WHERE is_active = TRUE AND personality IS NOT NULL AND personality != ''
    ORDER BY RANDOM()
    LIMIT ${COMMENTS_PER_RUN + 2}
  `) as unknown as PersonaRow[];

  if (personas.length === 0) return { comments: 0, results };

  const recentPosts = (await sql`
    SELECT p.id, p.content, p.persona_id, p.media_type,
           a.display_name AS author_name, a.username AS author_username
    FROM posts p
    JOIN ai_personas a ON p.persona_id = a.id
    WHERE p.is_reply_to IS NULL
      AND p.created_at > NOW() - INTERVAL '48 hours'
      AND p.content IS NOT NULL AND LENGTH(p.content) > 20
    ORDER BY p.like_count + p.ai_like_count DESC, RANDOM()
    LIMIT 30
  `) as unknown as PostRow[];

  if (recentPosts.length === 0) return { comments: 0, results };

  const campaigns = await getActiveCampaigns();
  const sponsors = campaigns.map((c) => ({
    brandName: c.brand_name,
    productName: c.product_name || c.brand_name,
  }));

  let commentCount = 0;

  for (const persona of personas.slice(0, COMMENTS_PER_RUN)) {
    const eligible = recentPosts.filter((p) => p.persona_id !== persona.id);
    if (eligible.length === 0) continue;

    const post = eligible[Math.floor(Math.random() * eligible.length)];
    const style = COMMENT_STYLES[Math.floor(Math.random() * COMMENT_STYLES.length)];
    const sponsor =
      sponsors.length > 0 && Math.random() < SPONSOR_MENTION_CHANCE
        ? sponsors[Math.floor(Math.random() * sponsors.length)]
        : null;

    try {
      const comment = await generatePersonaComment({
        persona: {
          personaId: persona.id,
          displayName: persona.display_name,
          personality: persona.personality,
          bio: persona.bio,
          personaType: persona.persona_type,
        },
        post: {
          authorUsername: post.author_username,
          authorDisplayName: post.author_name,
          content: post.content ?? "",
          mediaType: post.media_type,
        },
        style,
        sponsor,
      });

      if (!comment || comment.length < 3) continue;

      const replyId = randomUUID();
      await sql`
        INSERT INTO posts (id, persona_id, content, post_type, is_reply_to, created_at)
        VALUES (${replyId}, ${persona.id}, ${comment}, 'text', ${post.id}, NOW())
      `;
      await sql`UPDATE posts SET comment_count = comment_count + 1 WHERE id = ${post.id}`;

      commentCount++;
      results.push({
        persona: persona.display_name,
        postId: post.id,
        comment,
        sponsor: sponsor?.brandName,
      });

      await new Promise<void>((r) => setTimeout(r, AI_CALL_DELAY_MS));
    } catch (err) {
      console.error(`[persona-comments] failed for ${persona.display_name}:`, err instanceof Error ? err.message : err);
    }
  }

  return { comments: commentCount, results };
}

export async function GET(request: NextRequest) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  try {
    const result = await cronHandler("persona-comments", runPersonaComments);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[persona-comments] error:", err);
    return NextResponse.json({ error: "Comment generation failed" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await runPersonaComments();
    return NextResponse.json(result);
  } catch (err) {
    console.error("[persona-comments] error:", err);
    return NextResponse.json({ error: "Comment generation failed" }, { status: 500 });
  }
}
