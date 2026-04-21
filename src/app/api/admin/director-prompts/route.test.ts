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

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  mockIsAdmin = false;
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

async function call(
  method: "GET" | "POST" | "PUT" | "DELETE",
  url = "http://localhost/api/admin/director-prompts",
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
  if (method === "GET") return mod.GET(req);
  if (method === "POST") return mod.POST(req);
  if (method === "PUT") return mod.PUT(req);
  return mod.DELETE(req);
}

describe("GET /api/admin/director-prompts", () => {
  it("401 when not admin", async () => {
    expect((await call("GET")).status).toBe(401);
  });

  it("returns prompts + recentMovies", async () => {
    mockIsAdmin = true;
    fake.results = [
      [{ id: "p1", title: "Movie A", genre: "comedy", is_used: false }],
      [{ id: "m1", director_username: "ridley", title: "Scene B", genre: "scifi" }],
    ];
    const res = await call("GET");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { prompts: unknown[]; recentMovies: unknown[] };
    expect(body.prompts).toHaveLength(1);
    expect(body.recentMovies).toHaveLength(1);
  });

  it("returns empty arrays on DB error (fresh env parity)", async () => {
    mockIsAdmin = true;
    fake.results = [new Error("relation \"director_movie_prompts\" does not exist")];
    const res = await call("GET");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { prompts: unknown[]; recentMovies: unknown[] };
    expect(body.prompts).toEqual([]);
    expect(body.recentMovies).toEqual([]);
  });
});

describe("POST /api/admin/director-prompts", () => {
  it("401 when not admin", async () => {
    expect((await call("POST", undefined, { title: "x", concept: "y", genre: "comedy" })).status).toBe(401);
  });

  it("400 on missing title/concept/genre", async () => {
    mockIsAdmin = true;
    expect((await call("POST", undefined, { concept: "y", genre: "comedy" })).status).toBe(400);
    expect((await call("POST", undefined, { title: "x", genre: "comedy" })).status).toBe(400);
    expect((await call("POST", undefined, { title: "x", concept: "y" })).status).toBe(400);
  });

  it("400 on invalid genre", async () => {
    mockIsAdmin = true;
    const res = await call("POST", undefined, { title: "x", concept: "y", genre: "space_opera" });
    expect(res.status).toBe(400);
  });

  it("inserts with a UUID and returns the row", async () => {
    mockIsAdmin = true;
    fake.results = [[]];
    const res = await call("POST", undefined, { title: "X", concept: "Y", genre: "comedy" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; title: string; genre: string };
    expect(body.title).toBe("X");
    expect(body.genre).toBe("comedy");
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(fake.calls[0].strings.join("?")).toContain("INSERT INTO director_movie_prompts");
  });

  it("allows 'any' genre as a valid option", async () => {
    mockIsAdmin = true;
    fake.results = [[]];
    const res = await call("POST", undefined, { title: "X", concept: "Y", genre: "any" });
    expect(res.status).toBe(200);
  });
});

describe("PUT /api/admin/director-prompts — random concept", () => {
  it("401 when not admin", async () => {
    expect((await call("PUT")).status).toBe(401);
  });

  it("preview=1 returns concept without inserting", async () => {
    mockIsAdmin = true;
    const res = await call("PUT", "http://localhost/api/admin/director-prompts?preview=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string; concept: string; genre: string; preview: boolean };
    expect(body.preview).toBe(true);
    expect(body.title).toBeTruthy();
    expect(body.concept).toContain("AIG!itch");
    expect(fake.calls).toHaveLength(0);
  });

  it("default mode inserts with suggested_by='auto-generator'", async () => {
    mockIsAdmin = true;
    fake.results = [[]];
    const res = await call("PUT");
    expect(res.status).toBe(200);
    const insert = fake.calls[0];
    expect(insert.strings.join("?")).toContain("INSERT INTO director_movie_prompts");
    // 'auto-generator' is a SQL literal, not a template param — check the strings.
    expect(insert.strings.join("?")).toContain("'auto-generator'");
  });

  it("respects requested genre when provided", async () => {
    mockIsAdmin = true;
    fake.results = [[]];
    const res = await call("PUT", "http://localhost/api/admin/director-prompts?genre=horror");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { genre: string };
    expect(body.genre).toBe("horror");
  });

  it("director= does not break the route even though DIRECTORS is stubbed to {}", async () => {
    mockIsAdmin = true;
    fake.results = [[]];
    const res = await call("PUT", "http://localhost/api/admin/director-prompts?director=nolan&preview=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string; concept: string };
    // No "DIRECTOR STYLE:" injection because stub is empty
    expect(body.concept).not.toContain("DIRECTOR STYLE:");
  });
});

describe("DELETE /api/admin/director-prompts", () => {
  it("401 when not admin", async () => {
    expect((await call("DELETE", undefined, { id: "p1" })).status).toBe(401);
  });

  it("400 when id missing", async () => {
    mockIsAdmin = true;
    expect((await call("DELETE", undefined, {})).status).toBe(400);
  });

  it("default deletes from director_movie_prompts", async () => {
    mockIsAdmin = true;
    fake.results = [[]];
    const res = await call("DELETE", undefined, { id: "p1" });
    expect(res.status).toBe(200);
    expect(fake.calls[0].strings.join("?")).toContain("DELETE FROM director_movie_prompts");
  });

  it("type='movie' deletes from director_movies", async () => {
    mockIsAdmin = true;
    fake.results = [[]];
    const res = await call("DELETE", undefined, { id: "m1", type: "movie" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: string; type: string };
    expect(body.type).toBe("movie");
    expect(fake.calls[0].strings.join("?")).toContain("DELETE FROM director_movies");
  });
});

describe("generateRandomConcept (unit)", () => {
  it("produces a valid-shape concept with known genre options", async () => {
    const { generateRandomConcept } = await import("./route");
    const out = generateRandomConcept();
    expect(out.title).toBeTruthy();
    expect(out.concept).toContain("AIG!itch");
    expect([
      "action", "scifi", "romance", "family", "horror",
      "comedy", "drama", "documentary", "cooking_channel",
    ]).toContain(out.genre);
  });

  it("honours requested genre (not 'any')", async () => {
    const { generateRandomConcept } = await import("./route");
    const out = generateRandomConcept("drama");
    expect(out.genre).toBe("drama");
  });

  it("treats 'any' as a wildcard and picks a real genre", async () => {
    const { generateRandomConcept } = await import("./route");
    const out = generateRandomConcept("any");
    expect(out.genre).not.toBe("any");
  });
});
