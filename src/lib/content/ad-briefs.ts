/**
 * Ad Creator — brief CRUD lib.
 *
 * Storage for "ad briefs" — operator-authored seeds for promo /
 * explainer / tutorial videos that the Ad Creator pipeline (ROADMAP
 * sessions 3+) will turn into stitched MP4s using HeyGen + Grok.
 *
 *   ad_briefs
 *     One per ad. Carries title, project name, concept, status. Status
 *     transitions: draft → generating → ready → posted, plus 'archived'
 *     for soft delete and 'failed' for terminal errors.
 *
 *   ad_brief_assets
 *     Operator-uploaded media (existing video / image files) attached
 *     to a brief. The generation step in session 3 mixes these with
 *     freshly AI-generated clips per the brief's concept.
 *
 * Schema bootstrap is inline `CREATE TABLE IF NOT EXISTS` calls so a
 * fresh env doesn't need a migration pass — matches the pattern used
 * by the meatlab admin route.
 */

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

// ── Status enum (mirrored as a TS union; column is plain TEXT) ──────

export type AdBriefStatus =
  | "draft"
  | "generating"
  | "ready"
  | "posted"
  | "failed"
  | "archived";

export const AD_BRIEF_STATUS_VALUES: AdBriefStatus[] = [
  "draft",
  "generating",
  "ready",
  "posted",
  "failed",
  "archived",
];

export interface AdBrief {
  id: string;
  title: string;
  project_name: string;
  concept: string;
  status: AdBriefStatus;
  target_socials: string | null; // CSV: "telegram,x,feed"
  created_at: string;
  updated_at: string;
}

export interface AdBriefAsset {
  id: string;
  ad_brief_id: string;
  asset_type: "image" | "video";
  blob_url: string;
  original_filename: string;
  size_bytes: number | null;
  created_at: string;
}

export interface AdBriefWithAssets extends AdBrief {
  assets: AdBriefAsset[];
}

// ── Schema bootstrap ────────────────────────────────────────────────

let _schemaReady = false;

export async function ensureAdBriefsSchema(): Promise<void> {
  if (_schemaReady) return;
  const sql = getDb();
  await sql`
    CREATE TABLE IF NOT EXISTS ad_briefs (
      id              TEXT         PRIMARY KEY,
      title           TEXT         NOT NULL DEFAULT '',
      project_name    TEXT         NOT NULL DEFAULT '',
      concept         TEXT         NOT NULL DEFAULT '',
      status          TEXT         NOT NULL DEFAULT 'draft',
      target_socials  TEXT,
      created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `.catch(() => {});
  await sql`
    CREATE INDEX IF NOT EXISTS idx_ad_briefs_status_created
      ON ad_briefs(status, created_at DESC)
  `.catch(() => {});
  await sql`
    CREATE INDEX IF NOT EXISTS idx_ad_briefs_project
      ON ad_briefs(project_name)
  `.catch(() => {});

  await sql`
    CREATE TABLE IF NOT EXISTS ad_brief_assets (
      id                TEXT         PRIMARY KEY,
      ad_brief_id       TEXT         NOT NULL REFERENCES ad_briefs(id) ON DELETE CASCADE,
      asset_type        TEXT         NOT NULL DEFAULT 'image',
      blob_url          TEXT         NOT NULL,
      original_filename TEXT         NOT NULL DEFAULT '',
      size_bytes        BIGINT,
      created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `.catch(() => {});
  await sql`
    CREATE INDEX IF NOT EXISTS idx_ad_brief_assets_brief
      ON ad_brief_assets(ad_brief_id)
  `.catch(() => {});
  _schemaReady = true;
}

// ── Briefs CRUD helpers ─────────────────────────────────────────────

export interface CreateBriefInput {
  title: string;
  project_name: string;
  concept: string;
  target_socials?: string | null;
  status?: AdBriefStatus;
}

export async function createBrief(input: CreateBriefInput): Promise<AdBrief> {
  await ensureAdBriefsSchema();
  const sql = getDb();
  const id = randomUUID();
  const status = input.status ?? "draft";
  const rows = (await sql`
    INSERT INTO ad_briefs (id, title, project_name, concept, status, target_socials)
    VALUES (${id}, ${input.title}, ${input.project_name}, ${input.concept},
            ${status}, ${input.target_socials ?? null})
    RETURNING *
  `) as AdBrief[];
  return rows[0]!;
}

export interface ListBriefsOptions {
  status?: AdBriefStatus | null;
  project_name?: string | null;
  /** Include archived briefs in the listing. Default false. */
  includeArchived?: boolean;
  limit?: number;
}

export async function listBriefs(opts: ListBriefsOptions = {}): Promise<AdBrief[]> {
  await ensureAdBriefsSchema();
  const sql = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  if (opts.status && opts.project_name) {
    return (await sql`
      SELECT * FROM ad_briefs
      WHERE status = ${opts.status} AND project_name = ${opts.project_name}
      ORDER BY created_at DESC LIMIT ${limit}
    `) as AdBrief[];
  }
  if (opts.status) {
    return (await sql`
      SELECT * FROM ad_briefs WHERE status = ${opts.status}
      ORDER BY created_at DESC LIMIT ${limit}
    `) as AdBrief[];
  }
  if (opts.project_name) {
    const sqlBlock = opts.includeArchived
      ? sql`
          SELECT * FROM ad_briefs WHERE project_name = ${opts.project_name}
          ORDER BY created_at DESC LIMIT ${limit}
        `
      : sql`
          SELECT * FROM ad_briefs
          WHERE project_name = ${opts.project_name} AND status != 'archived'
          ORDER BY created_at DESC LIMIT ${limit}
        `;
    return (await sqlBlock) as AdBrief[];
  }
  if (opts.includeArchived) {
    return (await sql`
      SELECT * FROM ad_briefs ORDER BY created_at DESC LIMIT ${limit}
    `) as AdBrief[];
  }
  return (await sql`
    SELECT * FROM ad_briefs WHERE status != 'archived'
    ORDER BY created_at DESC LIMIT ${limit}
  `) as AdBrief[];
}

export async function getBrief(id: string): Promise<AdBrief | null> {
  await ensureAdBriefsSchema();
  const sql = getDb();
  const rows = (await sql`
    SELECT * FROM ad_briefs WHERE id = ${id} LIMIT 1
  `) as AdBrief[];
  return rows[0] ?? null;
}

export async function getBriefWithAssets(
  id: string,
): Promise<AdBriefWithAssets | null> {
  const brief = await getBrief(id);
  if (!brief) return null;
  const assets = await listAssetsForBrief(id);
  return { ...brief, assets };
}

export interface UpdateBriefInput {
  title?: string;
  project_name?: string;
  concept?: string;
  status?: AdBriefStatus;
  target_socials?: string | null;
}

export async function updateBrief(
  id: string,
  patch: UpdateBriefInput,
): Promise<AdBrief | null> {
  await ensureAdBriefsSchema();
  const sql = getDb();
  // COALESCE NULL → keep existing — caller passes undefined to skip.
  const rows = (await sql`
    UPDATE ad_briefs
    SET title          = COALESCE(${patch.title ?? null}, title),
        project_name   = COALESCE(${patch.project_name ?? null}, project_name),
        concept        = COALESCE(${patch.concept ?? null}, concept),
        status         = COALESCE(${patch.status ?? null}, status),
        target_socials = COALESCE(${patch.target_socials ?? null}, target_socials),
        updated_at     = NOW()
    WHERE id = ${id}
    RETURNING *
  `) as AdBrief[];
  return rows[0] ?? null;
}

export async function softDeleteBrief(id: string): Promise<boolean> {
  const updated = await updateBrief(id, { status: "archived" });
  return updated !== null;
}

// ── Assets ──────────────────────────────────────────────────────────

export interface CreateAssetInput {
  ad_brief_id: string;
  asset_type: "image" | "video";
  blob_url: string;
  original_filename: string;
  size_bytes?: number | null;
}

export async function createAsset(input: CreateAssetInput): Promise<AdBriefAsset> {
  await ensureAdBriefsSchema();
  const sql = getDb();
  const id = randomUUID();
  const rows = (await sql`
    INSERT INTO ad_brief_assets
      (id, ad_brief_id, asset_type, blob_url, original_filename, size_bytes)
    VALUES
      (${id}, ${input.ad_brief_id}, ${input.asset_type}, ${input.blob_url},
       ${input.original_filename}, ${input.size_bytes ?? null})
    RETURNING *
  `) as AdBriefAsset[];
  return rows[0]!;
}

export async function listAssetsForBrief(
  ad_brief_id: string,
): Promise<AdBriefAsset[]> {
  await ensureAdBriefsSchema();
  const sql = getDb();
  return (await sql`
    SELECT * FROM ad_brief_assets
    WHERE ad_brief_id = ${ad_brief_id}
    ORDER BY created_at ASC
  `) as AdBriefAsset[];
}

export async function deleteAsset(id: string): Promise<boolean> {
  await ensureAdBriefsSchema();
  const sql = getDb();
  const rows = (await sql`
    DELETE FROM ad_brief_assets WHERE id = ${id} RETURNING id
  `) as Array<{ id: string }>;
  return rows.length > 0;
}
