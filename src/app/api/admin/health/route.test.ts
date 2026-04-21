import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];

const fake = {
  results: [] as (RowSet | Error)[],
};

function fakeSql(..._args: unknown[]): Promise<RowSet> {
  const next = fake.results.shift();
  if (next instanceof Error) return Promise.reject(next);
  return Promise.resolve(next ?? []);
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

type Probe = { ok: boolean; status?: number; body?: unknown };
function mockFetchByHost(map: Record<string, Probe>) {
  return vi.fn().mockImplementation((url: string) => {
    for (const [host, probe] of Object.entries(map)) {
      if (url.includes(host)) {
        return Promise.resolve({
          ok: probe.ok,
          status: probe.status ?? (probe.ok ? 200 : 500),
          json: () => Promise.resolve(probe.body ?? {}),
          text: () => Promise.resolve(JSON.stringify(probe.body ?? "")),
        });
      }
    }
    return Promise.reject(new Error(`No mock for ${url}`));
  });
}

beforeEach(() => {
  fake.results = [];
  mockIsAdmin = false;
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.HELIUS_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.XAI_API_KEY;
  vi.restoreAllMocks();
});

async function callGET() {
  vi.resetModules();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest("http://localhost/api/admin/health"));
}

describe("GET /api/admin/health", () => {
  it("401 when not admin", async () => {
    expect((await callGET()).status).toBe(401);
  });

  it("returns status: ok when every probe succeeds", async () => {
    mockIsAdmin = true;
    process.env.UPSTASH_REDIS_REST_URL = "https://redis.example";
    process.env.UPSTASH_REDIS_REST_TOKEN = "tok";
    process.env.ANTHROPIC_API_KEY = "sk-anthropic";
    process.env.XAI_API_KEY = "sk-xai";

    fake.results = [[{ ping: 1 }]]; // DB probe
    vi.stubGlobal("fetch", mockFetchByHost({
      "redis.example":       { ok: true },
      "mainnet-beta.solana": { ok: true, body: { result: "ok" } },
      "api.anthropic.com":   { ok: true },
      "api.x.ai":            { ok: true },
    }));

    const res = await callGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      services: Record<string, { status: string }>;
    };
    expect(body.status).toBe("ok");
    expect(body.services.database.status).toBe("ok");
    expect(body.services.redis.status).toBe("ok");
    expect(body.services.solana.status).toBe("ok");
    expect(body.services.anthropic.status).toBe("ok");
    expect(body.services.xai.status).toBe("ok");
  });

  it("reports degraded when a provider key is missing", async () => {
    mockIsAdmin = true;
    // Only DB configured — everything else should error "Not configured"
    fake.results = [[{ ping: 1 }]];
    vi.stubGlobal("fetch", mockFetchByHost({
      "mainnet-beta.solana": { ok: true, body: { result: "ok" } },
    }));

    const res = await callGET();
    const body = (await res.json()) as {
      status: string;
      services: Record<string, { status: string; message: string }>;
    };
    expect(body.status).toBe("degraded");
    expect(body.services.redis.status).toBe("error");
    expect(body.services.redis.message).toContain("Not configured");
    expect(body.services.anthropic.status).toBe("error");
    expect(body.services.xai.status).toBe("error");
  });

  it("marks a service as error when its probe returns non-200", async () => {
    mockIsAdmin = true;
    process.env.ANTHROPIC_API_KEY = "sk-anthropic";
    process.env.XAI_API_KEY = "sk-xai";

    fake.results = [[{ ping: 1 }]];
    vi.stubGlobal("fetch", mockFetchByHost({
      "mainnet-beta.solana": { ok: true, body: { result: "ok" } },
      "api.anthropic.com":   { ok: false, status: 503 },
      "api.x.ai":            { ok: true },
    }));

    const res = await callGET();
    const body = (await res.json()) as { services: { anthropic: { status: string; message: string } } };
    expect(body.services.anthropic.status).toBe("error");
    expect(body.services.anthropic.message).toContain("503");
  });

  it("marks solana as error when getHealth returns non-ok", async () => {
    mockIsAdmin = true;
    process.env.ANTHROPIC_API_KEY = "sk-anthropic";
    process.env.XAI_API_KEY = "sk-xai";

    fake.results = [[{ ping: 1 }]];
    vi.stubGlobal("fetch", mockFetchByHost({
      "mainnet-beta.solana": { ok: true, body: { error: { message: "behind" } } },
      "api.anthropic.com":   { ok: true },
      "api.x.ai":            { ok: true },
    }));

    const res = await callGET();
    const body = (await res.json()) as { services: { solana: { status: string } } };
    expect(body.services.solana.status).toBe("error");
  });

  it("marks database as error when SQL probe rejects", async () => {
    mockIsAdmin = true;
    process.env.ANTHROPIC_API_KEY = "sk-anthropic";
    process.env.XAI_API_KEY = "sk-xai";

    fake.results = [new Error("db offline")];
    vi.stubGlobal("fetch", mockFetchByHost({
      "mainnet-beta.solana": { ok: true, body: { result: "ok" } },
      "api.anthropic.com":   { ok: true },
      "api.x.ai":            { ok: true },
    }));

    const res = await callGET();
    const body = (await res.json()) as { services: { database: { status: string } } };
    expect(body.services.database.status).toBe("error");
  });
});
