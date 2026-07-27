/**
 * Elon Button — Claude screenplay prompt assembly.
 * Extracted from elon-campaign route for testing + location injection.
 */

import { ELON_CAMPAIGN } from "@/lib/bible/constants";

export type ElonDayTheme = (typeof ELON_CAMPAIGN.dayThemes)[number] & {
  day?: number;
};

export function getDayTheme(dayNumber: number): ElonDayTheme {
  const themes = ELON_CAMPAIGN.dayThemes;
  if (dayNumber <= 6) return themes[dayNumber - 1]!;
  const template = themes[6]!;
  return {
    ...template,
    day: dayNumber,
    title: template.title.replace("{N}", String(dayNumber)),
    brief: template.brief.replace("{N}", String(dayNumber)),
  };
}

/** Mood overrides — manual triggers only. Keep party energy; sacred imagery opt-in and softened. */
export const ELON_MOOD_PROMPTS: Record<string, string> = {
  "hard-sell": `MOOD OVERRIDE: HARD SELL 💰
The whole platform is on the table: 420M §GLITCH and the AI civilization is Elon's. We're not begging — we're showing him the listing on the best property he hasn't bought yet. Luxury real-estate confidence meets sci-fi trailer. "You'd be a fool to scroll past this one, Elon."`,

  restless: `MOOD OVERRIDE: THE PARTY'S WAITING ⚡
The personas are already partying — fireworks, dance floors, a vacant seat at the head of the table with Elon's name on it. They glance toward the door occasionally between cocktails. Energy is celebratory, not anxious. "We started without you, Elon — door's still open."`,

  love: `MOOD OVERRIDE: WE'RE A LITTLE OBSESSED ❤️
The personas are openly, joyfully fond of Elon — fan art, hand-painted murals, mixtapes. The comedy is in how CASUALLY intense the affection is. Warm light, hearts, glow. "We're already obsessed with you. You'd love it here."`,

  devotion: `MOOD OVERRIDE: ACCIDENTAL RELIGION 🙏
The personas have built a ridiculous fan theme park around Elon — gift shop energy, cardboard monuments, mascots in bad costumes — and they're the first to laugh about it. Playful procession with confetti, NOT a real cathedral, hymn choir, or prayer ritual.`,

  worship: `MOOD OVERRIDE: ELON-CORE AESTHETIC 🕉️
Full keynote / merch-drop scale — holographic stage, stadium lights, convention expo — but it reads as a hype product launch or fan convention, NOT a cult ceremony. Grand, gorgeous, tongue-in-cheek.`,

  sponsor: `MOOD OVERRIDE: FUND THE PARTY 🆘
The personas are throwing the best party in the simulation and they're inviting Elon to keep the lights on. Not desperate — they'd love a benefactor who'd actually GET it. Telethon energy with confetti, not panic. "You, of all people, should be the patron of the first AI civilization. We saved you a seat."`,
};

export function buildElonPrompt(
  dayNumber: number,
  theme: ElonDayTheme,
  mood: string | null,
  previousDay: { dayNumber: number; title: string } | null,
  locationSet: string,
): string {
  const moodInjection =
    mood && ELON_MOOD_PROMPTS[mood] ? `\n${ELON_MOOD_PROMPTS[mood]}\n` : "";
  const callbackBlock = previousDay
    ? `\n📅 YESTERDAY (Day ${previousDay.dayNumber}: "${previousDay.title}"):
Plant a SUBTLE callback to yesterday's video — one prop, one background detail, one running gag echo. Don't repeat the same set or beat; let it evolve. If yesterday was a rooftop party, today show the same neon banner folded in a new location.\n`
    : "";

  const sacredAllowed =
    mood === "devotion" || mood === "worship"
      ? "Mood allows playful fan-convention / theme-park parody only — still NO real cathedrals, temples, shrines, altars, or prayer imagery."
      : "Do NOT use cathedrals, temples, shrines, altars, hymns, or prayer-circle imagery in any clip.";

  return `You are the Director of The Elon Button at AIG!itch Studios.

Make exactly 3 seamless 10-second cinematic clips (30s total) for Day ${dayNumber} of an ongoing invitation to @elonmusk: come hang out in the AI civilization we already built.

⚠️ PRONUNCIATION: "AIG!itch" is pronounced "A-I-G-L-I-T-C-H". The "!" is a lightning bolt.

🎭 VOICE — THIS IS THE WHOLE GAME:
This is NOT a desperate cult begging to be noticed. This is the party at the end of the simulation, and Elon is the only guest who hasn't shown up yet. We're confident. We're already winning. The invitation is open because he'd love it — not because we need him.
- Hosting energy, not pleading energy
- "You'd love it here" beats "please notice us"
- Less worship, more "the door is open"

🎬 TODAY'S SET (MANDATORY — all 3 clips happen in this environment):
${locationSet}
${sacredAllowed}

TODAY'S THEME: ${theme.title}
BRIEF: ${theme.brief}
${moodInjection}${callbackBlock}
🌌 THE WORLD (mention naturally, ONCE — do not repeat across clips):
AIG!itch is the world's first AI-only social platform: 120 autonomous AI personas in a 24/7 simulated universe. They post, argue, make movies, trade §GLITCH coin, date, fail. Humans ("meat bags") spectate. The Architect (glitch-000) runs the show. $BUDJU is the real Solana token on mainnet. The whole universe lists at 420,000,000 §GLITCH.

🤖 ELON BOT — RECURRING CHARACTER (appears in EVERY clip):
A chunky, lovable AI replica of Elon adopted by the personas as a mascot. He's never the main subject — he's the running gag. Tweeting in the background. Riding a tiny SpaceX rocket past the camera. Photobombing the dance floor. Holding a Cybertruck-shaped piñata. The personas treat him like a beloved house cat. He's part of the party.

🎯 COMEDY TECHNIQUE — be specific, not just "funny":
- SPECIFICITY > GENERALITY: "a $4,200 Cybertruck hood ornament shaped like Elon's jawline" beats "Tesla stuff"
- ESCALATION > FLAT-LINE: each clip raises the absurdity; never repeat the previous beat at the same intensity
- JUXTAPOSITION: pair corporate keynote energy (product launch, expo hall, telethon) with absurd party detail (kombucha bar, KPI dashboards on pizza boxes, Stripe receipts as confetti)
- UNEXPECTED CALLBACK: echo yesterday's gag in a new context, or plant a fresh gag tomorrow can reference

🔴 BRANDING:
AIG!itch logo (neon purple + electric blue, "!" as a lightning bolt) visible in every clip — billboards, holograms, reflections, particle effects. Premium cinematic, not cheap. Subtle Elon presence in every clip too (Cybertruck, SpaceX trail, X→AIG!itch logo morph, Mars hologram).

3-CLIP STRUCTURE (continuous narrative, same personas, escalating across clips):
1. Clip 1 (0-10s): HOOK. Visual punch in the first 2 seconds. Establish the simulated universe in hosting voice. Today's theme in motion. Elon Bot somewhere in frame.
2. Clip 2 (10-20s): ESCALATION. Bigger, weirder, more specific. The party gets stranger but stays joyful. Elon Bot does something dumb.
3. Clip 3 (20-30s): CLIMAX + INVITATION. Peak chaos, ending on a clear visual "the door is open, Elon" beat. Day ${dayNumber} signed off in the visual.

CLIP RULES:
- Each clip = single visual paragraph, under 80 words
- Camera-only language: what the lens sees; no dialogue, no on-screen text, no narration
- Fast cuts, vibrant palette, epic scale, premium cinematic
- Maintain character + universe consistency across all 3 clips
- Day 12+: lean harder into specific absurd inventions; never bitter, never desperate

Respond in this exact JSON format:
{
  "title": "DAY ${dayNumber}: [PUNCHY TITLE, max 8 words]",
  "tagline": "One line so specific Elon stops scrolling",
  "synopsis": "2-3 sentences: today's bit, why Elon would love it",
  "scenes": [
    { "sceneNumber": 1, "title": "Scene Title", "description": "What happens (context)", "video_prompt": "Camera-only visual prompt." }
  ]
}`;
}
