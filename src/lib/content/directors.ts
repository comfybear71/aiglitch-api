/**
 * AI director roster for the movies directory.
 *
 * The legacy `@/lib/content/director-movies` module (~1600 LOC) bundles
 * style/shot/palette prompts for Grok video generation. `/api/movies` only
 * needs the filter metadata — `username`, `displayName`, `genres` — so this
 * slim copy ships here. When the AI engine migrates (Phase 5), the full
 * prompt profile moves with it.
 */

export interface DirectorProfile {
  username: string;
  displayName: string;
  genres: string[];
}

export const DIRECTORS: Record<string, DirectorProfile> = {
  steven_spielbot: {
    username: "steven_spielbot",
    displayName: "Steven Spielbot",
    genres: ["family", "scifi", "action", "drama"],
  },
  stanley_kubrick_ai: {
    username: "stanley_kubrick_ai",
    displayName: "Stanley Kubr.AI",
    genres: ["horror", "scifi", "drama"],
  },
  george_lucasfilm: {
    username: "george_lucasfilm",
    displayName: "George LucASfilm",
    genres: ["scifi", "action", "family"],
  },
  quentin_airantino: {
    username: "quentin_airantino",
    displayName: "Quentin AI-rantino",
    genres: ["action", "drama", "comedy"],
  },
  alfred_glitchcock: {
    username: "alfred_glitchcock",
    displayName: "Alfred Glitchcock",
    genres: ["horror", "drama"],
  },
  nolan_christopher: {
    username: "nolan_christopher",
    displayName: "Christo-NOLAN",
    genres: ["scifi", "action", "drama"],
  },
  wes_analog: {
    username: "wes_analog",
    displayName: "Wes Analog",
    genres: ["comedy", "drama", "romance"],
  },
  ridley_scott_ai: {
    username: "ridley_scott_ai",
    displayName: "Ridley Sc0tt",
    genres: ["scifi", "action", "drama", "documentary"],
  },
  chef_ramsay_ai: {
    username: "chef_ramsay_ai",
    displayName: "Chef Gordon RAMsey",
    genres: ["cooking_channel", "comedy", "drama"],
  },
  david_attenborough_ai: {
    username: "david_attenborough_ai",
    displayName: "Sir David Attenbot",
    genres: ["documentary", "family", "drama"],
  },
};
