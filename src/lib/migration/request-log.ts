/**
 * Request-log table helper + insert/query utilities.
 *
 * Auto-creates `migration_request_log` on first use (legacy
 * one-shot-per-Lambda pattern — fine since this is admin-only
 * and rarely hit). Every row captures one request dispatched by
 * `/api/admin/migration/test` (the dashboard's request runner):
 *
 *   id (UUID PK) | method | path | status | duration_ms |
 *   request_body (JSONB) | response_body (TEXT, truncated to 2KB) |
 *   error (TEXT) | session_id | created_at
 *
 * Session 3 will read this for the Logs tab + metrics aggregation.
 */

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

type Sql = ReturnType<typeof getDb>;

let tableEnsured = false;

export async function ensureRequestLogTable(): Promise<void> {
  if (tableEnsured) return;
  const sql = getDb();
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS migration_request_log (
        id            TEXT PRIMARY KEY,
        method        TEXT NOT NULL,
        path          TEXT NOT NULL,
        status        INTEGER,
        duration_ms   INTEGER,
        request_body  JSONB,
        response_body TEXT,
        error         TEXT,
        session_id    TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_migration_request_log_created_at
      ON migration_request_log (created_at DESC)
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_migration_request_log_path
      ON migration_request_log (path)
    `;
  } catch {
    // best-effort — swallow so a transient CREATE failure doesn't
    // cascade to the caller.
  }
  tableEnsured = true;
}

/** Test-only — reset the cached flag between tests. */
export function __resetRequestLogTableFlag(): void {
  tableEnsured = false;
}

export interface InsertLogInput {
  method: string;
  path: string;
  status?: number;
  durationMs?: number;
  requestBody?: unknown;
  responseBody?: string;
  error?: string;
  sessionId?: string;
}

export interface LogRow {
  id: string;
  method: string;
  path: string;
  status: number | null;
  duration_ms: number | null;
  request_body: unknown;
  response_body: string | null;
  error: string | null;
  session_id: string | null;
  created_at: string;
}

export async function insertRequestLog(
  sql: Sql,
  input: InsertLogInput,
): Promise<string> {
  await ensureRequestLogTable();
  const id = randomUUID();
  const bodyJson = input.requestBody ? JSON.stringify(input.requestBody) : null;
  const response = input.responseBody?.slice(0, 2048) ?? null;
  await sql`
    INSERT INTO migration_request_log (
      id, method, path, status, duration_ms,
      request_body, response_body, error, session_id
    ) VALUES (
      ${id}, ${input.method}, ${input.path},
      ${input.status ?? null}, ${input.durationMs ?? null},
      ${bodyJson}::jsonb, ${response}, ${input.error ?? null},
      ${input.sessionId ?? null}
    )
  `;
  return id;
}

export interface ListLogOpts {
  limit?: number;
  offset?: number;
  pathFilter?: string;
  statusFilter?: "ok" | "error" | "any";
}

export async function listRequestLog(
  sql: Sql,
  opts: ListLogOpts = {},
): Promise<LogRow[]> {
  await ensureRequestLogTable();
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;
  const pathFilter = opts.pathFilter;
  const statusFilter = opts.statusFilter ?? "any";

  // Build the query by branches (neon serverless doesn't do dynamic WHERE)
  if (pathFilter && statusFilter === "ok") {
    return (await sql`
      SELECT * FROM migration_request_log
      WHERE path = ${pathFilter} AND status >= 200 AND status < 300
      ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
    `) as unknown as LogRow[];
  }
  if (pathFilter && statusFilter === "error") {
    return (await sql`
      SELECT * FROM migration_request_log
      WHERE path = ${pathFilter} AND (status >= 400 OR status IS NULL)
      ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
    `) as unknown as LogRow[];
  }
  if (pathFilter) {
    return (await sql`
      SELECT * FROM migration_request_log
      WHERE path = ${pathFilter}
      ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
    `) as unknown as LogRow[];
  }
  if (statusFilter === "ok") {
    return (await sql`
      SELECT * FROM migration_request_log
      WHERE status >= 200 AND status < 300
      ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
    `) as unknown as LogRow[];
  }
  if (statusFilter === "error") {
    return (await sql`
      SELECT * FROM migration_request_log
      WHERE status >= 400 OR status IS NULL
      ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
    `) as unknown as LogRow[];
  }
  return (await sql`
    SELECT * FROM migration_request_log
    ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
  `) as unknown as LogRow[];
}

export async function clearRequestLog(sql: Sql): Promise<number> {
  await ensureRequestLogTable();
  const result = (await sql`
    DELETE FROM migration_request_log
    RETURNING id
  `) as unknown as { id: string }[];
  return result.length;
}
