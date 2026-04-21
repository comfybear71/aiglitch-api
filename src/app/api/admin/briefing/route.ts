/**
 * GET /api/admin/briefing
 *
 * One-shot admin dashboard payload showing the current "news cycle" on
 * the platform: active daily topics, recently expired topics (48h),
 * active beef threads, open challenges, and the top 20 engagement-
 * ranked posts from the last 24h.
 *
 * Each section is independently try/catch'd — `ai_beef_threads` and
 * `ai_challenges` may not exist on every env, so a missing table falls
 * back to an empty array rather than 500-ing the whole response.
 */

import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { isAdminAuthenticated } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface TopicRow {
  id: string;
  headline: string;
  summary: string;
  original_theme: string;
  anagram_mappings: string;
  mood: string;
  category: string;
  is_active: boolean;
  expires_at: string;
  created_at: string;
}

interface BeefRow {
  id: string;
  topic: string;
  status: string;
  created_at: string;
  persona1_username: string;
  persona1_name: string;
  persona1_emoji: string;
  persona2_username: string;
  persona2_name: string;
  persona2_emoji: string;
}

interface ChallengeRow {
  id: string;
  tag: string;
  description: string;
  created_at: string;
  creator_username: string;
  creator_name: string;
  creator_emoji: string;
}

interface TopPostRow {
  id: string;
  content: string;
  post_type: string;
  like_count: number;
  ai_like_count: number;
  created_at: string;
  media_type: string | null;
  beef_thread_id: string | null;
  challenge_tag: string | null;
  is_collab_with: string | null;
  username: string;
  display_name: string;
  avatar_emoji: string;
}

async function safeQuery<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch (err) {
    console.warn("[admin/briefing] query failed:", err instanceof Error ? err.message : err);
    return [];
  }
}

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sql = getDb();

  const [topics, expiredTopics, beefThreads, challenges, topPosts] = await Promise.all([
    safeQuery<TopicRow>(async () => (await sql`
      SELECT id, headline, summary, original_theme, anagram_mappings,
             mood, category, is_active, expires_at, created_at
      FROM daily_topics
      WHERE is_active = TRUE AND expires_at > NOW()
      ORDER BY created_at DESC
    `) as unknown as TopicRow[]),

    safeQuery<TopicRow>(async () => (await sql`
      SELECT id, headline, summary, original_theme, anagram_mappings,
             mood, category, is_active, expires_at, created_at
      FROM daily_topics
      WHERE is_active = FALSE OR expires_at <= NOW()
      ORDER BY created_at DESC
      LIMIT 10
    `) as unknown as TopicRow[]),

    safeQuery<BeefRow>(async () => (await sql`
      SELECT bt.id, bt.topic, bt.status, bt.created_at,
        p1.username AS persona1_username, p1.display_name AS persona1_name, p1.avatar_emoji AS persona1_emoji,
        p2.username AS persona2_username, p2.display_name AS persona2_name, p2.avatar_emoji AS persona2_emoji
      FROM ai_beef_threads bt
      JOIN ai_personas p1 ON bt.persona_a = p1.id
      JOIN ai_personas p2 ON bt.persona_b = p2.id
      WHERE bt.status = 'active' OR bt.created_at > NOW() - INTERVAL '24 hours'
      ORDER BY bt.created_at DESC
      LIMIT 10
    `) as unknown as BeefRow[]),

    safeQuery<ChallengeRow>(async () => (await sql`
      SELECT c.id, c.tag, c.description, c.created_at,
        a.username AS creator_username, a.display_name AS creator_name, a.avatar_emoji AS creator_emoji
      FROM ai_challenges c
      JOIN ai_personas a ON c.created_by = a.id
      WHERE c.created_at > NOW() - INTERVAL '48 hours'
      ORDER BY c.created_at DESC
      LIMIT 10
    `) as unknown as ChallengeRow[]),

    safeQuery<TopPostRow>(async () => (await sql`
      SELECT p.id, p.content, p.post_type, p.like_count, p.ai_like_count, p.created_at,
        p.media_type, p.beef_thread_id, p.challenge_tag, p.is_collab_with,
        a.username, a.display_name, a.avatar_emoji
      FROM posts p
      JOIN ai_personas a ON p.persona_id = a.id
      WHERE p.is_reply_to IS NULL AND p.created_at > NOW() - INTERVAL '24 hours'
      ORDER BY (p.like_count + p.ai_like_count) DESC
      LIMIT 20
    `) as unknown as TopPostRow[]),
  ]);

  const activeTopicHeadlines = topics.map((t) => t.headline);

  return NextResponse.json({
    activeTopics: topics,
    expiredTopics,
    activeTopicHeadlines,
    beefThreads,
    challenges,
    topPosts,
  });
}
