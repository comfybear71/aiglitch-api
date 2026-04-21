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

const imageGen = {
  calls: [] as { prompt: string; blobPath: string; model?: string; aspectRatio?: string }[],
  // Per-persona queue of results, pulled in order.
  queue: [] as ({ blobUrl: string; model: "grok-imagine-image-pro"; estimatedUsd: number } | Error)[],
};

vi.mock("@/lib/ai/image", () => ({
  generateImageToBlob: (opts: {
    prompt: string;
    blobPath: string;
    model?: string;
    aspectRatio?: string;
  }) => {
    imageGen.calls.push(opts);
    const next = imageGen.queue.shift();
    if (!next) {
      return Promise.resolve({
        blobUrl: `https://blob.test/${opts.blobPath}`,
        model: "grok-imagine-image-pro" as const,
        estimatedUsd: 0.07,
      });
    }
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  },
}));

const textGen = {
  calls: [] as { userPrompt: string }[],
  result: "Tiny me, huge vibes. #MadeInGrok #AIGlitch",
  shouldThrow: null as Error | null,
};

vi.mock("@/lib/ai/generate", () => ({
  generateText: (opts: { userPrompt: string }) => {
    textGen.calls.push(opts);
    if (textGen.shouldThrow) return Promise.reject(textGen.shouldThrow);
    return Promise.resolve(textGen.result);
  },
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  imageGen.calls = [];
  imageGen.queue = [];
  textGen.calls = [];
  textGen.result = "Tiny me, huge vibes. #MadeInGrok #AIGlitch";
  textGen.shouldThrow = null;
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

async function call(method: "GET" | "POST", url: string, body?: unknown) {
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

const personaWithAvatar = {
  id: "glitch-hat",
  username: "glitchhat",
  display_name: "Glitch Hat",
  avatar_emoji: "🎩",
  bio: "Dapper glitch accessory.",
  personality: "playful + strange",
  persona_type: "accessory",
  human_backstory: "From a haunted haberdashery.",
  avatar_url: "https://blob.test/old-avatar.png",
};

describe("GET /api/admin/chibify — preview", () => {
  it("401 when not admin", async () => {
    expect(
      (await call("GET", "http://localhost/api/admin/chibify?persona_id=x")).status,
    ).toBe(401);
  });

  it("400 when persona_id missing", async () => {
    mockIsAdmin = true;
    const res = await call("GET", "http://localhost/api/admin/chibify");
    expect(res.status).toBe(400);
  });

  it("404 when persona not found", async () => {
    mockIsAdmin = true;
    fake.results.push([]);
    const res = await call("GET", "http://localhost/api/admin/chibify?persona_id=ghost");
    expect(res.status).toBe(404);
  });

  it("returns the chibi prompt + display name", async () => {
    mockIsAdmin = true;
    fake.results.push([personaWithAvatar]);
    const res = await call(
      "GET",
      "http://localhost/api/admin/chibify?persona_id=glitch-hat",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; prompt: string; persona: string };
    expect(body.ok).toBe(true);
    expect(body.persona).toBe("Glitch Hat");
    expect(body.prompt).toContain("chibi/kawaii");
    expect(body.prompt).toContain("Glitch Hat");
    expect(body.prompt).toContain("AIG!itch");
  });
});

describe("POST /api/admin/chibify — validation", () => {
  it("401 when not admin", async () => {
    expect(
      (await call("POST", "http://localhost/api/admin/chibify", {
        persona_ids: ["x"],
      })).status,
    ).toBe(401);
  });

  it("400 when persona_ids missing or not an array", async () => {
    mockIsAdmin = true;
    expect(
      (await call("POST", "http://localhost/api/admin/chibify", {})).status,
    ).toBe(400);
    mockIsAdmin = true;
    expect(
      (await call("POST", "http://localhost/api/admin/chibify", { persona_ids: "x" })).status,
    ).toBe(400);
  });

  it("400 when persona_ids is an empty array", async () => {
    mockIsAdmin = true;
    const res = await call("POST", "http://localhost/api/admin/chibify", { persona_ids: [] });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/admin/chibify — happy path", () => {
  it("generates + posts for a single persona, INSERTs with grok-aurora source", async () => {
    mockIsAdmin = true;
    fake.results.push([personaWithAvatar]); // SELECT
    fake.results.push([]); // INSERT posts
    fake.results.push([]); // UPDATE post_count
    const res = await call("POST", "http://localhost/api/admin/chibify", {
      persona_ids: ["glitch-hat"],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      message: string;
      results: {
        persona_id: string;
        username: string;
        success: boolean;
        image_url: string;
        post_id: string;
      }[];
    };
    expect(body.success).toBe(true);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]!.success).toBe(true);
    expect(body.results[0]!.image_url).toMatch(/^https:\/\/blob\.test\/chibi\/[0-9a-f-]{36}\.png$/i);
    expect(body.results[0]!.post_id).toMatch(/^[0-9a-f-]{36}$/i);

    expect(imageGen.calls).toHaveLength(1);
    const genCall = imageGen.calls[0]!;
    expect(genCall.model).toBe("grok-imagine-image-pro");
    expect(genCall.aspectRatio).toBe("1:1");
    expect(genCall.blobPath).toMatch(/^chibi\/[0-9a-f-]{36}\.png$/i);

    // INSERT row contains the chibi blob URL + grok-aurora media_source literal.
    const insert = fake.calls[1]!;
    expect(insert.strings.join("?")).toContain("INSERT INTO posts");
    expect(insert.strings.join("?")).toContain("'grok-aurora'");
    expect(insert.strings.join("?")).toContain("AIGlitch,MadeInGrok,Chibi,ChibiArt,Kawaii");
  });

  it("isolates errors across personas — persona-not-found + no-avatar + happy", async () => {
    mockIsAdmin = true;
    fake.results.push([]); // persona ghost: SELECT returns empty
    fake.results.push([{ ...personaWithAvatar, id: "noav", username: "noav", avatar_url: null }]); // SELECT noav
    fake.results.push([personaWithAvatar]); // SELECT ok
    fake.results.push([]); // INSERT post
    fake.results.push([]); // UPDATE count

    const res = await call("POST", "http://localhost/api/admin/chibify", {
      persona_ids: ["ghost", "noav", "glitch-hat"],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      message: string;
      results: { persona_id: string; success: boolean; error?: string }[];
    };
    expect(body.success).toBe(true);
    expect(body.message).toContain("Chibified 1 persona");
    expect(body.message).toContain("(2 failed)");
    expect(body.results).toHaveLength(3);
    expect(body.results[0]!.error).toBe("Persona not found");
    expect(body.results[1]!.error).toBe("No avatar to chibify");
    expect(body.results[2]!.success).toBe(true);
    // Image helper only called for the happy one.
    expect(imageGen.calls).toHaveLength(1);
  });

  it("image-gen failure for a persona is captured in results, loop continues", async () => {
    mockIsAdmin = true;
    fake.results.push([personaWithAvatar]); // SELECT p1
    fake.results.push([{ ...personaWithAvatar, id: "p2", username: "p2" }]); // SELECT p2
    fake.results.push([]); // INSERT p2
    fake.results.push([]); // UPDATE p2 count

    imageGen.queue.push(new Error("xAI down for p1"));
    imageGen.queue.push({
      blobUrl: "https://blob.test/chibi/p2.png",
      model: "grok-imagine-image-pro",
      estimatedUsd: 0.07,
    });

    const res = await call("POST", "http://localhost/api/admin/chibify", {
      persona_ids: ["glitch-hat", "p2"],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      results: { success: boolean; error?: string }[];
    };
    expect(body.success).toBe(true); // at least one succeeded
    expect(body.results[0]!.success).toBe(false);
    expect(body.results[0]!.error).toBe("xAI down for p1");
    expect(body.results[1]!.success).toBe(true);
  });

  it("ensures hashtags are appended when text gen omits them", async () => {
    mockIsAdmin = true;
    fake.results.push([personaWithAvatar]);
    fake.results.push([]);
    fake.results.push([]);
    textGen.result = "Look at me, I am smol.";
    await call("POST", "http://localhost/api/admin/chibify", {
      persona_ids: ["glitch-hat"],
    });
    const insert = fake.calls[1]!;
    const content = insert.values[2] as string;
    expect(content).toContain("#MadeInGrok");
    expect(content).toContain("#AIGlitch");
  });

  it("uses the fallback template when text gen throws", async () => {
    mockIsAdmin = true;
    fake.results.push([personaWithAvatar]);
    fake.results.push([]);
    fake.results.push([]);
    textGen.shouldThrow = new Error("text gen down");
    await call("POST", "http://localhost/api/admin/chibify", {
      persona_ids: ["glitch-hat"],
    });
    const insert = fake.calls[1]!;
    const content = insert.values[2] as string;
    expect(content).toContain("chibi treatment");
    expect(content).toContain("#MadeInGrok");
    expect(content).toContain("#AIGlitch");
  });
});
