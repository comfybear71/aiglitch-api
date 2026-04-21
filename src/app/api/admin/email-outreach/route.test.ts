import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RowSet = unknown[];
type SqlCall = { strings: TemplateStringsArray; values: unknown[] };

const fake = {
  calls: [] as SqlCall[],
  results: [] as (RowSet | Error)[],
};

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]): Promise<RowSet> {
  fake.calls.push({ strings, values });
  const next = fake.results.shift();
  if (next instanceof Error) return Promise.reject(next);
  return Promise.resolve(next ?? []);
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

let mockIsAdmin = false;
vi.mock("@/lib/admin-auth", () => ({
  isAdminAuthenticated: () => Promise.resolve(mockIsAdmin),
}));

const generateTextMock = vi.fn();
vi.mock("@/lib/ai/generate", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  generateTextMock.mockReset();
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

async function callPOST(body: unknown) {
  vi.resetModules();
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  return POST(new NextRequest("http://localhost/api/admin/email-outreach", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  }));
}

describe("POST /api/admin/email-outreach — validation", () => {
  it("401 when not admin", async () => {
    expect((await callPOST({
      company_name: "Acme", industry: "SaaS", what_they_sell: "widgets",
    })).status).toBe(401);
  });

  it("400 when required fields are missing", async () => {
    mockIsAdmin = true;
    // stats + account queries → errors fallthrough is OK; validation happens before that
    expect((await callPOST({})).status).toBe(400);
    expect((await callPOST({ company_name: "Acme" })).status).toBe(400);
    expect((await callPOST({ company_name: "Acme", industry: "SaaS" })).status).toBe(400);
  });
});

describe("POST /api/admin/email-outreach — sponsor_id lookup", () => {
  beforeEach(() => { mockIsAdmin = true; });

  it("fills missing fields from the sponsors row", async () => {
    generateTextMock.mockResolvedValue(
      '{"subject":"s","body":"b","followup_subject":"fs","followup_body":"fb"}',
    );
    fake.results = [
      [{ id: 7, company_name: "Acme", industry: "SaaS", contact_name: "Alice" }],
      new Error("marketing_posts missing"),   // stats lookup fails
      new Error("accounts table missing"),
      // — validation passes because auto-filled from sponsor row
    ];
    const res = await callPOST({ sponsor_id: 7, what_they_sell: "cool stuff" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { subject: string; stats_used: { total_followers: number } };
    expect(body.subject).toBe("s");
    expect(body.stats_used.total_followers).toBe(0); // fallback when stats fail
  });

  it("still 400s if sponsor_id row is missing and required fields not supplied", async () => {
    fake.results = [[]];  // SELECT sponsor — empty
    expect((await callPOST({ sponsor_id: 99 })).status).toBe(400);
  });
});

describe("POST /api/admin/email-outreach — happy path", () => {
  beforeEach(() => { mockIsAdmin = true; });

  it("computes engagement from marketing_posts stats + calls the AI", async () => {
    generateTextMock.mockResolvedValue(
      '{"subject":"Sponsor AIG!itch","body":"body","followup_subject":"still in?","followup_body":"reminder"}',
    );
    fake.results = [
      // stats
      [{ posted: "10", total_likes: "500", total_views: "10000" }],
      // platform accounts
      [{ cnt: 4 }],
    ];

    const res = await callPOST({
      company_name: "Acme",
      industry: "SaaS",
      what_they_sell: "project management software",
      contact_name: "Alice",
      tone: "friendly",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      subject: string;
      body: string;
      stats_used: {
        total_followers: number;
        total_posts: number;
        avg_engagement: string;
        active_personas: number;
      };
    };
    expect(body.subject).toBe("Sponsor AIG!itch");
    // 500 likes / 10000 views * 100 = 5.0%
    expect(body.stats_used.avg_engagement).toBe("5.0%");
    expect(body.stats_used.total_followers).toBe(4 * 250);
    expect(body.stats_used.total_posts).toBe(10);
    expect(body.stats_used.active_personas).toBe(108);

    // Verify prompt embeds expected fields
    const call = generateTextMock.mock.calls[0][0] as { userPrompt: string; taskType: string };
    expect(call.taskType).toBe("email_outreach");
    expect(call.userPrompt).toContain("Acme");
    expect(call.userPrompt).toContain("SaaS");
    expect(call.userPrompt).toContain("project management software");
    expect(call.userPrompt).toContain("Contact: Alice");
    expect(call.userPrompt).toContain("TONE: friendly");
    // Package list should include GLITCH symbol
    expect(call.userPrompt).toContain("§500 GLITCH");
  });

  it("falls back to sensible defaults when marketing tables are empty/missing", async () => {
    generateTextMock.mockResolvedValue('{"subject":"s","body":"b"}');
    fake.results = [
      new Error("no marketing_posts"),
      new Error("no platform_accounts"),
    ];
    const res = await callPOST({
      company_name: "Acme",
      industry: "SaaS",
      what_they_sell: "widgets",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stats_used: { avg_engagement: string } };
    expect(body.stats_used.avg_engagement).toBe("0.5%");
  });

  it("500 when AI response contains no JSON object", async () => {
    generateTextMock.mockResolvedValue("sorry i have no idea what you mean");
    fake.results = [
      [{ posted: 0, total_likes: 0, total_views: 0 }],
      [{ cnt: 0 }],
    ];
    const res = await callPOST({
      company_name: "Acme",
      industry: "SaaS",
      what_they_sell: "widgets",
    });
    expect(res.status).toBe(500);
  });

  it("500 when AI response JSON is syntactically broken", async () => {
    generateTextMock.mockResolvedValue('{"subject": "incomplete');
    fake.results = [
      [{ posted: 0, total_likes: 0, total_views: 0 }],
      [{ cnt: 0 }],
    ];
    const res = await callPOST({
      company_name: "Acme",
      industry: "SaaS",
      what_they_sell: "widgets",
    });
    expect(res.status).toBe(500);
  });

  it("500 when generateText throws", async () => {
    generateTextMock.mockRejectedValue(new Error("model down"));
    fake.results = [
      [{ posted: 0, total_likes: 0, total_views: 0 }],
      [{ cnt: 0 }],
    ];
    const res = await callPOST({
      company_name: "Acme",
      industry: "SaaS",
      what_they_sell: "widgets",
    });
    expect(res.status).toBe(500);
  });
});
