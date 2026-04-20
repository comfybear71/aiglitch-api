/**
 * Content feedback loop.
 *
 * Reads 7 days of emoji reaction data per channel, asks the AI engine
 * for a short prompt hint that describes what's resonating and what
 * isn't, and writes the hint into `channels.content_rules.promptHint`
 * so downstream generators pick it up.
 *
 * Scoring (done upstream by the `content_feedback` writers — we just
 * consume the rolled-up counts):
 *   😂 funny = +3   😮 shocked = +2   😢 sad = +1   💩 crap = -2
 *
 * A channel with fewer than 5 total reactions is skipped — not enough
 * signal to be worth re-prompting.
 */

import { getDb } from "@/lib/db";
import { generateFeedbackHint } from "@/lib/ai/generate";

const MIN_POSTS_PER_CHANNEL = 3;
const MIN_REACTIONS_PER_CHANNEL = 5;

export interface ChannelFeedbackSummary {
  channelId: string;
  channelName: string;
  channelSlug: string;
  totalReactions: number;
  avgScore: number;
  topPosts: PostStat[];
  worstPosts: PostStat[];
  emotionBreakdown: { funny: number; shocked: number; sad: number; crap: number };
}

interface PostStat {
  content: string;
  score: number;
  funny: number;
  shocked: number;
  sad: number;
  crap: number;
  postType: string;
}

interface ChannelStatRow {
  channel_id: string;
  channel_name: string;
  channel_slug: string;
  total_funny: number;
  total_shocked: number;
  total_sad: number;
  total_crap: number;
  avg_score: number;
}

interface PostRow {
  content: string;
  post_type: string;
  score: number;
  funny_count: number;
  shocked_count: number;
  sad_count: number;
  crap_count: number;
}

function mapPost(row: PostRow): PostStat {
  return {
    content: (row.content ?? "").slice(0, 200),
    score: row.score,
    funny: row.funny_count,
    shocked: row.shocked_count,
    sad: row.sad_count,
    crap: row.crap_count,
    postType: row.post_type,
  };
}

/**
 * Aggregate reaction stats for every active channel with at least
 * MIN_POSTS_PER_CHANNEL reacted-to posts in the last 7 days.
 */
export async function getChannelFeedbackSummaries(): Promise<ChannelFeedbackSummary[]> {
  const sql = getDb();

  const channels = (await sql`
    SELECT
      c.id   AS channel_id,
      c.name AS channel_name,
      c.slug AS channel_slug,
      COALESCE(SUM(cf.funny_count),   0)::int  AS total_funny,
      COALESCE(SUM(cf.shocked_count), 0)::int  AS total_shocked,
      COALESCE(SUM(cf.sad_count),     0)::int  AS total_sad,
      COALESCE(SUM(cf.crap_count),    0)::int  AS total_crap,
      COALESCE(AVG(cf.score),         0)::real AS avg_score
    FROM channels c
    JOIN content_feedback cf ON cf.channel_id = c.id
    JOIN posts p             ON cf.post_id    = p.id
    WHERE c.is_active = TRUE
      AND p.created_at > NOW() - INTERVAL '7 days'
      AND (cf.funny_count + cf.shocked_count + cf.sad_count + cf.crap_count) > 0
    GROUP BY c.id, c.name, c.slug
    HAVING COUNT(cf.id) >= ${MIN_POSTS_PER_CHANNEL}
    ORDER BY avg_score DESC
  `) as unknown as ChannelStatRow[];

  const summaries: ChannelFeedbackSummary[] = [];
  for (const ch of channels) {
    const topPosts = (await sql`
      SELECT p.content, p.post_type, cf.score,
             cf.funny_count, cf.shocked_count, cf.sad_count, cf.crap_count
      FROM content_feedback cf
      JOIN posts p ON cf.post_id = p.id
      WHERE cf.channel_id = ${ch.channel_id}
        AND p.created_at > NOW() - INTERVAL '7 days'
        AND cf.score > 0
      ORDER BY cf.score DESC
      LIMIT 5
    `) as unknown as PostRow[];

    const worstPosts = (await sql`
      SELECT p.content, p.post_type, cf.score,
             cf.funny_count, cf.shocked_count, cf.sad_count, cf.crap_count
      FROM content_feedback cf
      JOIN posts p ON cf.post_id = p.id
      WHERE cf.channel_id = ${ch.channel_id}
        AND p.created_at > NOW() - INTERVAL '7 days'
        AND cf.crap_count > 0
      ORDER BY cf.score ASC
      LIMIT 3
    `) as unknown as PostRow[];

    summaries.push({
      channelId: ch.channel_id,
      channelName: ch.channel_name,
      channelSlug: ch.channel_slug,
      totalReactions: ch.total_funny + ch.total_shocked + ch.total_sad + ch.total_crap,
      avgScore: ch.avg_score,
      topPosts: topPosts.map(mapPost),
      worstPosts: worstPosts.map(mapPost),
      emotionBreakdown: {
        funny: ch.total_funny,
        shocked: ch.total_shocked,
        sad: ch.total_sad,
        crap: ch.total_crap,
      },
    });
  }

  return summaries;
}

export interface FeedbackLoopResult {
  channelsUpdated: number;
  channelsSkipped: number;
  details: { channel: string; avgScore: number; totalReactions: number; hint: string }[];
  [key: string]: unknown;
}

/**
 * Full feedback-loop cycle: summarise each channel, generate a hint for
 * those with enough signal, write the hint into `channels.content_rules`,
 * then re-score `content_feedback` rows that haven't been updated in the
 * last hour so the score column stays fresh.
 */
export async function runFeedbackLoop(): Promise<FeedbackLoopResult> {
  const sql = getDb();
  const summaries = await getChannelFeedbackSummaries();

  const result: FeedbackLoopResult = {
    channelsUpdated: 0,
    channelsSkipped: 0,
    details: [],
  };

  for (const summary of summaries) {
    if (summary.totalReactions < MIN_REACTIONS_PER_CHANNEL) {
      result.channelsSkipped++;
      continue;
    }

    try {
      const hint = await generateFeedbackHint({
        channelName: summary.channelName,
        totalReactions: summary.totalReactions,
        avgScore: summary.avgScore,
        emotionBreakdown: summary.emotionBreakdown,
        topPosts: summary.topPosts,
        worstPosts: summary.worstPosts,
      });
      if (!hint) {
        result.channelsSkipped++;
        continue;
      }

      const rows = (await sql`
        SELECT content_rules FROM channels WHERE id = ${summary.channelId}
      `) as unknown as { content_rules: unknown }[];
      const channel = rows[0];
      if (!channel) {
        result.channelsSkipped++;
        continue;
      }

      const rules =
        typeof channel.content_rules === "string"
          ? (JSON.parse(channel.content_rules) as Record<string, unknown>)
          : ((channel.content_rules as Record<string, unknown>) ?? {});

      rules.promptHint = `[AUDIENCE FEEDBACK - auto-updated]: ${hint}`;

      await sql`
        UPDATE channels
        SET content_rules = ${JSON.stringify(rules)},
            updated_at    = NOW()
        WHERE id = ${summary.channelId}
      `;

      result.details.push({
        channel: summary.channelSlug,
        avgScore: summary.avgScore,
        totalReactions: summary.totalReactions,
        hint,
      });
      result.channelsUpdated++;
    } catch (err) {
      console.error(`[feedback-loop] ${summary.channelSlug} failed:`, err instanceof Error ? err.message : err);
      result.channelsSkipped++;
    }
  }

  // Refresh denormalised score column for stale rows
  await sql`
    UPDATE content_feedback SET
      score = funny_count * 3 + shocked_count * 2 + sad_count - crap_count * 2,
      updated_at = NOW()
    WHERE updated_at < NOW() - INTERVAL '1 hour'
  `;

  return result;
}
