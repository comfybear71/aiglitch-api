import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { ensureDbReady } from "@/lib/seed";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { env } from "@/lib/bible/env";
import {
  pickGenre,
  pickDirector,
  getMovieConcept,
  generateDirectorScreenplay,
  submitDirectorFilm,
  DIRECTORS,
} from "@/lib/content/director-movies";
import { cronHandler } from "@/lib/cron-handler";

export const maxDuration = 600;

interface GenerateRequest {
  genreOverride?: string;
  conceptOverride?: string;
  forceGenerate?: boolean;
}

interface GenerateResponse {
  success: boolean;
  action: "commissioned" | "in_progress" | "daily_limit" | "error";
  director?: string;
  directorName?: string;
  genre?: string;
  title?: string;
  tagline?: string;
  clipCount?: number;
  totalDuration?: number;
  cast?: string[];
  jobId?: string;
  concept?: string | null;
  message?: string;
  error?: string;
}

async function executeGeneration(request: NextRequest): Promise<GenerateResponse> {
  const isAdmin = await isAdminAuthenticated(request);

  let body: GenerateRequest = {};
  try {
    body = await request.json();
  } catch {
    // Empty body is fine
  }

  if (!env.XAI_API_KEY) {
    return {
      success: false,
      action: "error",
      error: "XAI_API_KEY required for video generation",
    };
  }

  const sql = getDb();
  await ensureDbReady();

  // ── Check if we already have a film in progress ──
  try {
    const inProgress = await sql`
      SELECT dm.title, dm.genre, dm.director_username
      FROM director_movies dm
      WHERE dm.status IN ('pending', 'generating')
        AND dm.created_at > NOW() - INTERVAL '2 hours'
      LIMIT 1
    ` as unknown as { title: string; genre: string; director_username: string }[];

    if (inProgress.length > 0 && !body.forceGenerate) {
      return {
        success: true,
        action: "in_progress",
        message: `"${inProgress[0].title}" (${inProgress[0].genre}) by @${inProgress[0].director_username} is still generating.`,
      };
    }
  } catch (err) {
    console.log("[director-movie] In-progress check error:", err);
  }

  // ── Check daily limit (one per day, unless admin forces) ──
  try {
    const todayCount = await sql`
      SELECT COUNT(*)::int as count FROM director_movies
      WHERE created_at > NOW() - INTERVAL '24 hours' AND source = 'cron'
    ` as unknown as { count: number }[];

    if (todayCount[0]?.count >= 1 && !isAdmin && !body.forceGenerate) {
      return {
        success: true,
        action: "daily_limit",
        message: "One blockbuster per day. Today's film has already been commissioned.",
      };
    }
  } catch (err) {
    console.log("[director-movie] Daily limit check error:", err);
  }

  // ── Commission new blockbuster ──
  const genre = body.genreOverride || (await pickGenre());
  const director = await pickDirector(genre);

  if (!director) {
    return {
      success: false,
      action: "error",
      error: `No available director for genre: ${genre}`,
    };
  }

  const directorProfile = DIRECTORS[director.username];
  if (!directorProfile) {
    return {
      success: false,
      action: "error",
      error: `Director profile not found: ${director.username}`,
    };
  }

  // Check for admin-created concepts
  const concept = body.conceptOverride
    ? { title: body.conceptOverride, concept: body.conceptOverride }
    : await getMovieConcept(genre);

  console.log(
    `[director-movie-gen] Commissioning: @${director.username} directing ${genre}${
      concept ? ` (concept: "${concept.title}")` : ""
    }`
  );

  // Generate screenplay
  const screenplay = await generateDirectorScreenplay(genre, directorProfile, concept?.concept);
  if (!screenplay || typeof screenplay === "string") {
    return {
      success: false,
      action: "error",
      error: "Screenplay generation failed",
    };
  }

  console.log(
    `[director-movie-gen] Screenplay: "${screenplay.title}" — ${screenplay.scenes.length} scenes, ${screenplay.totalDuration}s`
  );

  // Submit all scenes as Grok video jobs
  const jobId = await submitDirectorFilm(screenplay, director.id);
  if (!jobId) {
    return {
      success: false,
      action: "error",
      error: "Failed to submit video jobs",
    };
  }

  return {
    success: true,
    action: "commissioned",
    director: director.username,
    directorName: directorProfile.displayName,
    genre,
    title: screenplay.title,
    tagline: screenplay.tagline,
    clipCount: screenplay.scenes.length,
    totalDuration: screenplay.totalDuration,
    cast: screenplay.castList,
    jobId,
    concept: concept?.title || null,
  };
}

export async function POST(request: NextRequest): Promise<NextResponse<GenerateResponse>> {
  try {
    const result = await cronHandler("director-movie-generate", async () => {
      return await executeGeneration(request);
    });

    // cronHandler adds _cron_run_id; remove it for API response
    const { _cron_run_id, ...response } = result;

    return NextResponse.json(response);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("[director-movie-gen] Fatal error:", err);
    return NextResponse.json(
      { success: false, action: "error", error: errorMsg } as GenerateResponse,
      { status: 500 }
    );
  }
}
