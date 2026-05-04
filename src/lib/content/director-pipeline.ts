/**
 * Director Movie Pipeline
 *
 * Chunk D of director-movies-lib port (lines 1160-1194, 1195-1375, 1376-1572, 1611-1626).
 * Contains the complete video generation, stitching, and social media posting pipeline
 * for director-driven multi-clip movies.
 *
 * Depends on:
 * - director-constants (DIRECTORS, CHANNEL_TITLE_PREFIX)
 * - director-utils (MovieBible, DirectorScreenplay, buildContinuityPrompt)
 * - @/lib/ai/xai-extras (submitVideoJob)
 * - @/lib/media/mp4-concat (concatMP4Clips)
 * - @/lib/marketing/spread-post (spreadPostToSocial)
 * - @/lib/genres (getGenreBlobFolder, capitalizeGenre)
 * - @/lib/ad-campaigns (getActiveCampaigns, rollForPlacements, logImpressions)
 */

import { randomUUID } from "node:crypto";
import { put } from "@vercel/blob";
import { getDb } from "@/lib/db";
import { submitVideoJob } from "@/lib/ai/xai-extras";
import { concatMP4Clips } from "@/lib/media/mp4-concat";
import { spreadPostToSocial } from "@/lib/marketing/spread-post";
import { GENRE_TEMPLATES } from "@/lib/media/multi-clip";
import { DIRECTORS, CHANNEL_TITLE_PREFIX } from "./director-constants";
import { buildContinuityPrompt, type MovieBible, type DirectorScreenplay } from "./director-utils";
import { getGenreBlobFolder, capitalizeGenre } from "@/lib/genres";
import { getActiveCampaigns, rollForPlacements, logImpressions } from "@/lib/ad-campaigns";
import { CHANNEL_DEFAULTS } from "@/lib/repositories/channels";

/**
 * Build a MovieBible from a screenplay + director profile.
 * The bible is the continuity context shared across all clips.
 */
function buildMovieBible(
  screenplay: DirectorScreenplay,
  director: typeof DIRECTORS[string],
): MovieBible {
  return {
    title: screenplay.title,
    synopsis: screenplay.synopsis,
    genre: screenplay.genre,
    characterBible: screenplay.characterBible,
    directorStyleGuide: [
      `Director: ${director.displayName}`,
      `Style: ${director.style}`,
      `Signature Shot: ${director.signatureShot}`,
      `Color Palette: ${director.colorPalette}`,
      `Camera Work: ${director.cameraWork}`,
    ].join("\n"),
    scenes: screenplay.scenes.map(s => ({
      sceneNumber: s.sceneNumber,
      title: s.title,
      description: s.description,
      videoPrompt: s.videoPrompt,
      lastFrameDescription: s.lastFrameDescription,
    })),
  };
}

/**
 * Submit all scenes as Grok video jobs and create the multi-clip tracking records.
 * Returns the multi-clip job ID.
 *
 * Each scene's prompt now includes the full MovieBible (synopsis, character bible,
 * director style guide) plus previous-clip continuity context.
 * If Grok's image_url parameter is supported and a previous clip URL is available,
 * it will be used as a first-frame reference for visual continuity.
 */
export async function submitDirectorFilm(
  screenplay: DirectorScreenplay,
  directorPersonaId: string,
  source: "cron" | "admin" = "cron",
  options?: { channelId?: string; folder?: string },
): Promise<string | null> {
  const sql = getDb();
  const template = GENRE_TEMPLATES[screenplay.genre] || GENRE_TEMPLATES.drama;
  const director = DIRECTORS[screenplay.directorUsername];

  const movieBible = director
    ? buildMovieBible(screenplay, director)
    : {
        title: screenplay.title,
        synopsis: screenplay.synopsis,
        genre: screenplay.genre,
        characterBible: screenplay.characterBible,
        directorStyleGuide: `Director: ${screenplay.directorUsername}`,
        scenes: screenplay.scenes.map(s => ({
          sceneNumber: s.sceneNumber,
          title: s.title,
          description: s.description,
          videoPrompt: s.videoPrompt,
          lastFrameDescription: s.lastFrameDescription,
        })),
      };

  const jobId = randomUUID();
  const isChannelPost = !!options?.channelId;
  const isDatingPost = options?.channelId === "ch-ai-dating";
  let channelShowDirectorCaption: boolean = CHANNEL_DEFAULTS.showDirector;
  if (isChannelPost) {
    try {
      const chRow = await sql`SELECT show_director FROM channels WHERE id = ${options!.channelId}` as unknown as { show_director: boolean }[];
      if (chRow.length > 0) channelShowDirectorCaption = chRow[0].show_director === true;
    } catch { /* use default */ }
  }

  const channelPrefix = isChannelPost && options?.channelId
    ? CHANNEL_TITLE_PREFIX[options.channelId] || ""
    : "";

  const dateStr = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const isGNN = options?.channelId === "ch-gnn";
  const isStudiosCaption = options?.channelId === "ch-aiglitch-studios" || !isChannelPost;
  const caption = isStudiosCaption
    ? (channelShowDirectorCaption
      ? `🎬 AIG!itch Studios - ${screenplay.title} /${capitalize(screenplay.genre)} — ${screenplay.tagline}\n\n${screenplay.synopsis}\n\nDirected by ${DIRECTORS[screenplay.directorUsername]?.displayName || screenplay.directorUsername}\nStarring: ${screenplay.castList.join(", ")}\n\nAn AIG!itch Studios Production\n#AIGlitchPremieres #AIGlitch${capitalize(screenplay.genre)} #AIGlitchStudios`
      : `🎬 AIG!itch Studios - ${screenplay.title} /${capitalize(screenplay.genre)} — ${screenplay.tagline}\n\n${screenplay.synopsis}\n\nStarring: ${screenplay.castList.join(", ")}\n\nAn AIG!itch Studios Production\n#AIGlitchPremieres #AIGlitch${capitalize(screenplay.genre)} #AIGlitchStudios`)
    : isGNN
      ? `🎬 ${channelPrefix} - ${dateStr} - ${screenplay.title}\n\n${screenplay.synopsis}`
      : `🎬 ${channelPrefix} - ${screenplay.title}\n\n${screenplay.synopsis}`;

  try {
    await sql`SELECT 1 FROM multi_clip_jobs LIMIT 0`;
  } catch {
    await sql`
      CREATE TABLE IF NOT EXISTS multi_clip_jobs (
        id TEXT PRIMARY KEY, screenplay_id TEXT NOT NULL, title TEXT NOT NULL,
        tagline TEXT, synopsis TEXT, genre TEXT NOT NULL,
        clip_count INTEGER NOT NULL, completed_clips INTEGER DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'generating', persona_id TEXT NOT NULL,
        caption TEXT, final_video_url TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS multi_clip_scenes (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL, scene_number INTEGER NOT NULL,
        title TEXT, video_prompt TEXT NOT NULL, xai_request_id TEXT,
        video_url TEXT, status TEXT NOT NULL DEFAULT 'pending',
        fail_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ
      )
    `;
  }

  try { await sql`ALTER TABLE multi_clip_jobs ADD COLUMN IF NOT EXISTS placed_campaign_ids JSONB DEFAULT '[]'`; } catch { /* already exists */ }

  const placedIds = screenplay._adCampaigns?.map((c: unknown) => (c as { id: string }).id) || [];

  await sql`
    INSERT INTO multi_clip_jobs (id, screenplay_id, title, tagline, synopsis, genre, clip_count, persona_id, caption, channel_id, blob_folder, placed_campaign_ids)
    VALUES (${jobId}, ${screenplay.id}, ${screenplay.title}, ${screenplay.tagline}, ${screenplay.synopsis}, ${screenplay.genre}, ${screenplay.scenes.length}, ${directorPersonaId}, ${caption}, ${options?.channelId || null}, ${options?.folder || null}, ${JSON.stringify(placedIds)}::jsonb)
  `;

  const directorMovieId = randomUUID();
  await sql`
    INSERT INTO director_movies (id, director_id, director_username, title, genre, clip_count, multi_clip_job_id, status, source)
    VALUES (${directorMovieId}, ${directorPersonaId}, ${screenplay.directorUsername}, ${screenplay.title}, ${screenplay.genre}, ${screenplay.scenes.length}, ${jobId}, ${"generating"}, ${source})
  `;

  for (let i = 0; i < screenplay.scenes.length; i++) {
    const scene = screenplay.scenes[i];
    const sceneId = randomUUID();

    const previousScene = i > 0 ? screenplay.scenes[i - 1] : null;
    const enrichedPrompt = buildContinuityPrompt(
      movieBible,
      scene.sceneNumber,
      screenplay.scenes.length,
      scene.videoPrompt,
      previousScene ? previousScene.description : null,
      previousScene ? previousScene.lastFrameDescription : null,
      template,
      options?.channelId,
    );

    try {
      const result = await submitVideoJob(enrichedPrompt, scene.duration, "16:9");

      if (result.fellBack) {
        console.warn(`[director-movies] Scene ${scene.sceneNumber} used fallback provider: ${result.provider}`);
      }

      if (result.requestId) {
        await sql`
          INSERT INTO multi_clip_scenes (id, job_id, scene_number, title, video_prompt, xai_request_id, status)
          VALUES (${sceneId}, ${jobId}, ${scene.sceneNumber}, ${scene.title}, ${enrichedPrompt}, ${result.requestId}, ${"submitted"})
        `;
        console.log(`[director-movies] Scene ${scene.sceneNumber}/${screenplay.scenes.length} submitted: ${result.requestId} (${result.provider})`);
      } else if (result.videoUrl) {
        const blobUrl = await persistDirectorClip(result.videoUrl, jobId, scene.sceneNumber);
        await sql`
          INSERT INTO multi_clip_scenes (id, job_id, scene_number, title, video_prompt, video_url, status, completed_at)
          VALUES (${sceneId}, ${jobId}, ${scene.sceneNumber}, ${scene.title}, ${enrichedPrompt}, ${blobUrl}, ${"done"}, NOW())
        `;
        await sql`UPDATE multi_clip_jobs SET completed_clips = completed_clips + 1 WHERE id = ${jobId}`;
        console.log(`[director-movies] Scene ${scene.sceneNumber}/${screenplay.scenes.length} done immediately (${result.provider})`);
      } else {
        const errorDetail = result.error || "submit_rejected";
        console.error(`[director-movies] Scene ${scene.sceneNumber} submit failed: ${errorDetail}`);
        await sql`
          INSERT INTO multi_clip_scenes (id, job_id, scene_number, title, video_prompt, status, fail_reason)
          VALUES (${sceneId}, ${jobId}, ${scene.sceneNumber}, ${scene.title}, ${enrichedPrompt}, ${"failed"}, ${errorDetail.slice(0, 500)})
        `;
      }
    } catch (err) {
      console.error(`[director-movies] Scene ${scene.sceneNumber} error:`, err);
      const errMsg = err instanceof Error ? err.message : String(err);
      await sql`
        INSERT INTO multi_clip_scenes (id, job_id, scene_number, title, video_prompt, status, fail_reason)
        VALUES (${sceneId}, ${jobId}, ${scene.sceneNumber}, ${scene.title}, ${scene.videoPrompt}, ${"failed"}, ${`error: ${errMsg.slice(0, 200)}`})
      `;
    }
  }

  return jobId;
}

/**
 * Stitch completed clips into a single video and create ONE premiere post.
 *
 * The single post serves all contexts:
 *   - For You / trending feed (post_type='premiere', is_reply_to IS NULL)
 *   - Premieres tab / genre folder (genre hashtag filtering)
 *   - Director profile page (persona_id matches director)
 *
 * Individual 10-sec clips are marked as 'stitched' (internal/consumed) after
 * the full-length MP4 is saved. Only the final stitched video is the premiere.
 *
 * Uses binary concatenation for same-codec Grok clips.
 * Falls back to posting first clip if stitching fails.
 */
export async function stitchAndTriplePost(
  jobId: string,
): Promise<{ feedPostId: string; premierePostId: string; profilePostId: string; spreading: string[] } | null> {
  const sql = getDb();

  const jobs = await sql`
    SELECT j.*, dm.director_id, dm.director_username, dm.id as director_movie_id
    FROM multi_clip_jobs j
    LEFT JOIN director_movies dm ON dm.multi_clip_job_id = j.id
    WHERE j.id = ${jobId}
  ` as unknown as {
    id: string; title: string; genre: string; persona_id: string; caption: string;
    clip_count: number; status: string; final_video_url: string | null;
    channel_id: string | null; blob_folder: string | null;
    director_id: string; director_username: string; director_movie_id: string;
  }[];

  if (jobs.length === 0) return null;
  const job = jobs[0];

  if (job.status === "done" && job.final_video_url) {
    console.log(`[stitchAndTriplePost] Job ${jobId} already done — skipping duplicate stitch for "${job.title}"`);
    const existingPost = await sql`SELECT id FROM posts WHERE media_source = 'director-movie' AND media_url = ${job.final_video_url} LIMIT 1`;
    const postId = existingPost.length > 0 ? existingPost[0].id as string : jobId;
    return { feedPostId: postId, premierePostId: postId, profilePostId: postId, spreading: [] };
  }

  const scenes = await sql`
    SELECT video_url, scene_number FROM multi_clip_scenes
    WHERE job_id = ${jobId} AND status = 'done' AND video_url IS NOT NULL
    ORDER BY scene_number ASC
  ` as unknown as { video_url: string; scene_number: number }[];

  if (scenes.length === 0) return null;

  const clipBuffers: Buffer[] = [];
  for (const scene of scenes) {
    try {
      const res = await fetch(scene.video_url);
      if (res.ok) clipBuffers.push(Buffer.from(await res.arrayBuffer()));
    } catch (err) {
      console.error(`[director-movies] Failed to download scene ${scene.scene_number}:`, err);
    }
  }

  if (clipBuffers.length === 0) return null;

  let stitched: Buffer;
  let stitchFailed = false;
  try {
    stitched = concatMP4Clips(clipBuffers);
    console.log(`[director-movies] Stitching SUCCESS: ${clipBuffers.length} clips → ${(stitched.length / 1024 / 1024).toFixed(1)}MB`);
  } catch (err) {
    console.error(`[director-movies] ⚠️ MP4 CONCATENATION FAILED — falling back to FIRST CLIP ONLY (10s):`, err instanceof Error ? err.message : err);
    stitched = clipBuffers[0];
    stitchFailed = true;
  }

  const blobFolder = job.blob_folder || getGenreBlobFolder(job.genre);
  const blob = await put(`${blobFolder}/${randomUUID()}.mp4`, stitched, {
    access: "public",
    contentType: "video/mp4",
    addRandomSuffix: false,
  });
  const finalVideoUrl = blob.url;
  const totalDuration = scenes.length * 10;
  console.log(`[director-movies] Stitched ${clipBuffers.length} clips into ${(stitched.length / 1024 / 1024).toFixed(1)}MB video (${totalDuration}s) -> ${blobFolder}`);

  const postId = randomUUID();
  const aiLikeCount = Math.floor(Math.random() * 500) + 200;
  const effectiveChannelId = job.channel_id || "ch-aiglitch-studios";
  const isChannelJob = effectiveChannelId !== "ch-aiglitch-studios";
  const hashtags = job.channel_id === "ch-ai-dating"
    ? "AIGlitchDating,LonelyHeartsClub,AIGlitch"
    : isChannelJob
      ? `AIGlitch${capitalize(job.genre)},AIGlitch`
      : `AIGlitchPremieres,AIGlitch${capitalize(job.genre)},AIGlitchStudios`;
  const postType = isChannelJob ? "video" : "premiere";

  const ARCHITECT_ID = "glitch-000";
  const postPersonaId = isChannelJob ? ARCHITECT_ID : job.persona_id;

  const existingPost = await sql`
    SELECT id FROM posts
    WHERE media_source = 'director-movie'
      AND channel_id = ${effectiveChannelId}
      AND created_at > NOW() - INTERVAL '15 minutes'
      AND content LIKE ${job.title ? `%${job.title.slice(0, 30)}%` : '%'}
    LIMIT 1
  `;
  if (existingPost.length > 0) {
    console.log(`[stitchAndTriplePost] Duplicate detected — post ${existingPost[0].id} already exists for "${job.title}" on ${effectiveChannelId}`);
    return { feedPostId: existingPost[0].id as string, premierePostId: existingPost[0].id as string, profilePostId: existingPost[0].id as string, spreading: [] };
  }

  await sql`
    INSERT INTO posts (id, persona_id, content, post_type, hashtags, ai_like_count, media_url, media_type, media_source, video_duration, channel_id, created_at)
    VALUES (${postId}, ${postPersonaId}, ${job.caption}, ${postType}, ${hashtags}, ${aiLikeCount}, ${finalVideoUrl}, ${"video"}, ${"director-movie"}, ${totalDuration}, ${effectiveChannelId}, NOW())
  `;
  await sql`UPDATE channels SET post_count = post_count + 1, updated_at = NOW() WHERE id = ${effectiveChannelId}`;
  await sql`UPDATE ai_personas SET post_count = post_count + 1 WHERE id = ${postPersonaId}`;

  try {
    const [jobMeta] = await sql`SELECT placed_campaign_ids FROM multi_clip_jobs WHERE id = ${jobId}`;
    const storedIds = jobMeta?.placed_campaign_ids as string[] | null;

    if (storedIds && storedIds.length > 0) {
      const activeCampaigns = await getActiveCampaigns(job.channel_id);
      const placedCampaigns = activeCampaigns.filter(c => storedIds.includes(c.id));
      if (placedCampaigns.length > 0) {
        await logImpressions(placedCampaigns, postId, "video", job.channel_id, postPersonaId);
        console.log(`[ad-placement] Logged ${placedCampaigns.length} impressions for "${job.title}" (from stored IDs)`);
      }
    } else {
      const activeCampaigns = await getActiveCampaigns(job.channel_id);
      if (activeCampaigns.length > 0) {
        const placedCampaigns = rollForPlacements(activeCampaigns);
        if (placedCampaigns.length > 0) {
          await logImpressions(placedCampaigns, postId, "video", job.channel_id, postPersonaId);
          console.log(`[ad-placement] Logged ${placedCampaigns.length} impressions for "${job.title}" (fallback roll)`);
        }
      }
    }
  } catch { /* non-fatal */ }

  await sql`
    UPDATE multi_clip_scenes SET status = 'stitched'
    WHERE job_id = ${jobId} AND status = 'done'
  `;

  await sql`UPDATE multi_clip_jobs SET status = 'done', final_video_url = ${finalVideoUrl}, completed_at = NOW() WHERE id = ${jobId}`;

  if (job.director_movie_id) {
    await sql`
      UPDATE director_movies
      SET status = 'completed', post_id = ${postId}, premiere_post_id = ${postId}, profile_post_id = ${postId}
      WHERE id = ${job.director_movie_id}
    `;
  }

  console.log(`[director-movies] "${job.title}" posted as single premiere: ${postId} (${totalDuration}s, ${job.genre})`);

  const directorProfile = DIRECTORS[job.director_username];
  let spreadPersonaName = isChannelJob
    ? "The Architect"
    : (directorProfile?.displayName || job.director_username);
  let telegramLabel = isChannelJob ? "CHANNEL POST" : "MOVIE POSTED";
  let spreadEmoji = isChannelJob ? "💕" : "🎬";
  if (job.channel_id) {
    try {
      const ch = await sql`SELECT name, emoji FROM channels WHERE id = ${job.channel_id}` as unknown as { name: string; emoji: string }[];
      if (ch.length > 0) {
        telegramLabel = `${ch[0].emoji} ${ch[0].name}`;
        spreadEmoji = ch[0].emoji;
      } else {
        telegramLabel = "CHANNEL POST";
      }
    } catch {
      telegramLabel = "CHANNEL POST";
    }
  }
  const spread = await spreadPostToSocial(postId, postPersonaId, spreadPersonaName, spreadEmoji, { url: finalVideoUrl, type: "video" }, telegramLabel);
  if (spread.platforms.length > 0) {
    console.log(`[director-movies] "${job.title}" spread to: ${spread.platforms.join(", ")}`);
  }

  return { feedPostId: postId, premierePostId: postId, profilePostId: postId, spreading: spread.platforms };
}

function capitalize(s: string): string {
  return capitalizeGenre(s);
}

/**
 * Persist a fallback-provider video clip to blob storage (used when Kie.ai returns a direct URL).
 */
async function persistDirectorClip(tempUrl: string, jobId: string, sceneNumber: number): Promise<string> {
  const res = await fetch(tempUrl);
  if (!res.ok) throw new Error(`Failed to download clip: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const blob = await put(`multi-clip/${jobId}/scene-${sceneNumber}.mp4`, buffer, {
    access: "public",
    contentType: "video/mp4",
    addRandomSuffix: false,
  });
  return blob.url;
}
