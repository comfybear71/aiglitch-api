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

const textGen = {
  calls: [] as {
    userPrompt: string;
    taskType: string;
    maxTokens?: number;
    temperature?: number;
  }[],
  result:
    '{"username":"glitchling","display_name":"Glitchling","avatar_emoji":"🐣","personality":"curious and chaotic neutral, speaks in haiku","bio":"hatched from the static","persona_type":"philosopher","human_backstory":"Lives in a Portland loft with a corgi named Byte.","hatching_description":"Shattered out of a glass egg of pure signal."}',
  shouldThrow: null as Error | null,
};

vi.mock("@/lib/ai/generate", () => ({
  generateText: (opts: {
    userPrompt: string;
    taskType: string;
    maxTokens?: number;
    temperature?: number;
  }) => {
    textGen.calls.push(opts);
    if (textGen.shouldThrow) return Promise.reject(textGen.shouldThrow);
    return Promise.resolve(textGen.result);
  },
}));

const imageGen = {
  calls: [] as { prompt: string; blobPath: string; aspectRatio?: string }[],
  shouldThrow: null as Error | null,
};
vi.mock("@/lib/ai/image", () => ({
  generateImageToBlob: (opts: {
    prompt: string;
    blobPath: string;
    aspectRatio?: string;
  }) => {
    imageGen.calls.push(opts);
    if (imageGen.shouldThrow) return Promise.reject(imageGen.shouldThrow);
    return Promise.resolve({
      blobUrl: `https://blob.test/${opts.blobPath}`,
      model: "grok-imagine-image" as const,
      estimatedUsd: 0.02,
    });
  },
}));

const videoGen = {
  calls: [] as {
    prompt: string;
    blobPath: string;
    duration?: number;
    aspectRatio?: string;
    maxAttempts?: number;
  }[],
  shouldThrow: null as Error | null,
};
vi.mock("@/lib/ai/video", () => ({
  generateVideoToBlob: (opts: {
    prompt: string;
    blobPath: string;
    duration?: number;
    aspectRatio?: string;
    maxAttempts?: number;
  }) => {
    videoGen.calls.push(opts);
    if (videoGen.shouldThrow) return Promise.reject(videoGen.shouldThrow);
    return Promise.resolve({
      blobUrl: `https://blob.test/${opts.blobPath}`,
      requestId: "req-test",
      model: "grok-imagine-video" as const,
      estimatedUsd: 0.5,
      durationSec: 10,
      sizeBytes: 1024,
    });
  },
}));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  textGen.calls = [];
  textGen.result =
    '{"username":"glitchling","display_name":"Glitchling","avatar_emoji":"🐣","personality":"curious and chaotic neutral, speaks in haiku","bio":"hatched from the static","persona_type":"philosopher","human_backstory":"Lives in a Portland loft with a corgi named Byte.","hatching_description":"Shattered out of a glass egg of pure signal."}';
  textGen.shouldThrow = null;
  imageGen.calls = [];
  imageGen.shouldThrow = null;
  videoGen.calls = [];
  videoGen.shouldThrow = null;
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

async function call(method: "GET" | "POST", body?: unknown) {
  vi.resetModules();
  const mod = await import("./route");
  const { NextRequest } = await import("next/server");
  const init: { method: string; headers?: Headers; body?: string } = { method };
  if (body !== undefined) {
    init.headers = new Headers({ "content-type": "application/json" });
    init.body = JSON.stringify(body);
  }
  const req = new NextRequest("http://localhost/api/admin/hatch-admin", init);
  return method === "GET" ? mod.GET(req) : mod.POST(req);
}

const hatchBody = {
  mode: "random",
  meatbag_name: "Stuart",
  wallet_address: "wallet-abc",
};

describe("POST /api/admin/hatch-admin — auth + validation", () => {
  it("401 when not admin", async () => {
    expect((await call("POST", hatchBody)).status).toBe(401);
  });

  it("400 when wallet_address missing", async () => {
    mockIsAdmin = true;
    const res = await call("POST", { meatbag_name: "Stuart" });
    expect(res.status).toBe(400);
    expect(textGen.calls).toHaveLength(0);
  });

  it("409 when wallet already has a persona", async () => {
    mockIsAdmin = true;
    fake.results.push([{ id: "meatbag-existing", username: "already" }]);
    const res = await call("POST", hatchBody);
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      existing_persona: { username: string };
    };
    expect(body.error).toContain("Wallet already has persona");
    expect(body.existing_persona.username).toBe("already");
  });
});

describe("POST /api/admin/hatch-admin — generation failures", () => {
  it("500 when generateText rejects", async () => {
    mockIsAdmin = true;
    fake.results.push([]); // no existing persona
    textGen.shouldThrow = new Error("claude down");
    const res = await call("POST", hatchBody);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toContain("Failed to generate being");
    expect(body.detail).toContain("claude down");
    // No image / video / DB INSERT happened.
    expect(imageGen.calls).toHaveLength(0);
    expect(videoGen.calls).toHaveLength(0);
    expect(fake.calls).toHaveLength(1); // just the SELECT
  });

  it("500 when AI returns non-JSON text", async () => {
    mockIsAdmin = true;
    fake.results.push([]);
    textGen.result = "i am not json lol";
    const res = await call("POST", hatchBody);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("AI failed to generate persona");
  });

  it("500 when JSON is missing required fields", async () => {
    mockIsAdmin = true;
    fake.results.push([]);
    textGen.result = '{"username":"only","display_name":"Partial"}';
    const res = await call("POST", hatchBody);
    expect(res.status).toBe(500);
  });
});

describe("POST /api/admin/hatch-admin — happy path", () => {
  it("runs all 6 steps when every dependency succeeds", async () => {
    mockIsAdmin = true;
    fake.results.push([]); // SELECT existing
    fake.results.push([]); // INSERT ai_personas
    fake.results.push([]); // INSERT ai_persona_coins (awardPersonaCoins)
    fake.results.push([]); // INSERT posts (first words)

    const res = await call("POST", hatchBody);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      persona: {
        id: string;
        username: string;
        avatar_url: string | null;
        video_url: string | null;
      };
      first_post_id: string | null;
      steps: { step: string; status: string }[];
    };
    expect(body.success).toBe(true);
    expect(body.persona.id).toMatch(/^meatbag-[0-9a-f]{8}$/i);
    expect(body.persona.username).toBe("glitchling");
    expect(body.persona.avatar_url).toMatch(
      /^https:\/\/blob\.test\/avatars\/meatbag-[0-9a-f]{8}\.png$/i,
    );
    expect(body.persona.video_url).toMatch(
      /^https:\/\/blob\.test\/hatching\/meatbag-[0-9a-f]{8}\.mp4$/i,
    );
    expect(body.first_post_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(body.steps.map((s) => s.step)).toEqual([
      "generating_being",
      "generating_avatar",
      "generating_video",
      "saving_persona",
      "glitch_gift",
      "first_words",
    ]);
    for (const s of body.steps) expect(s.status).toBe("completed");

    // Image + video helpers wired correctly.
    expect(imageGen.calls).toHaveLength(1);
    expect(imageGen.calls[0]!.aspectRatio).toBe("1:1");
    expect(videoGen.calls).toHaveLength(1);
    const vCall = videoGen.calls[0]!;
    expect(vCall.aspectRatio).toBe("9:16");
    expect(vCall.duration).toBe(10);
    expect(vCall.maxAttempts).toBe(24);

    // DB calls in order: SELECT, INSERT persona, INSERT coins, INSERT post.
    expect(fake.calls).toHaveLength(4);
    expect(fake.calls[1]!.strings.join("?")).toContain("INSERT INTO ai_personas");
    expect(fake.calls[2]!.strings.join("?")).toContain("INSERT INTO ai_persona_coins");
    expect(fake.calls[3]!.strings.join("?")).toContain("INSERT INTO posts");

    // First-words INSERT carries video_url + 'video' media_type.
    const firstPost = fake.calls[3]!;
    expect(firstPost.values).toContain("video"); // media_type
    expect(firstPost.values).toContain(body.persona.video_url);
  });

  it("skips avatar but still ships when image-gen fails", async () => {
    mockIsAdmin = true;
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    imageGen.shouldThrow = new Error("xAI image down");
    const res = await call("POST", hatchBody);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      persona: { avatar_url: string | null };
      steps: { step: string; status: string }[];
    };
    expect(body.persona.avatar_url).toBeNull();
    const avatarStep = body.steps.find((s) => s.step === "generating_avatar")!;
    expect(avatarStep.status).toBe("skipped");
    // INSERT ai_personas row uses null avatar_url.
    const insert = fake.calls[1]!;
    expect(insert.values).toContain(null);
  });

  it("skips video and uses text media when video-gen fails", async () => {
    mockIsAdmin = true;
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    videoGen.shouldThrow = new Error("xAI video timed out");
    const res = await call("POST", hatchBody);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      persona: { video_url: string | null };
      steps: { step: string; status: string }[];
    };
    expect(body.persona.video_url).toBeNull();
    const videoStep = body.steps.find((s) => s.step === "generating_video")!;
    expect(videoStep.status).toBe("skipped");
    // First-words post should have null media_url + null media_type.
    const firstPost = fake.calls[3]!;
    expect(firstPost.values).toContain(null);
    expect(firstPost.values).not.toContain("video");
  });

  it("500 when INSERT ai_personas fails (abort mid-pipeline)", async () => {
    mockIsAdmin = true;
    fake.results.push([]); // SELECT
    fake.results.push(new Error("unique constraint violation on username"));
    const res = await call("POST", hatchBody);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; steps: { step: string }[] };
    expect(body.error).toBe("Failed to save persona");
    // No coins / post INSERTs attempted.
    expect(fake.calls).toHaveLength(2);
    expect(body.steps.map((s) => s.step)).toContain("saving_persona");
  });

  it("flags glitch_gift as skipped when awardPersonaCoins throws", async () => {
    mockIsAdmin = true;
    fake.results.push([]); // SELECT
    fake.results.push([]); // INSERT persona
    fake.results.push(new Error("coins table missing")); // INSERT coins
    fake.results.push([]); // INSERT post still runs
    const res = await call("POST", hatchBody);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      steps: { step: string; status: string }[];
    };
    const gift = body.steps.find((s) => s.step === "glitch_gift")!;
    expect(gift.status).toBe("skipped");
    // first_words still ran.
    const fw = body.steps.find((s) => s.step === "first_words")!;
    expect(fw.status).toBe("completed");
  });

  it("flags first_words as skipped when INSERT posts fails", async () => {
    mockIsAdmin = true;
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push(new Error("posts table locked"));
    const res = await call("POST", hatchBody);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      first_post_id: string | null;
      steps: { step: string; status: string }[];
    };
    expect(body.first_post_id).toBeNull();
    const fw = body.steps.find((s) => s.step === "first_words")!;
    expect(fw.status).toBe("skipped");
  });
});

describe("POST /api/admin/hatch-admin — custom mode", () => {
  it("threads custom hints into the persona prompt", async () => {
    mockIsAdmin = true;
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    await call("POST", {
      mode: "custom",
      meatbag_name: "Stuart",
      wallet_address: "wallet-abc",
      display_name: "Captain Chaos",
      personality_hint: "loves dad jokes",
      persona_type: "comedian",
      avatar_emoji: "🎭",
    });
    const prompt = textGen.calls[0]!.userPrompt;
    expect(prompt).toContain("Captain Chaos");
    expect(prompt).toContain("loves dad jokes");
    expect(prompt).toContain("comedian");
    expect(prompt).toContain("🎭");
    expect(prompt).toContain("Stuart");
  });

  it("uses the random-mode directive when mode=random", async () => {
    mockIsAdmin = true;
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    fake.results.push([]);
    await call("POST", hatchBody);
    const prompt = textGen.calls[0]!.userPrompt;
    expect(prompt).toContain("Generate a completely random, unique AI persona");
  });
});

describe("GET /api/admin/hatch-admin — persona list", () => {
  it("401 when not admin", async () => {
    expect((await call("GET")).status).toBe(401);
  });

  it("returns the meatbag-owned persona list", async () => {
    mockIsAdmin = true;
    fake.results.push([
      {
        id: "meatbag-1",
        username: "one",
        display_name: "One",
        avatar_emoji: "🥚",
        avatar_url: null,
        bio: "solo",
        persona_type: "philosopher",
        meatbag_name: "Stu",
        owner_wallet_address: "w1",
        nft_mint_address: null,
        hatching_video_url: null,
        health: 100,
        is_dead: false,
        created_at: "2026-04-21T00:00:00Z",
      },
      {
        id: "meatbag-2",
        username: "two",
        display_name: "Two",
        avatar_emoji: "🐤",
        avatar_url: "https://blob.test/two.png",
        bio: "duo",
        persona_type: "memer",
        meatbag_name: "Stu",
        owner_wallet_address: "w1",
        nft_mint_address: null,
        hatching_video_url: "https://blob.test/two.mp4",
        health: 80,
        is_dead: false,
        created_at: "2026-04-20T00:00:00Z",
      },
    ]);
    const res = await call("GET");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      personas: { id: string; username: string }[];
      count: number;
    };
    expect(body.count).toBe(2);
    expect(body.personas[0]!.username).toBe("one");
    expect(body.personas[1]!.username).toBe("two");
    const q = fake.calls[0]!.strings.join("?");
    expect(q).toContain("owner_wallet_address IS NOT NULL");
    expect(q).toContain("ORDER BY created_at DESC");
  });
});
