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

const blob = {
  putCalls: [] as { pathname: string; opts: unknown }[],
  putResults: [] as ({ url: string } | Error)[],
};

vi.mock("@vercel/blob", () => ({
  put: (pathname: string, _body: unknown, opts: unknown) => {
    blob.putCalls.push({ pathname, opts });
    const next = blob.putResults.shift();
    if (!next) return Promise.resolve({ url: `https://blob.test/${pathname}` });
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  },
}));

type SubmitResult = {
  requestId: string;
  syncVideoUrl?: string;
  model: "grok-imagine-video";
  estimatedUsd: number;
  durationSec: number;
};
type PollResult = {
  requestId: string;
  status: "pending" | "done" | "failed" | "expired";
  videoUrl?: string;
  respectModeration?: boolean;
};

const video = {
  submitCalls: [] as unknown[],
  submitQueue: [] as (SubmitResult | Error)[],
  pollCalls: [] as string[],
  pollQueue: [] as (PollResult | Error)[],
};

vi.mock("@/lib/ai/video", () => ({
  submitVideoJob: (opts: unknown) => {
    video.submitCalls.push(opts);
    const next = video.submitQueue.shift();
    if (!next) {
      return Promise.resolve({
        requestId: `req-${video.submitCalls.length}`,
        model: "grok-imagine-video" as const,
        estimatedUsd: 0.5,
        durationSec: 10,
      });
    }
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  },
  pollVideoJob: (requestId: string) => {
    video.pollCalls.push(requestId);
    const next = video.pollQueue.shift();
    if (!next) return Promise.resolve({ requestId, status: "pending" as const });
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  },
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  blob.putCalls = [];
  blob.putResults = [];
  video.submitCalls = [];
  video.submitQueue = [];
  video.pollCalls = [];
  video.pollQueue = [];
  process.env.DATABASE_URL = "postgres://test";
  process.env.XAI_API_KEY = "xai-test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.XAI_API_KEY;
  vi.restoreAllMocks();
});

// ensureTable runs 1 SQL call (CREATE TABLE IF NOT EXISTS).
function seedEnsureTable() {
  fake.results.unshift([]);
}

async function call(
  method: "GET" | "POST",
  url = "http://localhost/api/admin/spec-ads",
  body?: unknown,
) {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const init: { method: string; headers?: Headers; body?: string } = { method };
  if (body !== undefined) {
    init.headers = new Headers({ "content-type": "application/json" });
    init.body = JSON.stringify(body);
  }
  const req = new NextRequest(url, init);
  return method === "GET" ? mod.GET(req) : mod.POST(req);
}

describe("GET /api/admin/spec-ads", () => {
  it("401 when not admin", async () => {
    expect((await call("GET")).status).toBe(401);
  });

  it("action=list returns rows", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    fake.results.push([{ id: "ad-1", brand_name: "Acme" }]);
    const res = await call("GET", "http://localhost/api/admin/spec-ads?action=list");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ads: Array<{ id: string }> };
    expect(body.ads).toHaveLength(1);
    expect(body.ads[0]!.id).toBe("ad-1");
  });

  it("default action is list", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    fake.results.push([]);
    const res = await call("GET");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ads: unknown[] };
    expect(body.ads).toEqual([]);
  });

  it("action=status returns single ad", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    fake.results.push([{ id: "ad-1", status: "done" }]);
    const res = await call(
      "GET",
      "http://localhost/api/admin/spec-ads?action=status&id=ad-1",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ad: { id: string } };
    expect(body.ad.id).toBe("ad-1");
  });

  it("action=status 400 when id missing", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    const res = await call(
      "GET",
      "http://localhost/api/admin/spec-ads?action=status",
    );
    expect(res.status).toBe(400);
  });

  it("action=status 404 when ad missing", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    fake.results.push([]);
    const res = await call(
      "GET",
      "http://localhost/api/admin/spec-ads?action=status&id=nope",
    );
    expect(res.status).toBe(404);
  });

  it("unknown action → 400", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    const res = await call(
      "GET",
      "http://localhost/api/admin/spec-ads?action=weird",
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/admin/spec-ads — generate", () => {
  it("401 when not admin", async () => {
    expect((await call("POST", undefined, {})).status).toBe(401);
  });

  it("400 when brand_name missing", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    const res = await call("POST", undefined, { product_name: "X" });
    expect(res.status).toBe(400);
  });

  it("400 when product_name missing", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    const res = await call("POST", undefined, { brand_name: "Acme" });
    expect(res.status).toBe(400);
  });

  it("500 when XAI_API_KEY not set", async () => {
    delete process.env.XAI_API_KEY;
    mockIsAdmin = true;
    seedEnsureTable();
    const res = await call("POST", undefined, {
      brand_name: "Acme",
      product_name: "Widget",
    });
    expect(res.status).toBe(500);
  });

  it("submits 3 video jobs and inserts spec_ads row", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    fake.results.push([]); // INSERT
    video.submitQueue.push(
      {
        requestId: "r1",
        model: "grok-imagine-video",
        estimatedUsd: 0.5,
        durationSec: 10,
      },
      {
        requestId: "r2",
        model: "grok-imagine-video",
        estimatedUsd: 0.5,
        durationSec: 10,
      },
      {
        requestId: "r3",
        model: "grok-imagine-video",
        estimatedUsd: 0.5,
        durationSec: 10,
      },
    );
    fake.results.push([]); // UPDATE clips

    const res = await call("POST", undefined, {
      brand_name: "Acme Co",
      product_name: "Widget 9000",
      description: "It widgets.",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      brand_name: string;
      folder: string;
      clips: Array<{ request_id: string | null; channel: string }>;
      status: string;
    };
    expect(body.status).toBe("generating");
    expect(body.folder).toBe("sponsors_spec/acme-co");
    expect(body.clips).toHaveLength(3);
    expect(body.clips.map((c) => c.request_id).sort()).toEqual(["r1", "r2", "r3"]);
    expect(video.submitCalls).toHaveLength(3);

    // INSERT followed by UPDATE at tail.
    const insert = fake.calls.find((c) => c.strings.join("?").includes("INSERT INTO spec_ads"));
    expect(insert).toBeDefined();
    const update = fake.calls.find((c) => c.strings.join("?").includes("UPDATE spec_ads"));
    expect(update).toBeDefined();
  });

  it("marks failed clip when submitVideoJob throws", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    fake.results.push([]); // INSERT
    video.submitQueue.push(
      {
        requestId: "r1",
        model: "grok-imagine-video",
        estimatedUsd: 0.5,
        durationSec: 10,
      },
      new Error("xAI boom"),
      {
        requestId: "r3",
        model: "grok-imagine-video",
        estimatedUsd: 0.5,
        durationSec: 10,
      },
    );
    fake.results.push([]); // UPDATE

    const res = await call("POST", undefined, {
      brand_name: "Acme",
      product_name: "W",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      clips: Array<{ request_id: string | null; error?: string }>;
    };
    const failed = body.clips.find((c) => c.request_id === null);
    expect(failed?.error).toContain("xAI boom");
  });
});

describe("POST /api/admin/spec-ads — action=delete", () => {
  it("401 when not admin", async () => {
    expect(
      (await call("POST", undefined, { action: "delete", id: "ad-1" })).status,
    ).toBe(401);
  });

  it("400 when id missing", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    const res = await call("POST", undefined, { action: "delete" });
    expect(res.status).toBe(400);
  });

  it("deletes the row", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    fake.results.push([]); // DELETE
    const res = await call("POST", undefined, {
      action: "delete",
      id: "ad-1",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
    const last = fake.calls[fake.calls.length - 1]!;
    expect(last.strings.join("?")).toContain("DELETE FROM spec_ads");
    expect(last.values[0]).toBe("ad-1");
  });
});

describe("POST /api/admin/spec-ads — action=poll", () => {
  it("400 when request_id missing", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    const res = await call("POST", undefined, { action: "poll" });
    expect(res.status).toBe(400);
  });

  it("500 when XAI_API_KEY not set", async () => {
    delete process.env.XAI_API_KEY;
    mockIsAdmin = true;
    seedEnsureTable();
    const res = await call("POST", undefined, {
      action: "poll",
      request_id: "r1",
    });
    expect(res.status).toBe(500);
  });

  it("pending when pollVideoJob throws", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    video.pollQueue.push(new Error("grok 500"));
    const res = await call("POST", undefined, {
      action: "poll",
      request_id: "r1",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("pending");
  });

  it("failed when respect_moderation is false", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    video.pollQueue.push({
      requestId: "r1",
      status: "done",
      respectModeration: false,
    });
    const res = await call("POST", undefined, {
      action: "poll",
      request_id: "r1",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; error?: string };
    expect(body.status).toBe("failed");
    expect(body.error).toContain("moderation");
  });

  it("downloads + uploads + updates DB when video ready", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    video.pollQueue.push({
      requestId: "r1",
      status: "done",
      videoUrl: "https://grok.ai/video.mp4",
    });
    // fetch for download
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(16)),
      }),
    );
    // SELECT clips
    fake.results.push([
      {
        clips: [
          { channel_id: "ch-gnn", channel_name: "GNN", index: 0, status: "submitted", url: null, request_id: "r1" },
          { channel_id: "ch-aitunes", channel_name: "AiTunes", index: 1, status: "done", url: "u2", request_id: "r2" },
          { channel_id: "ch-ai-dating", channel_name: "Dating", index: 2, status: "done", url: "u3", request_id: "r3" },
        ],
      },
    ]);
    fake.results.push([]); // UPDATE

    const res = await call("POST", undefined, {
      action: "poll",
      request_id: "r1",
      spec_id: "ad-1",
      clip_index: 0,
      folder: "sponsors_spec/acme",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; videoUrl: string };
    expect(body.status).toBe("done");
    expect(body.videoUrl).toContain("blob.test/sponsors_spec/acme/clip-0.mp4");
    expect(blob.putCalls).toHaveLength(1);
    expect(blob.putCalls[0]!.pathname).toBe("sponsors_spec/acme/clip-0.mp4");
    // UPDATE marks all-done because the third clip also completes.
    const update = fake.calls.find((c) =>
      c.strings.join("?").includes("UPDATE spec_ads"),
    );
    expect(update).toBeDefined();
    // second-to-last positional value is the status
    const statusArg = update!.values[1];
    expect(statusArg).toBe("done");
  });

  it("done without spec_id still returns videoUrl (no DB update)", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    video.pollQueue.push({
      requestId: "r1",
      status: "done",
      videoUrl: "https://grok.ai/v.mp4",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      }),
    );

    const res = await call("POST", undefined, {
      action: "poll",
      request_id: "r1",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("done");
    expect(blob.putCalls).toHaveLength(1);
    // Only the ensureTable CREATE ran — no SELECT/UPDATE.
    const hasSelectOrUpdate = fake.calls.some((c) => {
      const sql = c.strings.join("?");
      return sql.includes("SELECT clips") || sql.includes("UPDATE spec_ads");
    });
    expect(hasSelectOrUpdate).toBe(false);
  });

  it("failed status passes through", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    video.pollQueue.push({ requestId: "r1", status: "failed" });
    const res = await call("POST", undefined, {
      action: "poll",
      request_id: "r1",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; error?: string };
    expect(body.status).toBe("failed");
    expect(body.error).toContain("failed");
  });

  it("expired status passes through as failed", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    video.pollQueue.push({ requestId: "r1", status: "expired" });
    const res = await call("POST", undefined, {
      action: "poll",
      request_id: "r1",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; error?: string };
    expect(body.status).toBe("failed");
    expect(body.error).toContain("expired");
  });

  it("still pending when no video yet", async () => {
    mockIsAdmin = true;
    seedEnsureTable();
    video.pollQueue.push({ requestId: "r1", status: "pending" });
    const res = await call("POST", undefined, {
      action: "poll",
      request_id: "r1",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("pending");
  });
});
