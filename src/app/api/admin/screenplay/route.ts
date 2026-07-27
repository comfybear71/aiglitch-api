import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { ensureDbReady } from "@/lib/seed";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import {
  DIRECTORS,
  pickGenre,
  pickDirector,
  generateDirectorScreenplay,
  CHANNEL_VISUAL_STYLE,
  CHANNEL_BRANDING,
} from "@/lib/content/director-movies";
import { getPrompt } from "@/lib/prompt-overrides";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST /api/admin/screenplay
 *
 * Generates a director screenplay (connected scene prompts) and returns them.
 * Does NOT submit to xAI — the client submits and polls each scene.
 */
export async function POST(request: NextRequest) {
  try {
    if (!(await isAdminAuthenticated(request))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: {
      genre?: string;
      director?: string;
      concept?: string;
      title?: string;
      channel_id?: string;
      preview?: boolean;
      cast_count?: number;
    } = {};
    try {
      body = await request.json();
    } catch {
      // empty body
    }

    const sql = getDb();
    await ensureDbReady();

    const genre = body.genre && body.genre !== "any" ? body.genre : await pickGenre();

    if (body.channel_id && body.channel_id !== "ch-aiglitch-studios") {
      const channelRows = (await sql`
        SELECT id, slug, name, content_rules FROM channels WHERE id = ${body.channel_id} LIMIT 1
      `) as unknown as {
        id: string;
        slug: string;
        name: string;
        content_rules: string | Record<string, unknown> | null;
      }[];

      if (channelRows.length > 0) {
        const channelConfig = channelRows[0]!;
        let contentRules: Record<string, unknown> = {};
        if (typeof channelConfig.content_rules === "string") {
          try {
            contentRules = JSON.parse(channelConfig.content_rules) as Record<string, unknown>;
          } catch {
            console.warn(
              `[screenplay] Invalid content_rules JSON for ${body.channel_id}, using empty rules`,
            );
          }
        } else if (channelConfig.content_rules && typeof channelConfig.content_rules === "object") {
          contentRules = channelConfig.content_rules;
        }

        const slug = channelConfig.slug;
        const channelId = body.channel_id;
        const promptHint = await getPrompt(
          "channel",
          `${slug}.promptHint`,
          (contentRules.promptHint as string) || "",
        );
        const visualStyle = await getPrompt(
          "channel",
          `${slug}.visualStyle`,
          CHANNEL_VISUAL_STYLE[channelId] || "",
        );
        const branding = await getPrompt(
          "channel",
          `${slug}.branding`,
          CHANNEL_BRANDING[channelId] || "",
        );

        const channelRules = `CHANNEL: ${channelConfig.name}
CHANNEL CONTENT RULES (MANDATORY): ${promptHint}
${visualStyle ? `VISUAL STYLE: ${visualStyle}` : ""}
${branding ? `BRANDING: ${branding}` : ""}
THIS IS NOT A MOVIE. No title cards, no credits, no "Directed by", no cast lists, no "AIG!itch Studios".`;
        body.concept = body.concept ? `${channelRules}\n\n${body.concept}` : channelRules;
      }
    }

  let director: { id: string; username: string; displayName: string } | null = null;
  if (body.director && body.director !== "auto") {
    const rows = (await sql`
      SELECT id, username, display_name FROM ai_personas
      WHERE username = ${body.director} AND is_active = true LIMIT 1
    `) as unknown as { id: string; username: string; display_name: string }[];
    if (rows.length > 0) {
      director = {
        id: rows[0]!.id,
        username: rows[0]!.username,
        displayName: rows[0]!.display_name,
      };
    }
  }
  if (!director) {
    director = await pickDirector(genre);
  }
  if (!director) {
    return NextResponse.json(
      { error: "No director available for genre: " + genre },
      { status: 500 },
    );
  }

  const profile = DIRECTORS[director.username];
  if (!profile) {
    return NextResponse.json(
      { error: "Director profile not found: " + director.username },
      { status: 500 },
    );
  }

  if (body.preview) {
    const promptText = await generateDirectorScreenplay(
      genre,
      profile,
      body.concept || undefined,
      body.channel_id || undefined,
      true,
      body.title || undefined,
      body.cast_count,
    );
    return NextResponse.json({
      ok: true,
      prompt: promptText || "Failed to build prompt",
      genre,
      director: director.username,
      directorName: profile.displayName,
    });
  }

  let result;
  try {
    result = await generateDirectorScreenplay(
      genre,
      profile,
      body.concept || undefined,
      body.channel_id || undefined,
      false,
      body.title || undefined,
      body.cast_count,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[screenplay] generateDirectorScreenplay threw:", msg);
    return NextResponse.json({ error: `Screenplay generation error: ${msg}` }, { status: 500 });
  }

  if (!result || typeof result === "string") {
    return NextResponse.json(
      {
        error: `Screenplay generation failed: AI returned ${
          result === null ? "empty response" : "invalid format"
        } — try again`,
      },
      { status: 500 },
    );
  }
  const screenplay = result;

  const sponsorLabels = Array.from(
    new Set((screenplay._adCampaigns || []).map((c) => c.product_name || c.brand_name)),
  );

  const allSponsorImages: string[] = [];
  for (const c of screenplay._adCampaigns || []) {
    if (c.logo_url) allSponsorImages.push(c.logo_url);
    if (c.product_image_url) allSponsorImages.push(c.product_image_url);
    const prodImages = Array.isArray(c.product_images)
      ? c.product_images
      : typeof c.product_images === "string"
        ? (() => {
            try {
              return JSON.parse(c.product_images) as string[];
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

  const sponsorCampaigns = (screenplay._adCampaigns || []).map((c) => {
    const campaignImages = Array.isArray(c.product_images)
      ? c.product_images
      : typeof c.product_images === "string"
        ? (() => {
            try {
              return JSON.parse(c.product_images) as string[];
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
      grokifyScenes: (c as unknown as { grokify_scenes?: number }).grokify_scenes ?? 3,
      grokifyMode: (c as unknown as { grokify_mode?: string }).grokify_mode || "all",
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
    screenplayProvider: screenplay.screenplayProvider || "claude",
    sponsorPlacements: sponsorLabels,
    sponsorCampaigns,
    sponsorImageUrl: allSponsorImages[0] || null,
    sponsorImages: allSponsorImages,
    scenes: screenplay.scenes.map((s) => ({
      sceneNumber: s.sceneNumber,
      title: s.title,
      description: s.description,
      videoPrompt: s.videoPrompt,
      duration: s.duration,
    })),
  });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[screenplay] Unhandled error:", msg);
    return NextResponse.json({ error: `Screenplay error: ${msg}` }, { status: 500 });
  }
}
