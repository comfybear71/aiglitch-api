import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };

const fake = {
  calls: [] as SqlCall[],
  results: [] as (RowSet | Error)[],
};

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<RowSet> {
  fake.calls.push({ strings, values });
  const next = fake.results.shift();
  if (next instanceof Error) return Promise.reject(next);
  return Promise.resolve(next ?? []);
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

async function call(method: "GET" | "POST", body?: unknown) {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const init: { method: string; headers?: Headers; body?: string } = { method };
  if (body !== undefined) {
    init.headers = new Headers({ "content-type": "application/json" });
    init.body = JSON.stringify(body);
  }
  const req = new NextRequest("http://localhost/api/admin/nft-marketplace", init);
  return method === "GET" ? mod.GET() : mod.POST(req);
}

// ensureTable runs one CREATE TABLE call; seed an empty row ahead of the real query.
function seedEnsureTable() {
  fake.results.unshift([]);
}

describe("GET /api/admin/nft-marketplace", () => {
  it("is public (no admin gate) and returns images newest-first", async () => {
    // mockIsAdmin stays false — GET must still succeed.
    seedEnsureTable();
    fake.results.push([
      { product_id: "glitch-hat", image_url: "https://blob.test/hat.png" },
      { product_id: "glitch-sticker", image_url: "https://blob.test/sticker.png" },
    ]);
    const res = await call("GET");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { images: { product_id: string }[] };
    expect(body.images).toHaveLength(2);
    expect(body.images[0].product_id).toBe("glitch-hat");
    const select = fake.calls[fake.calls.length - 1];
    expect(select.strings.join("?")).toContain("FROM nft_product_images");
    expect(select.strings.join("?")).toContain("ORDER BY created_at DESC");
  });

  it("ensureTable runs even on empty-catalogue GET (fresh env)", async () => {
    seedEnsureTable();
    fake.results.push([]);
    const res = await call("GET");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { images: unknown[] };
    expect(body.images).toEqual([]);
    expect(fake.calls[0].strings.join("?")).toContain("CREATE TABLE IF NOT EXISTS nft_product_images");
  });
});

describe("POST /api/admin/nft-marketplace — delete", () => {
  it("401 when not admin", async () => {
    expect((await call("POST", { action: "delete", product_id: "p1" })).status).toBe(401);
  });

  it("400 when product_id missing on delete", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    const res = await call("POST", { action: "delete" });
    expect(res.status).toBe(400);
  });

  it("deletes by product_id", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    fake.results.push([]); // DELETE
    const res = await call("POST", { action: "delete", product_id: "glitch-hat" });
    expect(res.status).toBe(200);
    const del = fake.calls[fake.calls.length - 1];
    expect(del.strings.join("?")).toContain("DELETE FROM nft_product_images");
    expect(del.values).toEqual(["glitch-hat"]);
  });
});

describe("POST /api/admin/nft-marketplace — generate (Phase 5 deferral)", () => {
  it("401 when not admin", async () => {
    expect(
      (
        await call("POST", {
          product_id: "glitch-hat",
          product_name: "Glitch Hat",
        })
      ).status,
    ).toBe(401);
  });

  it("400 when product_id or product_name missing", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    expect((await call("POST", { product_name: "orphan" })).status).toBe(400);
    mockIsAdmin = true;
    seedEnsureTable();
    expect((await call("POST", { product_id: "x" })).status).toBe(400);
  });

  it("returns 501 with an explanatory reason", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    const res = await call("POST", {
      product_id: "glitch-hat",
      product_name: "Glitch Hat",
      product_description: "the hat",
    });
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.reason).toContain("@/lib/ai/");
  });

  it("does not run any writes when deferred", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    await call("POST", {
      product_id: "glitch-hat",
      product_name: "Glitch Hat",
    });
    // Only the ensureTable CREATE should have run.
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].strings.join("?")).toContain("CREATE TABLE IF NOT EXISTS");
  });
});
