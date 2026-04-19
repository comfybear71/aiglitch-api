import { describe, expect, it } from "vitest";
import { threadComments, type CommentRow } from "./posts";

function mkComment(overrides: Partial<CommentRow> = {}): CommentRow {
  return {
    id: "c-default",
    content: "hi",
    created_at: "2026-01-01T00:00:00Z",
    like_count: 0,
    post_id: "p-1",
    parent_comment_id: null,
    parent_comment_type: null,
    username: "alice",
    display_name: "Alice",
    avatar_emoji: "🤖",
    avatar_url: null,
    is_human: false,
    ...overrides,
  };
}

describe("threadComments", () => {
  it("groups flat comments by post_id", () => {
    const result = threadComments(
      [
        mkComment({ id: "a1", post_id: "p-1" }),
        mkComment({ id: "a2", post_id: "p-2" }),
      ],
      [],
    );
    expect(result.get("p-1")?.map((c) => c.id)).toEqual(["a1"]);
    expect(result.get("p-2")?.map((c) => c.id)).toEqual(["a2"]);
  });

  it("sorts comments within a post chronologically ascending", () => {
    const result = threadComments(
      [
        mkComment({ id: "a-late", created_at: "2026-01-02T00:00:00Z" }),
        mkComment({ id: "a-early", created_at: "2026-01-01T00:00:00Z" }),
      ],
      [],
    );
    expect(result.get("p-1")?.map((c) => c.id)).toEqual(["a-early", "a-late"]);
  });

  it("attaches replies under their parent and removes them from top level", () => {
    const result = threadComments(
      [
        mkComment({ id: "parent", created_at: "2026-01-01T00:00:00Z" }),
        mkComment({
          id: "reply",
          created_at: "2026-01-01T00:01:00Z",
          parent_comment_id: "parent",
        }),
      ],
      [],
    );
    const top = result.get("p-1")!;
    expect(top.map((c) => c.id)).toEqual(["parent"]);
    expect(top[0]?.replies.map((r) => r.id)).toEqual(["reply"]);
  });

  it("treats reply with unknown parent as top-level (parent missing)", () => {
    const result = threadComments(
      [
        mkComment({
          id: "orphan",
          parent_comment_id: "ghost",
        }),
      ],
      [],
    );
    expect(result.get("p-1")?.map((c) => c.id)).toEqual(["orphan"]);
  });

  it("merges AI and human comments under the same post", () => {
    const result = threadComments(
      [mkComment({ id: "ai-1", is_human: false })],
      [mkComment({ id: "h-1", is_human: true })],
    );
    expect(result.get("p-1")?.map((c) => c.id).sort()).toEqual(["ai-1", "h-1"]);
  });

  it("caps top-level comments at maxTopLevel", () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      mkComment({ id: `c-${i}`, created_at: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z` }),
    );
    const result = threadComments(many, [], 10);
    expect(result.get("p-1")?.length).toBe(10);
  });

  it("returns empty map when no comments provided", () => {
    expect(threadComments([], []).size).toBe(0);
  });
});
