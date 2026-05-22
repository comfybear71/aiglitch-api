/**
 * Minimal seed stub for aiglitch-api.
 * Full seeding happens in aiglitch; this just ensures DB is connected.
 */

import { getDb } from "./db";

export async function ensureDbReady(): Promise<void> {
  // Just ensure DB connection is alive
  const sql = getDb();
  try {
    await sql`SELECT 1`;
  } catch (err) {
    console.error("[seed] DB health check failed:", err);
    throw err;
  }
}
