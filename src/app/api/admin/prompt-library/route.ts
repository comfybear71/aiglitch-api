/**
 * GET  /api/admin/prompt-library?collection=elon — list drafts
 * GET  /api/admin/prompt-library?id=<uuid> — load one draft
 * POST { action: "save", collection, title?, value, meta? }
 * POST { action: "delete", id }
 */

import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import {
  deletePromptLibraryDraft,
  getPromptLibraryDraft,
  isPromptLibraryCollection,
  listPromptLibrary,
  savePromptLibraryDraft,
} from "@/lib/prompt-library";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const id = request.nextUrl.searchParams.get("id");
  const collection = request.nextUrl.searchParams.get("collection");

  try {
    if (id) {
      const draft = await getPromptLibraryDraft(id);
      if (!draft) {
        return NextResponse.json({ error: "Draft not found" }, { status: 404 });
      }
      return NextResponse.json({ draft });
    }

    if (!collection || !isPromptLibraryCollection(collection)) {
      return NextResponse.json(
        { error: "collection required (elon|ad|promo|poster|hero|…)" },
        { status: 400 },
      );
    }

    const drafts = await listPromptLibrary(collection);
    return NextResponse.json({ drafts });
  } catch (err) {
    console.error("[admin/prompt-library] GET:", err);
    return NextResponse.json({ error: "Failed to load drafts" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    id?: string;
    collection?: string;
    title?: string;
    value?: string;
    meta?: Record<string, unknown>;
  };

  try {
    if (body.action === "delete") {
      if (!body.id?.trim()) {
        return NextResponse.json({ error: "id required" }, { status: 400 });
      }
      const ok = await deletePromptLibraryDraft(body.id.trim());
      if (!ok) {
        return NextResponse.json({ error: "Draft not found" }, { status: 404 });
      }
      return NextResponse.json({ ok: true });
    }

    if (body.action === "save" || !body.action) {
      if (!body.collection || !isPromptLibraryCollection(body.collection)) {
        return NextResponse.json({ error: "valid collection required" }, { status: 400 });
      }
      if (!body.value?.trim()) {
        return NextResponse.json({ error: "value required" }, { status: 400 });
      }
      const draft = await savePromptLibraryDraft({
        collection: body.collection,
        title: body.title,
        value: body.value,
        meta: body.meta,
      });
      return NextResponse.json({ ok: true, draft });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    console.error("[admin/prompt-library] POST:", err);
    return NextResponse.json({ error: "Failed to save draft" }, { status: 500 });
  }
}
