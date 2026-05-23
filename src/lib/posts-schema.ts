/**
 * Posts-table schema migrations applied lazily on first cron / route
 * call. Mirrors the cron-handler.ts and feedback-loop.ts patterns —
 * idempotent ALTER TABLE / CREATE INDEX so the schema converges
 * without a separate deploy step.
 *
 * Sister-repo `src/lib/db/schema.ts` is the canonical Drizzle
 * definition; this file just keeps the live Neon table aligned with
 * what the API writers expect. Coordinate any new column here with
 * an addition to the sister-repo schema in the same release.
 */

import { getDb } from "@/lib/db";

let productIdColumnEnsured = false;

/**
 * Ensure `posts.product_id` exists (nullable text) + the supporting
 * partial index used by "which posts shilled product X" queries.
 * Postgres `ADD COLUMN IF NOT EXISTS` is a no-op + fast when the
 * column is already there, so calling this on every cron tick is
 * cheap — we still gate with a warm-instance flag for symmetry.
 */
export async function ensurePostsProductIdColumn(): Promise<void> {
  if (productIdColumnEnsured) return;
  const sql = getDb();
  await sql`ALTER TABLE posts ADD COLUMN IF NOT EXISTS product_id TEXT`;
  await sql`
    CREATE INDEX IF NOT EXISTS posts_product_id_idx
    ON posts (product_id)
    WHERE product_id IS NOT NULL
  `;
  productIdColumnEnsured = true;
}
