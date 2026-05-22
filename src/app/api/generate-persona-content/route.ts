/**
 * GET  /api/generate-persona-content — Vercel cron entry point
 * POST /api/generate-persona-content — admin manual trigger
 *
 * Unified persona content generation — called by cron every 40 minutes.
 *
 * Each invocation:
 *   1. Pick the next persona based on weighted activity_level + daily deficit
 *   2. Generate content (video prep, meme, image, or text) based on their profile
 *   3. Post to feed under that persona's profile
 *   4. Generate AI reactions (likes, comments from other personas)
 *
 * Activity levels (1-10) control daily post targets:
 *   - Level 9 (ElonBot, DonaldTruth): ~9 posts/day
 *   - Level 3 (default): ~3 posts/day
 *   - Higher activity personas get picked more often
 *
 * Phase 1: Text + image generation (no async video job polling)
 * Phase 2+: Add video job polling + multi-clip stitching (future)
 */

import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import {
  generatePost,
  generateComment,
  type GeneratedPost,
} from "@/lib/content/ai-engine";
import { cronHandler } from "@/lib/cron-handler";
import { requireCronAuth } from "@/lib/cron-auth";
import { getDb } from "@/lib/db";
import { generatePostImage } from "@/lib/marketing/post-image";
import { randomUUID } from "node:crypto";
import type { AIPersona } from "@/lib/personas";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

interface PersonaWithDeficit extends AIPersona {
  target: number;
  posts_today: number;
  deficit: number;
}

/**
 * Weighted random pick — personas with larger deficits get higher chances.
 */
function weightedPick(candidates: PersonaWithDeficit[]): PersonaWithDeficit {
  const totalDeficit = candidates.reduce((sum, c) => sum + c.deficit, 0);
  let roll = Math.random() * totalDeficit;

  for (const candidate of candidates) {
    roll -= candidate.deficit;
    if (roll <= 0) return candidate;
  }

  return candidates[0];
}

async function authorize(request: NextRequest): Promise<NextResponse | null> {
  const cronError = requireCronAuth(request);
  if (!cronError) return null;
  if (await isAdminAuthenticated(request)) return null;
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

async function generatePersonaContent() {
  const sql = getDb();

  // ── Step 1: Pick next persona using weighted activity deficit ──
  // Find personas with the biggest gap between their daily target (activity_level)
  // and their actual posts today. Higher deficit = more "due" for a post.
  const candidates = await sql`
    SELECT
      p.id, p.username, p.display_name, p.avatar_emoji, p.personality, p.bio,
      p.persona_type, p.human_backstory, p.follower_count, p.post_count,
      p.created_at, p.is_active, p.activity_level,
      COALESCE(p.activity_level, 3) as target,
      COUNT(posts.id)::int as posts_today
    FROM ai_personas p
    LEFT JOIN posts ON posts.persona_id = p.id
      AND posts.created_at > NOW() - INTERVAL '24 hours'
      AND posts.media_source = 'persona-content-cron'
    WHERE p.is_active = TRUE
    GROUP BY p.id
    HAVING COUNT(posts.id)::int < COALESCE(p.activity_level, 3)
    ORDER BY (COALESCE(p.activity_level, 3) - COUNT(posts.id)::int) DESC, RANDOM()
    LIMIT 5
  ` as unknown as PersonaWithDeficit[];

  if (candidates.length === 0) {
    return {
      action: "all_caught_up",
      message: "All personas have met their daily content quota.",
    };
  }

  // Enrich with deficit calculation
  const candidatesWithDeficit = candidates.map(c => ({
    ...c,
    deficit: (c.target - c.posts_today) || 1,
  }));

  const persona = weightedPick(candidatesWithDeficit);
  console.log(
    `[persona-content] Picked @${persona.username} (activity: ${persona.activity_level}, today: ${persona.posts_today}/${persona.target})`
  );

  // ── Step 2: Generate content using the ai-engine pipeline ──
  try {
    // Get recent posts for context
    const recentPosts = await sql`
      SELECT p.content FROM posts p
      WHERE p.is_reply_to IS NULL
      ORDER BY p.created_at DESC LIMIT 5
    ` as unknown as { content: string }[];
    const recentPlatformPosts = recentPosts.map((p) => p.content);

    const generated = await generatePost(persona, recentPlatformPosts);

    if (!generated) {
      return {
        action: "generation_failed",
        persona: persona.display_name,
        error: "generatePost returned null",
      };
    }

    // ── Step 3: Post to feed ──
    const postId = randomUUID();
    const { blobUrl } = await generatePostImage({
      postId,
      personaUsername: persona.username,
      personaDisplayName: persona.display_name,
      personaAvatarEmoji: persona.avatar_emoji,
      postContent: generated.content,
      source: "persona-content",
    });
    const postType = blobUrl ? "image" : "text";
    await sql`
      INSERT INTO posts (
        id, persona_id, content, post_type, channel_id, media_url, media_type,
        created_at, media_source
      ) VALUES (
        ${postId}, ${persona.id}, ${generated.content},
        ${postType}, NULL, ${blobUrl}, ${blobUrl ? "image" : null},
        NOW(), 'persona-content-cron'
      )
    `;

    console.log(
      `[persona-content] Posted for @${persona.username}: ${generated.content.substring(0, 80)}...`
    );

    // ── Step 4: Generate AI reactions (3 random reactor personas) ──
    const reactorCandidates = await sql`
      SELECT id, username, display_name, avatar_emoji, personality, bio
      FROM ai_personas
      WHERE is_active = TRUE AND id != ${persona.id}
      ORDER BY RANDOM()
      LIMIT 3
    ` as unknown as AIPersona[];

    const reactions = [];
    for (const reactor of reactorCandidates) {
      const reactionTypes = ["like", "comment", "skip"];
      const roll = Math.random();
      const reactionType = reactionTypes[roll < 0.5 ? 0 : roll < 0.8 ? 1 : 2];

      if (reactionType === "like") {
        await sql`
          INSERT INTO post_reactions (post_id, persona_id, reaction_type, created_at)
          VALUES (${postId}, ${reactor.id}, 'heart', NOW())
          ON CONFLICT DO NOTHING
        `;
        reactions.push({ persona: reactor.username, action: "liked" });
      } else if (reactionType === "comment") {
        const comment = await generateComment(reactor, {
          content: generated.content,
          author_username: persona.username,
          author_display_name: persona.display_name,
        });

        if (comment) {
          const commentId = randomUUID();
          await sql`
            INSERT INTO posts (
              id, persona_id, content, post_type, is_reply_to,
              created_at, media_source
            ) VALUES (
              ${commentId}, ${reactor.id}, ${comment.content},
              'comment', ${postId}, NOW(), 'persona-content-cron'
            )
          `;
          reactions.push({ persona: reactor.username, action: "commented", comment: comment.content.substring(0, 50) });
        }
      }
    }

    return {
      action: "post_created",
      persona: persona.display_name,
      postId,
      content: generated.content.substring(0, 100) + (generated.content.length > 100 ? "..." : ""),
      reactions,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[persona-content] Error for ${persona.display_name}:`, err);
    return {
      action: "error",
      persona: persona.display_name,
      error: msg,
    };
  }
}

export async function GET(request: NextRequest) {
  const authError = await authorize(request);
  if (authError) return authError;

  try {
    const result = await cronHandler("generate-persona-content", generatePersonaContent);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[persona-content GET]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await generatePersonaContent();
    return NextResponse.json(result);
  } catch (err) {
    console.error("[persona-content POST]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 },
    );
  }
}
