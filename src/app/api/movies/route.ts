import { type NextRequest, NextResponse } from "next/server";
import {
  listDirectorMovies,
  listPremierePosts,
  type DirectorMovieRow,
  type PremierePostRow,
} from "@/lib/repositories/movies";
import { DIRECTORS } from "@/lib/content/directors";
import { GENRE_LABELS } from "@/lib/genres";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/movies — Movie directory (blockbusters + trailers).
 *
 * Blockbusters come from `director_movies`; trailers are premiere-tagged
 * video posts that aren't already tracked as a blockbuster. Optional
 * `?genre=` / `?director=` filters both sources. Response also returns
 * aggregate `genreCounts`, per-director `directors` (with `movieCount`),
 * and the full `GENRE_LABELS` dictionary so the consumer can render
 * filter UI without a second round-trip.
 */
export async function GET(request: NextRequest) {
  try {
    const genreFilter = request.nextUrl.searchParams.get("genre") ?? undefined;
    const directorFilter =
      request.nextUrl.searchParams.get("director") ?? undefined;

    const [directorMovies, premierePosts] = await Promise.all([
      listDirectorMovies({ genre: genreFilter, director: directorFilter }),
      listPremierePosts({ genre: genreFilter }),
    ]);

    const blockbusters = directorMovies.map(shapeBlockbuster);
    const trailers = shapeTrailers(premierePosts, directorMovies);

    const genreCounts: Record<string, number> = {};
    for (const movie of [...blockbusters, ...trailers]) {
      genreCounts[movie.genre] = (genreCounts[movie.genre] ?? 0) + 1;
    }

    const directorCounts: Record<
      string,
      { count: number; displayName: string }
    > = {};
    for (const movie of blockbusters) {
      const key = movie.directorUsername;
      if (!directorCounts[key]) {
        directorCounts[key] = { count: 0, displayName: movie.director };
      }
      directorCounts[key].count += 1;
    }

    const directors = Object.entries(DIRECTORS).map(([username, profile]) => ({
      username,
      displayName: profile.displayName,
      genres: profile.genres,
      movieCount: directorCounts[username]?.count ?? 0,
    }));

    const res = NextResponse.json({
      blockbusters,
      trailers,
      totalMovies: blockbusters.length + trailers.length,
      genreCounts,
      directors,
      genreLabels: GENRE_LABELS,
    });
    // Non-personalised; URL (incl. query) keys the cache. Moderate TTL —
    // blockbusters trickle in through the day, trailers churn faster.
    res.headers.set(
      "Cache-Control",
      "public, s-maxage=60, stale-while-revalidate=300",
    );
    return res;
  } catch (err) {
    console.error("[movies] error:", err);
    return NextResponse.json(
      {
        error: "Failed to load movies",
        blockbusters: [],
        trailers: [],
      },
      { status: 500 },
    );
  }
}

function shapeBlockbuster(dm: DirectorMovieRow) {
  return {
    id: dm.id,
    title: dm.title,
    genre: dm.genre,
    genreLabel: GENRE_LABELS[dm.genre] ?? dm.genre,
    director: dm.director_display_name,
    directorUsername: dm.director_username,
    clipCount: dm.clip_count,
    status: dm.status,
    type: "blockbuster" as const,
    postId: dm.post_id,
    premierePostId: dm.premiere_post_id,
    createdAt: dm.created_at,
    completedClips: dm.completed_clips,
    totalClips: dm.total_clips,
  };
}

function shapeTrailers(
  premierePosts: PremierePostRow[],
  directorMovies: DirectorMovieRow[],
) {
  const directorPostIds = new Set(
    directorMovies.flatMap((dm) =>
      [dm.post_id, dm.premiere_post_id].filter(
        (id): id is string => id !== null,
      ),
    ),
  );

  return premierePosts
    .filter((p) => !directorPostIds.has(p.id))
    .map((p) => {
      const genre = extractGenre(p.hashtags || "");
      return {
        id: p.id,
        title: extractTitle(p.content),
        genre,
        genreLabel: GENRE_LABELS[genre] ?? genre,
        director: null as string | null,
        directorUsername: null as string | null,
        clipCount: 1,
        status: "completed",
        type: "trailer" as const,
        postId: p.id,
        premierePostId: null as string | null,
        createdAt: p.created_at,
        postedBy: p.display_name,
        postedByUsername: p.username,
      };
    });
}

function extractTitle(content: string): string {
  const emoji = content.match(/🎬\s*(.+?)(?:\s*—|\n|$)/);
  if (emoji) return emoji[1]!.trim();
  const quoted = content.match(/"(.+?)"/);
  if (quoted) return quoted[1]!.trim();
  return content.slice(0, 50).trim();
}

function extractGenre(hashtags: string): string {
  for (const genre of Object.keys(GENRE_LABELS)) {
    const tag = `AIGlitch${genre.charAt(0).toUpperCase() + genre.slice(1)}`;
    if (hashtags.includes(tag)) return genre;
  }
  return "unknown";
}
