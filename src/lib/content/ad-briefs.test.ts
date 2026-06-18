/**
 * Tests for the ad-briefs CRUD lib.
 *
 * Uses the same fake-sql harness as the other content libs — captures
 * each tagged-template call and lets the test inject the result rows.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SqlCall = { strings: TemplateStringsArray; values: unknown[] };
const fake = {
  calls: [] as SqlCall[],
  results: [] as unknown[][],
};

function fakeSql(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Promise<unknown[]> {
  fake.calls.push({ strings, values });
  return Promise.resolve(fake.results.shift() ?? []);
}

vi.mock("@neondatabase/serverless", () => ({ neon: () => fakeSql }));

beforeEach(() => {
  fake.calls = [];
  fake.results = [];
  process.env.DATABASE_URL = "postgres://test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

/**
 * The schema bootstrap fires 5 statements (2 CREATE TABLE + 3 CREATE
 * INDEX) before the consumer's real query lands. Prepend that many empty
 * results so the test only needs to provide values for what it cares
 * about.
 */
function withSchema(...rows: unknown[][]): unknown[][] {
  return [...Array(5).fill([]), ...rows];
}

describe("createBrief", () => {
  it("INSERTs with the provided fields and returns the row", async () => {
    const inserted = {
      id: "uuid-1",
      title: "BUDJU explainer",
      project_name: "BUDJU",
      concept: "Explain DCA tiers in 30s.",
      status: "draft",
      target_socials: null,
      created_at: "now",
      updated_at: "now",
    };
    fake.results = withSchema([inserted]);
    const { createBrief } = await import("./ad-briefs");
    const out = await createBrief({
      title: "BUDJU explainer",
      project_name: "BUDJU",
      concept: "Explain DCA tiers in 30s.",
    });
    expect(out.id).toBe("uuid-1");
    expect(out.project_name).toBe("BUDJU");
    expect(out.status).toBe("draft");
  });

  it("accepts an explicit non-draft starting status", async () => {
    fake.results = withSchema([
      {
        id: "uuid-2",
        title: "t",
        project_name: "p",
        concept: "c",
        status: "ready",
        target_socials: null,
        created_at: "now",
        updated_at: "now",
      },
    ]);
    const { createBrief } = await import("./ad-briefs");
    const out = await createBrief({
      title: "t",
      project_name: "p",
      concept: "c",
      status: "ready",
    });
    expect(out.status).toBe("ready");
  });
});

describe("listBriefs filtering", () => {
  it("defaults to status != archived ORDER BY created_at DESC", async () => {
    fake.results = withSchema([
      { id: "a", title: "A", status: "draft" },
      { id: "b", title: "B", status: "ready" },
    ]);
    const { listBriefs } = await import("./ad-briefs");
    const list = await listBriefs();
    expect(list).toHaveLength(2);
    const last = fake.calls.at(-1)!;
    expect(last.strings.join("")).toContain("status != 'archived'");
  });

  it("status filter narrows the WHERE clause", async () => {
    fake.results = withSchema([[{ id: "a", status: "ready" }]]);
    const { listBriefs } = await import("./ad-briefs");
    await listBriefs({ status: "ready" });
    const last = fake.calls.at(-1)!;
    expect(last.strings.join("")).toContain("WHERE status =");
    expect(last.values).toContain("ready");
  });

  it("project_name filter (without status) hides archived unless asked", async () => {
    fake.results = withSchema([]);
    const { listBriefs } = await import("./ad-briefs");
    await listBriefs({ project_name: "BUDJU" });
    const last = fake.calls.at(-1)!;
    expect(last.strings.join("")).toContain("status != 'archived'");
  });

  it("project_name + includeArchived returns archived rows too", async () => {
    fake.results = withSchema([]);
    const { listBriefs } = await import("./ad-briefs");
    await listBriefs({ project_name: "BUDJU", includeArchived: true });
    const last = fake.calls.at(-1)!;
    expect(last.strings.join("")).not.toContain("status != 'archived'");
  });

  it("status + project_name uses both clauses", async () => {
    fake.results = withSchema([]);
    const { listBriefs } = await import("./ad-briefs");
    await listBriefs({ status: "draft", project_name: "ToGoGo" });
    const last = fake.calls.at(-1)!;
    expect(last.strings.join("")).toContain("status =");
    expect(last.strings.join("")).toContain("project_name =");
  });

  it("limit clamps to 1-200 range", async () => {
    fake.results = withSchema([]);
    const { listBriefs } = await import("./ad-briefs");
    await listBriefs({ limit: 9999 });
    const last = fake.calls.at(-1)!;
    expect(last.values).toContain(200);
  });
});

describe("getBrief / getBriefWithAssets", () => {
  it("getBrief returns null when no row found", async () => {
    fake.results = withSchema([]);
    const { getBrief } = await import("./ad-briefs");
    expect(await getBrief("missing")).toBeNull();
  });

  it("getBriefWithAssets returns the brief plus its assets", async () => {
    fake.results = withSchema(
      [{ id: "b-1", title: "T", project_name: "P", concept: "C", status: "draft" }],
      // The schema-bootstrap memoizes on first call inside the module, so
      // listAssetsForBrief skips it on the follow-up — no extra empty rows.
      [
        { id: "a-1", ad_brief_id: "b-1", asset_type: "image", blob_url: "u", original_filename: "x.png", size_bytes: null, created_at: "now" },
      ],
    );
    const { getBriefWithAssets } = await import("./ad-briefs");
    const out = await getBriefWithAssets("b-1");
    expect(out?.assets).toHaveLength(1);
    expect(out?.assets[0]!.asset_type).toBe("image");
  });
});

describe("updateBrief", () => {
  it("uses COALESCE so undefined fields keep existing values", async () => {
    fake.results = withSchema([{ id: "b-1", title: "newtitle" }]);
    const { updateBrief } = await import("./ad-briefs");
    await updateBrief("b-1", { title: "newtitle" });
    const last = fake.calls.at(-1)!;
    expect(last.strings.join("")).toContain("COALESCE");
    expect(last.values).toContain("newtitle");
  });

  it("returns null when row not found", async () => {
    fake.results = withSchema([]);
    const { updateBrief } = await import("./ad-briefs");
    expect(await updateBrief("missing", { title: "x" })).toBeNull();
  });
});

describe("softDeleteBrief", () => {
  it("calls updateBrief with status=archived", async () => {
    fake.results = withSchema([{ id: "b-1", status: "archived" }]);
    const { softDeleteBrief } = await import("./ad-briefs");
    const ok = await softDeleteBrief("b-1");
    expect(ok).toBe(true);
    const last = fake.calls.at(-1)!;
    expect(last.values).toContain("archived");
  });

  it("returns false when target row missing", async () => {
    fake.results = withSchema([]);
    const { softDeleteBrief } = await import("./ad-briefs");
    expect(await softDeleteBrief("missing")).toBe(false);
  });
});

describe("assets", () => {
  it("createAsset INSERTs and returns the row", async () => {
    fake.results = withSchema([
      {
        id: "a-1",
        ad_brief_id: "b-1",
        asset_type: "video",
        blob_url: "https://blob/x.mp4",
        original_filename: "x.mp4",
        size_bytes: 1000,
        created_at: "now",
      },
    ]);
    const { createAsset } = await import("./ad-briefs");
    const out = await createAsset({
      ad_brief_id: "b-1",
      asset_type: "video",
      blob_url: "https://blob/x.mp4",
      original_filename: "x.mp4",
      size_bytes: 1000,
    });
    expect(out.id).toBe("a-1");
    expect(out.asset_type).toBe("video");
  });

  it("deleteAsset returns true when a row was deleted", async () => {
    fake.results = withSchema([[{ id: "a-1" }]]);
    const { deleteAsset } = await import("./ad-briefs");
    expect(await deleteAsset("a-1")).toBe(true);
  });

  it("deleteAsset returns false when nothing matched", async () => {
    fake.results = withSchema([]);
    const { deleteAsset } = await import("./ad-briefs");
    expect(await deleteAsset("missing")).toBe(false);
  });
});
