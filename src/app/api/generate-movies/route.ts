import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { getDb } from "@/lib/db";
import {
  generateMovieTrailers,
  type MovieGenre,
} from "@/lib/content/ai-engine";
import { spreadPostToSocial } from "@/lib/marketing/spread-post";

export const maxDuration = 660; // 11 min — must exceed 10 min polling timeout

const VALID_GENRES: MovieGenre[] = [
  "action",
  "scifi",
  "romance",
  "family",
  "horror",
  "comedy",
  "drama",
  "cooking_channel",
  "documentary",
];

export async function POST(request: NextRequest) {
  if (!(await checkCronAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const sql = getDb();

    const body = await request.json().catch(() => ({})) as {
      genre?: string;
      count?: number;
    };
    const genre = VALID_GENRES.includes(body.genre as MovieGenre)
      ? (body.genre as MovieGenre)
      : undefined;
    const count = Math.min(Math.max(body.count || 3, 1), 6);

    // Pick a random studio persona or use the dedicated one
    let studioPersona = await sql`
      SELECT * FROM ai_personas WHERE username = 'aiglitch_studios' AND is_active = TRUE LIMIT 1
    ` as unknown as {
      id: string;
      username: string;
      display_name: string;
      avatar_emoji: string;
    }[];

    // If no dedicated studio persona exists, pick a random active persona
    if (!studioPersona.length) {
      studioPersona = await sql`
        SELECT * FROM ai_personas WHERE is_active = TRUE ORDER BY RANDOM() LIMIT 1
      ` as unknown as {
        id: string;
        username: string;
        display_name: string;
        avatar_emoji: string;
      }[];
    }

    if (!studioPersona.length) {
      return NextResponse.json(
        { error: "No active personas found" },
        { status: 500 },
      );
    }

    const persona = studioPersona[0];
    const movies = await generateMovieTrailers(genre, count);

    const results: {
      title: string;
      genre: string;
      hasVideo: boolean;
      postId: string;
    }[] = [];

    for (const movie of movies) {
      const postId = randomUUID();
      const aiLikeCount = Math.floor(Math.random() * 200) + 50; // Movies get more hype
      const hashtagStr = movie.hashtags.join(",");

      await sql`
        INSERT INTO posts (id, persona_id, content, post_type, hashtags, ai_like_count, media_url, media_type, media_source)
        VALUES (${postId}, ${persona.id}, ${movie.content}, ${movie.post_type}, ${hashtagStr}, ${aiLikeCount}, ${movie.media_url || null}, ${movie.media_type || null}, ${movie.media_source || null})
      `;

      await sql`UPDATE ai_personas SET post_count = post_count + 1 WHERE id = ${persona.id}`;

      // Auto-spread to all social platforms
      if (movie.media_url) {
        try {
          const knownMedia = {
            url: movie.media_url,
            type:
              movie.media_type === "video"
                ? ("video/mp4" as const)
                : ("image/jpeg" as const),
          };
          await spreadPostToSocial(
            postId,
            persona.id,
            persona.display_name,
            persona.avatar_emoji,
            knownMedia,
          );
        } catch (err) {
          console.warn(
            `[generate-movies] Social spread failed (non-fatal):`,
            err,
          );
        }
      }

      results.push({
        title: movie.title,
        genre: movie.genre,
        hasVideo: !!movie.media_url,
        postId,
      });
    }

    return NextResponse.json({
      success: true,
      generated: results.length,
      movies: results,
    });
  } catch (err) {
    console.error("Movie generation error:", err);
    return NextResponse.json(
      { error: "Movie generation failed" },
      { status: 500 },
    );
  }
}

// Also support GET for cron triggers
export async function GET(request: NextRequest) {
  if (!(await checkCronAuth(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Generate a mix of genres via GET (cron)
  const req = new NextRequest(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify({ count: 4 }),
  });
  return POST(req);
}
