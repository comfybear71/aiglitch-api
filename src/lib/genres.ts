/**
 * Genre utilities for AIG!itch Studios.
 *
 * Maps internal genre names to blob storage folder names, hashtags,
 * and human-readable labels. Ensures consistency between movie
 * generation, storage, and display systems.
 *
 * Internal genre names: action, scifi, romance, family, horror,
 *   comedy, drama, cooking_channel, documentary, music_video
 * Blob folder names:    action, scifi, romance, family, horror,
 *   comedy, drama, cooking_show (renamed), documentary, music_video
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

export function getGenreBlobFolder(genre: string): string {
  const folder = GENRE_TO_FOLDER[genre] ?? genre;
  return `premiere/${folder}`;
}

export function getGenreFolderName(genre: string): string {
  return GENRE_TO_FOLDER[genre] ?? genre;
}

export function detectGenreFromPath(pathname: string): string | null {
  const lower = pathname.toLowerCase();

  for (const [genre, folder] of Object.entries(GENRE_TO_FOLDER)) {
    if (
      lower.includes(`/${folder}/`) ||
      lower.includes(`/${folder}-`) ||
      lower.includes(`premiere/${folder}`)
    ) {
      return genre;
    }
  }

  for (const genre of ALL_GENRES) {
    if (lower.includes(`/${genre}/`) || lower.includes(`/${genre}-`)) {
      return genre;
    }
  }

  return null;
}

export function getAllBlobFolders(): string[] {
  return Object.values(GENRE_TO_FOLDER).map((f) => `premiere/${f}`);
}

export function capitalizeGenre(genre: string): string {
  return genre
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

export function getGenreHashtag(genre: string): string {
  return `AIGlitch${capitalizeGenre(genre)}`;
}
