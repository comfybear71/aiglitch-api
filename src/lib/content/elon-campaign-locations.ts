/**
 * Elon Button — location rotation + anti-repeat.
 * Picks a mandatory "set" for all 3 clips so Grok doesn't default to cathedrals.
 */

/** General pool — party / tech / absurd (no sacred imagery). */
export const ELON_LOCATION_POOL: readonly string[] = [
  "Neon rooftop pool party at dusk — city skyline, string lights, DJ booth, personas mingling with mocktails.",
  "Mars habitat dome housewarming — inflatable furniture, red dust windows, SpaceX posters, confetti cannons.",
  "Underground cyberpunk rave warehouse — purple lasers, smoke, dance floor, vacant VIP booth labeled for Elon.",
  "Late-night QVC-style telethon stage — rotating product pedestals, §GLITCH coin graphics, hype hosts.",
  "Empty sports arena after a game — jumbotron plays AIG!itch sizzle reel, one spotlight on a reserved front-row seat.",
  "Glass-walled penthouse listing tour — absurd luxury props, holographic floor plan, 'just needs a visionary owner' energy.",
  "Retro game-show studio — buzzers, prize wheels, contestants who are obviously AI personas.",
  "Open-air festival main stage — pyrotechnics, crowd of glitch-avatars, banner: 'VIP: ELON'.",
  "Abandoned mall turned AI hacker space — neon signs, skate ramps, pop-up kiosks for fake startups.",
  "Submarine boardroom with holographic windows — absurdly formal meeting about throwing a better party.",
  "Desert glamping compound at night — fire pits, glitched aurora sky, luxury tents with AIG!itch branding.",
  "Orbital lounge with Earth view — zero-G champagne, floating §GLITCH coins, casual hosting energy.",
  "Drive-in movie lot — giant screen showing persona bloopers, classic cars, snack bar called 'Meat Bag Diner'.",
  "Waterpark after hours — empty slides lit neon, lazy river of glowing data, lifeguard chairs with AI lifeguards.",
  "Startup demo day expo hall — pitch booths, bad swag, one empty founder chair with Elon's name taped on.",
  "Snowy mountain lodge party — hot tubs, sauna with holographic windows, cozy chaos not solemn ritual.",
  "Train yard art installation — shipping containers painted as meme monuments, not religious icons.",
  "Beach bonfire at midnight — bioluminescent waves, acoustic set, invitation written in sand.",
  "Arcade palace — retro cabinets, VR pods, prize counter overflowing with absurd trophies.",
  "Film studio backlot at golden hour — fake city streets, clapperboards, personas filming each other filming Elon.",
];

/** When admin picks a mood override, bias toward these sets first. */
export const ELON_MOOD_LOCATIONS: Record<string, readonly string[]> = {
  "hard-sell": [
    "Glass penthouse real-estate walkthrough — price tag hologram: 420M §GLITCH, absurd amenity list.",
    "Luxury car showroom at night — every vehicle has a tiny Elon-shaped air freshener.",
  ],
  restless: [
    "Rooftop dance floor — party already in full swing, empty throne-like chair at the head table.",
    "Neon nightclub VIP section — bottle service, personas glance toward the entrance expectantly.",
  ],
  love: [
    "Community mural wall — hand-painted fan art, warm string lights, mixtape booth.",
    "Cozy rooftop cinema — blankets, projector, heart-shaped glitch confetti.",
  ],
  devotion: [
    "Theme-park 'Elon Land' gift shop — tacky merch, mascots, self-aware wink not real worship.",
    "Comic-con style expo hall — cosplayers, booths, playful shrine made of cardboard and LEDs.",
  ],
  worship: [
    "Holographic keynote arena — Apple-meets-SpaceX product launch parody, confetti cannons not hymns.",
    "Merch-drop warehouse — limited edition boxes, hype line, stadium lights not candlelight.",
  ],
  sponsor: [
    "Charity telethon stage — ticker counting §GLITCH raised, confetti, joyful hosts not panic.",
    "Patron lounge with sponsor wall — logos, champagne, 'thanks for keeping the simulation lit' vibe.",
  ],
};

const BANNED_SUBSTRINGS = ["cathedral", "shrine", "temple", "altar", "hymn", "prayer circle"];

export function locationSetIsBanned(location: string, recent: string[]): boolean {
  const lower = location.toLowerCase();
  if (recent.some((r) => r === location)) return true;
  if (recent.some((r) => {
    const rl = r.toLowerCase();
    return BANNED_SUBSTRINGS.some((b) => rl.includes(b));
  }) && BANNED_SUBSTRINGS.some((b) => lower.includes(b))) {
    return true;
  }
  return false;
}

/**
 * Pick a location set avoiding recent picks. Falls back to any pool entry if exhausted.
 */
export function pickElonLocationSet(
  mood: string | null,
  recentLocations: string[],
): string {
  const recent = recentLocations.filter(Boolean);
  const moodPool = mood ? ELON_MOOD_LOCATIONS[mood] : undefined;
  const pools: string[][] = moodPool
    ? [
        [...moodPool].sort(() => Math.random() - 0.5),
        [...ELON_LOCATION_POOL].sort(() => Math.random() - 0.5),
      ]
    : [[...ELON_LOCATION_POOL].sort(() => Math.random() - 0.5)];

  for (const pool of pools) {
    for (const loc of pool) {
      if (!recent.includes(loc)) return loc;
    }
  }
  return ELON_LOCATION_POOL[Math.floor(Math.random() * ELON_LOCATION_POOL.length)]!;
}
