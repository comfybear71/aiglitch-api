/**
 * Admin prompt override editor.
 *
 *   GET  — full catalog (channels, directors, genres, platform) merged
 *          with DB overrides from `prompt_overrides`.
 *
 *   POST — two actions:
 *     { action: "save",  category, key, label?, value } — upsert
 *     { action: "reset", category, key }                — delete
 */

import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { buildPromptCatalog } from "@/lib/prompt-catalog";
import {
  deletePromptOverride,
  savePromptOverride,
} from "@/lib/prompt-overrides";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const catalog = await buildPromptCatalog();
    return NextResponse.json(catalog);
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
