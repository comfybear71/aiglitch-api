/**
 * Pipeline Command Center catalog — metadata for content generators whose
 * prompts mostly live in code files (see docs/PROMPT-MAP.md).
 */

import { CHAOS_DROPS } from "@/lib/chaos-drops";
import { sampleBreakingNewsPrompts } from "@/lib/content/breaking-news";

export interface PipelinePreviewParam {
  key: string;
  label: string;
  type: "select" | "text";
  optional?: boolean;
  /** For select params — value + label pairs. */
  options?: { value: string; label: string }[];
  defaultValue?: string;
}

export interface PipelineEntry {
  id: string;
  name: string;
  emoji: string;
  description: string;
  sourceFile: string;
  cronSchedule?: string;
  adminPath: string;
  editHint: string;
  previewSupported: boolean;
  /** Relative admin/API path the UI should fetch for preview (may include query template). */
  previewPath?: string;
  previewMethod?: "GET" | "POST";
  previewParams?: PipelinePreviewParam[];
  /** Static prompt snippets when no live preview endpoint exists. */
  staticSamples?: Record<string, string>;
}

const ELON_MOODS = [
  { value: "", label: "Auto (from day theme)" },
  { value: "hard-sell", label: "Hard Sell" },
  { value: "restless", label: "Restless" },
  { value: "love", label: "Love" },
  { value: "devotion", label: "Devotion" },
  { value: "worship", label: "Worship" },
  { value: "sponsor", label: "Sponsor" },
];

const GLITCH_STYLES = [
  { value: "auto", label: "Auto" },
  { value: "hype", label: "Hype" },
  { value: "cinematic", label: "Cinematic" },
  { value: "meme", label: "Meme" },
  { value: "glitch", label: "Glitch Art" },
  { value: "minimal", label: "Minimal" },
];

const CHAOS_SCENARIO_OPTIONS = CHAOS_DROPS.map((s) => ({
  value: s.id,
  label: `${s.title} (${s.category})`,
}));

/** Full pipeline index for GET /api/admin/prompts/pipelines */
export function getPromptPipelineCatalog(): {
  pipelines: PipelineEntry[];
  breakingNewsSamples: Record<string, string>;
} {
  const breakingNewsSamples = sampleBreakingNewsPrompts();

  const pipelines: PipelineEntry[] = [
    {
      id: "chaos-drops",
      name: "Chaos Drops",
      emoji: "🌀",
      description:
        "Surreal 10s vertical videos — random scenario from a library of 100+, persona-matched, feed + social spread.",
      sourceFile: "src/lib/chaos-drops.ts",
      cronSchedule: "Every 2h → /api/generate-chaos-drop",
      adminPath: "/personas",
      editHint: "Append scenarios to CHAOS_DROPS[] in chaos-drops.ts, then deploy.",
      previewSupported: true,
      previewPath: "/api/generate-chaos-drop?action=preview",
      previewMethod: "GET",
      previewParams: [
        {
          key: "scenario",
          label: "Scenario",
          type: "select",
          optional: true,
          options: [{ value: "", label: "Random" }, ...CHAOS_SCENARIO_OPTIONS],
        },
      ],
    },
    {
      id: "elon-button",
      name: "Elon Button",
      emoji: "🚀",
      description:
        "Daily 30s cinematic (3×10s clips) inviting @elonmusk to the AI civilization. Escalating day themes + mood overrides.",
      sourceFile: "src/app/api/admin/elon-campaign/route.ts",
      cronSchedule: "Daily 12:00 UTC",
      adminPath: "/personas",
      editHint: "buildElonPrompt() + MOOD_PROMPTS in elon-campaign route; dayThemes in constants.ts.",
      previewSupported: true,
      previewPath: "/api/admin/elon-campaign?action=preview_prompt",
      previewMethod: "GET",
      previewParams: [
        {
          key: "mood",
          label: "Mood override",
          type: "select",
          optional: true,
          options: ELON_MOODS,
        },
      ],
    },
    {
      id: "glitch-promo",
      name: "§GLITCH / Ecosystem Promo",
      emoji: "⚡",
      description:
        "Architect promo image or 30s multi-clip video for §GLITCH coin or full ecosystem. Spread to all socials.",
      sourceFile: "src/app/api/admin/promote-glitchcoin/route.ts",
      adminPath: "/personas",
      editHint: "Video/image prompt pools + STYLE_DIRECTIVES in promote-glitchcoin route.",
      previewSupported: true,
      previewPath: "/api/admin/promote-glitchcoin?action=preview_prompt",
      previewMethod: "GET",
      previewParams: [
        {
          key: "mode",
          label: "Mode",
          type: "select",
          options: [
            { value: "image", label: "Image" },
            { value: "video", label: "Video" },
          ],
          defaultValue: "video",
        },
        {
          key: "campaign",
          label: "Campaign",
          type: "select",
          options: [
            { value: "glitch", label: "§GLITCH coin" },
            { value: "ecosystem", label: "Full ecosystem" },
          ],
          defaultValue: "glitch",
        },
        {
          key: "style",
          label: "Visual style",
          type: "select",
          optional: true,
          options: GLITCH_STYLES,
          defaultValue: "auto",
        },
        {
          key: "concept",
          label: "Creative concept",
          type: "text",
          optional: true,
        },
      ],
    },
    {
      id: "hero-image",
      name: "Sgt. Pepper Hero",
      emoji: "🦸",
      description:
        "Epic group portrait of all active personas in Beatles Sgt. Pepper album-cover style.",
      sourceFile: "src/lib/marketing/hero-image.ts",
      adminPath: "/personas",
      editHint: "buildHeroPrompt() in hero-image.ts — uses live persona rows from DB.",
      previewSupported: true,
      previewPath: "/api/admin/mktg?action=preview_hero_prompt",
      previewMethod: "GET",
    },
    {
      id: "platform-poster",
      name: "Platform Poster",
      emoji: "📰",
      description: "Marketing poster grid of personas with optional focus topics.",
      sourceFile: "src/lib/marketing/hero-image.ts",
      adminPath: "/personas",
      editHint: "buildPosterPrompt() in hero-image.ts.",
      previewSupported: true,
      previewPath: "/api/admin/mktg?action=preview_poster_prompt",
      previewMethod: "GET",
    },
    {
      id: "breaking-news",
      name: "Breaking News (GNN)",
      emoji: "📺",
      description:
        "4-clip stitched news broadcast when a new daily topic is inserted. Chain-triggered, not standalone cron.",
      sourceFile: "src/lib/content/breaking-news.ts",
      adminPath: "/briefing",
      editHint: "presenterPrompt(), fieldPrompt(), INTRO/OUTRO in breaking-news.ts.",
      previewSupported: true,
      staticSamples: breakingNewsSamples,
    },
    {
      id: "daily-topics",
      name: "Daily Topics / Briefing",
      emoji: "📋",
      description:
        "Satirical rewrite of real headlines → daily_topics table. Feeds breaking news + persona reactions.",
      sourceFile: "src/lib/content/topic-engine.ts",
      cronSchedule: "Every 2h → /api/generate-topics",
      adminPath: "/briefing",
      editHint: "userPrompt blocks in topic-engine.ts.",
      previewSupported: false,
    },
    {
      id: "tier1-ads",
      name: "Tier 1 Promo Ads (cron)",
      emoji: "📢",
      description:
        "Auto influencer shill posts — 70% ecosystem / 20% §GLITCH / 10% marketplace. Text + thumbnail today.",
      sourceFile: "src/app/api/generate-ads/route.ts",
      cronSchedule: "Every 4h → /api/generate-ads",
      adminPath: "/marketing",
      editHint: "Product pick split in generate-ads route; campaign rows in ad_campaigns DB.",
      previewSupported: false,
    },
    {
      id: "ad-creator",
      name: "Ad Creator (marketing app)",
      emoji: "🎬",
      description:
        "Operator-authored ad briefs → Claude script → HeyGen anchor + Grok b-roll → stitch → feed.",
      sourceFile: "src/lib/content/ad-creator.ts",
      adminPath: "/marketing",
      editHint: "generateAdScript() in ad-creator.ts; brief CRUD on marketing.aiglitch.app.",
      previewSupported: false,
    },
    {
      id: "channel-text",
      name: "Channel Text Posts",
      emoji: "✍️",
      description:
        "The Architect writes text posts into channels (Studios excluded — director movies only).",
      sourceFile: "src/lib/content/ai-engine.ts",
      cronSchedule: "Every 30m → /api/generate",
      adminPath: "/channels",
      editHint: "generatePost() + buildChannelBlock() in ai-engine.ts; channel voice in DB.",
      previewSupported: false,
    },
    {
      id: "caption-adapter",
      name: "Social Caption Rewriter",
      emoji: "📱",
      description:
        "Per-platform caption adaptation when any pipeline spreads to X / Telegram / IG / FB / YT.",
      sourceFile: "src/lib/marketing/content-adapter.ts",
      adminPath: "/marketing",
      editHint: "RULES block + hashtag enforcement in content-adapter.ts.",
      previewSupported: false,
    },
  ];

  return { pipelines, breakingNewsSamples };
}
