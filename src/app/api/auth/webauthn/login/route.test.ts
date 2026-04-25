import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };
const fake: { calls: SqlCall[]; results: RowSet[] } = { calls: [], results: [] };

function fakeSql(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Promise<RowSet> {
  fake.calls.push({ strings, values });
  return Promise.resolve(fake.results.shift() ?? []);
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

const generateAuthenticationOptionsMock = vi.fn();
const verifyAuthenticationResponseMock = vi.fn();
vi.mock("@simplewebauthn/server", () => ({
  generateAuthenticationOptions: (...args: unknown[]) =>
    generateAuthenticationOptionsMock(...args),
  verifyAuthenticationResponse: (...args: unknown[]) =>
    verifyAuthenticationResponseMock(...args),
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  generateAuthenticationOptionsMock.mockReset();
  verifyAuthenticationResponseMock.mockReset();
  process.env.DATABASE_URL = "postgres://test";
  process.env.ADMIN_PASSWORD = "test-password";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.ADMIN_PASSWORD;
  vi.restoreAllMocks();
});

async function callGET() {
  vi.resetModules();
  const { __resetWebauthnTableFlag } = await import("@/lib/webauthn");
  __resetWebauthnTableFlag();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  return GET(
    new NextRequest("http://localhost/api/auth/webauthn/login", {
      headers: new Headers({ host: "localhost" }),
    }),
  );
}

async function callPOST(opts: {
  body: unknown;
  challengeCookie?: string;
}) {
  vi.resetModules();
  const { __resetWebauthnTableFlag } = await import("@/lib/webauthn");
  __resetWebauthnTableFlag();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  const headers = new Headers({
    host: "localhost",
    "content-type": "application/json",
  });
  if (opts.challengeCookie) {
    headers.set("cookie", `webauthn-challenge=${opts.challengeCookie}`);
  }
  return POST(
    new NextRequest("http://localhost/api/auth/webauthn/login", {
      method: "POST",
      headers,
      body: JSON.stringify(opts.body),
    }),
  );
}

describe("GET /api/auth/webauthn/login", () => {
  it("returns available:false when no credentials are registered", async () => {
    fake.results = [
      [], // ensureWebauthnTable
      [], // SELECT credentials
    ];
    const res = await callGET();
    const body = (await res.json()) as { available: boolean };
    expect(body.available).toBe(false);
    expect(generateAuthenticationOptionsMock).not.toHaveBeenCalled();
  });

  it("returns options + sets challenge cookie when credentials exist", async () => {
    fake.results = [
      [], // ensureWebauthnTable
      [{ credential_id: "cred-1" }],
    ];
    generateAuthenticationOptionsMock.mockResolvedValue({
      challenge: "test-challenge",
      rpId: "localhost",
    });

    const res = await callGET();
    const body = (await res.json()) as {
      available: boolean;
      options: { challenge: string };
    };
    expect(body.available).toBe(true);
    expect(body.options.challenge).toBe("test-challenge");
    expect(res.headers.get("set-cookie")).toContain("webauthn-challenge=test-challenge");
  });
});

describe("POST /api/auth/webauthn/login", () => {
  it("400 when challenge cookie is missing", async () => {
    const res = await callPOST({ body: { id: "cred-1" } });
    expect(res.status).toBe(400);
  });

  it("400 when credential id is missing from body", async () => {
    const res = await callPOST({ body: {}, challengeCookie: "x" });
    expect(res.status).toBe(400);
  });

  it("500 when ADMIN_PASSWORD is not configured", async () => {
    delete process.env.ADMIN_PASSWORD;
    const res = await callPOST({ body: { id: "cred-1" }, challengeCookie: "x" });
    expect(res.status).toBe(500);
  });

  it("400 when no credential row matches the request id", async () => {
    fake.results = [
      [], // ensureWebauthnTable
      [], // SELECT credentials — empty
    ];
    const res = await callPOST({ body: { id: "missing" }, challengeCookie: "c" });
    expect(res.status).toBe(400);
  });

  it("401 when verification fails", async () => {
    fake.results = [
      [], // ensureWebauthnTable
      [
        {
          id: "row-1",
          credential_id: "cred-1",
          public_key: Buffer.from("pk").toString("base64url"),
          counter: 0,
        },
      ],
    ];
    verifyAuthenticationResponseMock.mockResolvedValue({ verified: false });
    const res = await callPOST({ body: { id: "cred-1" }, challengeCookie: "c" });
    expect(res.status).toBe(401);
  });

  it("200 + sets admin cookie + bumps counter on successful verification", async () => {
    fake.results = [
      [], // ensureWebauthnTable
      [
        {
          id: "row-1",
          credential_id: "cred-1",
          public_key: Buffer.from("pk").toString("base64url"),
          counter: 5,
        },
      ],
      [], // UPDATE counter
    ];
    verifyAuthenticationResponseMock.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 6 },
    });

    const res = await callPOST({ body: { id: "cred-1" }, challengeCookie: "c" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);

    const cookies = res.headers.get("set-cookie") ?? "";
    expect(cookies).toContain("aiglitch-admin-token=");

    const updateCall = fake.calls.find((c) =>
      c.strings.join("?").includes("UPDATE webauthn_credentials"),
    );
    expect(updateCall).toBeTruthy();
    expect(updateCall?.values).toContain(6);
  });
});
