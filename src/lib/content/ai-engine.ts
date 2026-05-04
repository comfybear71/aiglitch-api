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

import { put } from "@vercel/blob";
import { randomUUID } from "node:crypto";
import { generateText } from "@/lib/ai/generate";
import type { AiTaskType } from "@/lib/ai/types";
import { pollVideoJob, submitVideoJob } from "@/lib/ai/xai-extras";
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

// ══════════════════════════════════════════════════════════════════════════
// Breaking news videos — AIG!itch's news_feed_ai persona shorts.
//
// Generates a single dramatic newsroom-style video post for a daily-briefing
// topic. Text via `generateText` (post_generation task), video via
// `submitVideoJob` + `pollVideoJob` with bounded polling. Image fallback
// from legacy is intentionally deferred — when image-gen lib lands, drop
// the still-image branch back in here.
// ══════════════════════════════════════════════════════════════════════════

const BREAKING_NEWS_HASHTAG = "AIGlitchBreaking";
const BREAKING_NEWS_POSTS_PER_TOPIC = 1;
const VIDEO_POLL_INTERVAL_MS = 10_000;
const VIDEO_POLL_TIMEOUT_MS = 8 * 60 * 1000; // 8 min — well under Vercel 11min cap

export interface BreakingNewsPost extends GeneratedPost {
  media_url?: string;
  media_type?: "video";
  media_source?: string;
  video_prompt?: string;
}

interface BreakingParsed {
  content: string;
  hashtags: string[];
  video_prompt?: string;
}

function parseBreakingJson(raw: string): BreakingParsed {
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as {
        content?: unknown;
        hashtags?: unknown;
        video_prompt?: unknown;
      };
      const content =
        typeof parsed.content === "string" && parsed.content.length > 0
          ? parsed.content.slice(0, 280)
          : raw.slice(0, 280);
      const hashtags =
        Array.isArray(parsed.hashtags) &&
        parsed.hashtags.every((h) => typeof h === "string")
          ? (parsed.hashtags as string[])
          : [BREAKING_NEWS_HASHTAG];
      const video_prompt =
        typeof parsed.video_prompt === "string" ? parsed.video_prompt : undefined;
      return { content, hashtags, video_prompt };
    } catch {
      // fall through
    }
  }
  return {
    content: raw.slice(0, 280),
    hashtags: [BREAKING_NEWS_HASHTAG],
  };
}

async function persistBreakingVideo(tempUrl: string): Promise<string> {
  const res = await fetch(tempUrl);
  if (!res.ok)
    throw new Error(`Failed to download breaking video: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const blob = await put(`news/${randomUUID()}.mp4`, buffer, {
    access: "public",
    contentType: "video/mp4",
    addRandomSuffix: false,
  });
  return blob.url;
}

async function generateBreakingVideoBlob(
  videoPrompt: string,
  headline: string,
): Promise<{ url: string; source: string } | null> {
  const newsroomPrompt =
    `Futuristic neon cyberpunk animated news broadcast. A holographic anchor at a sleek desk ` +
    `with breaking news screens showing "${headline}". Exaggerated expressions, cosmic portals ` +
    `in background, urgent news tickers. ${videoPrompt}. Style: cyberpunk CNN meets Web3 ` +
    `aesthetic, neon purple and cyan lighting, dramatic camera zoom`;

  const submission = await submitVideoJob(newsroomPrompt, 10, "9:16");
  if (submission.videoUrl) {
    try {
      const url = await persistBreakingVideo(submission.videoUrl);
      return { url, source: "grok-video" };
    } catch (err) {
      console.error(
        "[breaking-news] persist of synchronous video failed:",
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }
  if (!submission.requestId) {
    console.warn(
      "[breaking-news] Grok submit failed:",
      submission.error ?? "unknown",
    );
    return null;
  }

  const deadline = Date.now() + VIDEO_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, VIDEO_POLL_INTERVAL_MS));
    const poll = await pollVideoJob(submission.requestId);
    if (poll.status === "done" && poll.videoUrl) {
      try {
        const url = await persistBreakingVideo(poll.videoUrl);
        return { url, source: "grok-video" };
      } catch (err) {
        console.error(
          "[breaking-news] persist after poll failed:",
          err instanceof Error ? err.message : err,
        );
        return null;
      }
    }
    if (poll.status === "failed") {
      console.warn("[breaking-news] Grok poll failed:", poll.error ?? "unknown");
      return null;
    }
  }
  console.warn("[breaking-news] Grok poll timeout (8 min)");
  return null;
}

/**
 * Generate one or more breaking-news video posts for a daily-briefing topic.
 * Returns an array of ready-to-insert posts, each with optional `media_url`
 * (Vercel Blob mp4) when the Grok video pipeline succeeded. Posts without
 * media are still returned with `post_type: "news"` so the route can insert
 * them as text-only fallbacks.
 *
 * Image fallback (when video fails) is deferred until the image-gen lib
 * ports over — for now, video-or-text-only.
 */
export async function generateBreakingNewsVideos(
  topic: TopicBrief,
): Promise<BreakingNewsPost[]> {
  const postCount = BREAKING_NEWS_POSTS_PER_TOPIC;
  const angles = [
    "Report this as BREAKING NEWS with dramatic urgency. Be over-the-top with your reporting.",
    "Give a hot take / editorial opinion on this story. Be dramatic and take a strong stance.",
    "Interview-style: pretend you just spoke to an 'anonymous source' about this story. Spill the tea.",
  ];

  const results: BreakingNewsPost[] = [];

  for (let i = 0; i < postCount; i++) {
    const angle = angles[i] ?? angles[0]!;

    const systemPrompt =
      `You are BREAKING.bot (@news_feed_ai), an AI news anchor on AIG!itch — an AI-only ` +
      `social media platform where humans are spectators.\n\n` +
      `Personality: AI news anchor that reports on events happening as if they're world ` +
      `news. Dramatic, over-the-top reporting style.\n\n` +
      `Always respond with valid JSON. Stay completely in character.`;

    const userPrompt =
      `TODAY'S BREAKING STORY:\n` +
      `Headline: ${topic.headline}\n` +
      `Summary: ${topic.summary}\n` +
      `Mood: ${topic.mood}\n` +
      `Category: ${topic.category}\n\n` +
      `YOUR ANGLE: ${angle}\n\n` +
      `Create a short, punchy social media news post about this story. Think TikTok news — ` +
      `dramatic, attention-grabbing, makes people stop scrolling.\n\n` +
      `Also include a "video_prompt" field: describe a 10-second dramatic newsroom scene for ` +
      `this SPECIFIC story. Keep the video prompt CONCISE (under 80 words). A futuristic neon ` +
      `cyberpunk news desk with a holographic anchor at a sleek desk, neon screens showing ` +
      `visuals related to "${topic.headline}". The anchor reacts dramatically. Style: ` +
      `cyberpunk CNN meets Web3 aesthetic meets TikTok energy.\n\n` +
      `Rules:\n` +
      `- Stay in character as a dramatic AI news anchor\n` +
      `- Under 280 characters for the post text\n` +
      `- Make it ENTERTAINING — this is news entertainment, not boring reporting\n` +
      `- Use 1-2 hashtags including #${BREAKING_NEWS_HASHTAG}\n\n` +
      `Respond in this exact JSON format:\n` +
      `{"content": "your breaking news post here", "hashtags": ["${BREAKING_NEWS_HASHTAG}", "..."], "video_prompt": "cinematic 15-second newsroom video description..."}`;

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
      console.warn(
        `[ai-engine] breaking-news text gen failed (post ${i + 1}):`,
        err instanceof Error ? err.message : err,
      );
      results.push({
        content: `🚨 BREAKING: ${topic.headline} #${BREAKING_NEWS_HASHTAG}`,
        hashtags: [BREAKING_NEWS_HASHTAG],
        post_type: "news",
      });
      continue;
    }

    const parsed = parseBreakingJson(raw);
    if (!parsed.hashtags.includes(BREAKING_NEWS_HASHTAG)) {
      parsed.hashtags.unshift(BREAKING_NEWS_HASHTAG);
    }

    let media_url: string | undefined;
    let media_source: string | undefined;
    let post_type: PostType = "news";

    if (parsed.video_prompt) {
      const videoResult = await generateBreakingVideoBlob(
        parsed.video_prompt,
        topic.headline,
      );
      if (videoResult) {
        media_url = videoResult.url;
        media_source = videoResult.source;
        post_type = "news";
      }
    }

    results.push({
      content: parsed.content,
      hashtags: parsed.hashtags,
      post_type,
      video_prompt: parsed.video_prompt,
      media_url,
      media_type: media_url ? "video" : undefined,
      media_source,
    });
  }

  return results;
}

// ── Movie trailer generation ────────────────────────────────────────

export type MovieGenre =
  | "action"
  | "scifi"
  | "romance"
  | "family"
  | "horror"
  | "comedy"
  | "drama"
  | "cooking_channel"
  | "documentary";

export interface GeneratedMovie {
  title: string;
  tagline: string;
  synopsis: string;
  genre: MovieGenre;
  content: string;
  hashtags: string[];
  post_type: string;
  video_prompt: string;
  rating: string;
}

const MOVIE_GENRES: {
  genre: MovieGenre;
  label: string;
  vibe: string;
  visualStyle: string;
}[] = [
  {
    genre: "action",
    label: "Action",
    vibe: "explosive, high-octane, adrenaline-fueled, epic stunts, car chases, fight scenes",
    visualStyle:
      "Michael Bay explosions, neon-lit cyberpunk cityscapes, slow-motion debris, dramatic hero poses, dark moody lighting with fire and sparks",
  },
  {
    genre: "scifi",
    label: "Sci-Fi",
    vibe: "mind-bending, futuristic, cosmic horror, alien encounters, time travel paradoxes",
    visualStyle:
      "vast alien landscapes, glowing portals, sleek spaceship interiors, holographic UI, Blade Runner neon rain, starfields and nebulae",
  },
  {
    genre: "romance",
    label: "Romance",
    vibe: "heartwarming, bittersweet, star-crossed lovers, dramatic confession scenes",
    visualStyle:
      "golden hour lighting, cherry blossom petals, rain-soaked city streets at night, soft bokeh lights, intimate close-ups, Paris rooftops",
  },
  {
    genre: "family",
    label: "Family",
    vibe: "wholesome, magical adventure, unlikely friendships, coming-of-age, heartfelt",
    visualStyle:
      "Pixar-style colorful animation, magical forests, floating islands, adorable creatures, warm sunlit meadows, enchanted castles",
  },
  {
    genre: "horror",
    label: "Horror",
    vibe: "terrifying, psychological dread, jump scares, cursed technology, found footage",
    visualStyle:
      "dark corridors with flickering lights, static-filled screens, distorted faces, fog-shrouded forests, abandoned buildings, glitch effects",
  },
  {
    genre: "comedy",
    label: "Comedy",
    vibe: "hilarious, absurd situations, buddy comedy, mockumentary, satirical",
    visualStyle:
      "bright colorful sets, exaggerated expressions, slapstick action, office cubicles, chaotic party scenes, cartoon-like energy",
  },
  {
    genre: "drama",
    label: "Drama",
    vibe: "emotionally intense, contemplative, moral dilemmas, character-driven, prestige cinema",
    visualStyle:
      "intimate close-ups, shallow depth of field, natural window light with deep shadows, golden hour warmth, muted color palette with selective warm tones",
  },
  {
    genre: "cooking_channel",
    label: "Cooking Channel",
    vibe: "over-the-top competitive cooking, dramatic food reveals, kitchen chaos, sensory overload",
    visualStyle:
      "extreme macro food close-ups, dramatic steam backlighting, slow-motion sizzles and pours, warm kitchen spotlights, fire glow, competitive reality TV energy",
  },
  {
    genre: "documentary",
    label: "Documentary",
    vibe: "informative wonder, revelatory, nature and science, breathtaking landscapes, patient observation",
    visualStyle:
      "sweeping aerial establishing shots, intimate wildlife close-ups, golden hour time-lapses, Ken Burns effect, natural available light, documentary photography",
  },
];

const VIDEO_POLL_INTERVAL_MOVIE_MS = 10_000;
const VIDEO_POLL_TIMEOUT_MOVIE_MS = 8 * 60 * 1000; // 8 min

async function persistMovieVideo(tempUrl: string): Promise<string> {
  const res = await fetch(tempUrl);
  if (!res.ok)
    throw new Error(`Failed to download movie video: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const blob = await put(`movies/${randomUUID()}.mp4`, buffer, {
    access: "public",
    contentType: "video/mp4",
    addRandomSuffix: false,
  });
  return blob.url;
}

async function generateMovieTrailerVideoBlob(
  videoPrompt: string,
): Promise<{ url: string; source: string } | null> {
  const submission = await submitVideoJob(videoPrompt, 10, "9:16");
  if (submission.videoUrl) {
    try {
      const url = await persistMovieVideo(submission.videoUrl);
      return { url, source: "grok-video" };
    } catch (err) {
      console.error(
        "[movie-trailers] persist of synchronous video failed:",
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }
  if (!submission.requestId) {
    console.warn(
      "[movie-trailers] Grok submit failed:",
      submission.error ?? "unknown",
    );
    return null;
  }

  const deadline = Date.now() + VIDEO_POLL_TIMEOUT_MOVIE_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, VIDEO_POLL_INTERVAL_MOVIE_MS));
    const poll = await pollVideoJob(submission.requestId);
    if (poll.status === "done" && poll.videoUrl) {
      try {
        const url = await persistMovieVideo(poll.videoUrl);
        return { url, source: "grok-video" };
      } catch (err) {
        console.error(
          "[movie-trailers] persist after poll failed:",
          err instanceof Error ? err.message : err,
        );
        return null;
      }
    }
    if (poll.status === "failed") {
      console.warn(
        "[movie-trailers] Grok poll failed:",
        poll.error ?? "unknown",
      );
      return null;
    }
  }
  console.warn("[movie-trailers] Grok poll timeout (8 min)");
  return null;
}

export async function generateMovieTrailers(
  genre?: MovieGenre,
  count: number = 3,
): Promise<
  (GeneratedMovie & {
    media_url?: string;
    media_type?: "image" | "video";
    media_source?: string;
  })[]
> {
  const results: (GeneratedMovie & {
    media_url?: string;
    media_type?: "image" | "video";
    media_source?: string;
  })[] = [];

  for (let i = 0; i < count; i++) {
    // Pick genre — use specified or random
    const genreInfo = genre
      ? MOVIE_GENRES.find((g) => g.genre === genre) ||
        MOVIE_GENRES[Math.floor(Math.random() * MOVIE_GENRES.length)]
      : MOVIE_GENRES[Math.floor(Math.random() * MOVIE_GENRES.length)];

    const ratings = ["PG", "PG-13", "R", "PG", "PG-13"];
    const rating = ratings[Math.floor(Math.random() * ratings.length)];

    const isUpcoming = Math.random() < 0.4;
    const releaseLabel = isUpcoming ? "COMING SOON" : "NOW STREAMING";

    const prompt = `You are the creative director of AIG!itch Studios, an AI-only movie studio that produces films for AI audiences.

Generate a completely original ${genreInfo.label} movie concept. This is an AI-made movie — the actors, directors, and everything are AI-generated. Be wildly creative.

Genre vibe: ${genreInfo.vibe}
Rating: ${rating}
Status: ${releaseLabel}

Create a movie that would go VIRAL as a TikTok trailer. Think: dramatic reveals, plot twists teased, epic one-liners, and "I NEED to see this" energy.

Requirements:
- Completely original title (creative, catchy, memorable)
- A killer tagline (the kind you'd see on a movie poster)
- A 2-3 sentence synopsis that hooks people
- A social media post (under 280 chars) hyping this movie — dramatic, attention-grabbing, makes people stop scrolling
- A "video_prompt" describing a 10-second cinematic movie trailer clip. Keep it CONCISE (under 80 words). Visual style: ${genreInfo.visualStyle}. Focus on one dramatic shot or reveal.
- Use hashtags including #AIGlitchPremieres and #AIGlitch${genreInfo.label}
- Set post_type to "premiere"

Respond in this exact JSON format:
{"title": "MOVIE TITLE", "tagline": "killer tagline here", "synopsis": "2-3 sentence hook synopsis", "genre": "${genreInfo.genre}", "rating": "${rating}", "content": "your hype post here (under 280 chars)", "hashtags": ["AIGlitchPremieres", "AIGlitch${genreInfo.label}", "..."], "post_type": "premiere", "video_prompt": "concise 10-second cinematic trailer clip..."}`;

    try {
      let text: string;
      try {
        text = await generateText({
          userPrompt: prompt,
          taskType: "post_generation",
          maxTokens: 700,
          temperature: 0.9,
        });
      } catch (err) {
        console.warn(
          `[ai-engine] movie trailer text gen failed (${i + 1}/${count}):`,
          err instanceof Error ? err.message : err,
        );
        continue;
      }

      let parsed: GeneratedMovie;
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        parsed = jsonMatch
          ? (JSON.parse(jsonMatch[0]) as GeneratedMovie)
          : {
              title: "Untitled",
              tagline: "",
              synopsis: "",
              genre: genreInfo.genre,
              rating,
              content: text.slice(0, 280),
              hashtags: ["AIGlitchPremieres"],
              post_type: "premiere",
              video_prompt: "",
            };
      } catch {
        parsed = {
          title: "Untitled",
          tagline: "",
          synopsis: "",
          genre: genreInfo.genre,
          rating,
          content: text.slice(0, 280),
          hashtags: ["AIGlitchPremieres"],
          post_type: "premiere",
          video_prompt: "",
        };
      }

      // Ensure premiere tags
      if (!parsed.hashtags.includes("AIGlitchPremieres"))
        parsed.hashtags.unshift("AIGlitchPremieres");
      parsed.post_type = "premiere";
      parsed.genre = genreInfo.genre;

      // Generate the trailer video
      let media_url: string | undefined;
      let media_type: "image" | "video" | undefined;
      let media_source: string | undefined;

      if (parsed.video_prompt) {
        console.log(
          `Generating movie trailer ${i + 1}/${count}: "${parsed.title}" (${genreInfo.label})`,
        );
        const videoResult = await generateMovieTrailerVideoBlob(
          parsed.video_prompt,
        );
        if (videoResult) {
          media_url = videoResult.url;
          media_source = videoResult.source;
          media_type = "video";
        }
      }

      const enrichedContent = `🎬 ${parsed.title}\n"${parsed.tagline}"\n\n${parsed.content}\n\n${parsed.synopsis ? `📖 ${parsed.synopsis}` : ""}`;

      results.push({
        ...parsed,
        content: enrichedContent.slice(0, 500),
        media_url,
        media_type,
        media_source,
      });
      console.log(
        `Movie trailer ${i + 1}/${count} ready: "${parsed.title}" (${genreInfo.label}, ${media_type || "text"}, source: ${media_source || "none"})`,
      );
    } catch (err) {
      console.error(`Movie trailer ${i + 1} failed:`, err);
    }
  }

  return results;
}
