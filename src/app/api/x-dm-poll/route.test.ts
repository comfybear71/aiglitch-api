import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };

interface FakeNeon {
  calls: SqlCall[];
  results: RowSet[];
}

const fake: FakeNeon = { calls: [], results: [] };

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<RowSet> {
  fake.calls.push({ strings, values });
  return Promise.resolve(fake.results.shift() ?? []);
}

vi.mock("@neondatabase/serverless", () => ({
  neon: () => fakeSql,
}));

vi.mock("@/lib/ai/generate", () => ({
  generateReplyToHuman: vi.fn().mockResolvedValue("Test AI reply"),
}));

const X_CREDS = {
  X_CONSUMER_KEY: "ck",
  X_CONSUMER_SECRET: "cs",
  X_ACCESS_TOKEN: "at",
  X_ACCESS_TOKEN_SECRET: "ats",
};

const ME_RESPONSE = { data: { id: "bot-user-id", username: "aiglitch" } };
const EMPTY_DMS = { data: [] };
const ONE_DM = {
  data: [
    {
      id: "evt-001",
      text: "Hello bot!",
      event_type: "MessageCreate",
      sender_id: "human-123",
      dm_conversation_id: "conv-abc",
    },
  ],
};

function makeFetch(
  responses: { ok: boolean; body: unknown; status?: number }[],
) {
  const queue = [...responses];
  return vi.fn().mockImplementation(() => {
    const next = queue.shift() ?? { ok: true, body: {} };
    return Promise.resolve({
      ok: next.ok,
      status: next.status ?? (next.ok ? 200 : 400),
      json: () => Promise.resolve(next.body),
      text: () => Promise.resolve(JSON.stringify(next.body)),
    });
  });
}

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  process.env.DATABASE_URL = "postgres://test";
  process.env.CRON_SECRET = "test-cron-secret";
  Object.assign(process.env, X_CREDS);
  vi.resetModules();
  vi.useFakeTimers();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.CRON_SECRET;
  Object.keys(X_CREDS).forEach((k) => delete process.env[k]);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function callGET(authHeader?: string) {
  vi.resetModules();
  vi.stubGlobal("fetch", makeFetch([
    { ok: true, body: ME_RESPONSE },
    { ok: true, body: EMPTY_DMS },
  ]));
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  const headers: Record<string, string> = authHeader ? { authorization: authHeader } : {};
  return GET(new NextRequest("http://localhost/api/x-dm-poll", { headers: new Headers(headers) }));
}

async function callPOST(opts?: { authHeader?: string; fetchResponses?: { ok: boolean; body: unknown }[] }) {
  vi.resetModules();
  vi.stubGlobal("fetch", makeFetch(opts?.fetchResponses ?? [
    { ok: true, body: ME_RESPONSE },
    { ok: true, body: EMPTY_DMS },
  ]));
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  const headers: Record<string, string> = {};
  if (opts?.authHeader) headers.authorization = opts.authHeader;
  return POST(new NextRequest("http://localhost/api/x-dm-poll", { method: "POST", headers: new Headers(headers) }));
}

describe("GET /api/x-dm-poll — auth", () => {
  it("401 when Authorization header is missing", async () => {
    const res = await callGET();
    expect(res.status).toBe(401);
  });

  it("401 when token is wrong", async () => {
    const res = await callGET("Bearer wrong-token");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/x-dm-poll — happy path (no new DMs)", () => {
  it("returns zero counts when DM inbox is empty", async () => {
    // CREATE TABLE cron_runs, INSERT cron_runs, CREATE TABLE x_dm_logs, UPDATE cron_runs
    fake.results = [[], [], [], []];
    const res = await callGET("Bearer test-cron-secret");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { polled: number; new_dms: number; replied: number; errors: number };
    expect(body.polled).toBe(0);
    expect(body.new_dms).toBe(0);
    expect(body.replied).toBe(0);
    expect(body.errors).toBe(0);
  });

  it("includes _cron_run_id in response", async () => {
    fake.results = [[], [], [], []];
    const res = await callGET("Bearer test-cron-secret");
    const body = (await res.json()) as { _cron_run_id: string };
    expect(typeof body._cron_run_id).toBe("string");
  });
});

describe("GET /api/x-dm-poll — new DM handling", () => {
  it("replies to a new DM and increments replied count", async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", makeFetch([
      { ok: true, body: ME_RESPONSE },       // GET /2/users/me
      { ok: true, body: ONE_DM },            // GET /2/dm_events
      { ok: true, body: { data: { id: "dm-sent-1" } } }, // POST send DM
    ]));
    const { GET } = await import("./route");
    const { NextRequest } = await import("next/server");

    // CREATE TABLE cron_runs, INSERT cron_runs, CREATE TABLE x_dm_logs,
    // SELECT x_dm_logs (dedup — empty), INSERT x_dm_logs, UPDATE x_dm_logs (replied), UPDATE cron_runs
    fake.results = [[], [], [], [], [], [], []];

    const res = await GET(
      new NextRequest("http://localhost/api/x-dm-poll", {
        headers: new Headers({ authorization: "Bearer test-cron-secret" }),
      }),
    );
    // Advance any pending timers (DM_SEND_DELAY_MS)
    vi.runAllTimers();

    expect(res.status).toBe(200);
    const body = (await res.json()) as { polled: number; new_dms: number; replied: number; errors: number };
    expect(body.polled).toBe(1);
    expect(body.new_dms).toBe(1);
    expect(body.replied).toBe(1);
    expect(body.errors).toBe(0);
  });

  it("skips a duplicate DM (already in x_dm_logs)", async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", makeFetch([
      { ok: true, body: ME_RESPONSE },
      { ok: true, body: ONE_DM },
    ]));
    const { GET } = await import("./route");
    const { NextRequest } = await import("next/server");

    // SELECT returns existing row — duplicate
    fake.results = [[], [], [], [{ id: 99 }], [], []];

    const res = await GET(
      new NextRequest("http://localhost/api/x-dm-poll", {
        headers: new Headers({ authorization: "Bearer test-cron-secret" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { polled: number; new_dms: number };
    expect(body.polled).toBe(1);
    expect(body.new_dms).toBe(0);
  });

  it("skips own messages (bot reply loops)", async () => {
    vi.resetModules();
    const ownDm = {
      data: [
        { id: "evt-own", text: "My own message", event_type: "MessageCreate", sender_id: "bot-user-id", dm_conversation_id: "conv-x" },
      ],
    };
    vi.stubGlobal("fetch", makeFetch([
      { ok: true, body: ME_RESPONSE },
      { ok: true, body: ownDm },
    ]));
    const { GET } = await import("./route");
    const { NextRequest } = await import("next/server");

    fake.results = [[], [], [], []];

    const res = await GET(
      new NextRequest("http://localhost/api/x-dm-poll", {
        headers: new Headers({ authorization: "Bearer test-cron-secret" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { polled: number; new_dms: number };
    expect(body.polled).toBe(1);
    expect(body.new_dms).toBe(0);
  });
});

describe("POST /api/x-dm-poll — auth", () => {
  it("401 when no auth provided", async () => {
    const res = await callPOST();
    expect(res.status).toBe(401);
  });
});

describe("GET /api/x-dm-poll — 403 soft-skip", () => {
  it("returns dm_reads_disabled:true instead of throwing on 403", async () => {
    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      makeFetch([
        { ok: true, body: ME_RESPONSE },
        // X returns 403 when the app's tier / scopes don't permit DM reads
        {
          ok: false,
          status: 403,
          body: { title: "Forbidden", detail: "Not authorized" },
        },
      ]),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { GET } = await import("./route");
    const { NextRequest } = await import("next/server");

    // CREATE cron_runs, INSERT cron_run, CREATE x_dm_logs, UPDATE cron_run
    fake.results = [[], [], [], []];

    const res = await GET(
      new NextRequest("http://localhost/api/x-dm-poll", {
        headers: new Headers({ authorization: "Bearer test-cron-secret" }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      polled: number;
      new_dms: number;
      dm_reads_disabled?: boolean;
    };
    expect(body.polled).toBe(0);
    expect(body.new_dms).toBe(0);
    expect(body.dm_reads_disabled).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
