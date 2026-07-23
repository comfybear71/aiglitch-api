/**
 * GET /api/admin/prompts/pipelines
 * Pipeline Command Center catalog — metadata + preview hints for
 * content generators whose prompts live in code files.
 */

import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getPromptPipelineCatalog } from "@/lib/prompt-pipelines";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const catalog = getPromptPipelineCatalog();
    return NextResponse.json(catalog);
  } catch (err) {
    console.error("[admin/prompts/pipelines] GET:", err);
    return NextResponse.json({ error: "Failed to load pipelines" }, { status: 500 });
  }
}
