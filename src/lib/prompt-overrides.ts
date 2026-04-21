/**
 * Prompt Override System.
 *
 * Lets the admin dashboard edit AI prompts (channel hints, director
 * style, genre templates, platform briefs) from the browser — DB
 * overrides take priority, with the hardcoded default as fallback.
 *
 * The table is created lazily via `ensureTable()` so a fresh env
 * still works before any migration runs. Table has `UNIQUE(category, key)`
 * so INSERT…ON CONFLICT upserts cleanly.
 *
 * Consumers:
 *   - `getPrompt(category, key, default)` — read in content generators
 *   - `getPromptOverrides()` — bulk read for the admin catalog view
 *   - `savePromptOverride` / `deletePromptOverride` — admin writes
 */

import { getDb } from "@/lib/db";

export interface PromptOverrideRow {
  id: number;
  category: string;
  key: string;
  label: string;
  value: string;
  updated_at: string;
}

let _tableEnsured = false;

async function ensureTable(): Promise<void> {
  if (_tableEnsured) return;
  try {
    const sql = getDb();
    await sql`
      CREATE TABLE IF NOT EXISTS prompt_overrides (
        id         SERIAL      PRIMARY KEY,
        category   TEXT        NOT NULL,
        key        TEXT        NOT NULL,
        label      TEXT        NOT NULL DEFAULT '',
        value      TEXT        NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(category, key)
      )
    `;
    _tableEnsured = true;
  } catch {
    // Best-effort. Caller-level try/catch surfaces real errors.
  }
}

/** Reset the one-shot flag — test helper only. */
export function __resetPromptOverridesTableFlag(): void {
  _tableEnsured = false;
}

/**
 * Read a single prompt value — DB override if set, otherwise `defaultValue`.
 * Missing table / unset DB URL both fall through to the default so
 * content generators never break on a fresh env.
 */
export async function getPrompt(
  category: string,
  key: string,
  defaultValue: string,
): Promise<string> {
  try {
    const sql = getDb();
    const rows = (await sql`
      SELECT value FROM prompt_overrides
      WHERE category = ${category} AND key = ${key}
      LIMIT 1
    `) as unknown as { value: string }[];
    const val = rows[0]?.value;
    if (val) return val;
  } catch {
    // Table missing or DB unreachable — fall through
  }
  return defaultValue;
}

/** List prompt overrides, optionally filtered by category. */
export async function getPromptOverrides(
  category?: string,
): Promise<PromptOverrideRow[]> {
  try {
    await ensureTable();
    const sql = getDb();
    const rows = category
      ? await sql`
          SELECT id, category, key, label, value, updated_at
          FROM prompt_overrides
          WHERE category = ${category}
          ORDER BY key
        `
      : await sql`
          SELECT id, category, key, label, value, updated_at
          FROM prompt_overrides
          ORDER BY category, key
        `;
    return rows as unknown as PromptOverrideRow[];
  } catch {
    return [];
  }
}

/** Upsert a prompt override by (category, key). */
export async function savePromptOverride(
  category: string,
  key: string,
  label: string,
  value: string,
): Promise<void> {
  await ensureTable();
  const sql = getDb();
  await sql`
    INSERT INTO prompt_overrides (category, key, label, value, updated_at)
    VALUES (${category}, ${key}, ${label}, ${value}, NOW())
    ON CONFLICT (category, key) DO UPDATE
    SET value      = ${value},
        label      = ${label},
        updated_at = NOW()
  `;
}

/** Delete a prompt override — the consumer reverts to its hardcoded default. */
export async function deletePromptOverride(category: string, key: string): Promise<void> {
  await ensureTable();
  const sql = getDb();
  await sql`
    DELETE FROM prompt_overrides WHERE category = ${category} AND key = ${key}
  `;
}
