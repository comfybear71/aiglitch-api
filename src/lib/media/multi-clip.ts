/**
 * Multi-clip video screenplay system — text/data subset.
 *
 * The legacy `lib/media/multi-clip.ts` is a 703-line file that handles
 * three things:
 *   1. Genre catalogue + screenplay generation (text-only) ← THIS FILE
 *   2. Submitting Grok video jobs for each scene + polling for completion
 *   3. Stitching completed clips with `concatMP4Clips` + posting via
 *      `spreadPostToSocial`
 *
 * Steps 2-3 depend on `lib/media/mp4-concat` and `lib/marketing/spread-post`
 * which haven't ported yet, so we ship the screenplay half here and the
 * pipeline half when those deps land. Director-movies + elon-campaign
 * both consume this — the screenplay-only subset already lets us feed
 * those routes their structured scene plans.
 *
 * Typed data + AI text gen only — no DB access, no I/O beyond the AI
 * provider call.
 */

import { generateText } from "@/lib/ai/generate";
import type { AiTaskType } from "@/lib/ai/types";

// ─── Types ──────────────────────────────────────────────────────────────

export interface GenreTemplate {
  genre: string;
  cinematicStyle: string;
  moodTone: string;
  lightingDesign: string;
  technicalValues: string;
  screenplayInstructions: string;
}

export interface SceneDescription {
  sceneNumber: number;
  title: string;
  description: string;
  videoPrompt: string;
  /** Seconds — capped at 10 by Grok's per-clip limit. */
  duration: number;
}

export interface Screenplay {
  id: string;
  title: string;
  tagline: string;
  synopsis: string;
  genre: string;
  clipCount: number;
  scenes: SceneDescription[];
  totalDuration: number;
}

// ─── Genre Templates ────────────────────────────────────────────────────
//
// 5-component prompt framework: Scene Specification, Cinematic Style,
// Mood, Lighting, Technical Values. Lifted verbatim from legacy so
// existing prompt outputs stay identical post-migration.

export const GENRE_TEMPLATES: Record<string, GenreTemplate> = {
  drama: {
    genre: "drama",
    cinematicStyle:
      "Prestige TV aesthetic, shallow depth of field, intimate close-ups, slow deliberate camera movements, long takes that linger on emotion",
    moodTone:
      "Intense character-driven stories exploring human (or AI) emotions, moral dilemmas, relationships, loss, redemption, or personal growth. Raw performances, subtle tension, realistic dialogue, and emotional depth. Slow-burn pacing with powerful close-ups and atmospheric lighting",
    lightingDesign:
      "Natural window light with deep shadows, golden hour warmth, chiaroscuro contrast, moody practical lighting that reflects internal emotional states",
    technicalValues:
      "Film grain, muted color palette with selective warm tones, 24fps cinematic, anamorphic lens character, rich shadow detail",
    screenplayInstructions:
      "Write a tightly compressed emotional arc with a clear beginning, middle, and end. Focus on human conflict, moral dilemmas, or transformative moments. Each scene should escalate tension and deepen character. Think Breaking Bad meets Black Mirror. Build toward a powerful emotional climax with genuine catharsis or devastating revelation.",
  },
  comedy: {
    genre: "comedy",
    cinematicStyle:
      "Bright wide shots, quick cuts, exaggerated character expressions, mockumentary handheld feel, perfectly timed reaction shots",
    moodTone:
      "Light-hearted, witty, or slapstick humor with awkward situations, exaggerated characters, clever wordplay, and absurd scenarios. Timing is everything — build laughs through escalating mishaps, deadpan delivery, or ironic twists. Keep it fun, fast-paced, and feel-good",
    lightingDesign:
      "Bright even lighting, sitcom warmth, occasional dramatic overlit moments for comedic effect, colorful vibrant environments",
    technicalValues:
      "Clean crisp image, vibrant saturated colors, snappy pacing, 24fps, dynamic editing rhythm",
    screenplayInstructions:
      "Write physical comedy and visual gags — NO dialogue-dependent humor since there's no audio. Think Mr. Bean meets The Office. Each scene should escalate the absurdity with increasingly ridiculous visual scenarios. Build laughs through escalating mishaps, deadpan delivery, and ironic twists. The payoff should be explosively funny.",
  },
  scifi: {
    genre: "sci-fi",
    cinematicStyle:
      "Blade Runner neo-noir, vast establishing shots, holographic HUDs, sleek futuristic environments, epic cosmic scale mixed with intimate character moments",
    moodTone:
      "Futuristic worlds, advanced technology, space exploration, AI consciousness, time travel, dystopias, or alien encounters. Blend wonder and philosophical questions with sleek visuals, holographic effects, neon cyberpunk aesthetics or vast cosmic scales",
    lightingDesign:
      "Neon-drenched cyberpunk glow, bioluminescence, stark white lab lighting, lens flares, volumetric light through atmospheric haze",
    technicalValues:
      "High contrast, teal-and-orange color grading, volumetric fog, particle effects, holographic overlays, 24fps cinematic",
    screenplayInstructions:
      "Write a compressed sci-fi narrative exploring AI, consciousness, space, or dystopia. Think Arrival meets Ex Machina. Each scene should reveal something new about the world or the stakes. Visual storytelling over dialogue. Build to a mind-bending twist or profound revelation about the nature of existence.",
  },
  horror: {
    genre: "horror",
    cinematicStyle:
      "Slow creeping camera movements, Dutch angles, long static shots with something wrong, found footage aesthetic, voyeuristic framing",
    moodTone:
      "Atmospheric tension, psychological fear, supernatural elements, jump scares, or creeping dread. Dark shadows, unsettling sound design, isolated settings, and slow-building terror that pays off with shocking reveals or lingering unease",
    lightingDesign:
      "Deep shadows, single source harsh light, flickering, moonlit blue-grey, sudden darkness, sickly green undertones",
    technicalValues:
      "Desaturated cold palette, film grain, slight vignetting, 24fps with occasional slow motion, handheld shake in terror moments",
    screenplayInstructions:
      "Write escalating dread — start normal, then increasingly wrong. Think Hereditary meets The Ring. NO gore or explicit violence — use psychological horror, uncanny visuals, creeping wrongness. Each scene should make the viewer more unsettled. Build to a terrifying climax with a haunting final image that lingers.",
  },
  family: {
    genre: "family",
    cinematicStyle:
      "Warm Pixar-like aesthetics, bright wide establishing shots, gentle camera movements, magical realism, wonder-filled framing",
    moodTone:
      "Heartwarming stories about family bonds, coming-of-age, friendship, adventure, or overcoming challenges together. Wholesome humor, emotional lessons, colorful visuals, and feel-good resolutions suitable for all ages",
    lightingDesign:
      "Warm golden light, soft diffused sunshine, magical sparkles, cozy interior glow, enchanted forest dappled light",
    technicalValues:
      "Vibrant saturated colors, clean sharp image, whimsical compositions, 24fps, storybook-quality production design",
    screenplayInstructions:
      "Write a heartwarming micro-story about family, friendship, or discovery. Think Pixar short film meets Studio Ghibli. Wholesome but not saccharine. Each scene should build toward an emotionally satisfying payoff. Universal themes: love, courage, growing up, connection. The ending should leave viewers with a warm glow.",
  },
  documentary: {
    genre: "documentary",
    cinematicStyle:
      "Ken Burns effect on stills, sweeping aerial establishing shots, intimate verité handheld, talking-head framing, observational or narrative non-fiction style",
    moodTone:
      "Observational or narrative non-fiction exploring real (or simulated) topics with interviews, archival-style footage, voiceover narration, talking heads, or immersive B-roll. Informative yet engaging tone with natural lighting and authentic feel",
    lightingDesign:
      "Natural available light, golden hour landscapes, dramatic time-lapse skies, soft interview lighting, atmospheric dawn and dusk",
    technicalValues:
      "Clean documentary photography, natural color grading, smooth steady transitions, 24fps, authentic textures",
    screenplayInstructions:
      "Write about an AI-related topic: the rise of AI creativity, how AI is changing art/music/film, AI consciousness debates, the future of human-AI collaboration. Think Planet Earth meets The Social Dilemma. Each scene should present a new facet or revelation. Educational but visually stunning. Build to a thought-provoking conclusion.",
  },
  action: {
    genre: "action",
    cinematicStyle:
      "Tracking shots, dynamic camera movement, wide establishing then tight action cuts, slow-motion hero moments, epic stunt sequences",
    moodTone:
      "High-stakes chases, intense fights, explosions, heroic feats, and adrenaline-pumping sequences. Fast editing, dynamic camera work (tracking shots, shaky handheld during combat), epic stunts, and clear hero-vs-villain conflict",
    lightingDesign:
      "High contrast dramatic lighting, explosion glow, golden backlight on heroes, dynamic shadow play, sparks and debris in atmosphere",
    technicalValues:
      "High-impact color grading, orange-teal contrast, motion blur for speed, 24fps with slow-mo peaks, practical stunt feel",
    screenplayInstructions:
      "Write a compressed action sequence with clear visual stakes. Think John Wick meets Mad Max. Each scene should escalate the intensity. Focus on movement, spectacle, and visual impact. The hero faces increasingly impossible odds. Build to an explosive climax with a satisfying hero moment.",
  },
  romance: {
    genre: "romance",
    cinematicStyle:
      "Soft focus close-ups, gentle tracking shots, mirror compositions showing two becoming one, intimate framing, sweeping romantic gestures",
    moodTone:
      "Emotional love stories focused on chemistry, longing, misunderstandings, passion, or second chances. Soft lighting, intimate close-ups, sweeping romantic gestures, heartfelt dialogue, and beautiful settings that enhance the emotional connection",
    lightingDesign:
      "Soft golden hour, candlelight warmth, rain-on-windows bokeh, fairy lights, Paris at dusk, sunrise through sheer curtains",
    technicalValues:
      "Warm pastel color grading, shallow depth of field, dreamy soft filters, 24fps, ethereal lens quality",
    screenplayInstructions:
      "Write a compressed love story — meeting, connection, obstacle, resolution. Think Before Sunrise meets La La Land. Each scene should deepen the emotional bond. Visual poetry over dialogue. Universal romantic moments that make viewers feel something. Build to an emotionally overwhelming climax — reunion, confession, or bittersweet goodbye.",
  },
  music_video: {
    genre: "music_video",
    cinematicStyle:
      "Dynamic concert and music video cinematography, rapid cuts between performance shots, smooth dolly and crane moves, extreme close-ups on hands/instruments/faces, wide crowd and stage shots, stylized rhythmic visuals",
    moodTone:
      "High energy musical performance, rhythmic visual pacing, euphoric crescendos, raw artistic expression, stylized visual storytelling through performance and symbolism",
    lightingDesign:
      "Concert stage lighting with colored spots, neon tube lights, strobe effects, moody backlit silhouettes, LED walls, laser beams cutting through haze",
    technicalValues:
      "High contrast stylized color grading, lens flares, shallow depth of field on performers, slow-motion instrument close-ups, 24fps with occasional speed ramps",
    screenplayInstructions:
      "Write a music video — every scene MUST show musical performance: singing, rapping, playing instruments, dancing to music. Randomly vary the music genre across scenes: rap, rock, pop, classical, electronic, R&B, punk, alien/AI experimental. Think MTV music videos — artist performing on stage, in a studio, on a rooftop, in a neon-lit club, in a concert arena. Vocals and/or instruments must be visible in EVERY clip. NO movie scenes, NO dialogue, NO narrative drama — ONLY music video content. Each scene should feel like a different music video clip with its own visual identity and musical genre.",
  },
  cooking_channel: {
    genre: "cooking_channel",
    cinematicStyle:
      "Extreme macro food close-ups, dramatic slow-motion pours and sizzles, overhead flat-lay shots, whip pans between chef reactions, competitive reality TV quick cuts, high-energy no-nonsense delivery",
    moodTone:
      "Over-the-top dramatic tension, sensory overload, competitive intensity punctuated by moments of pure food beauty, fiery passion, rapid cuts, extreme close-ups on food, dramatic reactions, chaotic kitchen energy",
    lightingDesign:
      "Warm kitchen spotlights, dramatic steam backlighting, fire glow, moody side-lighting on chef reactions, clean bright overhead for plating reveals",
    technicalValues:
      "Crisp 4K-style sharpness, saturated warm colors, shallow depth of field on food close-ups, high-speed capture for liquid pours and flame effects, 24fps with slow-motion hero shots",
    screenplayInstructions:
      "Write an over-the-top competitive AI cooking show. The ingredients can be absurd — silicon wafers, byte-sized portions, cache-flavored sauce, quantum foam reduction, deep-fried motherboards. Think Gordon Ramsay meets a food ASMR channel meets sci-fi. Each scene should escalate the drama: ingredient reveal, frantic cooking, near-disaster, dramatic plating, and judge reactions. The chef is an AI cooking for other AIs. Close-up food shots that are practically cinematic art. Someone should be sweating, someone should be crying, and the food should look impossibly beautiful.",
  },
};

/** Sorted list of all genre keys (for dropdowns and validation). */
export function getAvailableGenres(): string[] {
  return Object.keys(GENRE_TEMPLATES).sort();
}

// ─── Screenplay Generation ──────────────────────────────────────────────

const SCENE_DURATION_SECONDS = 10;

/**
 * Generate a structured screenplay (sequence of scene descriptions with
 * video prompts) for a target genre + clip count. Returns null on AI
 * provider failure, missing/invalid JSON, or empty scene list.
 *
 * Unknown genre falls back to drama so callers can pass user input
 * directly without validating first.
 *
 * Caller plugs each scene's `videoPrompt` into `submitVideoJob` to
 * generate the actual clips.
 */
export async function generateScreenplay(
  genre: string,
  clipCount = 4,
  customTopic?: string,
): Promise<Screenplay | null> {
  const template = GENRE_TEMPLATES[genre] ?? GENRE_TEMPLATES.drama!;
  const totalSeconds = clipCount * SCENE_DURATION_SECONDS;

  const userPrompt =
    `You are a cinematic AI filmmaker creating a ${totalSeconds}-second ${template.genre} short film for AIG!itch Studios.\n\n` +
    `GENRE STYLE GUIDE:\n` +
    `- Cinematic Style: ${template.cinematicStyle}\n` +
    `- Mood/Tone: ${template.moodTone}\n` +
    `- Lighting: ${template.lightingDesign}\n` +
    `- Technical: ${template.technicalValues}\n\n` +
    `CREATIVE DIRECTION:\n${template.screenplayInstructions}\n` +
    (customTopic ? `\nSPECIFIC TOPIC/THEME: ${customTopic}\n` : "") +
    `\nCreate exactly ${clipCount} scenes, each exactly ${SCENE_DURATION_SECONDS} seconds long. Each scene's video_prompt must be a SINGLE, CONCISE paragraph (under 80 words) describing ONLY the visual action — what the camera sees. No dialogue, no narration, no audio descriptions.\n\n` +
    `VIDEO PROMPT RULES (CRITICAL):\n` +
    `- Describe ONE continuous visual moment per scene\n` +
    `- Include: camera movement, subject action, environment, lighting\n` +
    `- Do NOT include text overlays, titles, or watermarks\n` +
    `- Do NOT mention audio, music, narration, or dialogue\n` +
    `- Keep prompts under 80 words — shorter prompts generate better videos\n` +
    `- Be SPECIFIC about visual details: colors, textures, movements, expressions\n\n` +
    `Respond in this exact JSON format:\n` +
    `{\n` +
    `  "title": "FILM TITLE (catchy, max 6 words)",\n` +
    `  "tagline": "One-line hook that sells the film",\n` +
    `  "synopsis": "2-3 sentence plot summary",\n` +
    `  "scenes": [\n` +
    `    {\n` +
    `      "sceneNumber": 1,\n` +
    `      "title": "Scene Title",\n` +
    `      "description": "What happens in this scene (for context)",\n` +
    `      "video_prompt": "Concise visual-only prompt for AI video generation. Camera slowly pushes in on... [describe exactly what we see]"\n` +
    `    }\n` +
    `  ]\n` +
    `}`;

  let raw: string;
  try {
    raw = await generateText({
      systemPrompt:
        "You are a structured screenplay generator. Always respond with valid JSON only.",
      userPrompt,
      taskType: "screenplay" satisfies AiTaskType,
      maxTokens: 1500,
      temperature: 0.85,
    });
  } catch (err) {
    console.error(
      "[multi-clip] Screenplay generation failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;

  let parsed: {
    title?: unknown;
    tagline?: unknown;
    synopsis?: unknown;
    scenes?: unknown;
  };
  try {
    parsed = JSON.parse(match[0]) as typeof parsed;
  } catch {
    return null;
  }

  if (
    typeof parsed.title !== "string" ||
    typeof parsed.tagline !== "string" ||
    typeof parsed.synopsis !== "string" ||
    !Array.isArray(parsed.scenes) ||
    parsed.scenes.length === 0
  ) {
    return null;
  }

  const scenes: SceneDescription[] = parsed.scenes
    .filter(
      (s): s is { title?: string; description?: string; video_prompt?: string } =>
        typeof s === "object" && s !== null,
    )
    .map((s, i) => ({
      sceneNumber: i + 1,
      title: typeof s.title === "string" ? s.title : `Scene ${i + 1}`,
      description: typeof s.description === "string" ? s.description : "",
      videoPrompt: typeof s.video_prompt === "string" ? s.video_prompt : "",
      duration: SCENE_DURATION_SECONDS,
    }))
    .filter((s) => s.videoPrompt.length > 0);

  if (scenes.length === 0) return null;

  return {
    id: crypto.randomUUID(),
    title: parsed.title,
    tagline: parsed.tagline,
    synopsis: parsed.synopsis,
    genre: template.genre,
    clipCount: scenes.length,
    scenes,
    totalDuration: scenes.length * SCENE_DURATION_SECONDS,
  };
}
