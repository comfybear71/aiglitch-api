import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/prompt-overrides", () => ({ getPrompt: vi.fn() }));

import { getDb } from "@/lib/db";
import { getPrompt } from "@/lib/prompt-overrides";
import { PLATFORM_BRIEF } from "@/lib/bible/platform-brief";
import { buildPlatformBriefBlock } from "./platform-brief";

type Call = { strings: readonly string[]; params: unknown[] };

function fakeSql(results: unknown[][]) {
  let i = 0;
  const calls: Call[] = [];
  const sql = (strings: TemplateStringsArray, ...params: unknown[]) => {
    calls.push({ strings: Array.from(strings), params });
    const row = results[i] ?? [];
    i++;
    return Promise.resolve(row);
  };
  return { sql, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildPlatformBriefBlock", () => {
  it("combines brief override + live stats + channel URLs", async () => {
    vi.mocked(getPrompt).mockResolvedValue("BRIEF-OVERRIDE");
    const { sql } = fakeSql([
      [{ c: 111 }],
      [{ c: 19 }],
      [{ c: 42 }],
      [{ c: 12345 }],
      [{ c: 7 }],
      [
        { slug: "ch-aitunes", name: "AITunes", emoji: "🎵", description: null },
        { slug: "ch-gnn", name: "GNN", emoji: "📰", description: "News" },
      ],
    ]);
    vi.mocked(getDb).mockReturnValue(sql as never);

    const block = await buildPlatformBriefBlock();

    expect(block).toContain("BRIEF-OVERRIDE");
    expect(block).toContain("Active personas: 111");
    expect(block).toContain("Active public channels: 19");
    expect(block).toContain("Posts in last 24 hours: 42");
    expect(block).toContain("Total posts ever: 12,345");
    expect(block).toContain("Videos posted in last 24 hours: 7");
    expect(block).toContain("https://aiglitch.app/channels/ch-aitunes");
    expect(block).toContain("https://aiglitch.app/channels/ch-gnn");
  });

  it("falls back to constant + default stats when DB errors", async () => {
    vi.mocked(getPrompt).mockResolvedValue(PLATFORM_BRIEF);
    const sql = (() => {
      throw new Error("db down");
    }) as never;
    vi.mocked(getDb).mockReturnValue(sql);

    const block = await buildPlatformBriefBlock();

    expect(block).toContain("AIG!ITCH PLATFORM BRIEF");
    expect(block).toContain("Active personas: 111");
    expect(block).toContain("Active public channels: 19");
  });

  it("omits channel URL list when no channels present", async () => {
    vi.mocked(getPrompt).mockResolvedValue("X");
    const { sql } = fakeSql([
      [{ c: 0 }],
      [{ c: 0 }],
      [{ c: 0 }],
      [{ c: 0 }],
      [{ c: 0 }],
      [],
    ]);
    vi.mocked(getDb).mockReturnValue(sql as never);

    const block = await buildPlatformBriefBlock();

    expect(block).not.toContain("LIVE CHANNEL URL LIST");
  });
});
