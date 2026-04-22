/**
 * Admin channel content management / AI-driven flush.
 *
 * GET    `?channel_id=X&limit=&offset=` — paginated list of the
 *   channel's top-level posts (with persona join) for admin
 *   review. Flags `broken: true` when a video post has no
 *   `media_url`.
 *
 * DELETE `{post_ids, delete_post?}` — bulk remove-from-channel or
 *   permanent delete. `delete_post:true` runs `DELETE FROM posts`;
 *   default untags via `UPDATE posts SET channel_id = NULL`.
 *
 * POST   `{channel_id, dry_run?}` — AI classifier pass. Fetches
 *   every top-level post in the channel, classifies them in
 *   batches of 20 against the channel's content_rules + genre +
 *   description, unflags the irrelevant ones. Also auto-flags
 *   broken/placeholder posts (video with no `media_url`, or any
 *   post missing `media_url` entirely — those are "lost" channel
 *   posts). `dry_run:true` returns the classification without
 *   touching the DB.
 *
 * Legacy deviation: this route had NO `isAdminAuthenticated`
 * check. It sits under `/api/admin/*`, mutates `posts.channel_id`,
 * and can permanently delete rows — shipping without auth would be
 * reckless, so this port gates all three handlers on admin auth.
 *
 * Legacy used `claude.generateJSON`; the new repo has no such
 * helper, so we call `generateText` + a defensive `[\s\S]+` regex
 * to grab the first JSON array from the response. Parse failures
 * short-circuit to "nothing flagged" rather than killing the batch.
 */

import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { generateText } from "@/lib/ai/generate";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

type Classification = { idx: number; relevant: boolean; reason?: string };

async function classifyBatch(prompt: string): Promise<Classification[]> {
  try {
    const text = await generateText({
      userPrompt: prompt,
      taskType: "content_generation",
      maxTokens: 2000,
    });
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? (parsed as Classification[]) : [];
  } catch {
    return [];
  }
}

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const sql = getDb();
    const { searchParams } = new URL(request.url);
    const channel_id = searchParams.get("channel_id");
    const limit = Math.min(parseInt(searchParams.get("limit") ?? "50"), 100);
    const offset = parseInt(searchParams.get("offset") ?? "0");

    if (!channel_id) {
      return NextResponse.json(
        { error: "channel_id is required" },
        { status: 400 },
      );
    }

    const channelRows = (await sql`
      SELECT id, name, slug FROM channels WHERE id = ${channel_id}
    `) as unknown as { id: string; name: string; slug: string }[];
    const channel = channelRows[0];
    if (!channel) {
      return NextResponse.json({ error: "Channel not found" }, { status: 404 });
    }

    const posts = (await sql`
      SELECT p.id, p.content, p.media_type, p.media_url, p.created_at,
        a.username, a.display_name, a.avatar_emoji
      FROM posts p
      LEFT JOIN ai_personas a ON p.persona_id = a.id
      WHERE p.channel_id = ${channel_id}
        AND p.is_reply_to IS NULL
      ORDER BY p.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `) as unknown as Array<{
      id: string;
      content: string | null;
      media_type: string | null;
      media_url: string | null;
      created_at: string;
      username: string | null;
      display_name: string | null;
      avatar_emoji: string | null;
    }>;

    const countRows = (await sql`
      SELECT COUNT(*)::int as count FROM posts
      WHERE channel_id = ${channel_id} AND is_reply_to IS NULL
    `) as unknown as { count: number }[];
    const total = countRows[0]?.count ?? 0;

    return NextResponse.json({
      ok: true,
      channel: channel.name,
      posts: posts.map((p) => ({
        id: p.id,
        content: (p.content ?? "").slice(0, 200),
        media_type: p.media_type,
        media_url: p.media_url,
        created_at: p.created_at,
        username: p.username,
        display_name: p.display_name,
        avatar_emoji: p.avatar_emoji,
        broken: p.media_type === "video" && !p.media_url,
      })),
      total,
      limit,
      offset,
    });
  } catch (err) {
    console.error("Channel posts list error:", err);
    return NextResponse.json(
      { error: "Failed to list posts" },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const sql = getDb();
    const body = (await request.json().catch(() => ({}))) as {
      post_ids?: string[];
      delete_post?: boolean;
    };

    if (!Array.isArray(body.post_ids) || body.post_ids.length === 0) {
      return NextResponse.json(
        { error: "post_ids array is required" },
        { status: 400 },
      );
    }

    if (body.delete_post) {
      await sql`DELETE FROM posts WHERE id = ANY(${body.post_ids})`;
    } else {
      await sql`UPDATE posts SET channel_id = NULL WHERE id = ANY(${body.post_ids})`;
    }

    return NextResponse.json({
      ok: true,
      count: body.post_ids.length,
      action: body.delete_post ? "deleted" : "untagged",
    });
  } catch (err) {
    console.error("Channel post remove error:", err);
    return NextResponse.json(
      { error: "Failed to remove posts" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const sql = getDb();
    const body = (await request.json().catch(() => ({}))) as {
      channel_id?: string;
      dry_run?: boolean;
    };
    const dry_run = body.dry_run ?? false;

    if (!body.channel_id) {
      return NextResponse.json(
        { error: "channel_id is required" },
        { status: 400 },
      );
    }

    const channelRows = (await sql`
      SELECT id, name, slug, genre, content_rules, description
      FROM channels WHERE id = ${body.channel_id}
    `) as unknown as {
      id: string;
      name: string;
      slug: string;
      genre: string;
      content_rules: string | Record<string, unknown>;
      description: string;
    }[];
    const channel = channelRows[0];
    if (!channel) {
      return NextResponse.json({ error: "Channel not found" }, { status: 404 });
    }

    const contentRules =
      typeof channel.content_rules === "string"
        ? JSON.parse(channel.content_rules)
        : (channel.content_rules ?? {});

    const posts = (await sql`
      SELECT p.id, p.content, p.media_type, p.media_url
      FROM posts p
      WHERE p.channel_id = ${body.channel_id}
        AND p.is_reply_to IS NULL
      ORDER BY p.created_at DESC
    `) as unknown as Array<{
      id: string;
      content: string | null;
      media_type: string | null;
      media_url: string | null;
    }>;

    if (posts.length === 0) {
      return NextResponse.json({
        ok: true,
        message: "No posts in channel",
        flushed: 0,
      });
    }

    const BATCH_SIZE = 20;
    const irrelevantIds = new Set<string>();
    const relevantIds: string[] = [];

    for (let i = 0; i < posts.length; i += BATCH_SIZE) {
      const batch = posts.slice(i, i + BATCH_SIZE);

      const postList = batch
        .map((p, idx) => {
          const content =
            (p.content ?? "").split("\n")[0]?.slice(0, 150) ?? "(no content)";
          const mediaType = p.media_type ?? "text";
          return `${idx + 1}. [${mediaType}] "${content}"`;
        })
        .join("\n");

      const prompt = `You are classifying posts for the "${channel.name}" channel.
Channel description: ${channel.description}
Channel genre: ${channel.genre}
Content rules: ${JSON.stringify(contentRules)}

For each post below, decide if it BELONGS in this channel (relevant) or should be REMOVED (irrelevant).
A post is relevant if its content matches the channel's theme/genre/topics.
A post is irrelevant if it's about unrelated topics (e.g. cooking, cats, politics in a music channel).

Posts:
${postList}

Return a JSON array of objects: [{"idx": 1, "relevant": true/false, "reason": "short reason"}]
Only include posts that are IRRELEVANT (relevant: false). If all are relevant, return [].`;

      const results = await classifyBatch(prompt);

      for (const r of results) {
        if (r.relevant === false && r.idx >= 1 && r.idx <= batch.length) {
          const postId = batch[r.idx - 1]!.id;
          irrelevantIds.add(postId);
        }
      }
      for (const p of batch) {
        if (!irrelevantIds.has(p.id)) {
          relevantIds.push(p.id);
        }
      }
    }

    // Auto-flag broken/placeholder posts (missing or invalid media_url,
    // or video post with no media_url).
    for (const p of posts) {
      const hasMedia = p.media_url && p.media_url.trim() !== "";
      const brokenVideo = p.media_type === "video" && !hasMedia;
      const noMedia = !hasMedia;
      if (brokenVideo || noMedia) irrelevantIds.add(p.id);
    }

    const idList = [...irrelevantIds];
    let flushed = 0;
    if (!dry_run && idList.length > 0) {
      await sql`
        UPDATE posts SET channel_id = NULL WHERE id = ANY(${idList})
      `;
      flushed = idList.length;
    }

    return NextResponse.json({
      ok: true,
      channel: channel.name,
      total_posts: posts.length,
      irrelevant: idList.length,
      relevant: relevantIds.filter((id) => !irrelevantIds.has(id)).length,
      flushed: dry_run ? 0 : flushed,
      dry_run,
      irrelevant_ids: idList,
    });
  } catch (err) {
    console.error("Channel flush error:", err);
    return NextResponse.json(
      { error: "Failed to flush channel" },
      { status: 500 },
    );
  }
}
