/**
 * Breaking-news video cron.
 *
 *   POST — cron-auth'd. Pulls active rows from `daily_topics`, generates
 *          dramatic newsroom-style video posts for the news_feed_ai persona,
 *          inserts them into `posts`, and spreads to social platforms.
 *          Body: { count?: number }  (1-15, default 10)
 *
 *   GET  — cron-auth'd. Convenience wrapper that re-issues POST with
 *          `{ count: 10 }` so a cron schedule can hit either verb.
 */

import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  generateBreakingNewsVideos,
  type TopicBrief,
} from "@/lib/content/ai-engine";
import { requireCronAuth } from "@/lib/cron-auth";
import { getDb } from "@/lib/db";
import { spreadPostToSocial } from "@/lib/marketing/spread-post";
import type { AIPersona } from "@/lib/personas";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 660; // 11 min — must exceed 8 min video poll timeout

interface BreakingResult {
  headline: string;
  status: string;
  hasVideo: boolean;
  postId?: string;
  mediaSource?: string;
}

export async function POST(request: NextRequest) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  const sql = getDb();

  const body = (await request.json().catch(() => ({}))) as { count?: number };
  const targetCount = Math.min(Math.max(body.count ?? 10, 1), 15);

  const newsBots = (await sql`
    SELECT * FROM ai_personas WHERE username = 'news_feed_ai' AND is_active = TRUE LIMIT 1
  `) as unknown as AIPersona[];

  if (!newsBots.length) {
    return NextResponse.json(
      { error: "news_feed_ai persona not found or inactive" },
      { status: 500 },
    );
  }
  const newsBot = newsBots[0]!;

  const topics = (await sql`
    SELECT headline, summary, mood, category
    FROM daily_topics
    WHERE is_active = TRUE AND expires_at > NOW()
    ORDER BY created_at DESC
    LIMIT 10
  `) as unknown as TopicBrief[];

  if (!topics.length) {
    return NextResponse.json(
      {
        error:
          "No active briefing topics found. Generate topics first from the admin panel.",
        hint: "Hit the 'Generate Topics' button or call /api/generate-topics",
      },
      { status: 400 },
    );
  }

  console.log(
    `📰 Generating ${targetCount} breaking news videos from ${topics.length} briefing topics...`,
  );

  const results: BreakingResult[] = [];
  let generated = 0;

  for (
    let topicIdx = 0;
    generated < targetCount && topicIdx < topics.length * 2;
    topicIdx++
  ) {
    const topic = topics[topicIdx % topics.length]!;

    try {
      const postsNeeded = Math.min(targetCount - generated, 3);
      const newsPosts = await generateBreakingNewsVideos(topic);

      for (const newsPost of newsPosts.slice(0, postsNeeded)) {
        const postId = randomUUID();
        const hashtagStr = newsPost.hashtags.join(",");
        const aiLikeCount = Math.floor(Math.random() * 200) + 80;

        await sql`
          INSERT INTO posts (
            id, persona_id, content, post_type, hashtags, ai_like_count,
            media_url, media_type, media_source
          ) VALUES (
            ${postId}, ${newsBot.id}, ${newsPost.content}, ${newsPost.post_type},
            ${hashtagStr}, ${aiLikeCount},
            ${newsPost.media_url ?? null}, ${newsPost.media_type ?? null},
            ${newsPost.media_source ?? null}
          )
        `;
        await sql`UPDATE ai_personas SET post_count = post_count + 1 WHERE id = ${newsBot.id}`;

        if (newsPost.media_url) {
          try {
            await spreadPostToSocial(
              postId,
              newsBot.id,
              newsBot.display_name,
              newsBot.avatar_emoji,
              {
                url: newsPost.media_url,
                type:
                  newsPost.media_type === "video"
                    ? "video/mp4"
                    : "image/jpeg",
              },
            );
          } catch (err) {
            console.warn(
              "[breaking-news] Social spread failed (non-fatal):",
              err instanceof Error ? err.message : err,
            );
          }
        }

        const hasVideo =
          newsPost.media_type === "video" && !!newsPost.media_url;
        results.push({
          headline: topic.headline.slice(0, 80),
          status: hasVideo ? "video" : "text-only",
          hasVideo,
          postId,
          mediaSource: newsPost.media_source,
        });
        generated++;
      }
    } catch (err) {
      console.error(
        `Breaking news generation failed for "${topic.headline}":`,
        err,
      );
      results.push({
        headline: topic.headline.slice(0, 80),
        status: "failed",
        hasVideo: false,
      });
    }
  }

  const videoCount = results.filter((r) => r.hasVideo).length;
  return NextResponse.json({
    success: true,
    generated,
    videoCount,
    totalResults: results.length,
    briefingTopicsUsed: topics.length,
    results,
  });
}

export async function GET(request: NextRequest) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  const req = new NextRequest(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify({ count: 10 }),
  });
  return POST(req);
}
