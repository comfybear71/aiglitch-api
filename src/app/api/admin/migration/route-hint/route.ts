/**
 * GET /api/admin/migration/route-hint?path=/api/foo
 *
 * Returns a "what goes in the tester" hint for the given path:
 *   • `hint.source === "curated"` if `ROUTE_HINTS` has an entry — per-
 *     method description + example query + example body + setup notes.
 *   • `hint.source === "jsdoc"` if not — falls back to the first `/** ... *\/`
 *     block in the route file.
 *   • `hint.source === "none"` if the file has no header comment either.
 *
 * Admin-auth'd (matches the rest of the migration console).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getRouteHint } from "@/lib/migration/route-hints";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const path = request.nextUrl.searchParams.get("path");
  if (!path || !path.startsWith("/api/")) {
    return NextResponse.json(
      { error: "path query param required (e.g. ?path=/api/feed)" },
      { status: 400 },
    );
  }

  const curated = getRouteHint(path);
  if (curated) {
    return NextResponse.json({
      path,
      source: "curated" as const,
      methods: curated.methods,
    });
  }

  // Fallback — read the route file and grab its first /** ... */ block.
  const jsdoc = await readRouteJsdoc(path);
  if (jsdoc) {
    return NextResponse.json({
      path,
      source: "jsdoc" as const,
      jsdoc,
    });
  }

  return NextResponse.json({
    path,
    source: "none" as const,
    message:
      "No curated hint yet and the route file has no top-level doc comment. Add an entry to src/lib/migration/route-hints.ts or a JSDoc block to the route file.",
  });
}

/**
 * Read the route file at `src/app/api/<path>/route.ts` and extract its
 * first `/** ... *\/` block. Returns null on miss (file not found, no
 * header comment, unreadable).
 */
async function readRouteJsdoc(path: string): Promise<string | null> {
  // `/api/foo/[id]/bar` → `src/app/api/foo/[id]/bar/route.ts`
  const rel = path.replace(/^\/api\//, "");
  const filePath = join(process.cwd(), "src/app/api", rel, "route.ts");

  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch {
    return null;
  }

  const match = source.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) return null;

  // Strip leading ` * ` from each line and outer whitespace.
  const cleaned = match[1]!
    .split("\n")
    .map((l) => l.replace(/^\s*\*\s?/, ""))
    .join("\n")
    .trim();

  return cleaned || null;
}
