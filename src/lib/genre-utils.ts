/**
 * Genre utilities for AIG!itch Studios.
 *
 * Single source of truth for genre name → folder name → hashtag mapping
 * across movie generation, blob storage, and display surfaces.
 *
 * Internal genre names use the canonical form (e.g. `cooking_channel`).
 * Blob storage uses a slightly different folder name in some cases
 * (`cooking_show`) — this mapping is preserved verbatim from legacy so
 * existing blob URLs keep resolving.
 */

export const ALL_GENRES = [
  "action",
  "scifi",
  "romance",
  "family",
  "horror",
  "comedy",
  "drama",
  "cooking_channel",
  "documentary",
  "music_video",
] as const;

export type GenreName = (typeof ALL_GENRES)[number];

/** Internal genre name → blob folder name under `premiere/`. */
const GENRE_TO_FOLDER: Record<string, string> = {
  action: "action",
  scifi: "scifi",
  romance: "romance",
  family: "family",
  horror: "horror",
  comedy: "comedy",
  drama: "drama",
  cooking_channel: "cooking_show",
  documentary: "documentary",
  music_video: "music_video",
};

/** Human-readable labels for UI display. */
export const GENRE_LABELS: Record<string, string> = {
  action: "Action",
  scifi: "Sci-Fi",
  romance: "Romance",
  family: "Family",
  horror: "Horror",
  comedy: "Comedy",
  drama: "Drama",
  cooking_channel: "Cooking Show",
  documentary: "Documentary",
  music_video: "Music Video",
};

/**
 * Full blob storage path for a genre — `premiere/<folder>`. Falls back
 * to the genre name as-is for unknown values so the path is always
 * well-formed.
 */
export function getGenreBlobFolder(genre: string): string {
  const folder = GENRE_TO_FOLDER[genre] ?? genre;
  return `premiere/${folder}`;
}

/** Just the folder name (no `premiere/` prefix). */
export function getGenreFolderName(genre: string): string {
  return GENRE_TO_FOLDER[genre] ?? genre;
}

/**
 * Detect a genre from a blob URL or pathname. Tries mapped folder names
 * first (so `cooking_show` → `cooking_channel`), then falls back to a
 * direct match against internal names. Returns null when nothing fits.
 */
export function detectGenreFromPath(pathname: string): GenreName | null {
  const lower = pathname.toLowerCase();

  for (const [genre, folder] of Object.entries(GENRE_TO_FOLDER)) {
    if (
      lower.includes(`/${folder}/`) ||
      lower.includes(`/${folder}-`) ||
      lower.includes(`premiere/${folder}`)
    ) {
      return genre as GenreName;
    }
  }

  for (const genre of ALL_GENRES) {
    if (lower.includes(`/${genre}/`) || lower.includes(`/${genre}-`)) {
      return genre;
    }
  }

  return null;
}

/** Every blob folder path (for scanning / listing operations). */
export function getAllBlobFolders(): string[] {
  return Object.values(GENRE_TO_FOLDER).map((f) => `premiere/${f}`);
}

/**
 * Capitalize a genre name for hashtag use — preserves the underscored
 * form by capitalizing each word.
 *
 *   "cooking_channel" → "CookingChannel"
 *   "music_video"     → "MusicVideo"
 */
export function capitalizeGenre(genre: string): string {
  return genre
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

/** Genre-specific hashtag (e.g. `romance` → `AIGlitchRomance`). */
export function getGenreHashtag(genre: string): string {
  return `AIGlitch${capitalizeGenre(genre)}`;
}
