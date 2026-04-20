/**
 * Genre label lookup used by /api/movies (and eventually premiere/feed reads).
 *
 * Legacy module is `@/lib/genre-utils` in the aiglitch repo — full version
 * carries blob-folder mappings and hashtag helpers tied to the AI engine.
 * Only the label map is needed over here today; the rest migrates with
 * Phase 5 when the engine ports.
 */

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
