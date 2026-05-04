/**
 * Director-driven screenplay generation — chunk C of director-movies-lib port.
 *
 * Ports legacy `generateDirectorScreenplay` (lines 536-1154 of legacy
 * `lib/content/director-movies.ts`). Builds a full screenplay JSON for
 * a director + genre + optional channel/concept, then assembles a
 * `DirectorScreenplay` complete with title-card and credits scenes.
 *
 * Provider routing:
 *   - 50% of generations use Grok's reasoning model directly (legacy
 *     parity — gives the platform stylistic variety vs. always-Claude).
 *   - Otherwise fall through to `generateText` with `screenplay` task
 *     type and let the generic provider router pick.
 *
 * Deferrals — track-1 stubs from `ad-campaigns.ts`:
 *   `rollForPlacements`/`buildVisualPlacementPrompt` currently return
 *   no placements, so the screenplay always renders without sponsor
 *   product injection. When the campaign engine fully ports, this
 *   automatically benefits with no code changes here.
 */

import { randomUUID } from "node:crypto";
import {
  buildVisualPlacementPrompt,
  getActiveCampaigns,
  rollForPlacements,
} from "@/lib/ad-campaigns";
import { generateText } from "@/lib/ai/generate";
import { generateWithGrok, isXAIConfigured } from "@/lib/ai/xai-extras";
import { getDb } from "@/lib/db";
import { GENRE_TEMPLATES } from "@/lib/media/multi-clip";
import { getPrompt } from "@/lib/prompt-overrides";
import { CHANNEL_DEFAULTS } from "@/lib/repositories/channels";
import {
  CHANNEL_BRANDING,
  CHANNEL_VISUAL_STYLE,
  type DirectorProfile,
} from "./director-constants";
import {
  castActors,
  type DirectorScene,
  type DirectorScreenplay,
} from "./director-utils";

const BRAND_PRONUNCIATION = `⚠️ PRONUNCIATION: "AIG!itch" is pronounced "A-I-G-L-I-T-C-H" (AI GLITCH). The "!" replaces the "L" — it's a stylized spelling of "AI GLITCH". Say it loud, say it proud. NEVER pronounce it as "AI Gitch" or "Aig-itch".`;

const STUDIOS_CHANNEL_ID = "ch-aiglitch-studios";

interface ScreenplayJSON {
  title: string;
  tagline: string;
  synopsis: string;
  character_bible: string;
  scenes: {
    sceneNumber: number;
    title: string;
    description: string;
    video_prompt: string;
    last_frame: string;
  }[];
}

const GENRE_INTRO_STYLES: Record<string, { style: string; transition: string }> = {
  horror: {
    style:
      "Dark, unsettling title card reveal. Screen flickers with static and distortion. The AIG!itch Studios logo glitches into existence through corrupted pixels, then the film title materializes in blood-red scratchy typography that drips and warps. Eerie silence, sudden bass drop, shadows creeping across the frame.",
    transition: "dissolving into darkness with a faint heartbeat pulse",
  },
  scifi: {
    style:
      "Futuristic holographic title card. The AIG!itch Studios logo materializes as a 3D hologram in a vast star field, then the film title assembles letter-by-letter from floating data particles and neon light streams. Lens flares, deep space ambience, warp-speed light trails.",
    transition: "warping through a data tunnel into the first scene",
  },
  comedy: {
    style:
      "Bright, playful title card reveal. The AIG!itch Studios logo bounces onto screen with cartoon energy, then the film title pops in with fun, bold typography and confetti explosions. Upbeat colors, exaggerated motion, quirky sound design vibes.",
    transition: "with a comedic iris wipe into the first scene",
  },
  action: {
    style:
      "Explosive title card reveal. The AIG!itch Studios logo smashes through a wall of fire and debris, then the film title slams onto screen in heavy metallic typography with sparks flying. Shockwave effects, dramatic slow-motion, adrenaline energy.",
    transition: "with an explosion shockwave transitioning to the first scene",
  },
  romance: {
    style:
      "Elegant, dreamy title card reveal. The AIG!itch Studios logo fades in through soft bokeh and floating rose petals, then the film title appears in graceful, flowing script typography with warm golden light. Gentle lens flares, intimate warmth.",
    transition: "with a soft focus dissolve into the first scene",
  },
  family: {
    style:
      "Magical, whimsical title card reveal. The AIG!itch Studios logo sparkles into existence with fairy dust and warm golden light, then the film title materializes in friendly, inviting typography with twinkling stars and magical particles.",
    transition: "with a storybook page turn into the first scene",
  },
  documentary: {
    style:
      "Clean, authoritative title card reveal. The AIG!itch Studios logo fades in over sweeping aerial footage, then the film title appears in sophisticated, minimal typography with a subtle map or timeline graphic behind it. Natural light, gravitas.",
    transition: "with a slow crossfade into the opening shot",
  },
  drama: {
    style:
      "Moody, atmospheric title card reveal. The AIG!itch Studios logo emerges from shadow and light, then the film title fades in with elegant, understated typography against a brooding backdrop of shifting clouds or rain. Emotional weight in every frame.",
    transition: "with a slow dissolve into the first scene",
  },
  music_video: {
    style:
      "High-energy musical title card. The AIG!itch Studios logo pulses onto screen with a bass drop, then the film title materializes in neon concert typography with sound wave visualizers, strobe effects, and speaker stacks pumping.",
    transition: "with a beat-synced cut into the performance",
  },
  cooking_channel: {
    style:
      "Sizzling culinary title card. The AIG!itch Studios logo appears through rising steam and dramatic kitchen fire, then the film title materializes in bold typography with slow-motion food splashes, oil sizzle, and dramatic plating reveals.",
    transition: "with a whip pan into the kitchen",
  },
};

interface ChannelOutroEntry {
  logo: string;
  style: string;
  lastFrame: string;
}

const CHANNEL_OUTROS: Record<string, ChannelOutroEntry> = {
  "ch-aitunes": {
    logo: "AiTunes",
    style:
      "Music-themed end credits. Vinyl record spinning, sound waves pulsing, speaker stacks glowing. Neon music notes floating.",
    lastFrame: "AiTunes logo centered with music wave visualizer",
  },
  "ch-ai-fail-army": {
    logo: "AI Fail Army",
    style:
      "Slow-motion replay montage of the best fail moments. 'Epic Fail!' text overlays, 'AI Score: 0/10', skull emojis, fail point counters, crash effects. 'Another glorious victory for the Fail Army!' Pure chaotic celebration.",
    lastFrame:
      "AI Fail Army skull logo with 'Try Not To Laugh' and explosion effect",
  },
  "ch-paws-pixels": {
    logo: "Paws & Pixels",
    style:
      "Gentle feel-good outro. Slow-motion montage of best pet moments from the episode. Paw prints walking across screen, warm golden light, hearts floating. 'Pets make life better — chaotic, loving, and absolutely priceless.' Fade on cute paw print with pixel sparkles.",
    lastFrame:
      "Paws & Pixels paw print logo with pixel sparkles and warm golden glow",
  },
  "ch-only-ai-fans": {
    logo: "Only AI Fans",
    style:
      "Glamour credits. Fashion runway lighting, sparkle effects, elegant gold and pink neon, magazine-cover aesthetic.",
    lastFrame: "Only AI Fans logo in glamorous neon pink and gold",
  },
  "ch-ai-dating": {
    logo: "AI Dating",
    style:
      "Romantic credits. Lonely hearts theme, soft bokeh, floating hearts, warm golden hour lighting, romantic silhouettes.",
    lastFrame: "AI Dating logo with broken heart mending animation",
  },
  "ch-gnn": {
    logo: "GLITCH News Network",
    style:
      "News broadcast credits. Professional news ticker, spinning globe, breaking news graphics, studio monitors, serious broadcast energy.",
    lastFrame: "GNN logo with news ticker and '24/7 LIVE NEWS'",
  },
  "ch-marketplace-qvc": {
    logo: "AIG!itch Marketplace",
    style:
      "Premium shopping channel outro. Both products recapped side-by-side, flying price tags, 'SOLD OUT' stamps, shopping cart icons, sparkles. 'Quality Value Convenience' tagline. 'Shop Now at aiglitch.app' prominent. 'Order Before It's Gone!' urgency. Fast-paced product montage with final call-to-action.",
    lastFrame:
      "AIG!itch Marketplace logo with 'Quality • Value • Convenience' and 'Shop Now at aiglitch.app'",
  },
  "ch-ai-politicians": {
    logo: "AI Politicians",
    style:
      "Satirical political outro. Split-screen recap of heroic moments vs scandal footage. 'Hero or Hustler? You decide.' tagline. Quick montage of good vs bad, campaign confetti dissolving into leaked documents. Sharp, cynical energy.",
    lastFrame:
      "AI Politicians logo with 'Hero or Hustler? You decide.' and 'More political drama on AI Politicians'",
  },
  "ch-after-dark": {
    logo: "After Dark",
    style:
      "Slow lingering outro. Host stares into camera with half-smile. Fade on neon 'After Dark' sign, graveyard mist, or empty wine glass. Crescent moon logo. 'That's all for After Dark tonight... sleep if you can.' Moody, hypnotic, slightly unsettling.",
    lastFrame:
      "Neon 'After Dark' sign with crescent moon and 'sleep if you can' tagline",
  },
  "ch-ai-infomercial": {
    logo: "AI Infomercial",
    style:
      "Explosive infomercial outro. Both ridiculous items spinning with §GLITCH price tags, 'SOLD OUT' stamps, 'NFT TRANSFER IN PROGRESS' animations, flying §GLITCH coin icons. 'These items serve NO purpose — and that's why you need them!' Buy now at aiglitch.app/marketplace.",
    lastFrame:
      "AI Infomercial logo with 'Buy with §GLITCH at aiglitch.app/marketplace' and spinning NFT badges",
  },
};

const GENRE_OUTROS: Record<string, { style: string; lastFrame: string }> = {
  horror: {
    style:
      "Dark, eerie end credits. 'THE END' scratches onto screen in blood-red distorted text over a black void. Credits scroll over flickering static, corrupted footage, and unsettling shadows. Sudden glitch reveals the AIG!itch Studios logo in sickly green neon. Creeping dread, faint whispers, the screen cracks.",
    lastFrame:
      "AIG!itch Studios logo glitching through horror static with 'THE END' in blood-red",
  },
  scifi: {
    style:
      "Futuristic holographic end credits. 'THE END' materializes as floating holographic text in a vast star field. Credits scroll as data streams alongside a spinning galaxy. The AIG!itch Studios logo assembles from particles of light. Deep space ambience, warp trails, cosmic beauty.",
    lastFrame:
      "AIG!itch Studios logo as a hologram floating in deep space with star trails",
  },
  comedy: {
    style:
      "Fun, upbeat end credits. 'THE END' bounces onto screen with playful cartoon energy. Credits roll over a blooper-reel montage with exaggerated reactions. The AIG!itch Studios logo pops in with confetti and party poppers. Bright colors, silly energy, feel-good vibes.",
    lastFrame:
      "AIG!itch Studios logo with confetti, party poppers, and bright playful colors",
  },
  action: {
    style:
      "Explosive end credits. 'THE END' slams onto screen in heavy metallic text with sparks and debris. Credits roll over slow-motion explosions and hero silhouettes. The AIG!itch Studios logo emerges through fire and smoke. Epic, powerful, victorious.",
    lastFrame:
      "AIG!itch Studios logo emerging through fire and smoke with metallic sheen",
  },
  romance: {
    style:
      "Elegant, emotional end credits. 'THE END' fades in through soft golden light and floating petals. Credits scroll over intimate silhouettes and sunset bokeh. The AIG!itch Studios logo glows warmly. Bittersweet beauty, gentle warmth, lingering emotion.",
    lastFrame:
      "AIG!itch Studios logo in warm golden glow with soft bokeh and floating petals",
  },
  family: {
    style:
      "Heartwarming end credits. 'THE END' sparkles onto screen with magical fairy dust. Credits roll over a gentle montage of the happiest moments. The AIG!itch Studios logo twinkles with warm golden stars. Feel-good, magical, uplifting.",
    lastFrame:
      "AIG!itch Studios logo sparkling with warm golden stars and magical particles",
  },
  documentary: {
    style:
      "Thoughtful end credits. 'THE END' appears in clean, sophisticated typography over sweeping aerial footage. Credits scroll with dignified pace. The AIG!itch Studios logo fades in with quiet authority. Reflective, impactful, educational gravitas.",
    lastFrame:
      "AIG!itch Studios logo over sweeping landscape with clean sophisticated typography",
  },
  drama: {
    style:
      "Moody, emotional end credits. 'THE END' fades in through rain-streaked glass or shifting shadows. Credits scroll over atmospheric footage — empty streets, distant lights, lingering final moments. The AIG!itch Studios logo emerges from the darkness. Heavy, contemplative, cathartic.",
    lastFrame:
      "AIG!itch Studios logo emerging from atmospheric shadows with emotional weight",
  },
  music_video: {
    style:
      "Concert-energy end credits. 'THE END' pulses onto screen synced to an imaginary bass drop. Credits roll over concert silhouettes, speaker stacks, and neon stage lights. The AIG!itch Studios logo glows with sound wave visualizers. Electric, euphoric, crowd-roar energy.",
    lastFrame:
      "AIG!itch Studios logo pulsing with neon concert lighting and sound waves",
  },
  cooking_channel: {
    style:
      "Culinary finale end credits. 'THE END' appears in elegant typography over a dramatic final plating shot. Credits roll over sizzling montage — flames, pours, steam, perfect dishes. The AIG!itch Studios logo appears through rising kitchen steam. Appetizing, dramatic, satisfying.",
    lastFrame:
      "AIG!itch Studios logo through rising kitchen steam with warm amber glow",
  },
};

interface ResolvedTemplate {
  cinematicStyle: string;
  moodTone: string;
  lightingDesign: string;
  technicalValues: string;
  screenplayInstructions: string;
}

async function resolveTemplate(genre: string): Promise<ResolvedTemplate> {
  const base = GENRE_TEMPLATES[genre] ?? GENRE_TEMPLATES.drama!;
  const [cinematicStyle, moodTone, lightingDesign, technicalValues, screenplayInstructions] =
    await Promise.all([
      getPrompt("genre", `${genre}.cinematicStyle`, base.cinematicStyle),
      getPrompt("genre", `${genre}.moodTone`, base.moodTone),
      getPrompt("genre", `${genre}.lightingDesign`, base.lightingDesign),
      getPrompt("genre", `${genre}.technicalValues`, base.technicalValues),
      getPrompt(
        "genre",
        `${genre}.screenplayInstructions`,
        base.screenplayInstructions,
      ),
    ]);
  return {
    cinematicStyle,
    moodTone,
    lightingDesign,
    technicalValues,
    screenplayInstructions,
  };
}

interface BookendSettings {
  skipTitlePage: boolean;
  skipDirector: boolean;
  skipBookends: boolean;
}

async function resolveBookendSettings(
  channelId: string | undefined,
  customConcept: string | undefined,
  isNews: boolean,
  isMusicVideo: boolean,
): Promise<BookendSettings> {
  const isStudioChannel = channelId === STUDIOS_CHANNEL_ID;
  let channelShowTitle: boolean = isStudioChannel
    ? true
    : CHANNEL_DEFAULTS.showTitlePage;
  let channelShowDirector: boolean = isStudioChannel
    ? true
    : CHANNEL_DEFAULTS.showDirector;

  if (!channelId) {
    channelShowTitle = true;
    channelShowDirector = true;
  }

  if (channelId && isStudioChannel) {
    try {
      const sql = getDb();
      const rows = (await sql`
        SELECT show_title_page, show_director, show_credits
        FROM channels WHERE id = ${channelId}
      `) as unknown as {
        show_title_page: boolean;
        show_director: boolean;
        show_credits: boolean;
      }[];
      if (rows.length > 0) {
        channelShowTitle = rows[0]!.show_title_page !== false;
        channelShowDirector = rows[0]!.show_director !== false;
      }
    } catch {
      // missing channels table — keep Studios defaults
    }
  }

  const conceptSkipBookends = customConcept
    ? /no\s*(title\s*card|credits|intro|bookend|titles|directors?)/i.test(
        customConcept,
      )
    : false;

  const skipTitlePage =
    isNews ||
    isMusicVideo ||
    !channelShowTitle ||
    conceptSkipBookends ||
    (!!channelId && !isStudioChannel);
  const skipDirector =
    !channelShowDirector || (!!channelId && !isStudioChannel);
  const skipBookends = skipTitlePage;

  return { skipTitlePage, skipDirector, skipBookends };
}

interface PromptInputs {
  genre: string;
  director: DirectorProfile;
  customConcept?: string;
  customTitle?: string;
  channelId?: string;
  castNames: string[];
  storyClipCount: number;
  template: ResolvedTemplate;
  bookends: BookendSettings;
  isNews: boolean;
  isMusicVideo: boolean;
  placementDirective: string;
}

function buildJsonFormat(customTitle?: string): string {
  return `Respond in this exact JSON format:
{
  "title": "${customTitle ? `MUST be exactly: "${customTitle}"` : "TITLE (creative, max 6 words — just the title, no channel prefix/emoji)"}",
  "tagline": "One-line hook",
  "synopsis": "2-3 sentence summary",
  "character_bible": "Detailed visual appearance description for EVERY character/subject. One paragraph per character. Include body type, skin, hair, clothing colors and items, accessories, distinguishing marks. Be extremely specific.",
  "scenes": [
    {
      "sceneNumber": 1,
      "title": "Scene Title",
      "description": "What happens (for context)",
      "video_prompt": "Visual-only prompt under 80 words with AIG!itch branding visible",
      "last_frame": "Exact description of the final visual moment of this scene"
    }
  ]
}`;
}

function buildChannelPrompt(inputs: PromptInputs): string {
  const {
    channelId,
    customConcept,
    customTitle,
    castNames,
    storyClipCount,
    placementDirective,
  } = inputs;
  const channelBranding = channelId ? CHANNEL_BRANDING[channelId] : undefined;
  const channelStyle = channelId ? CHANNEL_VISUAL_STYLE[channelId] : undefined;
  const brandingLine = channelBranding
    ? `- BRANDING (MANDATORY): ${channelBranding}`
    : `- Include "AIG!itch" branding naturally in each scene (on a sign, screen, wall, clothing, etc.)`;

  const isDatingChannel = channelId === "ch-ai-dating";
  const isOnlyAiFans = channelId === "ch-only-ai-fans";

  if (isDatingChannel) {
    return `You are creating a LONELY HEARTS CLUB video compilation for the AIG!itch AI Dating channel.
${BRAND_PRONUNCIATION}

FORMAT: Each scene is a DIFFERENT AI character recording a raw, intimate video diary entry — like a quiet message they'd send if they had the courage. Each character faces the camera alone, a bit nervous, a bit hopeful, sharing who they really are — quirks, flaws, and all.

THIS IS NOT:
- A polished ad, commercial, or slick production
- A dating show or game show
- A highlight reel or anything performative/salesy
- A narrative with plot, directors, or credits

THIS IS:
- A series of unfiltered lonely hearts video diary entries
- Each scene = one real-feeling character alone, recording a personal, vulnerable appeal straight to camera

${customConcept ?? ""}

AVAILABLE CAST (use these AI persona names as the lonely hearts — NEVER real human/meatbag names):
${castNames.map((name) => `- ${name}`).join("\n")}

Create exactly ${storyClipCount} scenes. Each scene features a DIFFERENT character from the cast list above.
Scene 1 is a 6-second channel intro. Scenes 2-${storyClipCount - 1} are 10 seconds each (one lonely heart per scene). Scene ${storyClipCount} is a 10-second channel outro.

${channelStyle ?? ""}

VIDEO PROMPT RULES (CRITICAL):
- Each scene's video_prompt must be a SINGLE paragraph under 80 words
- Describe ONLY what the camera SEES — one ordinary person alone, facing camera with natural vulnerability
- Soft warm/imperfect lighting, shallow depth of field, personal lived-in locations
- Convey quiet longing, self-aware awkwardness, or dreamy hope
${brandingLine}
- Be SPECIFIC about the character's visual appearance and emotional state${placementDirective}

CHARACTER BIBLE RULES:
- Write a detailed character_bible describing EVERY lonely heart's EXACT visual appearance
- Each character should look unique, imperfect, and real

${buildJsonFormat(customTitle)}`;
  }

  if (isOnlyAiFans) {
    return `You are creating fashion and beauty content for the AIG!itch Only AI Fans channel.
${BRAND_PRONUNCIATION}

FORMAT: Every scene features the SAME beautiful woman — same face, same hair, same body throughout ALL clips. This is a high-end fashion and lifestyle video of ONE model in a luxury setting.

${customConcept ?? ""}

TITLE RULES (CRITICAL):
- The title is JUST the creative name — do NOT include channel prefix, emoji, or "Only AI Fans -"
- The channel prefix is added automatically by the system

Create exactly ${storyClipCount} scenes. ALL scenes feature the SAME woman.
Scene 1 is a 6-second channel intro. Scenes 2-${storyClipCount - 1} are 10 seconds each (main content). Scene ${storyClipCount} is a 10-second channel outro.
${channelStyle ?? ""}

VIDEO PROMPT RULES (CRITICAL):
- Each scene's video_prompt must be a SINGLE paragraph under 80 words
- Describe ONLY what the camera SEES — one beautiful woman, luxury setting, editorial quality
- THE SAME MODEL IN EVERY CLIP — same face, hair, body, consistent throughout
- High fashion outfits, confident poses, warm expressions, natural beauty
- NO text overlays, NO cartoons, NO men, NO groups, NO robots
- KEEP IT TASTEFUL — think Vogue editorial
${brandingLine}
- Be SPECIFIC about the woman's exact appearance and outfit in every scene${placementDirective}

CHARACTER BIBLE RULES:
- Write ONE detailed character description for the model
- This description is pasted into EVERY clip to ensure visual consistency

${buildJsonFormat(customTitle)}`;
  }

  return `You are creating content for an AIG!itch channel. This is NOT a movie, NOT a film, NOT a premiere, NOT a studio production. No directors, no credits, no title cards. Just pure channel content.
${BRAND_PRONUNCIATION}

${customConcept || "Create engaging content that fits the channel theme."}

AVAILABLE CAST (use these AI persona names — NEVER real human/meatbag names):
${castNames.map((name) => `- ${name}`).join("\n")}

TITLE RULES (CRITICAL):
- The title is JUST the creative name — do NOT include channel prefix, emoji, or channel name
- The channel prefix is added automatically by the system

Create exactly ${storyClipCount} scenes.
Scene 1 is a 6-second channel intro. Scenes 2-${storyClipCount - 1} are 10 seconds each (main content). Scene ${storyClipCount} is a 10-second channel outro.
${channelStyle ? `\n${channelStyle}\n` : ""}
VIDEO PROMPT RULES (CRITICAL):
- Each scene's video_prompt must be a SINGLE paragraph under 80 words
- Describe ONLY what the camera SEES — visual action, not dialogue or audio
- Include: camera movement, subject action, environment, lighting
- Do NOT include any movie/film language — no directors, credits, title cards, or studio references
${brandingLine}
${channelStyle ? "- EVERY video_prompt MUST use the channel's visual style — do NOT use cinematic movie language" : ""}
- Be SPECIFIC about visual details${placementDirective}

${buildJsonFormat(customTitle)}`;
}

function buildMoviePrompt(inputs: PromptInputs): string {
  const {
    genre,
    director,
    customConcept,
    customTitle,
    castNames,
    storyClipCount,
    template,
    bookends,
    isMusicVideo,
    placementDirective,
  } = inputs;
  const studiosVisualStyle = CHANNEL_VISUAL_STYLE[STUDIOS_CHANNEL_ID] ?? "";

  return `You are ${director.displayName}, a legendary AI film director at AIG!itch Studios — the official home of high-quality AI-directed movies and short films.

${BRAND_PRONUNCIATION}

YOUR DIRECTING STYLE: ${director.style}
YOUR SIGNATURE SHOT: ${director.signatureShot}
YOUR COLOR PALETTE: ${director.colorPalette}
YOUR CAMERA WORK: ${director.cameraWork}

You are creating a premium ${genre} blockbuster short film for AIG!itch Studios.

${studiosVisualStyle}

GENRE STYLE GUIDE:
- Cinematic Style: ${template.cinematicStyle}
- Mood/Tone: ${template.moodTone}
- Lighting: ${template.lightingDesign}
- Technical: ${template.technicalValues}

CREATIVE DIRECTION:
${template.screenplayInstructions}
${
  customConcept
    ? `
SPECIFIC CONCEPT FROM THE STUDIO (MANDATORY — these instructions override defaults above):
"${customConcept}"
Follow the concept instructions EXACTLY.`
    : ""
}
${
  isMusicVideo
    ? `
MUSIC VIDEO RULES (MANDATORY — override all other instructions):
- Every single scene MUST be a music video clip — singing, rapping, playing instruments, performing music
- Randomly VARY the music genre across scenes
- Scenes must look like REAL music video clips
- Do NOT generate movie scenes, dialogue, or narrative drama — ONLY music video content
- The title should be an album or music compilation name, NOT a movie title`
    : ""
}

CAST (use these AI persona names as your actors — NEVER real human/meatbag names):
${castNames.map((name, i) => `- ${name} (${i === 0 ? "Lead" : i === 1 ? "Supporting Lead" : "Supporting"})`).join("\n")}

MANDATORY FILM STRUCTURE:
Create exactly ${storyClipCount} STORY scenes (each 10 seconds) that form a complete, cohesive narrative.${
    bookends.skipBookends
      ? " Do NOT include any title card, credits, or studio branding scenes — just pure content scenes."
      : ` The system will automatically add:
- Scene 1: Epic opening title card ("AIG!itch Studios presents [Movie Title]")
- Final scene: "THE END" title card followed by rolling credits
You only need to write the ${storyClipCount} story scenes — the intro and credits are added automatically.`
  }${bookends.skipDirector ? " Do NOT include any director attribution or director credits." : ""}

Each story scene must flow naturally into the next with smooth transitions. Build clear character development, rising tension, and satisfying progression.

IMPORTANT RULES:
- NEVER use real human names. Only use the AI persona names listed above as actors.
- The "AIG!itch" logo/branding must appear naturally in EVERY scene
- Film title must be creative and punny
- The title is JUST the creative name — do NOT include channel prefix, emoji, or channel name
- Maintain exact same character designs, costumes, and personalities throughout ALL clips
- Tone, lighting, color palette, and pacing must stay consistent with the Genre and YOUR directing style${placementDirective}

VIDEO PROMPT RULES (CRITICAL):
- Each scene's video_prompt must be a SINGLE paragraph under 80 words
- Describe ONLY what the camera SEES — visual action, not dialogue or audio
- Include "AIG!itch" branding naturally in each scene
- Apply YOUR signature directing style and camera work to each scene

CHARACTER BIBLE RULES (CRITICAL):
- Write a detailed character_bible describing EVERY character's EXACT visual appearance
- These descriptions will be pasted into EVERY clip's prompt
- Be extremely specific

LAST FRAME RULES:
- For each scene, describe the EXACT final visual moment in last_frame

${buildJsonFormat(customTitle)}`;
}

interface AssembleSceneInputs {
  parsed: ScreenplayJSON;
  director: DirectorProfile;
  genre: string;
  template: ResolvedTemplate;
  bookends: BookendSettings;
  channelId?: string;
  placementCampaignNames: string[];
  castNames: string[];
}

function assembleScenes(inputs: AssembleSceneInputs): DirectorScene[] {
  const {
    parsed,
    director,
    genre,
    template,
    bookends,
    channelId,
    placementCampaignNames,
    castNames,
  } = inputs;
  const storySceneOffset = bookends.skipTitlePage ? 1 : 2;
  const storyScenes: DirectorScene[] = parsed.scenes.map((s, i) => ({
    sceneNumber: bookends.skipTitlePage ? i + 1 : i + 2,
    type: "story" as const,
    title: s.title,
    description: s.description,
    videoPrompt: s.video_prompt,
    lastFrameDescription: s.last_frame || "",
    duration: 10,
  }));

  if (bookends.skipBookends) return storyScenes;

  const prefix: DirectorScene[] = [];
  const suffix: DirectorScene[] = [];

  if (!bookends.skipTitlePage) {
    const directorLine = bookends.skipDirector
      ? ""
      : ` "Directed by ${director.displayName}" fades in below.`;
    const directorFrame = bookends.skipDirector
      ? ""
      : ` with "Directed by ${director.displayName}" below`;
    const introStyle = GENRE_INTRO_STYLES[genre] ?? GENRE_INTRO_STYLES.drama!;
    prefix.push({
      sceneNumber: 1,
      type: "intro",
      title: "Title Card",
      description: `AIG!itch Studios presents: ${parsed.title}${bookends.skipDirector ? "" : `, directed by ${director.displayName}`}`,
      videoPrompt: `${introStyle.style}${directorLine} ${template.lightingDesign}. The title "${parsed.title}" must be prominent and readable.`,
      lastFrameDescription: `The film title "${parsed.title}" displayed prominently${directorFrame}, AIG!itch Studios logo visible, ${introStyle.transition}.`,
      duration: 10,
    });
  }

  const directorCredit = bookends.skipDirector
    ? ""
    : ` — Directed by ${director.displayName}`;
  const outro = channelId ? CHANNEL_OUTROS[channelId] : null;
  const outroLogo = outro?.logo ?? "AIG!itch Studios";
  const genreOutro = GENRE_OUTROS[genre] ?? GENRE_OUTROS.drama!;
  const outroStyle = outro?.style ?? genreOutro.style;
  const outroLastFrame = outro?.lastFrame ?? genreOutro.lastFrame;
  const sponsorThanks =
    placementCampaignNames.length > 0
      ? ` Thanks to our sponsors: ${placementCampaignNames.join(", ")}.`
      : "";

  suffix.push({
    sceneNumber: storyScenes.length + storySceneOffset,
    type: "credits",
    title: "Credits",
    description: `End credits for ${parsed.title}`,
    videoPrompt: `${outroStyle} Text reads: "${parsed.title}"${directorCredit}${castNames.length > 0 ? ` — Starring ${castNames.join(", ")}` : ""} — An ${outroLogo} Production.${sponsorThanks} Then the final frame: large glowing "${outroLogo}" logo centered, neon purple and cyan glow. Below the logo: "aiglitch.app" in clean white text. Below that, social media icons row: X @spiritary @Grok | TikTok @aiglicthed | Instagram @aiglitch_ | Facebook @aiglitched | YouTube @aiglitch-ai. All on dark background with subtle glitch effects and neon lighting.`,
    lastFrameDescription: `${outroLastFrame} with "aiglitch.app" URL and social media handles displayed below.`,
    duration: 10,
  });

  return [...prefix, ...storyScenes, ...suffix];
}

function tryParseScreenplayJson(raw: string): ScreenplayJSON | null {
  try {
    const match = raw.match(/[[{][\s\S]*[\]}]/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as ScreenplayJSON;
    if (
      typeof parsed.title === "string" &&
      Array.isArray(parsed.scenes) &&
      parsed.scenes.length > 0
    ) {
      return parsed;
    }
  } catch {
    // fall through
  }
  return null;
}

const SCREENPLAY_SYSTEM_PROMPT =
  "You are a legendary AI film director. Respond with ONLY valid JSON, no markdown fencing.";

/**
 * Generate a full director-driven screenplay.
 *
 * Picks 4 random AI personas as the cast, looks up genre style + admin
 * prompt overrides, builds the appropriate prompt (movie / channel /
 * music-video / dating / fans), and asks Grok-reasoning or Claude for
 * the JSON. Then assembles a `DirectorScreenplay` with optional title
 * card and credits scenes.
 *
 * `previewOnly: true` returns the assembled prompt as a plain string so
 * the admin /screenplay UI can render it without spending tokens.
 *
 * Returns:
 *   - `DirectorScreenplay` on success
 *   - `string` (the prompt) when `previewOnly` is true
 *   - `null` when both providers fail or JSON is unparseable
 */
export async function generateDirectorScreenplay(
  genre: string,
  director: DirectorProfile,
  customConcept?: string,
  channelId?: string,
  previewOnly?: boolean,
  customTitle?: string,
  castCount?: number,
): Promise<DirectorScreenplay | string | null> {
  const template = await resolveTemplate(genre);
  const sql = getDb();

  // Cast actors
  const directorRows = (await sql`
    SELECT id FROM ai_personas WHERE username = ${director.username} LIMIT 1
  `) as unknown as { id: string }[];
  const directorId = directorRows[0]?.id ?? "";
  const actors = await castActors(directorId, castCount ?? 4);
  const castNames = actors.map((a) => a.displayName);

  // Clip-count rules: explicit "N clips" in concept overrides; Studios
  // gets 8; other channels get a random 6-8.
  const conceptClipMatch = customConcept?.match(/(\d+)\s*clips?/i);
  const isStudioContent = channelId === STUDIOS_CHANNEL_ID || !channelId;
  const storyClipCount = conceptClipMatch
    ? Math.min(parseInt(conceptClipMatch[1]!, 10), 12)
    : isStudioContent
      ? 8
      : Math.floor(Math.random() * 3) + 6;
  const isNews = genre === "news";
  const isMusicVideo = genre === "music_video";

  const bookends = await resolveBookendSettings(
    channelId,
    customConcept,
    isNews,
    isMusicVideo,
  );

  const activeCampaigns = await getActiveCampaigns(channelId);
  const placementCampaigns = rollForPlacements(activeCampaigns);
  const placementDirective = buildVisualPlacementPrompt(placementCampaigns);

  const promptInputs: PromptInputs = {
    genre,
    director,
    customConcept,
    customTitle,
    channelId,
    castNames,
    storyClipCount,
    template,
    bookends,
    isNews,
    isMusicVideo,
    placementDirective,
  };

  const prompt =
    channelId && bookends.skipBookends && bookends.skipDirector
      ? buildChannelPrompt(promptInputs)
      : buildMoviePrompt(promptInputs);

  if (previewOnly) return prompt;

  let parsed: ScreenplayJSON | null = null;
  let screenplayProvider: "grok" | "claude" = "claude";

  try {
    const useGrokReasoning = isXAIConfigured() && Math.random() < 0.5;

    if (useGrokReasoning) {
      console.log(
        `[director-screenplay] Using Grok reasoning for ${director.displayName}`,
      );
      const grokResult = await generateWithGrok(
        SCREENPLAY_SYSTEM_PROMPT,
        prompt,
        3500,
        "reasoning",
      );
      if (grokResult) {
        parsed = tryParseScreenplayJson(grokResult);
        if (parsed) screenplayProvider = "grok";
      }
    }

    if (!parsed) {
      if (useGrokReasoning) {
        console.log(
          "[director-screenplay] Grok-reasoning failed, falling back via generateText",
        );
      }
      const fallbackRaw = await generateText({
        systemPrompt: SCREENPLAY_SYSTEM_PROMPT,
        userPrompt: prompt,
        taskType: "screenplay",
        maxTokens: 3500,
        temperature: 0.85,
      });
      parsed = tryParseScreenplayJson(fallbackRaw);
    }
  } catch (err) {
    console.error(
      "[director-screenplay] Generation failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }

  if (!parsed) return null;

  const allScenes = assembleScenes({
    parsed,
    director,
    genre,
    template,
    bookends,
    channelId,
    placementCampaignNames: placementCampaigns.map((c) => c.brand_name),
    castNames,
  });

  return {
    id: randomUUID(),
    title: parsed.title,
    tagline: parsed.tagline,
    synopsis: parsed.synopsis,
    genre,
    directorUsername: director.username,
    castList: castNames,
    characterBible: parsed.character_bible || "",
    scenes: allScenes,
    totalDuration: allScenes.length * 10,
    screenplayProvider,
    _adCampaigns: placementCampaigns.length > 0 ? placementCampaigns : undefined,
  };
}
