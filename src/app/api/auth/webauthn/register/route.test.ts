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

const generateRegistrationOptionsMock = vi.fn();
const verifyRegistrationResponseMock = vi.fn();
vi.mock("@simplewebauthn/server", () => ({
  generateRegistrationOptions: (...args: unknown[]) =>
    generateRegistrationOptionsMock(...args),
  verifyRegistrationResponse: (...args: unknown[]) =>
    verifyRegistrationResponseMock(...args),
}));

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  generateRegistrationOptionsMock.mockReset();
  verifyRegistrationResponseMock.mockReset();
  mockIsAdmin = false;
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  vi.restoreAllMocks();
});

async function callGET() {
  vi.resetModules();
  const { __resetWebauthnTableFlag } = await import("@/lib/webauthn");
  __resetWebauthnTableFlag();
  const { GET } = await import("./route");
  const { NextRequest } = await import("next/server");
  return GET(
    new NextRequest("http://localhost/api/auth/webauthn/register", {
      headers: new Headers({ host: "localhost" }),
    }),
  );
}

async function callPOST(opts: { body: unknown; challengeCookie?: string }) {
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
    new NextRequest("http://localhost/api/auth/webauthn/register", {
      method: "POST",
      headers,
      body: JSON.stringify(opts.body),
    }),
  );
}

describe("GET /api/auth/webauthn/register", () => {
  it("401 when not authenticated as admin", async () => {
    const res = await callGET();
    expect(res.status).toBe(401);
  });

  it("returns options + challenge cookie when authed", async () => {
    mockIsAdmin = true;
    fake.results = [
      [], // ensureWebauthnTable
      [], // SELECT existing credentials
    ];
    generateRegistrationOptionsMock.mockResolvedValue({
      challenge: "reg-challenge",
      rp: { id: "localhost" },
    });

    const res = await callGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { challenge: string };
    expect(body.challenge).toBe("reg-challenge");
    expect(res.headers.get("set-cookie")).toContain(
      "webauthn-challenge=reg-challenge",
    );
  });

  it("excludes existing credentials from registration options", async () => {
    mockIsAdmin = true;
    fake.results = [
      [],
      [{ credential_id: "existing-1" }, { credential_id: "existing-2" }],
    ];
    generateRegistrationOptionsMock.mockResolvedValue({ challenge: "x" });

    await callGET();

    const args = generateRegistrationOptionsMock.mock.calls[0][0] as {
      excludeCredentials: { id: string }[];
    };
    expect(args.excludeCredentials.map((c) => c.id)).toEqual([
      "existing-1",
      "existing-2",
    ]);
  });
});

describe("POST /api/auth/webauthn/register", () => {
  it("401 when not authenticated as admin", async () => {
    mockIsAdmin = false;
    const res = await callPOST({ body: {} });
    expect(res.status).toBe(401);
  });

  it("400 when challenge cookie is missing", async () => {
    mockIsAdmin = true;
    const res = await callPOST({ body: { id: "x" } });
    expect(res.status).toBe(400);
  });

  it("400 when verification fails", async () => {
    mockIsAdmin = true;
    verifyRegistrationResponseMock.mockResolvedValue({ verified: false });
    const res = await callPOST({
      body: { id: "x" },
      challengeCookie: "c",
    });
    expect(res.status).toBe(400);
  });

  it("inserts the credential and returns success when verified", async () => {
    mockIsAdmin = true;
    verifyRegistrationResponseMock.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: new Uint8Array([1, 2, 3]),
          publicKey: new Uint8Array([9, 8, 7]),
          counter: 0,
        },
        credentialDeviceType: "platform",
      },
    });

    fake.results = [
      [], // ensureWebauthnTable
      [], // INSERT
    ];

    const res = await callPOST({
      body: { id: "x" },
      challengeCookie: "c",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);

    const insertCall = fake.calls.find((c) =>
      c.strings.join("?").includes("INSERT INTO webauthn_credentials"),
    );
    expect(insertCall).toBeTruthy();
  });
});
