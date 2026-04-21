/**
 * Admin prompt override editor.
 *
 *   GET  — lists every prompt override currently in DB, plus an empty
 *          `deferred` block listing the static catalogs (channels,
 *          directors, genres) that aren't available yet because their
 *          source data (`@/lib/bible/constants`, `@/lib/content/director-movies`,
 *          `@/lib/media/multi-clip`) still lives in the legacy repo.
 *
 *          Legacy returned a fully-assembled catalog merging static
 *          defaults with DB overrides. We defer that until those libs
 *          port over — the override CRUD alone is the useful half.
 *
 *   POST — two actions:
 *     { action: "save",  category, key, label?, value } — upsert
 *     { action: "reset", category, key }                — delete
 *
 *   The same `category`/`key` pairs that will eventually back the
 *   static catalog already work today — admin can save an override
 *   by any key and downstream `getPrompt(cat, key, default)` calls
 *   will pick it up immediately.
 */

import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import {
  getPromptOverrides,
  savePromptOverride,
  deletePromptOverride,
} from "@/lib/prompt-overrides";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFERRED_NOTE =
  "Static catalogs (channels, directors, genres) haven't been ported from the legacy repo yet. The override CRUD below works today — save or reset any (category, key) pair and `getPrompt()` callers will pick it up. The dashboard's grouped catalog view lands when @/lib/bible/constants, @/lib/content/director-movies, and @/lib/media/multi-clip port over.";

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const overrides = await getPromptOverrides();

    return NextResponse.json({
      // Current DB overrides — always populated
      overrides,
      overrideCount: overrides.length,

      // Static catalogs — empty until static-data libs port over
      channels:  [],
      directors: [],
      genres:    [],
      platform:  [],
      deferred:  {
        note:     DEFERRED_NOTE,
        sections: ["channels", "directors", "genres", "platform"],
      },
    });
  } catch (err) {
    console.error("[admin/prompts] GET:", err);
    return NextResponse.json({ error: "Failed to load prompts" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    category?: string;
    key?: string;
    label?: string;
    value?: string;
  };
  const { action, category, key, label, value } = body;

  try {
    if (action === "save") {
      if (!category || !key || value === undefined) {
        return NextResponse.json(
          { error: "category, key, and value required" },
          { status: 400 },
        );
      }
      await savePromptOverride(category, key, label || key, value);
      return NextResponse.json({ ok: true, message: "Prompt saved" });
    }

    if (action === "reset") {
      if (!category || !key) {
        return NextResponse.json({ error: "category and key required" }, { status: 400 });
      }
      await deletePromptOverride(category, key);
      return NextResponse.json({ ok: true, message: "Prompt reset to default" });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    console.error("[admin/prompts] POST:", err);
    return NextResponse.json({ error: "Failed to save prompt" }, { status: 500 });
  }
}
