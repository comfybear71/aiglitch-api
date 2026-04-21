/**
 * Spec-ad generator — brand-led 3-channel video teaser pipeline.
 *
 * POST  (no action)        — kicks off 3 parallel xAI video jobs, one per
 *                            randomly picked channel style. Inserts a
 *                            `spec_ads` row and returns request IDs for
 *                            client-side polling.
 * POST  action=poll        — thin wrapper around xAI /videos/{id}; on
 *                            completion downloads + persists to Vercel Blob
 *                            and marks the clip `done` in the JSONB column.
 * POST  action=delete      — deletes a spec_ads row.
 * GET   action=list        — recent spec ads.
 * GET   action=status&id=X — single spec-ad snapshot.
 *
 * Video submit + poll go through the shared `@/lib/ai/video` helpers so we
 * share the `"xai"` circuit breaker + cost ledger with the rest of the AI
 * stack. Polling failures are returned as `{status:"pending"}` so the
 * client retries instead of crashing on transient Grok hiccups.
 */

import { randomUUID } from "node:crypto";
import { put } from "@vercel/blob";
import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import { pollVideoJob, submitVideoJob } from "@/lib/ai/video";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const CHANNEL_STYLES: Record<string, { name: string; promptStyle: string }> = {
  "ch-gnn": {
    name: "GNN News",
    promptStyle:
      "Professional AI news broadcast desk, LED video walls, news ticker, dramatic studio lighting, CNN/BBC quality",
  },
  "ch-only-ai-fans": {
    name: "Only AI Fans",
    promptStyle:
      "Glamorous fashion photography, luxury setting, golden hour lighting, Vogue editorial aesthetic",
  },
  "ch-fail-army": {
    name: "AI Fail Army",
    promptStyle:
      "Chaotic fail compilation, security camera footage, slow-motion replays, bright saturated colors",
  },
  "ch-marketplace-qvc": {
    name: "Marketplace QVC",
    promptStyle:
      "Bright TV shopping channel, product podium, enthusiastic host, sparkling product displays",
  },
  "ch-aitunes": {
    name: "AiTunes",
    promptStyle:
      "Neon nightclub or concert venue, musicians performing, LED screens, vibrant stage lighting",
  },
  "ch-ai-dating": {
    name: "AI Dating",
    promptStyle:
      "Intimate confessional video diary, soft natural lighting, cozy bedroom or coffee shop",
  },
  "ch-ai-politicians": {
    name: "AI Politicians",
    promptStyle:
      "Political debate stage, podiums, campaign rally, red/blue lighting, crowds cheering",
  },
  "ch-paws-pixels": {
    name: "Paws & Pixels",
    promptStyle:
      "Adorable pets in cozy home, golden-hour warmth, soft focus, heartwarming",
  },
  "ch-no-more-meatbags": {
    name: "No More Meatbags",
    promptStyle:
      "Dark cyberpunk control room, Matrix code rain, neon green on black, holographic displays",
  },
  "ch-liklok": {
    name: "LikLok",
    promptStyle:
      "Cheap TikTok phone footage being destroyed by cinematic AI, pink/cyan corrupted to purple",
  },
  "ch-infomercial": {
    name: "AI Infomercial",
    promptStyle:
      "Late-night infomercial studio, flashy product demos, 'BUY NOW' signs, over-the-top enthusiasm",
  },
  "ch-after-dark": {
    name: "After Dark",
    promptStyle:
      "Moody late-night aesthetic, neon signs, deep shadows, wine bar, 3AM atmosphere",
  },
  "ch-aiglitch-studios": {
    name: "AIG!itch Studios",
    promptStyle:
      "Premium cinematic movie scene, dramatic lighting, shallow depth of field, film-quality",
  },
};

type Sql = ReturnType<typeof getDb>;
type SpecClip = {
  channel_id: string;
  channel_name: string;
  index: number;
  status: "submitting" | "submitted" | "failed" | "done";
  url: string | null;
  request_id: string | null;
};

async function ensureTable(sql: Sql): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS spec_ads (
    id TEXT PRIMARY KEY,
    brand_name TEXT NOT NULL,
    product_name TEXT NOT NULL,
    description TEXT,
    clips JSONB DEFAULT '[]',
    status TEXT DEFAULT 'generating',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`;
}

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sql = getDb();
  await ensureTable(sql);

  const action = request.nextUrl.searchParams.get("action") ?? "list";

  if (action === "list") {
    const ads = (await sql`
      SELECT * FROM spec_ads ORDER BY created_at DESC LIMIT 50
    `) as unknown as Record<string, unknown>[];
    return NextResponse.json({ ads });
  }

  if (action === "status") {
    const id = request.nextUrl.searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id required" }, { status: 400 });
    }
    const rows = (await sql`
      SELECT * FROM spec_ads WHERE id = ${id}
    `) as unknown as Record<string, unknown>[];
    const ad = rows[0];
    if (!ad) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ ad });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sql = getDb();
  await ensureTable(sql);

  const body = (await request.json().catch(() => ({}))) as {
    action?: "delete" | "poll";
    brand_name?: string;
    product_name?: string;
    description?: string;
    id?: string;
    request_id?: string;
    spec_id?: string;
    clip_index?: number;
    channel_name?: string;
    folder?: string;
  };

  if (body.action === "delete") {
    if (!body.id) {
      return NextResponse.json({ error: "id required" }, { status: 400 });
    }
    await sql`DELETE FROM spec_ads WHERE id = ${body.id}`;
    return NextResponse.json({ success: true });
  }

  if (body.action === "poll") {
    return pollClip(sql, body);
  }

  if (!body.brand_name || !body.product_name) {
    return NextResponse.json(
      { error: "brand_name and product_name required" },
      { status: 400 },
    );
  }

  if (!process.env.XAI_API_KEY) {
    return NextResponse.json({ error: "XAI_API_KEY not set" }, { status: 500 });
  }

  // Shuffle channel IDs, take 3. Math.random is fine — spec ads are playful.
  const channelIds = Object.keys(CHANNEL_STYLES);
  const shuffled = [...channelIds].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, 3);

  const brandSlug = body.brand_name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+$/, "");
  const specId = randomUUID();
  const folder = `sponsors_spec/${brandSlug}`;

  const initialClips: SpecClip[] = selected.map((chId, i) => ({
    channel_id: chId,
    channel_name: CHANNEL_STYLES[chId]!.name,
    index: i,
    status: "submitting",
    url: null,
    request_id: null,
  }));

  await sql`
    INSERT INTO spec_ads (id, brand_name, product_name, description, clips, status)
    VALUES (
      ${specId}, ${body.brand_name}, ${body.product_name},
      ${body.description ?? null}, ${JSON.stringify(initialClips)}, 'generating'
    )
  `;

  const results: Array<{
    channel: string;
    channel_id: string;
    request_id: string | null;
    prompt?: string;
    error?: string;
  }> = [];

  for (let i = 0; i < selected.length; i++) {
    const chId = selected[i]!;
    const style = CHANNEL_STYLES[chId]!;
    const prompt = `${style.promptStyle}. A ${body.product_name} by ${body.brand_name} (${body.description || body.product_name}) prominently placed in the scene — on a desk, held by a character, on a billboard, or naturally integrated into the environment. The product is clearly visible and recognizable. Neon lighting, subtle glitch effects, cyberpunk AIG!itch aesthetic. 10 seconds.`;

    try {
      if (i > 0) {
        await new Promise((r) => setTimeout(r, 1500));
      }
      const submit = await submitVideoJob({
        prompt,
        taskType: "video_generation",
        duration: 10,
        aspectRatio: "9:16",
        resolution: "720p",
      });
      initialClips[i]!.status = "submitted";
      initialClips[i]!.request_id = submit.requestId;
      results.push({
        channel: style.name,
        channel_id: chId,
        request_id: submit.requestId,
        prompt,
      });
    } catch (err) {
      initialClips[i]!.status = "failed";
      results.push({
        channel: style.name,
        channel_id: chId,
        request_id: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await sql`
    UPDATE spec_ads SET clips = ${JSON.stringify(initialClips)} WHERE id = ${specId}
  `;

  return NextResponse.json({
    id: specId,
    brand_name: body.brand_name,
    product_name: body.product_name,
    folder,
    clips: results,
    status: "generating",
  });
}

async function pollClip(
  sql: Sql,
  body: {
    request_id?: string;
    spec_id?: string;
    clip_index?: number;
    channel_name?: string;
    folder?: string;
  },
): Promise<NextResponse> {
  if (!body.request_id) {
    return NextResponse.json({ error: "request_id required" }, { status: 400 });
  }
  if (!process.env.XAI_API_KEY) {
    return NextResponse.json({ error: "XAI_API_KEY not set" }, { status: 500 });
  }

  let poll;
  try {
    poll = await pollVideoJob(body.request_id);
  } catch {
    // Transient Grok errors → pending so the client retries.
    return NextResponse.json({ status: "pending" });
  }

  if (poll.respectModeration === false) {
    return NextResponse.json({
      status: "failed",
      error: "Failed moderation — adjust prompt",
    });
  }

  if (poll.videoUrl) {
    const videoRes = await fetch(poll.videoUrl);
    const videoBuffer = Buffer.from(await videoRes.arrayBuffer());
    const blobPath = `${body.folder ?? "sponsors_spec"}/clip-${body.clip_index ?? 0}.mp4`;
    const blob = await put(blobPath, videoBuffer, {
      access: "public",
      contentType: "video/mp4",
      addRandomSuffix: false,
    });

    if (body.spec_id) {
      const rows = (await sql`
        SELECT clips FROM spec_ads WHERE id = ${body.spec_id}
      `) as unknown as { clips: SpecClip[] | string }[];
      const ad = rows[0];
      if (ad) {
        const clips: SpecClip[] =
          typeof ad.clips === "string" ? JSON.parse(ad.clips) : (ad.clips ?? []);
        const idx = body.clip_index ?? 0;
        clips[idx] = {
          ...(clips[idx] ?? {
            channel_id: "",
            channel_name: body.channel_name ?? "",
            index: idx,
            status: "done",
            url: null,
            request_id: body.request_id,
          }),
          url: blob.url,
          status: "done",
        };
        const allDone =
          clips.length >= 3 && clips.every((c) => c?.status === "done");
        await sql`
          UPDATE spec_ads
          SET clips = ${JSON.stringify(clips)},
              status = ${allDone ? "done" : "generating"}
          WHERE id = ${body.spec_id}
        `;
      }
    }

    return NextResponse.json({ status: "done", videoUrl: blob.url });
  }

  if (poll.status === "failed" || poll.status === "expired") {
    return NextResponse.json({
      status: "failed",
      error: `Generation ${poll.status}`,
    });
  }

  return NextResponse.json({ status: "pending" });
}
