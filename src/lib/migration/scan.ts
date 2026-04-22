/**
 * Filesystem scanner — finds every ported route under
 * `src/app/api/**` and returns its URL path + HTTP methods.
 *
 * This drives the "Ported" half of the migration dashboard. By
 * deriving from the filesystem we never have to manually maintain
 * a "what's done" list — adding a `route.ts` automatically shows up.
 *
 * Used at runtime by `/api/admin/migration/status`. Reads files
 * synchronously since:
 *   • the route count is bounded (~150 max ever)
 *   • the dashboard is admin-only and not high-traffic
 *   • avoids the need to ship a separate build-time generator
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface PortedRoute {
  path: string;
  methods: string[];
  /** Repo-relative path of the route file. */
  file: string;
}

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * Convert a filesystem dir under `src/app/api/` to its URL path.
 *   `src/app/api/admin/channels/route.ts` → `/api/admin/channels`
 *   `src/app/api/post/[id]/route.ts`      → `/api/post/[id]`
 */
function dirToApiPath(relativeDir: string): string {
  return `/api/${relativeDir.replace(/\\/g, "/")}`;
}

/**
 * Scan a route file for `export async function GET/POST/...` and
 * `export const GET = …`. Returns the methods it exports.
 */
function methodsInFile(content: string): string[] {
  const methods: string[] = [];
  for (const m of HTTP_METHODS) {
    // Catches both `export async function GET(` and `export const GET = `
    const re = new RegExp(`export\\s+(?:async\\s+function|const)\\s+${m}\\b`);
    if (re.test(content)) methods.push(m);
  }
  return methods;
}

/**
 * Recursively walk a directory and collect all `route.ts` files.
 */
function collectRouteFiles(rootDir: string): string[] {
  const found: string[] = [];
  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
      } else if (entry === "route.ts") {
        found.push(full);
      }
    }
  }
  walk(rootDir);
  return found;
}

/**
 * Scan the API directory and return every route + its exported
 * HTTP methods. Routes with zero methods are skipped (probably
 * placeholder / WIP files).
 *
 * Pass an explicit `apiDir` for tests; default uses the current
 * working directory + `src/app/api`.
 */
export function scanPortedRoutes(apiDir?: string): PortedRoute[] {
  const root = apiDir ?? join(process.cwd(), "src/app/api");
  const files = collectRouteFiles(root);

  const routes: PortedRoute[] = [];
  for (const file of files) {
    const relative = file.slice(root.length + 1).replace(/\/route\.ts$/, "");
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    const methods = methodsInFile(content);
    if (methods.length === 0) continue; // WIP / placeholder
    routes.push({
      path: dirToApiPath(relative),
      methods,
      file: `src/app/api/${relative}/route.ts`,
    });
  }

  // Sort by path for stable output
  return routes.sort((a, b) => a.path.localeCompare(b.path));
}
