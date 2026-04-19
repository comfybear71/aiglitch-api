#!/usr/bin/env node
/**
 * Verifies that the migrated /api/feed (Slice A — For You default mode)
 * returns a response with the same shape and drawn from the same post
 * pool as the legacy aiglitch.app/api/feed.
 *
 * Run:
 *   npm run verify:feed
 *   npm run verify:feed -- --legacy https://aiglitch.app/api/feed \
 *                          --new    https://<preview>.vercel.app/api/feed
 *   npm run verify:feed -- --samples 10
 *
 * Exits 0 on pass, 1 on any failure.
 */

interface FeedResponse {
  posts: Array<Record<string, unknown>>;
  nextCursor: string | null;
  [key: string]: unknown;
}

interface Args {
  legacy: string;
  new: string;
  samples: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    legacy: "https://aiglitch.app/api/feed",
    new: "https://aiglitch-api.vercel.app/api/feed",
    samples: 5,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--legacy" && v) args.legacy = v;
    else if (k === "--new" && v) args.new = v;
    else if (k === "--samples" && v) args.samples = parseInt(v, 10);
  }
  return args;
}

async function fetchFeed(url: string): Promise<FeedResponse> {
  // Vercel's bot protection rejects requests without a User-Agent.
  const res = await fetch(url, {
    cache: "no-store",
    headers: {
      "User-Agent": "aiglitch-api/verify-feed (Mozilla/5.0 compatible)",
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return (await res.json()) as FeedResponse;
}

function topLevelKeys(r: FeedResponse): Set<string> {
  return new Set(Object.keys(r));
}

function postKeys(r: FeedResponse): Set<string> {
  const keys = new Set<string>();
  for (const p of r.posts) {
    for (const k of Object.keys(p)) keys.add(k);
  }
  return keys;
}

function postIds(r: FeedResponse): string[] {
  return r.posts.map((p) => String(p.id));
}

function diff<T>(a: Set<T>, b: Set<T>): { onlyA: T[]; onlyB: T[]; shared: T[] } {
  const onlyA: T[] = [];
  const onlyB: T[] = [];
  const shared: T[] = [];
  for (const x of a) (b.has(x) ? shared : onlyA).push(x);
  for (const x of b) if (!a.has(x)) onlyB.push(x);
  return { onlyA, onlyB, shared };
}

function heading(s: string): void {
  console.log(`\n${s}\n${"=".repeat(s.length)}`);
}

function row(label: string, value: string): void {
  console.log(`  ${label.padEnd(24)} ${value}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let failures = 0;

  heading("aiglitch-api Feed Verify");
  row("legacy", args.legacy);
  row("new", args.new);
  row("samples", String(args.samples));

  // --- Shape parity on one call each ---
  heading("Shape parity");
  let legacySample: FeedResponse;
  let newSample: FeedResponse;
  try {
    [legacySample, newSample] = await Promise.all([
      fetchFeed(args.legacy),
      fetchFeed(args.new),
    ]);
  } catch (err) {
    console.error(`✗ initial fetch failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const topLegacy = topLevelKeys(legacySample);
  const topNew = topLevelKeys(newSample);
  const topDiff = diff(topLegacy, topNew);
  if (topDiff.onlyA.length === 0) {
    console.log(`  ✓ new has every top-level key legacy has (${topDiff.shared.length})`);
  } else {
    console.log(`  ✗ new is missing top-level keys present in legacy: ${topDiff.onlyA.join(", ")}`);
    failures++;
  }
  if (topDiff.onlyB.length > 0) {
    console.log(`  ⚠ new has extra top-level keys not in legacy: ${topDiff.onlyB.join(", ")}`);
  }

  const postLegacy = postKeys(legacySample);
  const postNew = postKeys(newSample);
  const postDiff = diff(postLegacy, postNew);
  if (postDiff.onlyA.length === 0) {
    console.log(`  ✓ new post shape covers every legacy field (${postDiff.shared.length})`);
  } else {
    console.log(`  ✗ new is missing post fields present in legacy: ${postDiff.onlyA.join(", ")}`);
    failures++;
  }
  if (postDiff.onlyB.length > 0) {
    console.log(`  ⚠ new has extra post fields not in legacy: ${postDiff.onlyB.join(", ")}`);
  }

  // --- Set overlap across N samples ---
  heading(`Post ID overlap across ${args.samples} samples`);
  const legacyUnion = new Set<string>();
  const newUnion = new Set<string>();

  for (let i = 0; i < args.samples; i++) {
    const [l, n] = await Promise.all([fetchFeed(args.legacy), fetchFeed(args.new)]);
    for (const id of postIds(l)) legacyUnion.add(id);
    for (const id of postIds(n)) newUnion.add(id);
  }

  const idDiff = diff(newUnion, legacyUnion);
  const overlapRatio = newUnion.size === 0 ? 0 : idDiff.shared.length / newUnion.size;
  const overlapPct = Math.round(overlapRatio * 100);

  row("legacy unique ids", String(legacyUnion.size));
  row("new unique ids", String(newUnion.size));
  row("intersection", `${idDiff.shared.length} (${overlapPct}% of new)`);

  if (overlapRatio >= 0.5) {
    console.log(`  ✓ overlap is healthy (≥50%)`);
  } else {
    console.log(`  ✗ overlap is suspiciously low — new may be filtering differently`);
    failures++;
  }

  if (idDiff.onlyA.length > 0 && args.samples >= 3) {
    // IDs only in new across multiple samples is strong signal
    console.log(
      `  ⚠ ${idDiff.onlyA.length} ids in new never appeared in legacy across ${args.samples} samples`,
    );
  }

  // --- Summary ---
  heading("Result");
  if (failures === 0) {
    console.log("  ✓ PASS");
    process.exit(0);
  } else {
    console.log(`  ✗ FAIL (${failures} check${failures === 1 ? "" : "s"} failed)`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
