import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanPortedRoutes } from "./scan";

function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), "scan-test-"));
  // Mirror src/app/api layout
  mkdirSync(join(root, "health"), { recursive: true });
  writeFileSync(
    join(root, "health/route.ts"),
    `export async function GET() { return new Response("ok"); }`,
  );
  // CRUD route with multiple methods
  mkdirSync(join(root, "admin/channels"), { recursive: true });
  writeFileSync(
    join(root, "admin/channels/route.ts"),
    `export async function GET() {}\nexport async function POST() {}\nexport async function DELETE() {}`,
  );
  // Dynamic segment
  mkdirSync(join(root, "post/[id]"), { recursive: true });
  writeFileSync(
    join(root, "post/[id]/route.ts"),
    `export const GET = async () => {};`,
  );
  // Placeholder (no handlers) — should be skipped
  mkdirSync(join(root, "wip"), { recursive: true });
  writeFileSync(
    join(root, "wip/route.ts"),
    `// nothing exported yet`,
  );
  return root;
}

describe("scanPortedRoutes", () => {
  it("walks the api dir and returns routes + methods", () => {
    const root = makeTree();
    try {
      const routes = scanPortedRoutes(root);
      const paths = routes.map((r) => r.path);
      expect(paths).toContain("/api/health");
      expect(paths).toContain("/api/admin/channels");
      expect(paths).toContain("/api/post/[id]");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("captures all 5 method styles", () => {
    const root = makeTree();
    try {
      const routes = scanPortedRoutes(root);
      const channels = routes.find((r) => r.path === "/api/admin/channels");
      expect(channels?.methods.sort()).toEqual(["DELETE", "GET", "POST"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("supports `export const GET = …` style", () => {
    const root = makeTree();
    try {
      const routes = scanPortedRoutes(root);
      const post = routes.find((r) => r.path === "/api/post/[id]");
      expect(post?.methods).toEqual(["GET"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips placeholder routes with no exports", () => {
    const root = makeTree();
    try {
      const routes = scanPortedRoutes(root);
      const wip = routes.find((r) => r.path === "/api/wip");
      expect(wip).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("output is sorted by path for stable ordering", () => {
    const root = makeTree();
    try {
      const routes = scanPortedRoutes(root);
      const paths = routes.map((r) => r.path);
      const sorted = [...paths].sort();
      expect(paths).toEqual(sorted);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
