/** Strip query/hash so blob URLs dedupe consistently. */
export function normalizeMediaUrl(url: string): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`.toLowerCase();
  } catch {
    return url.split(/[?#]/)[0]!.toLowerCase();
  }
}

/** First-line headline from post content — matches TikTok Blaster card title. */
export function normalizeBlasterTitle(content: string): string {
  let title = content || "";
  title = title.replace(/^[^\w]*\s*/, "");
  const firstLine = title.split("\n")[0] || title;
  return firstLine.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 120);
}

export interface DedupeableVideoRow {
  id: string;
  media_url: string;
  content: string;
  created_at: string;
  blasted_at: string | null;
  tiktok_url: string | null;
}

export type DedupedVideoRow<T extends DedupeableVideoRow> = T & {
  duplicate_count: number;
};

function rowsAreDuplicates(a: DedupeableVideoRow, b: DedupeableVideoRow): boolean {
  const urlA = normalizeMediaUrl(a.media_url);
  const urlB = normalizeMediaUrl(b.media_url);
  if (urlA && urlA === urlB) return true;

  const titleA = normalizeBlasterTitle(a.content);
  const titleB = normalizeBlasterTitle(b.content);
  return titleA.length > 0 && titleA === titleB;
}

/**
 * One card per unique video for TikTok. Rows merge when they share the same
 * media_url OR the same headline (promo runs often re-upload the same clip
 * to blob with a new URL per persona/post).
 */
export function dedupeBlasterVideos<T extends DedupeableVideoRow>(
  rows: T[],
  max = 500,
): DedupedVideoRow<T>[] {
  if (rows.length === 0) return [];

  const parent = rows.map((_, i) => i);
  function find(i: number): number {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  }
  function union(a: number, b: number) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  }

  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (rowsAreDuplicates(rows[i]!, rows[j]!)) union(i, j);
    }
  }

  const groups = new Map<number, T[]>();
  for (let i = 0; i < rows.length; i++) {
    const root = find(i);
    const list = groups.get(root) ?? [];
    list.push(rows[i]!);
    groups.set(root, list);
  }

  const deduped: DedupedVideoRow<T>[] = [];

  for (const groupRows of groups.values()) {
    const sorted = [...groupRows].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
    const pick = sorted[0]!;
    const blastedRow = sorted.find((r) => r.blasted_at);
    deduped.push({
      ...pick,
      blasted_at: blastedRow?.blasted_at ?? pick.blasted_at,
      tiktok_url: blastedRow?.tiktok_url ?? pick.tiktok_url,
      duplicate_count: groupRows.length,
    });
  }

  deduped.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  return deduped.slice(0, max);
}

/** Session / blast tracking — hide if ANY key matches. */
export function blasterDedupeKeys(mediaUrl: string, content: string): string[] {
  const keys: string[] = [];
  const urlKey = normalizeMediaUrl(mediaUrl);
  const titleKey = normalizeBlasterTitle(content);
  if (urlKey) keys.push(`url:${urlKey}`);
  if (titleKey) keys.push(`title:${titleKey}`);
  return keys;
}

export function blasterKeysMatch(
  a: { media_url: string; content: string },
  b: { media_url: string; content: string },
): boolean {
  return rowsAreDuplicates(
    { ...a, id: "", created_at: "", blasted_at: null, tiktok_url: null },
    { ...b, id: "", created_at: "", blasted_at: null, tiktok_url: null },
  );
}
