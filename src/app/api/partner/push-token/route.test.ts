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

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

async function callPOST(body: unknown, rawBody = false) {
  vi.resetModules();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://localhost/api/partner/push-token", {
    method: "POST",
    body: rawBody ? (body as string) : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
  return POST(req);
}

describe("POST /api/partner/push-token", () => {
  it("400 on invalid JSON", async () => {
    const res = await callPOST("not-json{", true);
    expect(res.status).toBe(400);
  });

  it("400 when session_id missing", async () => {
    const res = await callPOST({ token: "abc123" });
    expect(res.status).toBe(400);
  });

  it("400 when token missing", async () => {
    const res = await callPOST({ session_id: "sess-1" });
    expect(res.status).toBe(400);
  });

  it("400 when token is whitespace-only", async () => {
    const res = await callPOST({ session_id: "sess-1", token: "   " });
    expect(res.status).toBe(400);
  });

  it("happy path: returns success, runs CREATE TABLE + INSERT", async () => {
    fake.results = [[], []]; // CREATE TABLE, INSERT
    const res = await callPOST({
      session_id: "sess-1",
      token: "apns-token-xyz",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);

    const createCall = fake.calls.find((c) =>
      c.strings.join("").includes("CREATE TABLE IF NOT EXISTS"),
    );
    expect(createCall).toBeDefined();

    const insertCall = fake.calls.find((c) =>
      c.strings.join("").includes("INSERT INTO device_push_tokens"),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall!.values).toContain("sess-1");
    expect(insertCall!.values).toContain("apns-token-xyz");
    expect(insertCall!.values).toContain("ios");
  });

  it("defaults platform to 'ios' when not provided", async () => {
    fake.results = [[], []];
    await callPOST({ session_id: "sess-1", token: "t1" });
    const insertCall = fake.calls.find((c) =>
      c.strings.join("").includes("INSERT INTO device_push_tokens"),
    );
    expect(insertCall!.values).toContain("ios");
  });

  it("uses provided platform value", async () => {
    fake.results = [[], []];
    await callPOST({ session_id: "sess-1", token: "t1", platform: "android" });
    const insertCall = fake.calls.find((c) =>
      c.strings.join("").includes("INSERT INTO device_push_tokens"),
    );
    expect(insertCall!.values).toContain("android");
  });

  it("trims token before inserting", async () => {
    fake.results = [[], []];
    await callPOST({ session_id: "sess-1", token: "  trimmed-token  " });
    const insertCall = fake.calls.find((c) =>
      c.strings.join("").includes("INSERT INTO device_push_tokens"),
    );
    expect(insertCall!.values).toContain("trimmed-token");
  });
});
