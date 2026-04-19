import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

let _cachedSql: NeonQueryFunction<false, false> | null = null;

export function getDb(): NeonQueryFunction<false, false> {
  if (_cachedSql) return _cachedSql;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  _cachedSql = neon(url);
  return _cachedSql;
}
