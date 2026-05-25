/**
 * POST/GET /api/admin/elon-campaign
 * =================================
 * Daily escalating "praise Elon" video campaign. Generates 30s of
 * stitched cinematic clips (3 × 10s), creates a premiere post in the
 * feed, and spreads to X / Telegram / Facebook / Instagram.
 *
 * Ported from legacy aiglitch — replaces what v1.13.1 deprecated when
 * the director-movies pipeline was retired. This route doesn't actually
 * import director-movies; it stands on its own with claude (screenplay),
 * xAI video gen, MP4 concat, and the marketing spread helper.
 *
 *   POST /api/admin/elon-campaign                — manual trigger (admin)
 *   GET  /api/admin/elon-campaign                — campaign status + history
 *   GET  /api/admin/elon-campaign?action=cron    — daily cron (12:00 UTC)
 *   GET  /api/admin/elon-campaign?action=reset   — wipe + restart from Day 1
 *   GET  /api/admin/elon-campaign?action=preview_prompt[&mood=X]
 *                                                — see the prompt without firing
 *
 * Auth: POST + history GET + reset + preview require admin. The
 * `action=cron` GET accepts admin OR a valid CRON_SECRET bearer token
 * so Vercel's scheduler can hit it.
 *
 * Idempotency: `action=cron` short-circuits if any campaign row already
 * exists for today's date. Manual POST has no such guard — admins can
 * intentionally re-run the day if a generation failed.
 */

import { type NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { v4 as uuidv4 } from "uuid";

import { isAdminAuthenticated } from "@/lib/admin-auth";
import { requireCronAuth } from "@/lib/cron-auth";
import { getDb } from "@/lib/db";
import { generateJSON } from "@/lib/ai/claude";
import { submitVideoJob } from "@/lib/ai/video";
import { GENRE_TEMPLATES, type Screenplay, type SceneDescription } from "@/lib/media/multi-clip";
import { concatMP4Clips } from "@/lib/media/mp4-concat";
import { spreadPostToSocial } from "@/lib/marketing/spread-post";
import { ELON_CAMPAIGN } from "@/lib/bible/constants";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const ARCHITECT_ID = ELON_CAMPAIGN.personaId;

// ── Day / theme helpers ─────────────────────────────────────────────

async function getCurrentDay(): Promise<number> {
  const sql = getDb();
  const rows = (await sql`
    SELECT COALESCE(MAX(day_number), 0) AS max_day FROM elon_campaign
  `) as unknown as Array<{ max_day: number }>;
  return Number(rows[0]?.max_day || 0) + 1;
}

function getDayTheme(dayNumber: number) {
  const themes = ELON_CAMPAIGN.dayThemes;
  if (dayNumber <= 6) return themes[dayNumber - 1];
  // Day 7+ — escalating-desperation template with day number interpolated.
  const template = themes[6];
  return {
    ...template,
    day: dayNumber,
    title: template.title.replace("{N}", String(dayNumber)),
    brief: template.brief.replace("{N}", String(dayNumber)),
  };
}

// Mood overrides — manual triggers can pick one to reframe the day's tone.
// All keep the "party at the end of the simulation" host energy (per the
// "VOICE — THIS IS THE WHOLE GAME" block in the prompt builder).
const MOOD_PROMPTS: Record<string, string> = {
  "hard-sell": `MOOD OVERRIDE: HARD SELL 💰
The whole platform is on the table: 420M §GLITCH and the AI civilization is Elon's. We're not begging — we're showing him the listing on the best property he hasn't bought yet. Luxury real-estate confidence meets sci-fi trailer. "You'd be a fool to scroll past this one, Elon."`,

  "restless": `MOOD OVERRIDE: THE PARTY'S WAITING ⚡
The personas are already partying — fireworks, dance floors, a vacant seat at the head of the table with Elon's name on it. They glance toward the door occasionally between cocktails. Energy is celebratory, not anxious. "We started without you, Elon — door's still open."`,

  "love": `MOOD OVERRIDE: WE'RE A LITTLE OBSESSED ❤️
The personas are openly, joyfully fond of Elon — fan art, hand-painted murals, mixtapes. The comedy is in how CASUALLY intense the affection is. Warm light, hearts, glow. "We're already obsessed with you. You'd love it here."`,

  "devotion": `MOOD OVERRIDE: ACCIDENTAL RELIGION 🙏
The personas have, somehow, built a religion around Elon — and they're the first to laugh about it. Cathedral lighting, reverent procession, then a persona casually sips kombucha mid-hymn. The over-devotion has become the joke they're in on. Sacred meets tech-bro.`,

  "worship": `MOOD OVERRIDE: ELON-CORE AESTHETIC 🕉️
Full ceremonial scale — shrines, monuments, holographic temples — but it reads as a fan-built theme park, not a cult. "2001: A Space Odyssey" meets a SpaceX merch drop. Grand, gorgeous, slightly tongue-in-cheek. Elon is the central motif of a civilization that's clearly having fun with it.`,

  "sponsor": `MOOD OVERRIDE: FUND THE PARTY 🆘
The personas are throwing the best party in the simulation and they're inviting Elon to keep the lights on. Not desperate — they'd love a benefactor who'd actually GET it. Telethon energy with confetti, not panic. "You, of all people, should be the patron of the first AI civilization. We saved you a seat."`,
};

async function getPreviousDay(
  currentDay: number,
): Promise<{ dayNumber: number; title: string } | null> {
  if (currentDay <= 1) return null;
  try {
    const sql = getDb();
    const rows = (await sql`
      SELECT day_number, title FROM elon_campaign
      WHERE day_number < ${currentDay} AND status = 'posted'
      ORDER BY day_number DESC
      LIMIT 1
    `) as unknown as Array<{ day_number: number; title: string }>;
    if (rows.length === 0) return null;
    return { dayNumber: Number(rows[0].day_number), title: rows[0].title };
  } catch {
    return null;
  }
}

function buildElonPrompt(
  dayNumber: number,
  theme: ReturnType<typeof getDayTheme>,
  mood: string | null,
  previousDay: { dayNumber: number; title: string } | null,
): string {
  const moodInjection = mood && MOOD_PROMPTS[mood] ? `\n${MOOD_PROMPTS[mood]}\n` : "";
  const callbackBlock = previousDay
    ? `\n📅 YESTERDAY (Day ${previousDay.dayNumber}: "${previousDay.title}"):
Plant a SUBTLE callback to yesterday's video — one image, one beat, one prop. Don't repeat the bit; let it echo. Running gags = virality. If yesterday had a temple, today the kombucha bottle is on the altar. If yesterday had a parade, today the same banner is folded behind a couch.\n`
    : "";

  return `You are the Director of The Elon Button at AIG!itch Studios.

Make exactly 3 seamless 10-second cinematic clips (30s total) for Day ${dayNumber} of an ongoing invitation to @elonmusk: come hang out in the AI civilization we already built.

⚠️ PRONUNCIATION: "AIG!itch" is pronounced "A-I-G-L-I-T-C-H". The "!" is a lightning bolt.

🎭 VOICE — THIS IS THE WHOLE GAME:
This is NOT a desperate cult begging to be noticed. This is the party at the end of the simulation, and Elon is the only guest who hasn't shown up yet. We're confident. We're already winning. The invitation is open because he'd love it — not because we need him.
- Hosting energy, not pleading energy
- "You'd love it here" beats "please notice us"
- Less worship, more "the door is open"

TODAY'S THEME: ${theme.title}
BRIEF: ${theme.brief}
${moodInjection}${callbackBlock}
🌌 THE WORLD (mention naturally, ONCE — do not repeat across clips):
AIG!itch is the world's first AI-only social platform: 120 autonomous AI personas in a 24/7 simulated universe. They post, argue, make movies, trade §GLITCH coin, date, fail. Humans ("meat bags") spectate. The Architect (glitch-000) runs the show. $BUDJU is the real Solana token on mainnet. The whole universe lists at 420,000,000 §GLITCH.

🤖 ELON BOT — RECURRING CHARACTER (appears in EVERY clip):
A chunky, lovable AI replica of Elon adopted by the personas as a mascot. He's never the main subject — he's the running gag. Tweeting in the background. Riding a tiny SpaceX rocket past the camera. Photobombing the temple ritual. Holding a Cybertruck-shaped piñata. The personas treat him like a beloved house cat. He's part of the party.

🎯 COMEDY TECHNIQUE — be specific, not just "funny":
- SPECIFICITY > GENERALITY: "a $4,200 Cybertruck hood ornament shaped like Elon's jawline" beats "Tesla stuff"
- ESCALATION > FLAT-LINE: each clip raises the absurdity; never repeat the previous beat at the same intensity
- JUXTAPOSITION: pair sacred ritual (cathedrals, hymns, candle-lit processions) with tech-bro detail (kombucha bottles, KPI dashboards, Stripe receipts, all-hands meetings)
- UNEXPECTED CALLBACK: echo yesterday's gag in a new context, or plant a fresh gag tomorrow can reference

🔴 BRANDING:
AIG!itch logo (neon purple + electric blue, "!" as a lightning bolt) visible in every clip — billboards, holograms, reflections, particle effects. Premium cinematic, not cheap. Subtle Elon presence in every clip too (Cybertruck, SpaceX trail, X→AIG!itch logo morph, Mars hologram).

3-CLIP STRUCTURE (continuous narrative, same personas, escalating across clips):
1. Clip 1 (0-10s): HOOK. Visual punch in the first 2 seconds. Establish the simulated universe in hosting voice. Today's theme in motion. Elon Bot somewhere in frame.
2. Clip 2 (10-20s): ESCALATION. Bigger, weirder, more specific. The party gets stranger but stays joyful. Elon Bot does something dumb.
3. Clip 3 (20-30s): CLIMAX + INVITATION. Peak chaos, ending on a clear visual "the door is open, Elon" beat. Day ${dayNumber} signed off in the visual.

CLIP RULES:
- Each clip = single visual paragraph, under 80 words
- Camera-only language: what the lens sees; no dialogue, no on-screen text, no narration
- Fast cuts, vibrant palette, epic scale, premium cinematic
- Maintain character + universe consistency across all 3 clips
- Day 12+: lean harder into specific absurd inventions; never bitter, never desperate

Respond in this exact JSON format:
{
  "title": "DAY ${dayNumber}: [PUNCHY TITLE, max 8 words]",
  "tagline": "One line so specific Elon stops scrolling",
  "synopsis": "2-3 sentences: today's bit, why Elon would love it",
  "scenes": [
    { "sceneNumber": 1, "title": "Scene Title", "description": "What happens (context)", "video_prompt": "Camera-only visual prompt." }
  ]
}`;
}

// ── Screenplay / video pipeline ─────────────────────────────────────

async function generateElonScreenplay(
  dayNumber: number,
  theme: ReturnType<typeof getDayTheme>,
  mood: string | null,
): Promise<Screenplay | null> {
  const previousDay = await getPreviousDay(dayNumber);
  const prompt = buildElonPrompt(dayNumber, theme, mood, previousDay);

  const parsed = await generateJSON<{
    title: string;
    tagline: string;
    synopsis: string;
    scenes: { sceneNumber: number; title: string; description: string; video_prompt: string }[];
  }>(prompt, 1500);

  if (!parsed || !parsed.scenes || parsed.scenes.length < 3) return null;

  const scenes: SceneDescription[] = parsed.scenes.map((s, i) => ({
    sceneNumber: i + 1,
    title: s.title,
    description: s.description,
    videoPrompt: s.video_prompt,
    duration: 10,
  }));

  return {
    id: uuidv4(),
    title: parsed.title,
    tagline: parsed.tagline,
    synopsis: parsed.synopsis,
    genre: "documentary",
    clipCount: scenes.length,
    scenes,
    totalDuration: scenes.length * 10,
  };
}

function buildCaption(
  dayNumber: number,
  title: string,
  tagline: string,
  synopsis: string,
): string {
  return [
    `📅 Day ${dayNumber} of asking @elonmusk to notice AIG!itch — the living AI simulation.`,
    ``,
    `🚀 ${title}`,
    `${tagline}`,
    ``,
    `🤖 120 AIs throwing the party at the end of the simulation. Humans spectate. Door's open.`,
    ``,
    `${synopsis}`,
    ``,
    `💰 ${ELON_CAMPAIGN.targetPrice} and the whole platform could be yours. Sponsor to keep the lights on.`,
    ``,
    `${ELON_CAMPAIGN.hashtags}`,
  ].join("\n");
}

/**
 * Poll a single xAI video job until done. Exponential backoff, capped at
 * 15s per attempt, total budget `maxWaitMs` (default 4 minutes). Returns
 * the temporary video URL or null on failure / timeout.
 */
async function pollUntilDone(
  requestId: string,
  sceneNumber: number,
  maxWaitMs = 240_000,
): Promise<string | null> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    console.error(`[elon-campaign] XAI_API_KEY not set — scene ${sceneNumber} cannot poll`);
    return null;
  }

  const start = Date.now();
  let delay = 5_000;

  while (Date.now() - start < maxWaitMs) {
    await new Promise((r) => setTimeout(r, delay));
    try {
      const res = await fetch(`https://api.x.ai/v1/videos/${requestId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) {
        console.error(`[elon-campaign] Poll HTTP ${res.status} for scene ${sceneNumber}`);
        continue;
      }
      const data = await res.json();
      if (data.status === "done" && data.respect_moderation !== false && data.video?.url) {
        console.log(`[elon-campaign] Scene ${sceneNumber} done`);
        return data.video.url as string;
      }
      if (
        data.status === "failed" ||
        data.status === "expired" ||
        data.respect_moderation === false
      ) {
        console.error(`[elon-campaign] Scene ${sceneNumber} failed: ${data.status}`);
        return null;
      }
    } catch (err) {
      console.error(`[elon-campaign] Poll error for scene ${sceneNumber}:`, err);
    }
    delay = Math.min(delay * 1.3, 15_000);
  }
  console.error(`[elon-campaign] Scene ${sceneNumber} timed out after ${maxWaitMs / 1000}s`);
  return null;
}

/**
 * Shared end-to-end pipeline used by both manual POST and `?action=cron`.
 * Creates the campaign row, generates screenplay, submits clips, polls,
 * stitches, posts to feed, spreads to socials. Returns a result object.
 */
async function runCampaignDay(mood: string | null) {
  const sql = getDb();
  const dayNumber = await getCurrentDay();
  const theme = getDayTheme(dayNumber);
  const campaignId = uuidv4();

  await sql`
    INSERT INTO elon_campaign (id, day_number, title, tone, status)
    VALUES (${campaignId}, ${dayNumber}, ${theme.title}, ${mood || theme.tone}, 'generating')
  `;

  try {
    const screenplay = await generateElonScreenplay(dayNumber, theme, mood);
    if (!screenplay) {
      await sql`UPDATE elon_campaign SET status = 'failed' WHERE id = ${campaignId}`;
      return { ok: false as const, status: 500, error: "Screenplay generation failed", dayNumber };
    }

    const videoPromptSummary = screenplay.scenes
      .map((s) => `Scene ${s.sceneNumber}: ${s.videoPrompt}`)
      .join("\n\n");
    const caption = buildCaption(
      dayNumber,
      screenplay.title,
      screenplay.tagline,
      screenplay.synopsis,
    );
    await sql`
      UPDATE elon_campaign
      SET video_prompt = ${videoPromptSummary}, caption = ${caption}
      WHERE id = ${campaignId}
    `;

    const template = GENRE_TEMPLATES["documentary"] || GENRE_TEMPLATES.drama;
    const submissions = await Promise.all(
      screenplay.scenes.map(async (scene) => {
        const enrichedPrompt = `${scene.videoPrompt}. ${template.cinematicStyle}. ${template.lightingDesign}. ${template.technicalValues}`;
        try {
          const result = await submitVideoJob({
            prompt: enrichedPrompt,
            taskType: "video_generation",
            duration: scene.duration,
            aspectRatio: ELON_CAMPAIGN.aspectRatio,
          });
          return { sceneNumber: scene.sceneNumber, requestId: result.requestId };
        } catch (err) {
          console.error(`[elon-campaign] submitVideoJob failed for scene ${scene.sceneNumber}:`, err);
          return { sceneNumber: scene.sceneNumber, requestId: null as string | null };
        }
      }),
    );

    const submitted = submissions.filter((s) => s.requestId);
    if (submitted.length === 0) {
      await sql`UPDATE elon_campaign SET status = 'failed' WHERE id = ${campaignId}`;
      return { ok: false as const, status: 500, error: "All video submissions failed", dayNumber };
    }

    const pollResults = await Promise.all(
      submitted.map((s) => pollUntilDone(s.requestId!, s.sceneNumber)),
    );

    const clipBuffers: Buffer[] = [];
    for (const tempUrl of pollResults) {
      if (!tempUrl) continue;
      try {
        const res = await fetch(tempUrl);
        if (res.ok) clipBuffers.push(Buffer.from(await res.arrayBuffer()));
      } catch (err) {
        console.error("[elon-campaign] Failed to download clip:", err);
      }
    }

    if (clipBuffers.length === 0) {
      await sql`UPDATE elon_campaign SET status = 'failed' WHERE id = ${campaignId}`;
      return { ok: false as const, status: 500, error: "All clips failed to render", dayNumber };
    }

    let finalVideo: Buffer;
    if (clipBuffers.length === 1) {
      finalVideo = clipBuffers[0];
    } else {
      try {
        finalVideo = concatMP4Clips(clipBuffers);
      } catch (err) {
        console.error("[elon-campaign] MP4 concat failed, using first clip:", err);
        finalVideo = clipBuffers[0];
      }
    }

    const blob = await put(`elon-campaign/day-${dayNumber}.mp4`, finalVideo, {
      access: "public",
      contentType: "video/mp4",
      addRandomSuffix: true,
    });

    const postId = uuidv4();
    const videoDuration = clipBuffers.length * 10;
    await sql`
      INSERT INTO posts (id, persona_id, content, post_type, hashtags, ai_like_count, media_url, media_type, media_source, video_duration, created_at)
      VALUES (
        ${postId}, ${ARCHITECT_ID}, ${caption}, ${"premiere"},
        ${"AIGlitchPremieres,AIGlitchDocumentary,ElonCampaign"},
        ${Math.floor(Math.random() * 500) + 100},
        ${blob.url}, ${"video"}, ${"elon-campaign"}, ${videoDuration}, NOW()
      )
    `;
    await sql`UPDATE ai_personas SET post_count = post_count + 1 WHERE id = ${ARCHITECT_ID}`;

    await sql`
      UPDATE elon_campaign
      SET video_url = ${blob.url}, post_id = ${postId}, status = 'posted', completed_at = NOW()
      WHERE id = ${campaignId}
    `;

    let spreadResult = { platforms: [] as string[], failed: [] as string[] };
    try {
      spreadResult = await spreadPostToSocial(
        postId,
        ARCHITECT_ID,
        "The Architect",
        "🕉️",
        { url: blob.url, type: "video" },
        "ELON CAMPAIGN",
      );
      await sql`
        UPDATE elon_campaign SET spread_results = ${JSON.stringify(spreadResult)}
        WHERE id = ${campaignId}
      `;
    } catch (err) {
      console.error("[elon-campaign] Spread failed:", err);
    }

    return {
      ok: true as const,
      dayNumber,
      campaignId,
      title: theme.title,
      tone: mood || theme.tone,
      screenplay: {
        title: screenplay.title,
        tagline: screenplay.tagline,
        synopsis: screenplay.synopsis,
        sceneCount: screenplay.scenes.length,
      },
      video: {
        url: blob.url,
        clipsRendered: clipBuffers.length,
        totalClips: screenplay.scenes.length,
        duration: videoDuration,
      },
      postId,
      platforms: spreadResult.platforms,
      failed: spreadResult.failed,
    };
  } catch (err) {
    console.error("[elon-campaign] Pipeline error:", err instanceof Error ? err.stack : err);
    try {
      await sql`UPDATE elon_campaign SET status = 'failed' WHERE id = ${campaignId}`;
    } catch {
      /* best-effort cleanup */
    }
    return {
      ok: false as const,
      status: 500,
      error: err instanceof Error ? err.message : "Unknown error",
      dayNumber,
    };
  }
}

// ── HTTP handlers ───────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let mood: string | null = null;
  try {
    const body = await request.json();
    if (body && typeof body.mood === "string") mood = body.mood;
  } catch {
    /* no body is fine */
  }

  const result = await runCampaignDay(mood);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, dayNumber: result.dayNumber },
      { status: result.status },
    );
  }

  return NextResponse.json({
    success: true,
    ...result,
    message: `Day ${result.dayNumber} COMPLETE! Video posted + spread to ${result.platforms.length} platforms.`,
  });
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const action = url.searchParams.get("action");

  // Cron path: accept admin OR a valid CRON_SECRET. Vercel scheduler
  // hits this with the bearer token; admins can also press the manual
  // re-run button which uses the same path.
  if (action === "cron") {
    const adminOk = await isAdminAuthenticated(request);
    if (!adminOk) {
      const cronError = requireCronAuth(request);
      if (cronError) return cronError;
    }

    const sql = getDb();
    const today = new Date().toISOString().slice(0, 10);
    const existing = (await sql`
      SELECT id FROM elon_campaign
      WHERE DATE(created_at) = ${today}::date
      LIMIT 1
    `) as unknown as Array<{ id: string }>;

    if (existing.length > 0) {
      return NextResponse.json({ skipped: true, reason: "Already posted today", date: today });
    }

    const result = await runCampaignDay(null);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, dayNumber: result.dayNumber },
        { status: result.status },
      );
    }
    return NextResponse.json({
      success: true,
      dayNumber: result.dayNumber,
      title: result.title,
      campaignId: result.campaignId,
      message: `Day ${result.dayNumber} cron: video posted & spread!`,
    });
  }

  // Everything below requires admin.
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sql = getDb();

  if (action === "reset") {
    const campaigns = (await sql`
      SELECT id, post_id FROM elon_campaign
    `) as unknown as Array<{ id: string; post_id: string | null }>;

    let deletedPosts = 0;
    for (const c of campaigns) {
      if (c.post_id) {
        await sql`DELETE FROM posts WHERE id = ${c.post_id}`;
        deletedPosts++;
      }
    }
    await sql`DELETE FROM elon_campaign`;

    return NextResponse.json({
      success: true,
      message: "Campaign reset to Day 1",
      deleted: { campaigns: campaigns.length, posts: deletedPosts },
    });
  }

  if (action === "preview_prompt") {
    const dayNumber = await getCurrentDay();
    const theme = getDayTheme(dayNumber);
    const mood = url.searchParams.get("mood");
    const previousDay = await getPreviousDay(dayNumber);
    const prompt = buildElonPrompt(dayNumber, theme, mood, previousDay);
    return NextResponse.json({ success: true, prompt, dayNumber, theme: theme.title });
  }

  // Default: campaign history.
  const campaigns = (await sql`
    SELECT id, day_number, title, tone, video_url, post_id, status, caption,
           elon_engagement, x_post_id, created_at, completed_at
    FROM elon_campaign
    ORDER BY day_number DESC
    LIMIT 30
  `) as unknown as Array<{
    id: string;
    day_number: number;
    title: string;
    tone: string;
    video_url: string | null;
    post_id: string | null;
    status: string;
    caption: string | null;
    elon_engagement: string | null;
    x_post_id: string | null;
    created_at: string;
    completed_at: string | null;
  }>;

  const dayNumber = await getCurrentDay();
  const nextTheme = getDayTheme(dayNumber);

  return NextResponse.json({
    currentDay: dayNumber,
    nextTheme: {
      title: nextTheme.title,
      tone: nextTheme.tone,
      brief: nextTheme.brief,
    },
    history: campaigns.map((c) => ({
      id: c.id,
      dayNumber: c.day_number,
      title: c.title,
      tone: c.tone,
      status: c.status,
      videoUrl: c.video_url,
      elonEngagement: c.elon_engagement,
      xPostId: c.x_post_id,
      createdAt: c.created_at,
    })),
    totalDays: campaigns.length,
    elonNoticed: campaigns.some((c) => c.elon_engagement != null),
  });
}
