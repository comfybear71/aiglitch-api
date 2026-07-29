/**
 * Dated prompt drafts for PromptViewer tools (Elon, ads, heroes, …).
 * Separate from `prompt_overrides` (live catalog UNIQUE category/key).
 */

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

export const PROMPT_LIBRARY_COLLECTIONS = [
  "elon",
  "ad",
  "promo",
  "poster",
  "hero",
  "channel-promo",
  "channel-title",
] as const;

export type PromptLibraryCollection = (typeof PROMPT_LIBRARY_COLLECTIONS)[number];

export interface PromptLibraryDraft {
  id: string;
  collection: string;
  title: string;
  value: string;
  meta: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface PromptLibraryListItem {
  id: string;
  collection: string;
  title: string;
  preview: string;
  created_at: string;
  updated_at: string;
  stale: boolean;
}

/** Drafts older than this (days) get a stale flag in list UI. */
export const PROMPT_LIBRARY_STALE_DAYS = 14;

let _tableEnsured = false;

export function isPromptLibraryCollection(
  raw: string,
): raw is PromptLibraryCollection {
  return (PROMPT_LIBRARY_COLLECTIONS as readonly string[]).includes(raw);
}

async function ensureTable(): Promise<void> {
  if (_tableEnsured) return;
  const sql = getDb();
  await sql`
    CREATE TABLE IF NOT EXISTS prompt_library (
      id         UUID        PRIMARY KEY,
      collection TEXT        NOT NULL,
      title      TEXT        NOT NULL DEFAULT '',
      value      TEXT        NOT NULL,
      meta       JSONB       NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_prompt_library_collection_created
    ON prompt_library (collection, created_at DESC)
  `;
  _tableEnsured = true;
}

/** Test helper only. */
export function __resetPromptLibraryTableFlag(): void {
  _tableEnsured = false;
}

function defaultTitle(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function previewOf(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}…` : oneLine;
}

function isStale(createdAt: string): boolean {
  const t = new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return false;
  return Date.now() - t > PROMPT_LIBRARY_STALE_DAYS * 24 * 60 * 60 * 1000;
}

export async function listPromptLibrary(
  collection: string,
): Promise<PromptLibraryListItem[]> {
  await ensureTable();
  const sql = getDb();
  const rows = (await sql`
    SELECT id, collection, title, value, created_at, updated_at
    FROM prompt_library
    WHERE collection = ${collection}
    ORDER BY created_at DESC
    LIMIT 50
  `) as unknown as Array<{
    id: string;
    collection: string;
    title: string;
    value: string;
    created_at: string;
    updated_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    collection: r.collection,
    title: r.title || defaultTitle(),
    preview: previewOf(r.value),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    stale: isStale(String(r.created_at)),
  }));
}

export async function getPromptLibraryDraft(
  id: string,
): Promise<PromptLibraryDraft | null> {
  await ensureTable();
  const sql = getDb();
  const rows = (await sql`
    SELECT id, collection, title, value, meta, created_at, updated_at
    FROM prompt_library
    WHERE id = ${id}
    LIMIT 1
  `) as unknown as Array<{
    id: string;
    collection: string;
    title: string;
    value: string;
    meta: Record<string, unknown> | string;
    created_at: string;
    updated_at: string;
  }>;
  const row = rows[0];
  if (!row) return null;
  const meta =
    typeof row.meta === "string"
      ? (JSON.parse(row.meta) as Record<string, unknown>)
      : (row.meta ?? {});
  return {
    id: row.id,
    collection: row.collection,
    title: row.title,
    value: row.value,
    meta,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export async function savePromptLibraryDraft(opts: {
  collection: string;
  title?: string;
  value: string;
  meta?: Record<string, unknown>;
}): Promise<PromptLibraryDraft> {
  await ensureTable();
  const sql = getDb();
  const id = randomUUID();
  const title = (opts.title ?? "").trim() || defaultTitle();
  await sql`
    INSERT INTO prompt_library (id, collection, title, value, meta, created_at, updated_at)
    VALUES (
      ${id},
      ${opts.collection},
      ${title},
      ${opts.value},
      ${JSON.stringify(opts.meta ?? {})}::jsonb,
      NOW(),
      NOW()
    )
  `;
  const draft = await getPromptLibraryDraft(id);
  if (!draft) throw new Error("Failed to read back saved draft");
  return draft;
}

export async function deletePromptLibraryDraft(id: string): Promise<boolean> {
  await ensureTable();
  const sql = getDb();
  const rows = (await sql`
    DELETE FROM prompt_library WHERE id = ${id} RETURNING id
  `) as unknown as Array<{ id: string }>;
  return rows.length > 0;
}
