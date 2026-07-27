import { readFileSync } from "fs";
import { neon } from "@neondatabase/serverless";

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const raw = readFileSync(".env.local", "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^DATABASE_URL=(.+)$/);
      if (m) return m[1].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* no file */
  }
  return null;
}

const url = loadDatabaseUrl();
if (!url) {
  console.error("NO DATABASE_URL");
  process.exit(1);
}

const sql = neon(url);
const PLATFORMS = ["x", "telegram", "instagram", "facebook", "youtube"];

const posts = await sql`
  SELECT p.id, p.content, p.channel_id, p.created_at,
    (SELECT COUNT(*)::int FROM marketing_posts mp WHERE mp.source_post_id = p.id) AS spread_count,
    (SELECT COUNT(*)::int FROM marketing_posts mp WHERE mp.source_post_id = p.id AND mp.status = 'posted') AS posted_count,
    (SELECT COUNT(*)::int FROM marketing_posts mp WHERE mp.source_post_id = p.id AND mp.status = 'failed') AS failed_count
  FROM posts p
  WHERE p.persona_id = 'glitch-000'
    AND p.media_source = 'director-movie'
    AND p.created_at > NOW() - INTERVAL '6 hours'
  ORDER BY p.created_at DESC
  LIMIT 10
`;

console.log(`\nRecent channel videos (last 6h): ${posts.length}\n`);

let allGreen = true;
for (const p of posts) {
  const rows = await sql`
    SELECT platform, status, platform_url, error_message
    FROM marketing_posts
    WHERE source_post_id = ${p.id}
    ORDER BY platform
  `;
  const title = (p.content || "").split("\n")[0]?.slice(0, 60) ?? p.id;
  const posted = rows.filter((r) => r.status === "posted").map((r) => r.platform);
  const failed = rows.filter((r) => r.status === "failed");
  const missing = PLATFORMS.filter((pl) => !rows.some((r) => r.platform === pl));

  const ok = missing.length === 0 && failed.length === 0 && posted.length >= 5;
  if (!ok) allGreen = false;

  console.log(`${ok ? "✅" : "⚠️"} ${title}`);
  console.log(`   post ${p.id} | channel ${p.channel_id} | ${p.created_at}`);
  console.log(`   posted: ${posted.join(", ") || "none"}`);
  if (failed.length) {
    for (const f of failed) {
      console.log(`   FAILED ${f.platform}: ${(f.error_message || "").slice(0, 80)}`);
    }
  }
  if (missing.length) console.log(`   MISSING rows: ${missing.join(", ")}`);
  console.log("");
}

console.log(allGreen ? "ALL RECENT VIDEOS: 5/5 platforms posted" : "Some videos incomplete — see above");
