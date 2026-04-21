import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };

const fake = {
  calls: [] as SqlCall[],
  results: [] as (RowSet | Error)[],
};

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]) {
  fake.calls.push({ strings, values });
  const next = fake.results.shift();
  const promise: Promise<RowSet> =
    next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? []);
  return Object.assign(promise, { catch: promise.catch.bind(promise) });
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

const gen = {
  calls: [] as unknown[],
  result:
    '{"video_prompt":"A neon product shot","caption":"buy now","x_caption":"drops today"}',
  shouldThrow: null as Error | null,
};

vi.mock("@/lib/ai/generate", () => ({
  generateText: (opts: unknown) => {
    gen.calls.push(opts);
    if (gen.shouldThrow) return Promise.reject(gen.shouldThrow);
    return Promise.resolve(gen.result);
  },
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  gen.calls = [];
  gen.result =
    '{"video_prompt":"A neon product shot","caption":"buy now","x_caption":"drops today"}';
  gen.shouldThrow = null;
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
});

async function callGet(query = "", authed = true, id = "42") {
  if (authed) mockIsAdmin = true;
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest(
    `http://localhost/api/admin/sponsors/${id}/ads${query}`,
    { method: "GET" },
  );
  return mod.GET(req, { params: Promise.resolve({ id }) });
}

async function callPost(body: unknown, authed = true, id = "42") {
  if (authed) mockIsAdmin = true;
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest(
    `http://localhost/api/admin/sponsors/${id}/ads`,
    {
      method: "POST",
      headers: new Headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    },
  );
  return mod.POST(req, { params: Promise.resolve({ id }) });
}

async function callPut(body: unknown, authed = true) {
  if (authed) mockIsAdmin = true;
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest(
    "http://localhost/api/admin/sponsors/42/ads",
    {
      method: "PUT",
      headers: new Headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    },
  );
  return mod.PUT(req);
}

describe("GET /api/admin/sponsors/[id]/ads", () => {
  it("401 when not admin", async () => {
    expect((await callGet("", false)).status).toBe(401);
  });

  it("default action → list ads for sponsor", async () => {
    fake.results.push([
      { id: 1, sponsor_id: 42, product_name: "Widget" },
      { id: 2, sponsor_id: 42, product_name: "Gadget" },
    ]);
    const res = await callGet();
    const body = (await res.json()) as { ads: unknown[] };
    expect(body.ads).toHaveLength(2);
  });

  it("placements action → 404 when sponsor missing", async () => {
    fake.results.push([]); // sponsor lookup empty
    const res = await callGet("?action=placements");
    expect(res.status).toBe(404);
  });

  it("placements action → empty when sponsor has no campaigns", async () => {
    fake.results.push([{ company_name: "Acme" }]);
    fake.results.push([]); // no campaigns
    const res = await callGet("?action=placements");
    const body = (await res.json()) as {
      placements: unknown[];
      total: number;
      sponsor: string;
    };
    expect(body.total).toBe(0);
    expect(body.sponsor).toBe("Acme");
  });

  it("placements action → joins impressions + posts + channels", async () => {
    fake.results.push([{ company_name: "Acme" }]);
    fake.results.push([
      { id: 7, brand_name: "Acme", product_name: "Widget" },
    ]);
    fake.results.push([
      {
        impression_id: 1,
        campaign_id: 7,
        post_id: "p-1",
        channel_id: "ch-1",
        channel_name: "AI News",
        post_content: "Check out Widget",
      },
    ]);
    const res = await callGet("?action=placements");
    const body = (await res.json()) as {
      placements: unknown[];
      total: number;
      campaigns: { id: number; brand: string; product: string }[];
    };
    expect(body.total).toBe(1);
    expect(body.campaigns[0]!.brand).toBe("Acme");
  });

  it("DB error → 500", async () => {
    fake.results.push(new Error("db down"));
    const res = await callGet();
    expect(res.status).toBe(500);
  });
});

describe("POST /api/admin/sponsors/[id]/ads", () => {
  it("401 when not admin", async () => {
    expect((await callPost({}, false)).status).toBe(401);
  });

  it("400 when product_name or description missing", async () => {
    expect((await callPost({})).status).toBe(400);
    expect((await callPost({ product_name: "X" })).status).toBe(400);
  });

  it("happy path inserts + returns id from package defaults", async () => {
    fake.results.push([{ id: 101 }]); // RETURNING id
    const res = await callPost({
      product_name: "Widget",
      product_description: "does things",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: number };
    expect(body.ok).toBe(true);
    expect(body.id).toBe(101);

    const insert = fake.calls[0]!;
    // 'draft' literal is in the SQL template; verify it got through.
    expect(insert.strings.join("?")).toContain("'draft'");
  });

  it("body overrides package defaults (frequency + campaign_days + cash_paid)", async () => {
    fake.results.push([{ id: 102 }]);
    await callPost({
      product_name: "X",
      product_description: "y",
      frequency: 99,
      campaign_days: 30,
      cash_paid: 5000,
    });
    const insertValues = fake.calls[0]!.values;
    expect(insertValues).toContain(99);
    expect(insertValues).toContain(30);
    expect(insertValues).toContain(5000);
  });
});

describe("PUT /api/admin/sponsors/[id]/ads", () => {
  it("401 when not admin", async () => {
    expect((await callPut({ id: 1 }, false)).status).toBe(401);
  });

  it("400 when id missing", async () => {
    expect((await callPut({})).status).toBe(400);
  });

  it("delete action removes row", async () => {
    fake.results.push([]); // DELETE
    const res = await callPut({ id: 1, action: "delete" });
    expect(res.status).toBe(200);
    const del = fake.calls.find((c) =>
      c.strings.join("?").includes("DELETE FROM sponsored_ads"),
    );
    expect(del).toBeDefined();
  });

  it("generate action → AI JSON parse + pending_review", async () => {
    fake.results.push([]); // UPDATE pending_review
    const res = await callPut({
      id: 1,
      action: "generate",
      product_name: "Widget",
      product_description: "fun",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      prompt: string;
      caption: string;
      x_caption: string;
    };
    expect(body.prompt).toBe("A neon product shot");
    expect(body.caption).toBe("buy now");
    expect(body.x_caption).toBe("drops today");
    const update = fake.calls.find((c) =>
      c.strings.join("?").includes("pending_review"),
    );
    expect(update).toBeDefined();
  });

  it("generate action handles extra text around JSON (first {...} match)", async () => {
    gen.result =
      'Here is the ad:\n```json\n{"video_prompt":"neon x","caption":"c","x_caption":"xc"}\n```';
    fake.results.push([]); // UPDATE pending_review
    const res = await callPut({
      id: 1,
      action: "generate",
      product_name: "Widget",
      product_description: "fun",
    });
    const body = (await res.json()) as { prompt: string };
    expect(body.prompt).toBe("neon x");
  });

  it("generate action → 500 when JSON parse fails", async () => {
    gen.result = "sorry, I cannot help with that";
    const res = await callPut({
      id: 1,
      action: "generate",
      product_name: "X",
      product_description: "Y",
    });
    expect(res.status).toBe(500);
  });

  it("generate action → 500 when AI throws", async () => {
    gen.shouldThrow = new Error("AI down");
    const res = await callPut({
      id: 1,
      action: "generate",
      product_name: "X",
      product_description: "Y",
    });
    expect(res.status).toBe(500);
  });

  it("default update → COALESCE patch", async () => {
    fake.results.push([]); // UPDATE sponsored_ads
    const res = await callPut({
      id: 1,
      video_url: "https://blob.test/x.mp4",
    });
    expect(res.status).toBe(200);
    const update = fake.calls[0]!;
    expect(update.values).toContain("https://blob.test/x.mp4");
  });

  it("publishing status triggers GLITCH deduction", async () => {
    fake.results.push([]); // UPDATE sponsored_ads
    fake.results.push([{ sponsor_id: 42, glitch_cost: 500 }]);
    fake.results.push([]); // UPDATE sponsors
    const res = await callPut({ id: 1, status: "published" });
    expect(res.status).toBe(200);
    const deduct = fake.calls.find((c) =>
      c.strings.join("?").includes("UPDATE sponsors"),
    );
    expect(deduct).toBeDefined();
    expect(deduct!.values).toContain(500);
  });
});
