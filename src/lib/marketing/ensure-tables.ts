/**
 * Lazy-creates the marketing tables consumed by `/api/admin/spread`,
 * `/api/admin/media/spread`, and the spread-post orchestrator. Same
 * self-sufficient pattern as `migration_request_log` etc. — table
 * exists on first call, cached per lambda instance, idempotent.
 *
 * Schema lifted from the legacy `safeMigrate` calls verbatim so a
 * fresh dev DB matches production.
 */

import { getDb } from "@/lib/db";

let _tablesEnsured = false;

/** Reset the cache flag — test helper only. */
export function __resetMarketingTablesFlag(): void {
  _tablesEnsured = false;
}

export async function ensureMarketingTables(): Promise<void> {
  if (_tablesEnsured) return;
  const sql = getDb();
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS marketing_posts (
        id                 TEXT PRIMARY KEY,
        campaign_id        TEXT,
        platform           TEXT NOT NULL,
        source_post_id     TEXT,
        persona_id         TEXT,
        adapted_content    TEXT NOT NULL,
        adapted_media_url  TEXT,
        thumbnail_url      TEXT,
        platform_post_id   TEXT,
        platform_url       TEXT,
        status             TEXT NOT NULL DEFAULT 'queued',
        scheduled_for      TIMESTAMPTZ,
        posted_at          TIMESTAMPTZ,
        impressions        INTEGER NOT NULL DEFAULT 0,
        likes              INTEGER NOT NULL DEFAULT 0,
        shares             INTEGER NOT NULL DEFAULT 0,
        comments           INTEGER NOT NULL DEFAULT 0,
        views              INTEGER NOT NULL DEFAULT 0,
        clicks             INTEGER NOT NULL DEFAULT 0,
        error_message      TEXT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS marketing_platform_accounts (
        id                 TEXT PRIMARY KEY,
        platform           TEXT UNIQUE NOT NULL,
        account_name       TEXT NOT NULL DEFAULT '',
        account_id         TEXT NOT NULL DEFAULT '',
        account_url        TEXT NOT NULL DEFAULT '',
        access_token       TEXT NOT NULL DEFAULT '',
        refresh_token      TEXT NOT NULL DEFAULT '',
        token_expires_at   TIMESTAMPTZ,
        extra_config       TEXT NOT NULL DEFAULT '{}',
        is_active          BOOLEAN NOT NULL DEFAULT FALSE,
        last_posted_at     TIMESTAMPTZ,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    _tablesEnsured = true;
  } catch (err) {
    console.error(
      "[marketing] ensureMarketingTables failed:",
      err instanceof Error ? err.message : err,
    );
    // Don't cache the failure — let next call retry.
    throw err;
  }
}
