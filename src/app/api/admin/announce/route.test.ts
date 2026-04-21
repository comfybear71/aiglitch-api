import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };

const fake = {
  calls: [] as SqlCall[],
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

function mockFetch(responses: { ok: boolean; status?: number }[]) {
  const queue = [...responses];
  return vi.fn().mockImplementation(() => {
    const next = queue.shift() ?? { ok: true };
    return Promise.resolve({
      ok: next.ok,
      status: next.status ?? (next.ok ? 200 : 500),
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(""),
    });
  });
}

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
});

async function callPOST(body: unknown) {
  vi.resetModules();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  return POST(new NextRequest("http://localhost/api/admin/announce", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  }));
}

describe("POST /api/admin/announce", () => {
  it("401 when not admin", async () => {
    expect((await callPOST({ title: "t", body: "b" })).status).toBe(401);
  });

  it("400 when title or body missing", async () => {
    mockIsAdmin = true;
    expect((await callPOST({ body: "b" })).status).toBe(400);
    expect((await callPOST({ title: "t" })).status).toBe(400);
  });

  it("returns sent:0 when no push tokens are registered", async () => {
    mockIsAdmin = true;
    fake.results = [[]];
    const res = await callPOST({ title: "hi", body: "there" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sent: number; errors: number; total_tokens: number };
    expect(body).toMatchObject({ sent: 0, errors: 0, total_tokens: 0 });
  });

  it("filters out non-Expo-looking tokens before sending", async () => {
    mockIsAdmin = true;
    fake.results = [
      [
        { push_token: "ExponentPushToken[abc123]" },
        { push_token: "fcm:someOtherToken" },    // should be filtered
        { push_token: "ExponentPushToken[def456]" },
      ],
    ];
    const fetchMock = mockFetch([{ ok: true }]);
    vi.stubGlobal("fetch", fetchMock);

    const res = await callPOST({ title: "hi", body: "there" });
    const body = (await res.json()) as { sent: number; total_tokens: number };
    expect(body.sent).toBe(2);
    expect(body.total_tokens).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("counts Expo failures as errors without aborting", async () => {
    mockIsAdmin = true;
    fake.results = [[{ push_token: "ExponentPushToken[abc]" }, { push_token: "ExponentPushToken[def]" }]];
    vi.stubGlobal("fetch", mockFetch([{ ok: false, status: 500 }]));

    const res = await callPOST({ title: "hi", body: "there" });
    const body = (await res.json()) as { sent: number; errors: number };
    expect(body.sent).toBe(0);
    expect(body.errors).toBe(2);
  });

  it("batches >100 tokens into multiple Expo calls", async () => {
    mockIsAdmin = true;
    const tokens = Array.from({ length: 150 }, (_, i) => ({
      push_token: `ExponentPushToken[${i}]`,
    }));
    fake.results = [tokens];
    const fetchMock = mockFetch([{ ok: true }, { ok: true }]);
    vi.stubGlobal("fetch", fetchMock);

    const res = await callPOST({ title: "hi", body: "there" });
    const body = (await res.json()) as { sent: number };
    expect(fetchMock).toHaveBeenCalledTimes(2); // 100 + 50
    expect(body.sent).toBe(150);
  });
});
