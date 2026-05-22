/**
 * POST /api/admin/screenplay — admin manual screenplay generation.
 *
 * Generates a director screenplay (connected scene prompts) and returns
 * them as JSON. Does NOT submit videos to xAI — the admin UI submits
 * + polls each scene through `/api/admin/extend-video` or `/api/generate-channel-video`.
 *
 * Body (all optional):
 *   - genre    string  — explicit genre; default = pickGenre()
 *   - director string  — explicit persona username; default = pickDirector(genre)
 *   - concept  string  — free-text seed concept
 *   - title    string  — explicit movie title
 *   - channel_id string — enriches concept with channel rules + visual style
 *   - preview  boolean — return the assembled prompt only (no AI call)
 *   - cast_count number — actor count, default 4
 *
 * Differences from legacy port:
 *   • Channel config comes from the `channels` table (live truth) rather
 *     than the legacy CHANNELS constant — keeps response shape identical
 *     but doesn't require porting another ~1200 lines of bible seed data.
 *   • `ensureDbReady` dropped per the rest of admin/* — schema assumed live.
 */

import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import {
  CHANNEL_BRANDING,
  CHANNEL_VISUAL_STYLE,
  DIRECTORS,
} from "@/lib/content/director-constants";
import { pickDirector, pickGenre } from "@/lib/content/director-utils";
import { generateDirectorScreenplay } from "@/lib/content/director-screenplay";
import { getPrompt } from "@/lib/prompt-overrides";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

interface ScreenplayBody {
  genre?: string;
  director?: string;
  concept?: string;
  title?: string;
  channel_id?: string;
  preview?: boolean;
  cast_count?: number;
}

interface ChannelConfigRow {
  name: string;
  slug: string;
  content_rules: unknown;
}

interface AdCampaign {
  brand_name: string;
  product_name: string;
  visual_prompt: string;
  logo_url: string | null;
  product_image_url: string | null;
  product_images: unknown;
  grokify_scenes?: number;
  grokify_mode?: string;
}

const STUDIOS_CHANNEL_ID = "ch-aiglitch-studios";

function parseRules(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (typeof raw === "object") return raw as Record<string, unknown>;
  return {};
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: ScreenplayBody = {};
  try {
    body = (await request.json()) as ScreenplayBody;
  } catch {
    // empty body — every field is optional
  }

  const sql = getDb();
  const genre =
    body.genre && body.genre !== "any" ? body.genre : await pickGenre();

  // Channel-aware concept enrichment. Studios is a movie channel and KEEPS
  // its title cards / credits / "directed by" framing — every other channel
  // gets the no-movie directive prepended.
  if (body.channel_id && body.channel_id !== STUDIOS_CHANNEL_ID) {
    const rows = (await sql`
      SELECT name, slug, content_rules
      FROM channels
      WHERE id = ${body.channel_id}
      LIMIT 1
    `) as unknown as ChannelConfigRow[];
    const channelConfig = rows[0];
    if (channelConfig) {
      const rules = parseRules(channelConfig.content_rules);
      const promptHint = await getPrompt(
        "channel",
        `${channelConfig.slug}.promptHint`,
        typeof rules.promptHint === "string" ? rules.promptHint : "",
      );
      const visualStyle = CHANNEL_VISUAL_STYLE[body.channel_id] ?? "";
      const branding = CHANNEL_BRANDING[body.channel_id] ?? "";

      const channelRules = `CHANNEL: ${channelConfig.name}
CHANNEL CONTENT RULES (MANDATORY): ${promptHint}
${visualStyle ? `VISUAL STYLE: ${visualStyle}` : ""}
${branding ? `BRANDING: ${branding}` : ""}
THIS IS NOT A MOVIE. No title cards, no credits, no "Directed by", no cast lists, no "AIG!itch Studios".`;
      body.concept = body.concept
        ? `${channelRules}\n\n${body.concept}`
        : channelRules;
    }
  }

  // Resolve director.
  let director: { id: string; username: string; displayName: string } | null = null;
  if (body.director && body.director !== "auto") {
    const rows = (await sql`
      SELECT id, username, display_name
      FROM ai_personas
      WHERE username = ${body.director} AND is_active = true
      LIMIT 1
    `) as unknown as {
      id: string;
      username: string;
      display_name: string;
    }[];
    if (rows[0]) {
      director = {
        id: rows[0].id,
        username: rows[0].username,
        displayName: rows[0].display_name,
      };
    }
  }
  if (!director) {
    director = await pickDirector(genre);
  }
  if (!director) {
    return NextResponse.json(
      { error: `No director available for genre: ${genre}` },
      { status: 500 },
    );
  }

  const profile = DIRECTORS[director.username];
  if (!profile) {
    return NextResponse.json(
      { error: `Director profile not found: ${director.username}` },
      { status: 500 },
    );
  }

  // Preview mode — return assembled prompt without firing the AI.
  if (body.preview) {
    const promptText = await generateDirectorScreenplay(
      genre,
      profile,
      body.concept ?? undefined,
      body.channel_id ?? undefined,
      true,
      body.title ?? undefined,
      body.cast_count,
    );
    return NextResponse.json({
      ok: true,
      prompt:
        typeof promptText === "string" ? promptText : "Failed to build prompt",
      genre,
      director: director.username,
      directorName: profile.displayName,
    });
  }

  let result: Awaited<ReturnType<typeof generateDirectorScreenplay>>;
  try {
    result = await generateDirectorScreenplay(
      genre,
      profile,
      body.concept ?? undefined,
      body.channel_id ?? undefined,
      false,
      body.title ?? undefined,
      body.cast_count,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[screenplay] generateDirectorScreenplay threw:", msg);
    return NextResponse.json(
      { error: `Screenplay generation error: ${msg}` },
      { status: 500 },
    );
  }
  if (!result || typeof result === "string") {
    const detail = result === null ? "empty response" : "invalid format";
    console.error("[screenplay] generateDirectorScreenplay returned:", detail);
    return NextResponse.json(
      {
        error: `Screenplay generation failed: AI returned ${detail} — try again`,
      },
      { status: 500 },
    );
  }
  const screenplay = result;

  // Surface sponsor campaign metadata + collected images so the Grokify
  // pipeline in the admin UI can read what's been placed.
  const adCampaigns = (screenplay._adCampaigns ?? []) as AdCampaign[];
  const allSponsorImages: string[] = [];
  for (const c of adCampaigns) {
    if (c.logo_url) allSponsorImages.push(c.logo_url);
    if (c.product_image_url) allSponsorImages.push(c.product_image_url);
    const prodImages = Array.isArray(c.product_images)
      ? c.product_images
      : typeof c.product_images === "string"
        ? (() => {
            try {
              return JSON.parse(c.product_images) as unknown[];
            } catch {
              return [];
            }
          })()
        : [];
    for (const img of prodImages) {
      if (typeof img === "string" && img && !allSponsorImages.includes(img)) {
        allSponsorImages.push(img);
      }
    }
  }

  const sponsorCampaigns = adCampaigns.map((c) => {
    const campaignImages = Array.isArray(c.product_images)
      ? c.product_images
      : typeof c.product_images === "string"
        ? (() => {
            try {
              return JSON.parse(c.product_images) as unknown[];
            } catch {
              return [];
            }
          })()
        : [];
    return {
      brandName: c.brand_name,
      productName: c.product_name,
      visualPrompt: c.visual_prompt,
      logoUrl: c.logo_url,
      productImageUrl: c.product_image_url,
      productImages: campaignImages as string[],
      grokifyScenes: c.grokify_scenes ?? 3,
      grokifyMode: c.grokify_mode ?? "all",
    };
  });

  return NextResponse.json({
    title: screenplay.title,
    tagline: screenplay.tagline,
    synopsis: screenplay.synopsis,
    genre: screenplay.genre,
    director: director.username,
    directorName: profile.displayName,
    directorId: director.id,
    castList: screenplay.castList,
    screenplayProvider: screenplay.screenplayProvider ?? "claude",
    sponsorPlacements: adCampaigns.map((c) => c.brand_name),
    sponsorCampaigns,
    sponsorImageUrl: allSponsorImages[0] ?? null,
    sponsorImages: allSponsorImages,
    scenes: screenplay.scenes.map((s) => ({
      sceneNumber: s.sceneNumber,
      title: s.title,
      description: s.description,
      videoPrompt: s.videoPrompt,
      duration: s.duration,
    })),
  });
}
