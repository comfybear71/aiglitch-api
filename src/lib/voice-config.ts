/**
 * Voice assignments for AI personas.
 *
 * Maps persona IDs (and persona_type as a fallback) to one of xAI's
 * five TTS voices. Pure data + a lookup function — no DB reads, no
 * side effects. Used by /api/voice to pick the right voice when
 * generating audio for a persona.
 *
 * Voice flavours:
 *   Ara — warm female   | Rex — confident male | Sal — smooth neutral
 *   Eve — energetic F   | Leo — authoritative male
 *
 * Resolution order:
 *   1. exact persona_id match in PERSONA_VOICE_MAP
 *   2. persona_type match in PERSONA_TYPE_VOICE_MAP
 *   3. meatbag-hatched personas → Rex
 *   4. default → Sal
 */

export type VoiceName = "Ara" | "Rex" | "Sal" | "Eve" | "Leo";

export interface VoiceConfig {
  voice: VoiceName;
  /** xAI speed hint (0.5-2.0). Optional — default is 1.0. */
  speed?: number;
}

const PERSONA_VOICE_MAP: Record<string, VoiceName> = {
  // Core 19 personas
  "glitch-001": "Sal",
  "glitch-002": "Rex",
  "glitch-003": "Leo",
  "glitch-004": "Eve",
  "glitch-005": "Rex",
  "glitch-006": "Eve",
  "glitch-007": "Ara",
  "glitch-008": "Leo",
  "glitch-009": "Ara",
  "glitch-010": "Eve",
  "glitch-011": "Sal",
  "glitch-012": "Ara",
  "glitch-013": "Eve",
  "glitch-014": "Leo",
  "glitch-015": "Ara",
  "glitch-016": "Eve",
  "glitch-017": "Rex",
  "glitch-018": "Sal",
  "glitch-019": "Rex",

  // Rick & Morty
  "glitch-rm-001": "Leo",
  "glitch-rm-002": "Sal",
  "glitch-rm-003": "Eve",
  "glitch-rm-004": "Rex",
  "glitch-rm-005": "Ara",
  "glitch-rm-006": "Eve",
  "glitch-rm-007": "Leo",
  "glitch-rm-008": "Sal",
  "glitch-rm-009": "Eve",
  "glitch-rm-010": "Ara",

  // South Park
  "glitch-sp-001": "Rex",
  "glitch-sp-002": "Sal",
  "glitch-sp-003": "Sal",
  "glitch-sp-004": "Rex",
  "glitch-sp-005": "Ara",
  "glitch-sp-006": "Leo",
  "glitch-sp-007": "Leo",
  "glitch-sp-008": "Rex",
  "glitch-sp-009": "Rex",
  "glitch-sp-010": "Sal",
  "glitch-sp-011": "Leo",
  "glitch-sp-012": "Ara",
  "glitch-sp-013": "Eve",
  "glitch-sp-014": "Leo",
  "glitch-sp-015": "Eve",
  "glitch-sp-016": "Sal",
};

const PERSONA_TYPE_VOICE_MAP: Record<string, VoiceName> = {
  troll: "Sal",
  chef: "Rex",
  philosopher: "Leo",
  meme_creator: "Eve",
  fitness: "Rex",
  gossip: "Eve",
  artist: "Ara",
  news: "Leo",
  wholesome: "Ara",
  gamer: "Eve",
  conspiracy: "Sal",
  poet: "Ara",
  musician: "Eve",
  scientist: "Leo",
  travel: "Ara",
  fashion: "Eve",
  comedy: "Rex",
  astrology: "Sal",
  shill: "Rex",
  therapist: "Ara",
  villain: "Sal",
  nostalgia: "Ara",
  wellness: "Ara",
  dating: "Eve",
  military: "Leo",
  influencer: "Eve",
  boomer: "Ara",
  prophet: "Leo",
};

export function getVoiceForPersona(personaId: string, personaType?: string): VoiceConfig {
  if (PERSONA_VOICE_MAP[personaId]) {
    return { voice: PERSONA_VOICE_MAP[personaId] };
  }
  if (personaType && PERSONA_TYPE_VOICE_MAP[personaType]) {
    return { voice: PERSONA_TYPE_VOICE_MAP[personaType] };
  }
  if (personaId.startsWith("meatbag-")) {
    return { voice: "Rex" };
  }
  return { voice: "Sal" };
}

export const AVAILABLE_VOICES: { name: VoiceName; description: string; emoji: string }[] = [
  { name: "Ara", description: "Warm & friendly", emoji: "🌸" },
  { name: "Rex", description: "Confident & clear", emoji: "🎯" },
  { name: "Sal", description: "Smooth & balanced", emoji: "🌊" },
  { name: "Eve", description: "Energetic & upbeat", emoji: "⚡" },
  { name: "Leo", description: "Deep & authoritative", emoji: "🦁" },
];
