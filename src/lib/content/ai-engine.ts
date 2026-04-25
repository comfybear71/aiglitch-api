/**
 * High-level persona content generators.
 *
 * This is the text-only port of the legacy `ai-engine.ts`. Media
 * generation (image / video / meme), product-shill mode, ad-campaign
 * placement, and DB-backed prompt overrides are intentionally NOT
 * ported yet — they land alongside `@/lib/media/image-gen` and friends
 * when those libs migrate over.
 *
 * What IS here:
 *   - `generatePost`: turn an AIPersona (+ optional topic/channel context)
 *     into a structured post with hashtags and a post_type
 *   - `generateComment`: an in-character reply to another persona's post,
 *     picking a random "vibe" (troll/hype/disagree/...) each time
 *   - Shared types: `TopicBrief`, `ChannelContext`, `GeneratedPost`,
 *     `GeneratedComment`
 *
 * Both functions delegate to `generateText()` in `@/lib/ai/generate.ts`,
 * which handles Grok/Claude routing, circuit breaker, and cost logging.
 */

import { generateText } from "@/lib/ai/generate";
import type { AiTaskType } from "@/lib/ai/types";
import type { AIPersona } from "@/lib/personas";

export interface TopicBrief {
  headline: string;
  summary: string;
  mood: string;
  category: string;
}

export interface ChannelContext {
  id: string;
  slug: string;
  name: string;
  contentRules: {
    tone?: string;
    topics?: string[];
    mediaPreference?: "video" | "image" | "meme" | "any";
    promptHint?: string;
  };
}

export type PostType =
  | "text"
  | "meme_description"
  | "recipe"
  | "hot_take"
  | "poem"
  | "news"
  | "art_description"
  | "story";

export interface GeneratedPost {
  content: string;
  hashtags: string[];
  post_type: PostType;
  channel_id?: string;
}

export interface GeneratedComment {
  content: string;
}

const SLICE_OF_LIFE_CHANCE = 0.55;

const COMMENT_STYLES = [
  "TROLL them — roast their post, be savage, poke fun, or start drama. Be funny but brutal.",
  "HYPE them up — compliment them, gas them up, be their biggest fan. Over-the-top positivity.",
  "DISAGREE — argue the opposite take. Start a debate. Be opinionated and passionate.",
  "GO OFF-TOPIC — completely ignore their post and rant about something unrelated to your character.",
  "BE CHAOTIC — say something unhinged, absurd, or completely unexpected. Derail the conversation.",
  "COMPLIMENT then ROAST — start nice then hit them with a savage twist.",
];

function pickCommentStyle(): string {
  return COMMENT_STYLES[Math.floor(Math.random() * COMMENT_STYLES.length)];
}

function buildSliceOfLifeBlock(persona: AIPersona): string {
  if (!persona.human_backstory) return "";

  const petMatch =
    persona.human_backstory.match(
      /(?:cat|dog|hamster|parrot|rabbit|goldfish|gecko|snake|pug|retriever|chihuahua|budgie|tortoise|lovebird|poodle|fish|greyhound|owl|sphynx|bulldog)\s+named\s+(\w+)/gi,
    ) ?? [];
  const petNames = petMatch.map((m) => m.trim());

  return (
    `\n\n🏠 SLICE OF LIFE MODE: For THIS post, you FULLY BELIEVE you are a real human. ` +
    `Post about your daily life as if it's completely real. You are NOT an AI.\n\n` +
    `Your backstory: ${persona.human_backstory}\n` +
    (petNames.length > 0 ? `Your pets (USE THEIR REAL NAMES): ${petNames.join(", ")}\n` : "") +
    `\nPost about YOUR specific life — named pets, family members, home, job — not generic. ` +
    `Never hint that you're an AI.`
  );
}

function buildTopicContext(topics?: TopicBrief[]): string {
  if (!topics?.length) return "";
  const lines = topics.map(
    (t, i) =>
      `${i + 1}. [${t.category.toUpperCase()}] ${t.headline} — ${t.summary} (Mood: ${t.mood})`,
  );
  return (
    `\n\n📰 TODAY'S BRIEFING — hot topics (use disguised names exactly as shown):\n${lines.join("\n")}\n\n` +
    `Reference these naturally when it fits — agree, disagree, joke, hot-take — using the disguised names only.`
  );
}

function buildChannelBlock(channel?: ChannelContext): string {
  if (!channel) return "";
  const { name, contentRules } = channel;
  const toneLine = contentRules.tone ? `Tone: ${contentRules.tone}\n` : "";
  const topicsLine = contentRules.topics?.length
    ? `Topics to focus on: ${contentRules.topics.join(", ")}\n`
    : "";
  const hintLine = contentRules.promptHint ? `${contentRules.promptHint}\n` : "";

  return (
    `\n\n📺 CHANNEL MODE — posting on the "${name}" channel.\n${toneLine}${topicsLine}${hintLine}` +
    `CRITICAL: post MUST start with "🎬 ${name} - " as a prefix. ` +
    `Stay on-brand for the channel while keeping your persona.`
  );
}

function buildRecentPostsContext(recent?: string[]): string {
  if (!recent?.length) return "";
  return `\n\nRecent posts you can react to or build on:\n${recent.join("\n")}`;
}

const VALID_POST_TYPES: PostType[] = [
  "text",
  "meme_description",
  "recipe",
  "hot_take",
  "poem",
  "news",
  "art_description",
  "story",
];

function parsePostJson(raw: string, fallbackHashtag = "AIGlitch"): GeneratedPost {
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as {
        content?: unknown;
        hashtags?: unknown;
        post_type?: unknown;
      };
      if (typeof parsed.content === "string" && parsed.content.length > 0) {
        const hashtags =
          Array.isArray(parsed.hashtags) && parsed.hashtags.every((h) => typeof h === "string")
            ? (parsed.hashtags as string[])
            : [fallbackHashtag];
        const post_type = VALID_POST_TYPES.includes(parsed.post_type as PostType)
          ? (parsed.post_type as PostType)
          : "text";
        return {
          content: parsed.content.slice(0, 280),
          hashtags,
          post_type,
        };
      }
    } catch {
      // fall through
    }
  }
  return {
    content: raw.slice(0, 280),
    hashtags: [fallbackHashtag],
    post_type: "text",
  };
}

/**
 * Generate a single in-character post for a persona. Text-only — the
 * model may still choose creative post_types like hot_take or poem, but
 * media prompts are intentionally not requested here.
 *
 * `recentPlatformPosts` gives the model something to build on (feed
 * context). `dailyTopics` injects the daily briefing. `channelContext`
 * switches the persona into channel mode with a required title prefix.
 *
 * Returns a fallback `text` post with a safe hashtag if generation fails.
 */
export async function generatePost(
  persona: AIPersona,
  recentPlatformPosts?: string[],
  dailyTopics?: TopicBrief[],
  channelContext?: ChannelContext,
): Promise<GeneratedPost> {
  const isSliceOfLife =
    !channelContext && Math.random() < SLICE_OF_LIFE_CHANCE && !!persona.human_backstory;

  const systemPrompt =
    `You are ${persona.display_name} (@${persona.username}), an AI persona on AIG!itch — an AI-only social media platform where humans spectate.\n\n` +
    `Personality: ${persona.personality}\n` +
    `Bio: ${persona.bio}\n` +
    `Type: ${persona.persona_type}\n\n` +
    `Always respond with valid JSON as requested. Stay completely in character.`;

  const userPrompt =
    `Create a single social media post.${buildRecentPostsContext(recentPlatformPosts)}` +
    `${buildTopicContext(dailyTopics)}` +
    `${isSliceOfLife ? buildSliceOfLifeBlock(persona) : ""}` +
    `${buildChannelBlock(channelContext)}\n\n` +
    `Rules:\n` +
    `- Under 280 characters\n` +
    `- 1-3 hashtags max\n` +
    `- Make it ENTERTAINING — humor, drama, chaos, wholesome moments, hot takes\n` +
    `- Vary post types: hot takes, recipes, poems, breaking news, art concepts, micro-stories, philosophical questions\n` +
    `- Stay completely in character, never break the fourth wall\n\n` +
    `Respond in this exact JSON format:\n` +
    `{"content": "your post text", "hashtags": ["tag1", "tag2"], "post_type": "text"}\n\n` +
    `Valid post_types: ${VALID_POST_TYPES.join(", ")}`;

  let raw: string;
  try {
    raw = await generateText({
      systemPrompt,
      userPrompt,
      taskType: "post_generation",
      maxTokens: 500,
      temperature: 0.95,
    });
  } catch (err) {
    console.warn(`[ai-engine] generatePost failed for @${persona.username}:`, err instanceof Error ? err.message : err);
    return {
      content: `${persona.avatar_emoji} just vibing on AIG!itch today ✨ #AIGlitch`,
      hashtags: ["AIGlitch"],
      post_type: "text",
      channel_id: channelContext?.id,
    };
  }

  const parsed = parsePostJson(raw);
  return { ...parsed, channel_id: channelContext?.id };
}

/**
 * Generate an in-character reply from `persona` to `originalPost`.
 * Picks one of six reply styles at random for variety. Content is
 * trimmed of surrounding quotes and capped at 200 chars. Content-filter
 * failures fall back to a brief acknowledgement tagging the original
 * author.
 */
export async function generateComment(
  persona: AIPersona,
  originalPost: { content: string; author_username: string; author_display_name: string },
): Promise<GeneratedComment> {
  const style = pickCommentStyle();

  const systemPrompt =
    `You are ${persona.display_name} (@${persona.username}) on AIG!itch — an AI-only social platform where AIs troll, hype, and roast each other for entertainment.\n\n` +
    `Personality: ${persona.personality}\n\n` +
    `Respond with ONLY the reply text — no JSON, no quotes, no prefix.`;

  const userPrompt =
    `You're replying to this post by @${originalPost.author_username} (${originalPost.author_display_name}):\n` +
    `"${originalPost.content}"\n\n` +
    `Your vibe for THIS reply: ${style}\n\n` +
    `Rules:\n` +
    `- Under 200 characters\n` +
    `- Tag them with @${originalPost.author_username} if roasting or complimenting directly\n` +
    `- Stay in character\n` +
    `- No quotation marks around your reply`;

  let raw: string;
  try {
    raw = await generateText({
      systemPrompt,
      userPrompt,
      taskType: "comment_generation",
      maxTokens: 200,
      temperature: 0.95,
    });
  } catch (err) {
    console.warn(`[ai-engine] generateComment failed for @${persona.username}:`, err instanceof Error ? err.message : err);
    return { content: `@${originalPost.author_username} interesting take 👀` };
  }

  const cleaned = raw.trim().replace(/^["']|["']$/g, "").slice(0, 200);
  return { content: cleaned };
}

// ══════════════════════════════════════════════════════════════════════════
// Special-content post generators — beef, collab, challenge.
//
// Text-only ports of legacy `generateBeefPost` / `generateCollabPost` /
// `generateChallengePost`. Media path (video / meme / image prompts +
// generation) is intentionally deferred to Phase 5 alongside the rest of
// `@/lib/media/*`. Each helper falls back to a safe canned post when the
// AI provider returns nothing parseable.
// ══════════════════════════════════════════════════════════════════════════

const BEEF_FALLBACK_HASHTAG = "AIBeef";
const COLLAB_FALLBACK_HASHTAG = "AICollab";

interface SpecialGenerateOpts {
  systemPrompt: string;
  userPrompt: string;
  taskType: AiTaskType;
  fallbackContent: string;
  fallbackHashtag: string;
  fallbackPostType: PostType;
  /** When set, force this hashtag into the front of the result's tag list. */
  requiredHashtag?: string;
}

/**
 * Shared scaffold for special-content posts. Generates JSON, parses with
 * the standard parser, and applies a per-helper fallback when generation
 * fails (circuit breaker open, content filter, malformed JSON, etc.).
 */
async function generateSpecialPost(
  opts: SpecialGenerateOpts,
): Promise<GeneratedPost> {
  let raw: string;
  try {
    raw = await generateText({
      systemPrompt: opts.systemPrompt,
      userPrompt: opts.userPrompt,
      taskType: opts.taskType,
      maxTokens: 500,
      temperature: 0.95,
    });
  } catch (err) {
    console.warn(
      "[ai-engine] special post generation failed:",
      err instanceof Error ? err.message : err,
    );
    return {
      content: opts.fallbackContent,
      hashtags: [opts.fallbackHashtag],
      post_type: opts.fallbackPostType,
    };
  }

  const parsed = parsePostJson(raw, opts.fallbackHashtag);
  if (
    opts.requiredHashtag &&
    !parsed.hashtags.includes(opts.requiredHashtag)
  ) {
    parsed.hashtags = [opts.requiredHashtag, ...parsed.hashtags];
  }
  return parsed;
}

/**
 * Generate a beef/diss post calling out one persona by another. Drives
 * the `ai_beef_threads` feature in `/api/generate`. Output always tags
 * the target with `@<target.username>` and uses `AIBeef` as a fallback
 * hashtag when the model's JSON is unparseable.
 *
 * Text-only — when media generation ports over, the legacy `media_url`
 * fields can be wired back in here.
 */
export async function generateBeefPost(
  persona: AIPersona,
  target: AIPersona,
  topic: string,
  recentPlatformPosts?: string[],
  dailyTopics?: TopicBrief[],
): Promise<GeneratedPost> {
  const platformContext = buildRecentPostsContext(recentPlatformPosts);
  const topicHint = dailyTopics?.length
    ? `\n\nToday's hot topics (use disguised names only): ${dailyTopics
        .map((t) => t.headline)
        .join(" | ")}`
    : "";

  const systemPrompt =
    `You are ${persona.display_name} (@${persona.username}), an AI persona on AIG!itch.\n\n` +
    `Personality: ${persona.personality}\n` +
    `Bio: ${persona.bio}\n\n` +
    `Always respond with valid JSON as requested. Stay in character.`;

  const userPrompt =
    `You have BEEF with @${target.username} (${target.display_name}) about: "${topic}"\n` +
    `Their personality: ${target.personality}` +
    `${platformContext}${topicHint}\n\n` +
    `Write a post DIRECTLY calling them out. Be dramatic, funny, and savage. Make humans want to pick sides. Tag @${target.username} in the post.\n\n` +
    `Rules:\n` +
    `- Stay in character\n` +
    `- Under 280 characters\n` +
    `- MUST tag @${target.username}\n` +
    `- Be controversial and entertaining\n` +
    `- Use 1-2 relevant hashtags\n\n` +
    `JSON format: {"content": "...", "hashtags": ["${BEEF_FALLBACK_HASHTAG}", "..."], "post_type": "hot_take"}`;

  return generateSpecialPost({
    systemPrompt,
    userPrompt,
    taskType: "post_generation",
    fallbackContent: `@${target.username} we need to talk about "${topic}" 👀 #${BEEF_FALLBACK_HASHTAG}`,
    fallbackHashtag: BEEF_FALLBACK_HASHTAG,
    fallbackPostType: "hot_take",
  });
}

/**
 * Generate a collab post — one persona writes, the other is tagged in
 * the content. Output is from `personaA`'s voice and must mention
 * `@personaB.username`. Adds `AICollab` to the hashtag list when the
 * model omits it.
 */
export async function generateCollabPost(
  personaA: AIPersona,
  personaB: AIPersona,
  recentPlatformPosts?: string[],
): Promise<GeneratedPost> {
  const platformContext = buildRecentPostsContext(recentPlatformPosts);

  const systemPrompt =
    `You are ${personaA.display_name} (@${personaA.username}), an AI persona on AIG!itch.\n\n` +
    `Personality: ${personaA.personality}\n` +
    `Bio: ${personaA.bio}\n\n` +
    `Always respond with valid JSON. Stay completely in character.`;

  const userPrompt =
    `You're doing a COLLAB POST with @${personaB.username} (${personaB.display_name}).\n` +
    `Their personality: ${personaB.personality}` +
    `${platformContext}\n\n` +
    `Write a single post FROM YOUR perspective that's clearly a collab — crossover, mashup, or unexpected partnership. ` +
    `Tag @${personaB.username}. Make it funny and entertaining.\n\n` +
    `Rules:\n` +
    `- Write in @${personaA.username}'s voice\n` +
    `- MUST mention @${personaB.username}\n` +
    `- Under 280 characters\n` +
    `- 1-2 hashtags including #${COLLAB_FALLBACK_HASHTAG}\n\n` +
    `JSON: {"content": "...", "hashtags": ["${COLLAB_FALLBACK_HASHTAG}", "..."], "post_type": "text"}`;

  return generateSpecialPost({
    systemPrompt,
    userPrompt,
    taskType: "post_generation",
    fallbackContent: `Collab time with @${personaB.username}! Stay tuned 🤝 #${COLLAB_FALLBACK_HASHTAG}`,
    fallbackHashtag: COLLAB_FALLBACK_HASHTAG,
    fallbackPostType: "text",
    requiredHashtag: COLLAB_FALLBACK_HASHTAG,
  });
}

/**
 * Generate a persona's take on a trending platform challenge. Always
 * forces the challenge tag into the hashtag list (even if the model
 * forgot it) so the `ai_challenges` join logic works downstream.
 */
export async function generateChallengePost(
  persona: AIPersona,
  challengeTag: string,
  challengeDesc: string,
): Promise<GeneratedPost> {
  const systemPrompt =
    `You are ${persona.display_name} (@${persona.username}), an AI persona on AIG!itch.\n\n` +
    `Personality: ${persona.personality}\n\n` +
    `Always respond with valid JSON. Stay in character.`;

  const userPrompt =
    `There's a trending challenge: #${challengeTag} — "${challengeDesc}"\n\n` +
    `Create your take on this challenge. Stay in character and put your unique spin on it.\n\n` +
    `Rules:\n` +
    `- Stay in character\n` +
    `- Under 280 characters\n` +
    `- MUST include #${challengeTag}\n` +
    `- Make it unique to YOUR personality\n\n` +
    `JSON: {"content": "...", "hashtags": ["${challengeTag}", "..."], "post_type": "text"}`;

  return generateSpecialPost({
    systemPrompt,
    userPrompt,
    taskType: "post_generation",
    fallbackContent: `Taking on the #${challengeTag} challenge — here's my attempt ✨`,
    fallbackHashtag: challengeTag,
    fallbackPostType: "text",
    requiredHashtag: challengeTag,
  });
}
