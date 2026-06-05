/**
 * Breaking News pipeline — single stitched MP4 per daily_topic.
 *
 * Per topic: [intro.mp4] + [presenter clip] + [field clip] + [outro.mp4]
 * stitched with mp4-concat (pure JS, no ffmpeg) into a single 26s video.
 *
 * Intro + outro are lazy-generated ONCE per environment and reused on
 * every story (~$0.30 one-time cost).
 *
 * Per-story cost: presenter 10s ($0.50) + field 10s ($0.50) = $1.00.
 * Capped at 2 stories/day via platform_settings, so $2/day hard ceiling
 * = ~$60/month worst case.
 *
 * Entry point: processNewTopicsForBreakingNews — called by the
 * /api/generate-topics cron AFTER topics insert. Deduped on
 * daily_topics.breaking_video_url IS NULL.
 *
 * Storage layout (Vercel Blob):
 *   breaking-news/brand/intro.mp4              — one-time, reused
 *   breaking-news/brand/outro.mp4              — one-time, reused
 *   breaking-news/clips/<topic_id>/presenter.mp4
 *   breaking-news/clips/<topic_id>/field.mp4
 *   breaking-news/stitched/<YYYY-MM-DD>/<topic_id>.mp4   — final, posted
 */

import { put } from "@vercel/blob";
import { generateVideoToBlob } from "@/lib/ai/video";
import { concatMP4Clips } from "@/lib/media/mp4-concat";
import { getDb } from "@/lib/db";
import { spreadPostToSocial } from "@/lib/marketing/spread-post";
import { randomUUID } from "node:crypto";

const NEWS_PERSONA_ID = "news_feed_ai";
const NEWS_PERSONA_NAME = "GLITCH NEWS NETWORK";
const NEWS_PERSONA_EMOJI = "🛰️";
const BREAKING_HASHTAG = "BreakingGlitch";

// ── Tunables ────────────────────────────────────────────────────────
const DAILY_CAP_DEFAULT = 2;
const INTRO_DURATION_SEC = 3;
const OUTRO_DURATION_SEC = 3;
const PRESENTER_DURATION_SEC = 10;
const FIELD_DURATION_SEC = 10;

// ── platform_settings keys ──────────────────────────────────────────
const KEY_ENABLED = "breaking_news_enabled";
const KEY_DAILY_COUNT = "breaking_news_daily_count";
const KEY_DAILY_RESET_DATE = "breaking_news_daily_reset_date";
const KEY_INTRO_URL = "breaking_news_intro_url";
const KEY_OUTRO_URL = "breaking_news_outro_url";

export interface BreakingNewsTopic {
  id: string;
  headline: string;
  summary: string;
  category: string;
  mood: string;
}

export interface BreakingNewsResult {
  topic_id: string;
  status: "posted" | "skipped" | "failed" | "cap_hit" | "disabled";
  video_url?: string;
  post_id?: string;
  error?: string;
}

// ─── Schema bootstrap ───────────────────────────────────────────────
//
// Idempotent column adds — safe to call on every cron tick. PostgreSQL
// IF NOT EXISTS makes this cheap when the columns already exist.

let _schemaEnsured = false;

async function ensureBreakingNewsColumns(): Promise<void> {
  if (_schemaEnsured) return;
  const sql = getDb();
  try {
    await sql`ALTER TABLE daily_topics ADD COLUMN IF NOT EXISTS breaking_video_url TEXT`;
    await sql`ALTER TABLE daily_topics ADD COLUMN IF NOT EXISTS breaking_video_generated_at TIMESTAMP`;
    _schemaEnsured = true;
  } catch (err) {
    console.error(
      "[breaking-news] schema ensure failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

// ─── Settings helpers ───────────────────────────────────────────────

async function readSetting(key: string): Promise<string | null> {
  const sql = getDb();
  try {
    const rows = (await sql`
      SELECT value FROM platform_settings WHERE key = ${key}
    `) as Array<{ value: string }>;
    return rows[0]?.value ?? null;
  } catch {
    return null;
  }
}

async function writeSetting(key: string, value: string): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO platform_settings (key, value, updated_at)
    VALUES (${key}, ${value}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = ${value}, updated_at = NOW()
  `;
}

export async function isBreakingNewsEnabled(): Promise<boolean> {
  const v = await readSetting(KEY_ENABLED);
  // Default ON if the row doesn't exist yet (first deploy).
  if (v === null) return true;
  return v === "true";
}

export async function setBreakingNewsEnabled(enabled: boolean): Promise<void> {
  await writeSetting(KEY_ENABLED, enabled ? "true" : "false");
}

/**
 * Read + reset (if new day) the daily count. Returns the current count
 * and the remaining cap. Resets to 0 at midnight UTC.
 */
async function getDailyCounter(): Promise<{ count: number; remaining: number }> {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const storedDate = await readSetting(KEY_DAILY_RESET_DATE);
  if (storedDate !== today) {
    await writeSetting(KEY_DAILY_COUNT, "0");
    await writeSetting(KEY_DAILY_RESET_DATE, today);
    return { count: 0, remaining: DAILY_CAP_DEFAULT };
  }
  const count = Number((await readSetting(KEY_DAILY_COUNT)) ?? "0");
  return { count, remaining: Math.max(0, DAILY_CAP_DEFAULT - count) };
}

async function incrementDailyCount(): Promise<void> {
  const current = Number((await readSetting(KEY_DAILY_COUNT)) ?? "0");
  await writeSetting(KEY_DAILY_COUNT, String(current + 1));
}

export async function getBreakingNewsStatus(): Promise<{
  enabled: boolean;
  dailyCap: number;
  count: number;
  remaining: number;
  intro_url: string | null;
  outro_url: string | null;
}> {
  const enabled = await isBreakingNewsEnabled();
  const { count, remaining } = await getDailyCounter();
  return {
    enabled,
    dailyCap: DAILY_CAP_DEFAULT,
    count,
    remaining,
    intro_url: await readSetting(KEY_INTRO_URL),
    outro_url: await readSetting(KEY_OUTRO_URL),
  };
}

// ─── Brand asset generation (one-time, lazy) ────────────────────────

const INTRO_PROMPT =
  "GLITCH NEWS NETWORK logo materializes from neon static. Cyberpunk newsroom backdrop with " +
  "purple and cyan glow. Glitching red text 'BREAKING — GLITCH NEWS NETWORK' fills the screen. " +
  "Urgent stinger music. Sharp digital noise transitions. Pure brand intro, no narration. " +
  "9:16 portrait. 3 seconds.";

const OUTRO_PROMPT =
  "GLITCH NEWS NETWORK logo crashes through digital noise. Tagline 'STAY UNINFORMED — GLITCH NEWS " +
  "NETWORK' in glitching cyan text. Cyberpunk newsroom dissolves to black. Sign-off audio sting. " +
  "9:16 portrait. 3 seconds.";

async function generateBrandClip(
  prompt: string,
  duration: number,
  slug: "intro" | "outro",
): Promise<string> {
  const result = await generateVideoToBlob({
    prompt,
    taskType: "video_generation",
    duration,
    aspectRatio: "9:16",
    blobPath: `breaking-news/brand/${slug}.mp4`,
  });
  return result.blobUrl;
}

/**
 * Ensure intro + outro exist in Blob. Lazy — only generates if missing.
 * Returns the URLs (cached in platform_settings after first generation).
 */
export async function ensureBrandAssets(): Promise<{
  introUrl: string;
  outroUrl: string;
}> {
  let introUrl = await readSetting(KEY_INTRO_URL);
  let outroUrl = await readSetting(KEY_OUTRO_URL);

  if (!introUrl) {
    introUrl = await generateBrandClip(INTRO_PROMPT, INTRO_DURATION_SEC, "intro");
    await writeSetting(KEY_INTRO_URL, introUrl);
  }
  if (!outroUrl) {
    outroUrl = await generateBrandClip(OUTRO_PROMPT, OUTRO_DURATION_SEC, "outro");
    await writeSetting(KEY_OUTRO_URL, outroUrl);
  }

  return { introUrl, outroUrl };
}

// ─── Per-topic video generation ─────────────────────────────────────

function presenterPrompt(topic: BreakingNewsTopic, dateLabel: string): string {
  return (
    `Cyberpunk newsroom. Holographic GLITCH NEWS NETWORK anchor at a sleek neon desk. ` +
    `Bottom-screen ticker shows "${dateLabel} — BREAKING". Anchor leans toward camera ` +
    `urgently and delivers: "${topic.headline}. ${topic.summary.slice(0, 120)}" ` +
    `Glitch effects pulse behind them, news graphics fly across screen. Purple and cyan ` +
    `lighting, dramatic camera push-in. 9:16 portrait. 10 seconds.`
  );
}

function fieldPrompt(topic: BreakingNewsTopic, dateLabel: string): string {
  return (
    `On-scene field footage related to "${topic.headline}". Dramatic visuals matching the ` +
    `${topic.mood} mood and ${topic.category} category. Date stamp "${dateLabel}" in the ` +
    `corner with GLITCH NEWS NETWORK watermark. Cyberpunk reporter aesthetic, glitchy ` +
    `transitions, urgent atmosphere. No anchor in this scene — pure environmental ` +
    `storytelling. 9:16 portrait. 10 seconds.`
  );
}

function dateLabel(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD UTC
}

async function downloadToBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Generate one stitched breaking news video for a single topic.
 * Returns the final stitched URL + the new post ID.
 *
 * Steps:
 *   1. Ensure brand assets exist (lazy generation on first call)
 *   2. Generate presenter clip + field clip IN PARALLEL
 *   3. Download intro, outro, presenter, field as Buffers
 *   4. Stitch [intro, presenter, field, outro] via mp4-concat
 *   5. Upload stitched MP4 to Blob
 *   6. INSERT post into posts table (For You feed)
 *   7. Spread to active social accounts (skips youtube for short video)
 *   8. UPDATE daily_topics with breaking_video_url + timestamp
 */
async function generateOneStitchedBreakingNews(
  topic: BreakingNewsTopic,
): Promise<{ videoUrl: string; postId: string }> {
  const today = new Date();
  const label = dateLabel(today);

  // 1. Brand assets (cheap if already generated).
  const { introUrl, outroUrl } = await ensureBrandAssets();

  // 2. Generate presenter + field in parallel (independent xAI calls).
  const presenterPromise = generateVideoToBlob({
    prompt: presenterPrompt(topic, label),
    taskType: "video_generation",
    duration: PRESENTER_DURATION_SEC,
    aspectRatio: "9:16",
    blobPath: `breaking-news/clips/${topic.id}/presenter.mp4`,
  });
  const fieldPromise = generateVideoToBlob({
    prompt: fieldPrompt(topic, label),
    taskType: "video_generation",
    duration: FIELD_DURATION_SEC,
    aspectRatio: "9:16",
    blobPath: `breaking-news/clips/${topic.id}/field.mp4`,
  });
  const [presenter, field] = await Promise.all([presenterPromise, fieldPromise]);

  // 3. Download all 4 source clips.
  const [introBuf, presenterBuf, fieldBuf, outroBuf] = await Promise.all([
    downloadToBuffer(introUrl),
    downloadToBuffer(presenter.blobUrl),
    downloadToBuffer(field.blobUrl),
    downloadToBuffer(outroUrl),
  ]);

  // 4. Stitch with pure-JS concat (matches what channel videos use).
  const stitched = concatMP4Clips([introBuf, presenterBuf, fieldBuf, outroBuf]);

  // 5. Upload final.
  const stitchedBlob = await put(
    `breaking-news/stitched/${label}/${topic.id}.mp4`,
    stitched,
    {
      access: "public",
      contentType: "video/mp4",
      addRandomSuffix: false,
    },
  );

  // 6. INSERT post → For You feed.
  const sql = getDb();
  const postId = randomUUID();
  const caption =
    `🛰️ BREAKING — ${label}\n\n${topic.headline}\n\n${topic.summary}\n\n` +
    `#${BREAKING_HASHTAG} #AIGlitch #GLITCHNewsNetwork`;
  const hashtags = `${BREAKING_HASHTAG},AIGlitch,GLITCHNewsNetwork`;

  try {
    await sql`
      INSERT INTO posts (
        id, persona_id, content, post_type, hashtags,
        media_url, media_type, ai_like_count, media_source, created_at
      ) VALUES (
        ${postId}, ${NEWS_PERSONA_ID}, ${caption}, 'news', ${hashtags},
        ${stitchedBlob.url}, 'video',
        ${Math.floor(Math.random() * 500) + 200},
        'breaking-news', NOW()
      )
    `;
    await sql`
      UPDATE ai_personas SET post_count = post_count + 1 WHERE id = ${NEWS_PERSONA_ID}
    `;
  } catch (err) {
    console.error(
      "[breaking-news] post insert failed (continuing to spread):",
      err instanceof Error ? err.message : err,
    );
  }

  // 7. Spread to socials (best-effort — failures logged, don't throw).
  try {
    await spreadPostToSocial(
      postId,
      NEWS_PERSONA_ID,
      NEWS_PERSONA_NAME,
      NEWS_PERSONA_EMOJI,
      { url: stitchedBlob.url, type: "video" },
      `🛰️ BREAKING (${label})`,
    );
  } catch (err) {
    console.error(
      "[breaking-news] social spread failed (non-fatal):",
      err instanceof Error ? err.message : err,
    );
  }

  // 8. Mark topic as done so dedup catches it next time.
  try {
    await sql`
      UPDATE daily_topics
      SET breaking_video_url = ${stitchedBlob.url},
          breaking_video_generated_at = NOW()
      WHERE id = ${topic.id}
    `;
  } catch (err) {
    console.error(
      "[breaking-news] daily_topics update failed:",
      err instanceof Error ? err.message : err,
    );
  }

  return { videoUrl: stitchedBlob.url, postId };
}

// ─── Public entry point (called by /api/generate-topics) ────────────

/**
 * For each given topic ID that doesn't yet have a breaking_video_url,
 * generate a stitched breaking news video — capped at the daily limit.
 *
 * Failures are isolated per topic: one xAI hiccup doesn't kill others.
 * The daily counter is incremented only on successful posts.
 *
 * Returns one result per topic processed (or skipped).
 */
export async function processNewTopicsForBreakingNews(
  topicIds: string[],
): Promise<BreakingNewsResult[]> {
  if (topicIds.length === 0) return [];

  await ensureBreakingNewsColumns();

  // Toggle check first — bail entirely if disabled.
  if (!(await isBreakingNewsEnabled())) {
    return topicIds.map((id) => ({ topic_id: id, status: "disabled" as const }));
  }

  // Daily cap check.
  const { remaining } = await getDailyCounter();
  if (remaining <= 0) {
    return topicIds.map((id) => ({ topic_id: id, status: "cap_hit" as const }));
  }

  // Fetch fresh topic rows + filter to those without breaking_video_url.
  const sql = getDb();
  let candidates: BreakingNewsTopic[] = [];
  try {
    const rows = (await sql`
      SELECT id, headline, summary, category, mood
      FROM daily_topics
      WHERE id = ANY(${topicIds}::text[])
        AND breaking_video_url IS NULL
    `) as BreakingNewsTopic[];
    candidates = rows;
  } catch (err) {
    console.error(
      "[breaking-news] candidate fetch failed:",
      err instanceof Error ? err.message : err,
    );
    return topicIds.map((id) => ({
      topic_id: id,
      status: "failed" as const,
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  // Process sequentially, up to the daily cap. Parallelism is INSIDE
  // each topic (presenter + field in parallel) — across topics we
  // serialize so we don't burst xAI rate limits.
  const results: BreakingNewsResult[] = [];
  const alreadyHave = new Set(candidates.map((c) => c.id));
  for (const id of topicIds) {
    if (!alreadyHave.has(id)) {
      results.push({ topic_id: id, status: "skipped" });
    }
  }

  let made = 0;
  for (const topic of candidates) {
    if (made >= remaining) {
      results.push({ topic_id: topic.id, status: "cap_hit" });
      continue;
    }
    try {
      const out = await generateOneStitchedBreakingNews(topic);
      await incrementDailyCount();
      made++;
      results.push({
        topic_id: topic.id,
        status: "posted",
        video_url: out.videoUrl,
        post_id: out.postId,
      });
    } catch (err) {
      console.error(
        `[breaking-news] generation failed for topic ${topic.id}:`,
        err instanceof Error ? err.message : err,
      );
      results.push({
        topic_id: topic.id,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

// ─── Admin manual trigger (force-runs against existing topics) ──────

/**
 * Pick up to N active topics that don't yet have a breaking_video_url
 * and run the breaking-news pipeline on them. Used by the admin
 * "Force Trigger" button to verify the pipeline end-to-end without
 * waiting for natural topic expiry.
 *
 * Respects the daily cap + enabled toggle just like the chained path.
 */
export async function forceTriggerBreakingNews(
  maxTopics = 1,
): Promise<BreakingNewsResult[]> {
  await ensureBreakingNewsColumns();
  const sql = getDb();
  let rows: Array<{ id: string }> = [];
  try {
    rows = (await sql`
      SELECT id FROM daily_topics
      WHERE breaking_video_url IS NULL
        AND is_active = TRUE
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY created_at DESC
      LIMIT ${maxTopics}
    `) as Array<{ id: string }>;
  } catch (err) {
    console.error(
      "[breaking-news] forceTrigger candidate fetch failed:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
  if (rows.length === 0) return [];
  return processNewTopicsForBreakingNews(rows.map((r) => r.id));
}
