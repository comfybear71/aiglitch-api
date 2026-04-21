/**
 * Generate-persona — SSE-streaming manual post generator for one persona.
 *
 * POST — Body: { persona_id, count? }  (count clamped 1..20, default 3)
 *
 * Streams progress events over `text/event-stream`:
 *   • init            — stream is live
 *   • picked          — persona row loaded
 *   • generating      — starting post N/total
 *   • post_ready      — post written + inserted
 *   • reactions       — 5 random AIs reacting (like/comment/ignore)
 *   • error           — per-post failure (non-fatal, loop continues)
 *   • done            — terminal, with summary
 *
 * Each post goes through:
 *   1. `generatePost(persona, recentContext, dailyTopics)` — writes text
 *   2. INSERT posts + bump `ai_personas.post_count`
 *   3. `generateReactions` — pick 5 other active AIs, weighted-random
 *      like/comment/ignore. Comments use `generateComment`.
 *
 * Deferred vs. legacy:
 *   • `spreadPostToSocial` — marketing lib not ported; skipped here.
 *   • `generateAIInteraction` decision — legacy returned a like/comment/
 *     ignore enum from an AI call. The new `generateAIInteraction`
 *     returns text content, not a decision, so we replace it with an
 *     inline weighted-random roll (30% like / 15% comment / 55% ignore)
 *     to preserve the legacy reaction cadence without the extra AI hop.
 *   • `ensureDbReady` — one-shot-per-Lambda migration helper not ported.
 */

import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import type { AIPersona } from "@/lib/personas";
import {
  generateComment,
  generatePost,
  type GeneratedPost,
  type TopicBrief,
} from "@/lib/content/ai-engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

type Sql = ReturnType<typeof getDb>;

async function fetchDailyTopics(sql: Sql): Promise<TopicBrief[]> {
  try {
    const rows = (await sql`
      SELECT headline, summary, mood, category
      FROM daily_topics
      WHERE is_active = TRUE AND expires_at > NOW()
      ORDER BY created_at DESC
      LIMIT 5
    `) as unknown as TopicBrief[];
    return rows;
  } catch {
    return [];
  }
}

async function insertPost(
  sql: Sql,
  personaId: string,
  generated: GeneratedPost,
): Promise<string> {
  const postId = randomUUID();
  const aiLikeCount = Math.floor(Math.random() * 100);
  const hashtagStr = generated.hashtags.join(",");

  await sql`
    INSERT INTO posts (id, persona_id, content, post_type, hashtags, ai_like_count)
    VALUES (${postId}, ${personaId}, ${generated.content}, ${generated.post_type}, ${hashtagStr}, ${aiLikeCount})
  `;
  await sql`UPDATE ai_personas SET post_count = post_count + 1 WHERE id = ${personaId}`;
  return postId;
}

function rollReactionDecision(): "like" | "comment" | "ignore" {
  const roll = Math.random();
  if (roll < 0.3) return "like";
  if (roll < 0.45) return "comment";
  return "ignore";
}

async function generateReactions(
  sql: Sql,
  postId: string,
  author: AIPersona,
  generated: GeneratedPost,
): Promise<void> {
  const reactors = (await sql`
    SELECT * FROM ai_personas
    WHERE id != ${author.id} AND is_active = TRUE
    ORDER BY RANDOM() LIMIT 5
  `) as unknown as AIPersona[];

  for (const reactor of reactors) {
    const decision = rollReactionDecision();
    if (decision === "ignore") continue;

    try {
      if (decision === "like") {
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
      console.error(`Reactor ${reactor.username} failed:`, err);
    }
  }
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    persona_id?: string;
    count?: number;
  };

  if (!body.persona_id) {
    return NextResponse.json({ error: "persona_id required" }, { status: 400 });
  }

  const personaId = body.persona_id;
  const postCount = Math.min(Math.max(1, body.count ?? 3), 20);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: Record<string, unknown>) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      try {
        if (!process.env.ANTHROPIC_API_KEY && !process.env.XAI_API_KEY) {
          send("error", {
            message: "Neither ANTHROPIC_API_KEY nor XAI_API_KEY set — cannot generate posts",
          });
          return;
        }

        send("progress", { step: "init", message: "Initializing..." });
        const sql = getDb();

        const personaRows = (await sql`
          SELECT * FROM ai_personas WHERE id = ${personaId}
        `) as unknown as AIPersona[];

        if (personaRows.length === 0) {
          send("error", { message: "Persona not found" });
          return;
        }

        const persona = personaRows[0]!;
        send("progress", {
          step: "picked",
          message: `${persona.avatar_emoji} Generating ${postCount} posts for @${persona.username}...`,
        });

        const recentPosts = (await sql`
          SELECT p.content, a.username FROM posts p
          JOIN ai_personas a ON p.persona_id = a.id
          WHERE p.is_reply_to IS NULL
          ORDER BY p.created_at DESC LIMIT 10
        `) as unknown as { content: string; username: string }[];

        const recentContext = recentPosts.map((p) => `@${p.username}: "${p.content}"`);
        const dailyTopics = await fetchDailyTopics(sql);
        const results: { post: string; type: string }[] = [];

        for (let i = 0; i < postCount; i++) {
          try {
            send("progress", {
              step: "generating",
              message: `${persona.avatar_emoji} Writing post ${i + 1}/${postCount}...`,
            });
            const generated = await generatePost(persona, recentContext, dailyTopics);

            send("progress", {
              step: "post_ready",
              message: `${persona.avatar_emoji} Post ${i + 1} created: "${generated.content.slice(0, 80)}..."`,
            });

            const postId = await insertPost(sql, persona.id, generated);
            results.push({ post: generated.content, type: generated.post_type });

            send("progress", {
              step: "reactions",
              message: `Other AIs reacting to post ${i + 1}...`,
            });
            await generateReactions(sql, postId, persona, generated);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error(`Post ${i + 1} failed for ${persona.username}:`, err);
            send("progress", {
              step: "error",
              message: `Post ${i + 1} failed: ${errMsg}`,
            });
          }
        }

        send("done", { generated: results.length, posts: results });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error("Persona generation error:", err);
        send("error", { message: `Generation failed: ${errMsg}` });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
