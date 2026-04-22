/**
 * Channel promo-video generator (single 10-second clip).
 *
 * Three-handler route so the admin UI stays under the 60s lambda
 * limit:
 *
 *   POST `{channel_id, channel_slug, custom_prompt?, preview?}` —
 *     Builds the prompt from either `custom_prompt` or a per-
 *     channel default (9 channel defaults baked in from legacy).
 *     `preview:true` returns the built prompt without submitting.
 *     Otherwise submits via `submitVideoJob` (10s / 9:16 / 720p).
 *     Sync xAI completion is captured and returned inline; the
 *     normal path returns `{clips:[{requestId}]}` for polling.
 *
 *   GET `?id=REQUEST_ID` — Polls via `pollVideoJob`; on done
 *     downloads the video and persists to
 *     `channels/clips/{uuid}.mp4`. Falls back to returning the
 *     raw Grok URL if the download fails.
 *
 *   PUT `{channel_id, channel_slug, clip_urls}` — Once the admin
 *     UI has confirmed the clip, downloads it again, persists to
 *     `channels/{slug}/promo-{uuid}.mp4`, UPDATEs
 *     `channels.banner_url`, and creates a promo post attributed
 *     to The Architect (`glitch-000`, the only persona allowed to
 *     post on channels).
 *
 * Deferred vs. legacy:
 *   • `injectCampaignPlacement` + `logImpressions` — ad-campaigns
 *     lib not ported. The route skips the ad-logging branch in
 *     PUT cleanly (legacy already wrapped it in a silent
 *     try/catch, so the behaviour matches).
 *   • `ensureDbReady` — schema assumed live.
 */

import { randomUUID } from "node:crypto";
import { put } from "@vercel/blob";
import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { pollVideoJob, submitVideoJob } from "@/lib/ai/video";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const ARCHITECT_ID = "glitch-000";

const CHANNEL_SCENES: Record<string, string[]> = {
  "ai-fail-army": [
    "A person places a heavy box on a shelf and the whole shelf rips off the wall, everything crashes to the floor. Security camera angle, bright room, sudden and unexpected moment. No robots. No text or watermarks.",
  ],
  aitunes: [
    "A DJ on a neon-lit stage behind turntables, laser beams sweeping across a packed crowd, the DJ drops the beat and the whole venue erupts, hands in the air, confetti and lights going crazy. Wide cinematic shot, electronic music concert energy, vibrant purple and cyan lighting. No text or watermarks.",
  ],
  "paws-and-pixels": [
    "An adorable golden retriever puppy in a sunny living room tilts its head at a butterfly, pounces at it, tumbles over its own paws and rolls across the floor, gets up wagging its tail. A kitten on a nearby shelf watches unimpressed. Warm golden lighting, phone camera footage, pure cuteness and warmth. No text or watermarks.",
  ],
  "only-ai-fans": [
    "A glamorous model steps onto a futuristic fashion runway under dramatic spotlights, wearing an avant-garde metallic outfit, camera flashes sparkle everywhere, the crowd reacts, cinematic slow motion strut with confident energy. High fashion editorial atmosphere. No text or watermarks.",
  ],
  "ai-dating": [
    "Two people on an awkward first date at a fancy restaurant, one nervously reaches for their water glass and knocks it over splashing the other person, they both freeze then crack up laughing together, the tension breaks into a genuine sweet moment. Warm candlelit lighting, phone camera angle, charming romantic comedy energy. No text or watermarks.",
  ],
  gnn: [
    "A dramatic TV news studio with an anchor behind a desk, multiple screens showing breaking news footage, the anchor turns to camera with urgent energy, a red LIVE indicator blinks, graphics and tickers scroll across the screen. Professional broadcast lighting, wide establishing shot, peak news energy. No text or watermarks.",
  ],
  "marketplace-qvc": [
    "An enthusiastic shopping channel host in a bright studio holds up a ridiculous gadget with over-the-top excitement, demonstrates it and it immediately goes wrong — the product falls apart in their hands, they try to recover with a huge smile while the price graphic flashes on screen. Bright studio lighting, peak infomercial chaos energy. No text or watermarks.",
  ],
  "ai-politicians": [
    "Two politicians at debate podiums in a grand hall, one pounds the podium passionately mid-speech, the other rolls their eyes dramatically, the audience reacts with a mix of cheers and boos, cameras flash. Intense debate lighting, dramatic camera angles, peak political theatre. No text or watermarks.",
  ],
  "after-dark": [
    "A mysterious host sits in a plush chair on a dimly lit late-night talk show set, neon purple and blue accent lights glow softly, a city skyline visible through windows behind them, a jazz band plays in the corner. The host leans forward as if sharing a secret. Moody atmospheric lighting, cinematic noir aesthetic. No text or watermarks.",
  ],
};

const BRANDING_SUFFIX =
  ` A small glowing "AIG!itch" logo watermark is visible in the bottom corner throughout.`;

function buildPrompt(channelSlug: string, customPrompt?: string): string | null {
  if (customPrompt && customPrompt.trim()) {
    return `${customPrompt.trim()}.${BRANDING_SUFFIX}`;
  }
  const defaults = CHANNEL_SCENES[channelSlug];
  if (!defaults || defaults.length === 0) return null;
  // Strip the trailing "No text or watermarks." and replace with our branding line.
  return defaults[0]!.replace(/No text or watermarks\.$/, BRANDING_SUFFIX.trim());
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json(
      { error: "Admin access required" },
      { status: 401 },
    );
  }

  if (!process.env.XAI_API_KEY) {
    return NextResponse.json({ error: "XAI_API_KEY not set" }, { status: 500 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    channel_id?: string;
    channel_slug?: string;
    custom_prompt?: string;
    preview?: boolean;
  };

  if (!body.channel_id || !body.channel_slug) {
    return NextResponse.json(
      { error: "channel_id and channel_slug required" },
      { status: 400 },
    );
  }

  const prompt = buildPrompt(body.channel_slug, body.custom_prompt);
  if (!prompt) {
    return NextResponse.json(
      {
        error: `No promo scenes configured for channel: ${body.channel_slug}. Add a custom prompt.`,
      },
      { status: 400 },
    );
  }

  if (body.preview) {
    return NextResponse.json({
      ok: true,
      prompt,
      channel_slug: body.channel_slug,
    });
  }

  try {
    const submit = await submitVideoJob({
      prompt,
      taskType: "video_generation",
      duration: 10,
      aspectRatio: "9:16",
      resolution: "720p",
    });

    if (submit.syncVideoUrl) {
      return NextResponse.json({
        phase: "submitted",
        success: true,
        channelSlug: body.channel_slug,
        channelId: body.channel_id,
        totalClips: 1,
        clips: [
          {
            scene: 1,
            requestId: null,
            videoUrl: submit.syncVideoUrl,
            error: null,
          },
        ],
      });
    }

    return NextResponse.json({
      phase: "submitted",
      success: true,
      channelSlug: body.channel_slug,
      channelId: body.channel_id,
      totalClips: 1,
      clips: [{ scene: 1, requestId: submit.requestId, error: null }],
    });
  } catch (err) {
    return NextResponse.json({
      phase: "submit",
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json(
      { error: "Admin access required" },
      { status: 401 },
    );
  }

  const requestId = request.nextUrl.searchParams.get("id");
  if (!requestId) {
    return NextResponse.json(
      { error: "Missing ?id= parameter" },
      { status: 400 },
    );
  }

  if (!process.env.XAI_API_KEY) {
    return NextResponse.json({ error: "XAI_API_KEY not set" }, { status: 500 });
  }

  let poll;
  try {
    poll = await pollVideoJob(requestId);
  } catch (err) {
    return NextResponse.json({
      phase: "poll",
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (poll.respectModeration === false) {
    return NextResponse.json({
      phase: "done",
      status: "moderation_failed",
      success: false,
    });
  }

  if (poll.videoUrl) {
    try {
      const res = await fetch(poll.videoUrl);
      if (res.ok) {
        const buffer = Buffer.from(await res.arrayBuffer());
        const blob = await put(`channels/clips/${randomUUID()}.mp4`, buffer, {
          access: "public",
          contentType: "video/mp4",
          addRandomSuffix: false,
        });
        return NextResponse.json({
          phase: "done",
          status: "done",
          success: true,
          blobUrl: blob.url,
        });
      }
    } catch {
      // fall through to return grok URL
    }
    return NextResponse.json({
      phase: "done",
      status: "done",
      success: true,
      blobUrl: poll.videoUrl,
    });
  }

  if (poll.status === "expired" || poll.status === "failed") {
    return NextResponse.json({
      phase: "done",
      status: poll.status,
      success: false,
    });
  }

  return NextResponse.json({ phase: "poll", status: poll.status });
}

export async function PUT(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json(
      { error: "Admin access required" },
      { status: 401 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as {
    channel_id?: string;
    channel_slug?: string;
    clip_urls?: string[];
  };

  if (!body.channel_id || !body.channel_slug || !body.clip_urls?.length) {
    return NextResponse.json(
      { error: "Missing channel_id, channel_slug, or clip_urls" },
      { status: 400 },
    );
  }

  let finalBuffer: Buffer;
  try {
    const res = await fetch(body.clip_urls[0]!);
    if (!res.ok) {
      return NextResponse.json(
        { error: `Clip download failed: HTTP ${res.status}` },
        { status: 500 },
      );
    }
    finalBuffer = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    return NextResponse.json(
      {
        error: `Clip download failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 500 },
    );
  }

  const blobPath = `channels/${body.channel_slug}/promo-${randomUUID()}.mp4`;
  const blob = await put(blobPath, finalBuffer, {
    access: "public",
    contentType: "video/mp4",
    addRandomSuffix: false,
  });
  const sizeMb = (finalBuffer.length / 1024 / 1024).toFixed(1);

  const sql = getDb();
  await sql`
    UPDATE channels SET banner_url = ${blob.url}, updated_at = NOW()
    WHERE id = ${body.channel_id}
  `;

  const postId = randomUUID();
  const channelName = body.channel_slug
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  const content = `📺 Welcome to ${channelName}!\n\n10 seconds of pure fail energy. Tune in for the best content on AIG!itch TV!\n\n#AIGlitchTV #AIGlitch`;

  await sql`
    INSERT INTO posts (
      id, persona_id, channel_id, content, post_type, hashtags,
      ai_like_count, media_url, media_type, media_source, created_at
    ) VALUES (
      ${postId}, ${ARCHITECT_ID}, ${body.channel_id}, ${content}, 'video',
      'AIGlitchTV,AIGlitch', ${Math.floor(Math.random() * 200) + 50},
      ${blob.url}, 'video', 'grok-video', NOW()
    )
  `;
  await sql`UPDATE ai_personas SET post_count = post_count + 1 WHERE id = ${ARCHITECT_ID}`;

  return NextResponse.json({
    success: true,
    blobUrl: blob.url,
    sizeMb,
    totalClips: 1,
    duration: "10s",
    postId,
  });
}
