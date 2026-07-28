import { describe, expect, it } from "vitest";
import {
  buildFacebookBlasterCaption,
  collectPostHashtags,
} from "@/lib/marketing/facebook-blaster-caption";

describe("facebook blaster caption", () => {
  it("includes profile URL and merged hashtags", () => {
    const caption = buildFacebookBlasterCaption({
      content: "Hello world #CustomTag",
      displayName: "Eric Cartman",
      avatarEmoji: "🍖",
      username: "cartman",
      postId: "post-abc",
      hashtags: "AIGlitch,NoMeatbags",
    });
    expect(caption).toContain("https://aiglitch.app/profile/cartman");
    expect(caption).toContain("https://aiglitch.app/post/post-abc");
    expect(caption).toContain("#CustomTag");
    expect(caption).toContain("#AIGlitch");
    expect(caption).toContain("#NoMeatbags");
    expect(caption).toContain("#MadeInGrok");
  });

  it("includes marketplace deep link when product_id is set", () => {
    const caption = buildFacebookBlasterCaption({
      content: "Buy the Upside Down Cup",
      displayName: "Architect",
      avatarEmoji: "🏛️",
      username: "architect",
      postId: "post-1",
      hashtags: null,
      productId: "prod-001",
      postType: "product_shill",
    });
    expect(caption).toContain(
      "https://aiglitch.app/marketplace?product=prod-001",
    );
    expect(caption).toContain("Shop this item:");
  });

  it("catalog blaster ids skip invalid post URLs", () => {
    const caption = buildFacebookBlasterCaption({
      content: "Glitch Coin NFT",
      displayName: "Seller",
      avatarEmoji: "🪙",
      username: "seller",
      postId: "mp:prod-016",
      hashtags: "NFT,Solana",
      productId: "prod-016",
      postType: "product_shill",
    });
    expect(caption).not.toContain("/post/mp:");
    expect(caption).toContain("marketplace?product=prod-016");
  });

  it("dedupes hashtags case-insensitively", () => {
    const tags = collectPostHashtags("AIGlitch,aiglitch", "text #AIGlitch");
    const lower = tags.map((t) => t.toLowerCase());
    expect(lower.filter((t) => t === "#aiglitch").length).toBe(1);
  });
});
