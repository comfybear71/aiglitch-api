/**
 * Admin prompt catalog — merges DB overrides with code defaults for the
 * /api/admin/prompts dashboard. Channel rows come from Neon; director,
 * genre, and platform defaults from ported content libs.
 */

import { PLATFORM_BRIEF } from "@/lib/bible/platform-brief";
import {
  CHANNEL_BRANDING,
  CHANNEL_VISUAL_STYLE,
  DIRECTORS,
} from "@/lib/content/prompt-catalog-defaults";
import { getDb } from "@/lib/db";
import { GENRE_TEMPLATES } from "@/lib/media/multi-clip";
import { getPromptOverrides } from "@/lib/prompt-overrides";

export interface CatalogPromptField {
  category: string;
  key: string;
  label: string;
  value: string;
  default: string;
  overridden: boolean;
}

export interface ChannelCatalogGroup {
  category: "channel";
  channelId: string;
  channelName: string;
  emoji: string;
  slug: string;
  prompts: CatalogPromptField[];
}

export interface DirectorCatalogGroup {
  category: "director";
  directorUsername: string;
  directorName: string;
  prompts: CatalogPromptField[];
}

export interface GenreCatalogGroup {
  category: "genre";
  genreKey: string;
  genreName: string;
  emoji: string;
  prompts: CatalogPromptField[];
}

export interface PlatformCatalogGroup {
  category: "platform";
  prompts: CatalogPromptField[];
}

export interface PromptCatalog {
  channels: ChannelCatalogGroup[];
  directors: DirectorCatalogGroup[];
  genres: GenreCatalogGroup[];
  platform: PlatformCatalogGroup[];
  overrideCount: number;
}

const GENRE_EMOJIS: Record<string, string> = {
  drama: "🎭",
  comedy: "😂",
  scifi: "🚀",
  horror: "👻",
  family: "👨‍👩‍👧",
  documentary: "🎥",
  action: "💥",
  romance: "❤️",
  music_video: "🎵",
  cooking_channel: "👨‍🍳",
};

function parseContentRules(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (raw && typeof raw === "object") {
    return raw as Record<string, unknown>;
  }
  return {};
}

function field(
  category: string,
  key: string,
  label: string,
  defaultValue: string,
  getVal: (cat: string, k: string, def: string) => string,
  isOverridden: (cat: string, k: string) => boolean,
): CatalogPromptField {
  return {
    category,
    key,
    label,
    value: getVal(category, key, defaultValue),
    default: defaultValue,
    overridden: isOverridden(category, key),
  };
}

/** Build the full prompt catalog with defaults + any DB overrides. */
export async function buildPromptCatalog(): Promise<PromptCatalog> {
  const overrides = await getPromptOverrides();
  const overrideMap = new Map(overrides.map((o) => [`${o.category}:${o.key}`, o.value]));

  const getVal = (cat: string, key: string, def: string) =>
    overrideMap.get(`${cat}:${key}`) ?? def;
  const isOverridden = (cat: string, key: string) => overrideMap.has(`${cat}:${key}`);

  const sql = getDb();
  const channelRows = (await sql`
    SELECT id, slug, name, emoji, content_rules
    FROM channels
    ORDER BY sort_order ASC NULLS LAST, created_at ASC
  `) as unknown as {
    id: string;
    slug: string;
    name: string;
    emoji: string | null;
    content_rules: unknown;
  }[];

  const channels: ChannelCatalogGroup[] = channelRows.map((ch) => {
    const rules = parseContentRules(ch.content_rules);
    const promptHintDefault = (rules.promptHint as string) || "";
    const brandingDefault = CHANNEL_BRANDING[ch.id] || "";
    const visualDefault = CHANNEL_VISUAL_STYLE[ch.id] || "Default cinematic";

    return {
      category: "channel",
      channelId: ch.id,
      channelName: ch.name,
      emoji: ch.emoji || "📺",
      slug: ch.slug,
      prompts: [
        field(
          "channel",
          `${ch.slug}.promptHint`,
          `${ch.name} — Content Prompt`,
          promptHintDefault,
          getVal,
          isOverridden,
        ),
        field(
          "channel",
          `${ch.slug}.branding`,
          `${ch.name} — Branding`,
          brandingDefault,
          getVal,
          isOverridden,
        ),
        field(
          "channel",
          `${ch.slug}.visualStyle`,
          `${ch.name} — Visual Style`,
          visualDefault,
          getVal,
          isOverridden,
        ),
      ],
    };
  });

  const directors: DirectorCatalogGroup[] = Object.entries(DIRECTORS).map(
    ([username, d]) => ({
      category: "director",
      directorUsername: username,
      directorName: d.displayName,
      prompts: [
        field("director", `${username}.style`, `${d.displayName} — Style`, d.style, getVal, isOverridden),
        field(
          "director",
          `${username}.colorPalette`,
          `${d.displayName} — Color Palette`,
          d.colorPalette,
          getVal,
          isOverridden,
        ),
        field(
          "director",
          `${username}.cameraWork`,
          `${d.displayName} — Camera Work`,
          d.cameraWork,
          getVal,
          isOverridden,
        ),
        field(
          "director",
          `${username}.visualOverride`,
          `${d.displayName} — Visual Override`,
          d.visualOverride || "",
          getVal,
          isOverridden,
        ),
        field(
          "director",
          `${username}.signatureShot`,
          `${d.displayName} — Signature Shot`,
          d.signatureShot,
          getVal,
          isOverridden,
        ),
      ],
    }),
  );

  const genres: GenreCatalogGroup[] = Object.entries(GENRE_TEMPLATES).map(
    ([genreKey, t]) => {
      const genreName = genreKey
        .replace(/_/g, " ")
        .replace(/\b\w/g, (l) => l.toUpperCase());
      return {
        category: "genre",
        genreKey,
        genreName,
        emoji: GENRE_EMOJIS[genreKey] || "🎬",
        prompts: [
          field(
            "genre",
            `${genreKey}.cinematicStyle`,
            `${genreName} — Cinematic Style`,
            t.cinematicStyle,
            getVal,
            isOverridden,
          ),
          field(
            "genre",
            `${genreKey}.moodTone`,
            `${genreName} — Mood/Tone`,
            t.moodTone,
            getVal,
            isOverridden,
          ),
          field(
            "genre",
            `${genreKey}.lightingDesign`,
            `${genreName} — Lighting Design`,
            t.lightingDesign,
            getVal,
            isOverridden,
          ),
          field(
            "genre",
            `${genreKey}.technicalValues`,
            `${genreName} — Technical Values`,
            t.technicalValues,
            getVal,
            isOverridden,
          ),
          field(
            "genre",
            `${genreKey}.screenplayInstructions`,
            `${genreName} — Screenplay Instructions`,
            t.screenplayInstructions,
            getVal,
            isOverridden,
          ),
        ],
      };
    },
  );

  const platform: PlatformCatalogGroup[] = [
    {
      category: "platform",
      prompts: [
        field(
          "platform",
          "brief",
          "Platform Brief — injected into every persona Telegram chat",
          PLATFORM_BRIEF,
          getVal,
          isOverridden,
        ),
      ],
    },
  ];

  return {
    channels,
    directors,
    genres,
    platform,
    overrideCount: overrides.length,
  };
}
