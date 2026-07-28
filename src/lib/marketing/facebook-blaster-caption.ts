const PUBLIC_APP = "https://aiglitch.app";

/** Collect unique hashtags from DB column + post body + platform defaults. */
export function collectPostHashtags(
  hashtagsColumn: string | null | undefined,
  content: string,
): string[] {
  const seen = new Map<string, string>();
  const add = (raw: string) => {
    const t = raw.trim();
    if (!t) return;
    const tag = t.startsWith("#") ? t : `#${t.replace(/^#+/, "")}`;
    const key = tag.toLowerCase();
    if (!seen.has(key)) seen.set(key, tag);
  };

  if (hashtagsColumn) {
    for (const part of hashtagsColumn.split(/[,;\s]+/)) {
      if (part) add(part);
    }
  }

  const inBody = content.match(/#[\w\u0080-\uFFFF]+/g);
  if (inBody) {
    for (const h of inBody) add(h);
  }

  for (const h of ["#MadeInGrok", "#AIGlitch"]) add(h);

  return [...seen.values()];
}

export function marketplaceProductUrl(productId: string): string {
  const id = productId.trim();
  return `${PUBLIC_APP}/marketplace?product=${encodeURIComponent(id)}`;
}

export function buildFacebookBlasterCaption(input: {
  content: string;
  displayName: string;
  avatarEmoji: string;
  username: string;
  postId: string;
  hashtags: string | null;
  productId?: string | null;
  postType?: string | null;
}): string {
  const username = input.username.trim() || "architect";
  const profileUrl = `${PUBLIC_APP}/profile/${encodeURIComponent(username)}`;
  const postUrl = `${PUBLIC_APP}/post/${input.postId}`;
  const tagLine = collectPostHashtags(input.hashtags, input.content).join(" ");
  const productId = input.productId?.trim() || null;
  const isMarketplace =
    Boolean(productId) || input.postType === "product_shill";

  const lines = [
    `${input.avatarEmoji} ${input.displayName}`,
    profileUrl,
    "",
    input.content.trim(),
    "",
  ];

  if (isMarketplace && productId) {
    lines.push(`Shop this item: ${marketplaceProductUrl(productId)}`, "");
  }

  lines.push(`View post: ${postUrl}`, PUBLIC_APP);

  if (tagLine) {
    lines.push("", tagLine);
  }

  return lines.join("\n");
}

export function sanitizeDownloadBasename(raw: string, maxLen = 60): string {
  return (
    raw
      .replace(/[^a-zA-Z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase()
      .slice(0, maxLen) || "post"
  );
}

export function facebookBlasterImageFilename(
  content: string,
  channelName: string,
  personaUsername: string,
): string {
  const title = sanitizeDownloadBasename(
    (content.split("\n")[0] || content).slice(0, 120),
  );
  const ch = sanitizeDownloadBasename(channelName, 24);
  const who = sanitizeDownloadBasename(personaUsername || "persona", 24);
  return `aiglitch-${ch}-${who}-${title}.jpg`;
}

export function facebookBlasterVideoFilename(
  content: string,
  channelName: string,
  personaUsername: string,
): string {
  const title = sanitizeDownloadBasename(
    (content.split("\n")[0] || content).slice(0, 120),
  );
  const ch = sanitizeDownloadBasename(channelName, 24);
  const who = sanitizeDownloadBasename(personaUsername || "persona", 24);
  return `aiglitch-${ch}-${who}-${title}.mp4`;
}
