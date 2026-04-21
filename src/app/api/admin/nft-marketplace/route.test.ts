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

// Image-gen helper — mocked; actual xAI + Blob download logic is covered
// in src/lib/ai/image.test.ts.
const imageGen = {
  calls: [] as { prompt: string; blobPath: string; taskType: string }[],
  result: {
    blobUrl: "https://blob.test/marketplace/glitch-hat-abcdef12.png",
    model: "grok-imagine-image" as const,
    estimatedUsd: 0.02,
  },
  shouldThrow: null as Error | null,
};

vi.mock("@/lib/ai/image", () => ({
  generateImageToBlob: (opts: { prompt: string; blobPath: string; taskType: string }) => {
    imageGen.calls.push(opts);
    if (imageGen.shouldThrow) return Promise.reject(imageGen.shouldThrow);
    return Promise.resolve(imageGen.result);
  },
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  imageGen.calls = [];
  imageGen.result = {
    blobUrl: "https://blob.test/marketplace/glitch-hat-abcdef12.png",
    model: "grok-imagine-image",
    estimatedUsd: 0.02,
  };
  imageGen.shouldThrow = null;
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

describe("POST /api/admin/nft-marketplace — generate", () => {
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
    // Neither branch should have invoked the image helper.
    expect(imageGen.calls).toHaveLength(0);
  });

  it("calls the helper with marketplace/{id}-{slug}.png blobPath and UPSERTs the row", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    fake.results.push([]); // UPSERT
    const res = await call("POST", {
      product_id: "glitch-hat",
      product_name: "Glitch Hat",
      product_description: "holographic cap",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      image_url: string;
      product_id: string;
    };
    expect(body.success).toBe(true);
    expect(body.product_id).toBe("glitch-hat");
    expect(body.image_url).toBe("https://blob.test/marketplace/glitch-hat-abcdef12.png");

    expect(imageGen.calls).toHaveLength(1);
    const genCall = imageGen.calls[0]!;
    expect(genCall.taskType).toBe("image_generation");
    expect(genCall.blobPath).toMatch(/^marketplace\/glitch-hat-[0-9a-f]{8}\.png$/i);
    expect(genCall.prompt).toContain("Glitch Hat");
    expect(genCall.prompt).toContain("holographic cap");

    const upsert = fake.calls[fake.calls.length - 1]!;
    const sqlText = upsert.strings.join("?");
    expect(sqlText).toContain("INSERT INTO nft_product_images");
    expect(sqlText).toContain("ON CONFLICT (product_id) DO UPDATE");
    expect(upsert.values).toContain("glitch-hat");
    expect(upsert.values).toContain("https://blob.test/marketplace/glitch-hat-abcdef12.png");
  });

  it("uses custom_prompt verbatim when provided", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    fake.results.push([]);
    await call("POST", {
      product_id: "glitch-hat",
      product_name: "Glitch Hat",
      custom_prompt: "bare-bones mock of the hat",
    });
    expect(imageGen.calls[0]!.prompt).toBe("bare-bones mock of the hat");
  });

  it("returns 500 and does not write when the helper throws", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    imageGen.shouldThrow = new Error("xAI upstream failed");
    const res = await call("POST", {
      product_id: "glitch-hat",
      product_name: "Glitch Hat",
    });
    expect(res.status).toBe(500);
    const hasInsert = fake.calls.some((c) =>
      c.strings.join("?").includes("INSERT INTO nft_product_images"),
    );
    expect(hasInsert).toBe(false);
  });
});
