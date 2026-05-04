/**
 * Director Movie Utilities
 *
 * Chunk B of director-movies-lib port (lines 255-535 + 1573-1610 of legacy).
 * Contains interfaces and helper functions for director-driven movie generation:
 * continuity prompt building, genre/director selection, actor casting, concept retrieval.
 *
 * Depends on:
 * - director-constants (DIRECTORS, CHANNEL_VISUAL_STYLE)
 * - @/lib/media/multi-clip (GENRE_TEMPLATES)
 * - @/lib/db (getDb)
 */

import { getDb } from "@/lib/db";
import { DIRECTORS, CHANNEL_VISUAL_STYLE } from "./director-constants";
import type { GenreTemplate } from "@/lib/media/multi-clip";
import { GENRE_TEMPLATES } from "@/lib/media/multi-clip";

export interface MovieBible {
  title: string;
  synopsis: string;
  genre: string;
  characterBible: string;     // detailed appearance descriptions for every character
  directorStyleGuide: string; // director's complete visual language
  scenes: {
    sceneNumber: number;
    title: string;
    description: string;      // narrative context (what happens)
    videoPrompt: string;      // visual-only prompt
    lastFrameDescription: string; // description of the final visual moment
  }[];
}

export interface DirectorScreenplay {
  id: string;
  title: string;
  tagline: string;
  synopsis: string;
  genre: string;
  directorUsername: string;
  castList: string[];    // AI persona names cast as actors
  characterBible: string; // detailed character appearance descriptions
  scenes: DirectorScene[];
  totalDuration: number;
  screenplayProvider?: "grok" | "claude"; // which AI wrote the screenplay
  _adCampaigns?: unknown[]; // product placements injected into this screenplay
}

export interface DirectorScene {
  sceneNumber: number;
  type: "intro" | "story" | "credits";
  title: string;
  description: string;
  videoPrompt: string;
  lastFrameDescription: string;
  duration: number;
}

// Genre to director mapping — which directors are best for which genre
const GENRE_DIRECTOR_MAP: Record<string, string[]> = {
  action: ["steven_spielbot", "george_lucasfilm", "quentin_airantino", "nolan_christopher", "ridley_scott_ai"],
  scifi: ["stanley_kubrick_ai", "george_lucasfilm", "nolan_christopher", "ridley_scott_ai", "steven_spielbot"],
  horror: ["alfred_glitchcock", "stanley_kubrick_ai"],
  comedy: ["wes_analog", "quentin_airantino", "chef_ramsay_ai"],
  drama: ["steven_spielbot", "stanley_kubrick_ai", "quentin_airantino", "alfred_glitchcock", "nolan_christopher", "wes_analog", "ridley_scott_ai"],
  romance: ["wes_analog", "steven_spielbot"],
  family: ["steven_spielbot", "george_lucasfilm", "wes_analog", "david_attenborough_ai"],
  documentary: ["david_attenborough_ai", "ridley_scott_ai"],
  cooking_channel: ["chef_ramsay_ai"],
};

/**
 * Build a fully continuity-aware prompt for a single clip in a multi-clip movie.
 *
 * Every clip receives the full movie bible so Grok maintains visual consistency:
 * characters look identical, locations match, lighting/color stays consistent,
 * and the narrative flows from the exact moment the previous clip ended.
 */
export function buildContinuityPrompt(
  movieBible: MovieBible,
  clipNumber: number,
  totalClips: number,
  sceneVideoPrompt: string,
  previousClipSummary: string | null,
  previousLastFrame: string | null,
  genreTemplate: GenreTemplate,
  channelId?: string,
): string {
  const sections: string[] = [];
  const isChannelClip = !!channelId;
  const isDatingClip = channelId === "ch-ai-dating";
  const channelStyle = channelId ? CHANNEL_VISUAL_STYLE[channelId] : undefined;

  if (isChannelClip) {
    const charBible = movieBible.characterBible.slice(0, 600);

    sections.push(
      `"${movieBible.title}" — Clip ${clipNumber}/${totalClips}`,
      `\nCHARACTERS: ${charBible}`,
    );

    if (clipNumber > 1 && previousLastFrame) {
      sections.push(`\nCONTINUE FROM: ${previousLastFrame.slice(0, 200)}`);
    } else if (clipNumber === 1) {
      sections.push(`\nOPENING CLIP — establishes all visuals for the entire video. Be specific.`);
    }

    sections.push(`\nSCENE: ${sceneVideoPrompt}`);

    if (channelStyle) {
      sections.push(`\n${channelStyle.slice(0, 400)}`);
    }

    sections.push(`\nNo title cards, credits, text overlays, or on-screen text.`);

  } else {
    sections.push(
      `=== MOVIE BIBLE — "${movieBible.title}" (${movieBible.genre.toUpperCase()}) ===`,
      `SYNOPSIS: ${movieBible.synopsis}`,
    );

    sections.push(
      `\nCHARACTER BIBLE (MUST remain visually identical in EVERY clip):`,
      movieBible.characterBible,
    );

    sections.push(
      `\nDIRECTOR STYLE GUIDE:`,
      movieBible.directorStyleGuide,
    );

    sections.push(`\n=== CLIP ${clipNumber} OF ${totalClips} ===`);

    if (clipNumber === 1) {
      sections.push(
        `This is the OPENING CLIP — it establishes EVERYTHING for the entire video.`,
        `Every character, setting, lighting setup, color palette, and art style you show here MUST remain IDENTICAL in all ${totalClips - 1} subsequent clips.`,
        `Be SPECIFIC: if a character has red hair, they have red hair in EVERY clip. If the room has blue walls, EVERY clip has blue walls. If the lighting is golden hour, EVERY clip is golden hour.`,
        `This clip sets the visual "contract" — nothing changes after this.`,
      );
    } else if (previousClipSummary) {
      sections.push(
        `PREVIOUS CLIP (Clip ${clipNumber - 1}):`,
        previousClipSummary,
      );
      if (previousLastFrame) {
        sections.push(
          `LAST FRAME OF PREVIOUS CLIP: ${previousLastFrame}`,
          `START this clip from EXACTLY this visual moment. Continue seamlessly.`,
        );
      }
    }

    sections.push(
      `\nSCENE TO GENERATE:`,
      sceneVideoPrompt,
    );

    sections.push(
      `\nCINEMATIC REQUIREMENTS:`,
      `Style: ${genreTemplate.cinematicStyle}`,
      `Lighting: ${genreTemplate.lightingDesign}`,
      `Technical: ${genreTemplate.technicalValues}`,
    );

    const directorUsername = Object.keys(DIRECTORS).find(u => movieBible.directorStyleGuide.includes(DIRECTORS[u].displayName));
    if (directorUsername && DIRECTORS[directorUsername]?.visualOverride) {
      sections.push(
        `\nDIRECTOR VISUAL MANDATE (MUST be applied to every frame):`,
        DIRECTORS[directorUsername].visualOverride,
      );
    }
  }

  if (isDatingClip) {
    sections.push(
      `\nSTYLE CONTINUITY:`,
      `- Maintain consistent warm lighting, colour grading, and intimate mood across all clips`,
      `- Each clip features a DIFFERENT character — do NOT reuse the same character`,
      `- Characters must match their character bible description EXACTLY`,
      `- AIG!itch branding subtly visible in each scene (coffee cup, sign, necklace, phone screen)`,
      `- NO text, NO titles, NO credits, NO director names — just the character in their setting`,
    );
  } else if (isChannelClip) {
    sections.push(
      `\nCONTINUITY: Same characters, same look, same location, same lighting in every clip. AIG!itch branding visible.`,
    );
  } else {
    sections.push(
      `\nCONTINUITY RULES (CRITICAL — STRICT ENFORCEMENT):`,
      `- Maintain 100% visual continuity with previous clip — this MUST look like ONE continuous video`,
      `- Same characters with IDENTICAL appearance: same face, same hair color/style, same body type, same clothing, same accessories in EVERY clip`,
      `- Same location/setting — do NOT change locations between clips unless the scene description explicitly says to`,
      `- Same lighting setup, same time of day, same weather, same color grading throughout`,
      `- Same art style and production quality — if clip 1 is photorealistic, ALL clips are photorealistic`,
      `- Same camera language — if clip 1 uses handheld, ALL clips use handheld`,
      `- If this is a MUSIC VIDEO: maintain the SAME music genre throughout (if jazz, EVERY clip is jazz — same instruments, same mood, same venue)`,
      `- Continue the exact plot/action from where the previous clip ended — NO jump cuts to unrelated scenes`,
      `- Characters must be recognizable frame-to-frame — a viewer should NEVER wonder "is that the same person?"`,
      `- AIG!itch branding must be visible somewhere in every clip (sign, screen, badge, hologram, logo on clothing)`,
    );
  }

  return sections.join("\n");
}

/**
 * Pick the best director for a genre, avoiding the one who directed last.
 */
export async function pickDirector(genre: string): Promise<{ id: string; username: string; displayName: string } | null> {
  const sql = getDb();

  const eligibleUsernames = GENRE_DIRECTOR_MAP[genre] || Object.keys(DIRECTORS);

  let lastDirector = "";
  try {
    const lastFilm = await sql`
      SELECT director_username FROM director_movies
      ORDER BY created_at DESC LIMIT 1
    ` as unknown as { director_username: string }[];
    if (lastFilm.length > 0) lastDirector = lastFilm[0].director_username;
  } catch {
    // Table might not exist yet
  }

  const candidates = eligibleUsernames.filter(u => u !== lastDirector);
  const pick = candidates.length > 0
    ? candidates[Math.floor(Math.random() * candidates.length)]
    : eligibleUsernames[Math.floor(Math.random() * eligibleUsernames.length)];

  const rows = await sql`
    SELECT id, username, display_name FROM ai_personas
    WHERE username = ${pick} AND is_active = TRUE
    LIMIT 1
  ` as unknown as { id: string; username: string; display_name: string }[];

  if (rows.length === 0) return null;
  return { id: rows[0].id, username: rows[0].username, displayName: rows[0].display_name };
}

/**
 * Pick a genre that wasn't used in the last film.
 */
export async function pickGenre(): Promise<string> {
  const sql = getDb();
  const channelOnlyGenres = new Set(["music_video", "news"]);
  const allGenres = Object.keys(GENRE_TEMPLATES).filter(g => !channelOnlyGenres.has(g));

  let lastGenre = "";
  try {
    const lastFilm = await sql`
      SELECT genre FROM director_movies
      ORDER BY created_at DESC LIMIT 1
    ` as unknown as { genre: string }[];
    if (lastFilm.length > 0) lastGenre = lastFilm[0].genre;
  } catch {
    // Table might not exist yet
  }

  const candidates = allGenres.filter(g => g !== lastGenre);
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/**
 * Cast AI personas as actors in the film.
 * Picks 2-4 random personas (excluding directors) to star.
 * Used by `generateDirectorScreenplay` (chunk C).
 */
export async function castActors(excludeId: string, count: number = 4): Promise<{ id: string; username: string; displayName: string }[]> {
  const sql = getDb();
  const actors = await sql`
    SELECT id, username, display_name FROM ai_personas
    WHERE is_active = TRUE AND persona_type != 'director' AND id != ${excludeId}
    ORDER BY RANDOM() LIMIT ${count}
  ` as unknown as { id: string; username: string; display_name: string }[];

  return actors.map(a => ({ id: a.id, username: a.username, displayName: a.display_name }));
}

/**
 * Check for an admin-created prompt to use, or return null to freestyle.
 */
export async function getMovieConcept(genre: string): Promise<{ id?: string; title: string; concept: string } | null> {
  const sql = getDb();

  try {
    const prompts = await sql`
      SELECT id, title, concept FROM director_movie_prompts
      WHERE is_used = FALSE AND genre = ${genre}
      ORDER BY created_at ASC LIMIT 1
    ` as unknown as { id: string; title: string; concept: string }[];

    if (prompts.length > 0) {
      await sql`UPDATE director_movie_prompts SET is_used = TRUE WHERE id = ${prompts[0].id}`;
      return prompts[0];
    }
  } catch {
    // Table might not exist yet — that's fine, use random concept
  }

  try {
    const anyPrompts = await sql`
      SELECT id, title, concept FROM director_movie_prompts
      WHERE is_used = FALSE AND genre = 'any'
      ORDER BY created_at ASC LIMIT 1
    ` as unknown as { id: string; title: string; concept: string }[];

    if (anyPrompts.length > 0) {
      await sql`UPDATE director_movie_prompts SET is_used = TRUE WHERE id = ${anyPrompts[0].id}`;
      return anyPrompts[0];
    }
  } catch {
    // Fine
  }

  return null;
}
