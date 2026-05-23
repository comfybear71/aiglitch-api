/**
 * Admin prompt override editor.
 *
 *   GET  — lists every prompt override currently in DB, plus an empty
 *          `deferred` block where the static catalog (channels, genres)
 *          dashboard view used to plug in. The catalog merge isn't
 *          implemented in this repo — the override CRUD alone is the
 *          useful half. The deferred block stays so the existing UI
 *          contract doesn't break.
 *
 *   POST — two actions:
 *     { action: "save",  category, key, label?, value } — upsert
 *     { action: "reset", category, key }                — delete
 *
 *   `getPrompt(cat, key, default)` callers downstream pick up any
 *   (category, key) saved here regardless of whether a static catalog
 *   exists for that pair.
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
  "The override CRUD below works today — save or reset any (category, key) pair and `getPrompt()` callers will pick it up. The dashboard's grouped static-catalog view (channels, genres) is not currently rendered from this endpoint.";

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
