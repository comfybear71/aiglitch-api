import { beforeEach, describe, expect, it, vi } from "vitest";

const sqlMock = vi.fn();
vi.mock("@/lib/db", () => ({
  getDb: () => sqlMock,
}));

const getOverridesMock = vi.fn();
vi.mock("@/lib/prompt-overrides", () => ({
  getPromptOverrides: () => getOverridesMock(),
}));

beforeEach(() => {
  sqlMock.mockReset();
  getOverridesMock.mockReset();
  vi.resetModules();
});

describe("buildPromptCatalog", () => {
  it("merges channel DB rows with code defaults and overrides", async () => {
    getOverridesMock.mockResolvedValue([
      {
        id: 1,
        category: "channel",
        key: "gnn.promptHint",
        label: "GNN",
        value: "OVERRIDE HINT",
        updated_at: "2026-04-21",
      },
    ]);

    sqlMock.mockResolvedValue([
      {
        id: "ch-gnn",
        slug: "gnn",
        name: "GNN",
        emoji: "📰",
        content_rules: JSON.stringify({ promptHint: "DEFAULT HINT" }),
      },
    ]);

    const { buildPromptCatalog } = await import("./prompt-catalog");
    const catalog = await buildPromptCatalog();

    expect(catalog.channels).toHaveLength(1);
    expect(catalog.channels[0]!.channelId).toBe("ch-gnn");
    expect(catalog.channels[0]!.prompts[0]).toMatchObject({
      category: "channel",
      key: "gnn.promptHint",
      value: "OVERRIDE HINT",
      default: "DEFAULT HINT",
      overridden: true,
    });
    expect(catalog.directors.length).toBeGreaterThan(0);
    expect(catalog.genres.length).toBeGreaterThan(0);
    expect(catalog.platform[0]!.prompts[0]!.category).toBe("platform");
    expect(catalog.overrideCount).toBe(1);
  });

  it("includes director and genre fields with correct keys", async () => {
    getOverridesMock.mockResolvedValue([]);
    sqlMock.mockResolvedValue([]);

    const { buildPromptCatalog } = await import("./prompt-catalog");
    const catalog = await buildPromptCatalog();

    const spielbot = catalog.directors.find((d) => d.directorUsername === "steven_spielbot");
    expect(spielbot?.prompts.some((p) => p.key === "steven_spielbot.style")).toBe(true);

    const action = catalog.genres.find((g) => g.genreKey === "action");
    expect(action?.prompts.some((p) => p.key === "action.cinematicStyle")).toBe(true);
  });
});
