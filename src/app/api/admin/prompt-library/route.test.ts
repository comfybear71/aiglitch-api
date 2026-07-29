import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
const fake = {
  calls: [] as { strings: TemplateStringsArray; values: unknown[] }[],
  results: [] as RowSet[],
};

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<RowSet> {
  fake.calls.push({ strings, values });
  return Promise.resolve(fake.results.shift() ?? []);
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

async function callGET(qs: string) {
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest(`http://localhost/api/admin/prompt-library?${qs}`));
}

async function callPOST(body: unknown) {
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  return POST(
    new NextRequest("http://localhost/api/admin/prompt-library", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("GET /api/admin/prompt-library", () => {
  it("401 without auth", async () => {
    expect((await callGET("collection=elon")).status).toBe(401);
  });

  it("400 without collection", async () => {
    mockIsAdmin = true;
    fake.results = [];
    expect((await callGET("")).status).toBe(400);
  });

  it("200 lists drafts", async () => {
    mockIsAdmin = true;
    const now = new Date().toISOString();
    fake.results = [
      [],
      [],
      [
        {
          id: "a",
          collection: "elon",
          title: "t",
          value: "hello",
          created_at: now,
          updated_at: now,
        },
      ],
    ];
    const res = await callGET("collection=elon");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { drafts: unknown[] };
    expect(body.drafts).toHaveLength(1);
  });
});

describe("POST /api/admin/prompt-library", () => {
  it("401 without auth", async () => {
    expect((await callPOST({ action: "save", collection: "elon", value: "x" })).status).toBe(
      401,
    );
  });

  it("400 save without value", async () => {
    mockIsAdmin = true;
    expect(
      (await callPOST({ action: "save", collection: "elon", value: "  " })).status,
    ).toBe(400);
  });

  it("200 save", async () => {
    mockIsAdmin = true;
    const now = new Date().toISOString();
    fake.results = [
      [],
      [],
      [],
      [
        {
          id: "new",
          collection: "elon",
          title: "auto",
          value: "full prompt",
          meta: {},
          created_at: now,
          updated_at: now,
        },
      ],
    ];
    const res = await callPOST({
      action: "save",
      collection: "elon",
      value: "full prompt",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; draft: { value: string } };
    expect(body.ok).toBe(true);
    expect(body.draft.value).toBe("full prompt");
  });
});
