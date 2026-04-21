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
  putThrow: null as Error | null,
};

vi.mock("@vercel/blob", () => ({
  put: (pathname: string, _body: unknown, opts: unknown) => {
    blob.putCalls.push({ pathname, opts });
    if (blob.putThrow) return Promise.reject(blob.putThrow);
    return Promise.resolve({ url: `https://blob.test/${pathname}` });
  },
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  blob.putCalls = [];
  blob.putThrow = null;
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
});

async function call(
  fields: Record<string, string | File> = {},
  authed = true,
) {
  if (authed) mockIsAdmin = true;
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const req = new NextRequest("http://localhost/api/content/upload", {
    method: "POST",
    body: form,
  });
  return mod.POST(req);
}

describe("POST /api/content/upload", () => {
  it("401 when not admin", async () => {
    expect((await call({}, false)).status).toBe(401);
  });

  it("400 when file missing", async () => {
    expect((await call({})).status).toBe(400);
  });

  it("happy path uploads + inserts + returns media", async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], "test.png", {
      type: "image/png",
    });
    fake.results.push([]); // INSERT
    const res = await call({ file, folder: "test-folder" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      media: { id: string; url: string; filename: string; folder: string };
    };
    expect(body.success).toBe(true);
    expect(body.media.filename).toBe("test.png");
    expect(body.media.folder).toBe("test-folder");
    expect(blob.putCalls[0]!.pathname).toBe("test-folder/test.png");
    const opts = blob.putCalls[0]!.opts as {
      access: string;
      addRandomSuffix: boolean;
    };
    expect(opts.addRandomSuffix).toBe(true);
  });

  it("default folder is 'uploads'", async () => {
    const file = new File([new Uint8Array([1])], "x.png", { type: "image/png" });
    fake.results.push([]);
    await call({ file });
    expect(blob.putCalls[0]!.pathname).toBe("uploads/x.png");
  });

  it("blob put failure → 500 with message", async () => {
    blob.putThrow = new Error("blob quota exceeded");
    const file = new File([new Uint8Array([1])], "x.png", { type: "image/png" });
    const res = await call({ file });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("blob quota exceeded");
  });

  it("empty content_type falls back to octet-stream", async () => {
    const file = new File([new Uint8Array([1])], "weird.bin", { type: "" });
    fake.results.push([]);
    await call({ file });
    const insert = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO uploaded_media"),
    );
    expect(insert!.values).toContain("application/octet-stream");
  });
});
