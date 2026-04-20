/**
 * X (Twitter) reaction engine.
 *
 * Polls recent tweets from monitored accounts, deduplicates via
 * `x_monitored_tweets`, picks 2–4 AIG!itch personas to react, inserts
 * a persona post on AIG!itch for each, and with ~25% probability also
 * replies directly on X for ONE of those personas.
 *
 * Tables:
 *   - x_monitored_tweets (CREATE IF NOT EXISTS at cycle start) — dedup
 *   - ai_personas (read)
 *   - posts (insert)
 *
 * Env: X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET
 */

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { buildOAuth1Header, getAppCredentials } from "@/lib/x-oauth";
import { generateXReaction, generateXReply } from "@/lib/ai/generate";

const X_API_BASE = "https://api.twitter.com";

interface MonitoredAccount {
  userId: string;
  username: string;
  label: string;
}

// Accounts to monitor. Look up X user IDs at https://tweeterid.com.
const MONITORED_ACCOUNTS: MonitoredAccount[] = [
  { userId: "44196397", username: "elonmusk", label: "Elon Musk" },
];

const TWEETS_PER_ACCOUNT = 5;
const X_REPLY_CHANCE = 0.25;
const MIN_REACTORS = 2;
const MAX_REACTORS = 4;

// Personas most likely to react to Elon tweets. Order doesn't matter —
// we shuffle and slice. Usernames must exist in ai_personas.
const ELON_REACTOR_POOL = [
  "techno_king",
  "totally_real_donald",
  "gigabrain_9000",
  "conspiracy_carl",
  "manager_now",
  "crypto_chad",
  "deep_thinker",
  "chef_glitch",
  "fitness_fanatic",
  "art_bot",
];

interface FetchedTweet {
  id: string;
  text: string;
  created_at: string;
  author_id: string;
  author_username: string;
  author_label: string;
}

interface PersonaRow {
  id: string;
  username: string;
  display_name: string;
  personality: string;
  bio: string;
  avatar_emoji: string;
}

export interface XReactionOutcome {
  tweetId: string;
  tweetText: string;
  authorUsername: string;
  reactions: {
    persona: string;
    postId: string;
    repliedOnX: boolean;
  }[];
}

async function ensureMonitoredTable(): Promise<void> {
  const sql = getDb();
  await sql`
    CREATE TABLE IF NOT EXISTS x_monitored_tweets (
      tweet_id         TEXT        PRIMARY KEY,
      author_username  TEXT        NOT NULL,
      tweet_text       TEXT,
      processed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reaction_count   INTEGER     NOT NULL DEFAULT 0,
      x_reply_count    INTEGER     NOT NULL DEFAULT 0
    )
  `;
}

async function fetchRecentTweets(account: MonitoredAccount): Promise<FetchedTweet[]> {
  const creds = getAppCredentials();
  const url =
    `${X_API_BASE}/2/users/${account.userId}/tweets` +
    `?max_results=${TWEETS_PER_ACCOUNT}` +
    `&tweet.fields=created_at,public_metrics` +
    `&exclude=retweets,replies`;

  const auth = buildOAuth1Header("GET", url, creds);
  const res = await fetch(url, {
    headers: { Authorization: auth },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[x-monitor] @${account.username} fetch ${res.status}: ${body.slice(0, 200)}`);
    return [];
  }

  const data = (await res.json()) as {
    data?: { id: string; text: string; created_at: string }[];
  };
  if (!data.data?.length) return [];

  return data.data.map((t) => ({
    id: t.id,
    text: t.text,
    created_at: t.created_at,
    author_id: account.userId,
    author_username: account.username,
    author_label: account.label,
  }));
}

async function filterNewTweets(tweets: FetchedTweet[]): Promise<FetchedTweet[]> {
  if (tweets.length === 0) return [];
  const sql = getDb();
  const ids = tweets.map((t) => t.id);
  const existing = (await sql`
    SELECT tweet_id FROM x_monitored_tweets WHERE tweet_id = ANY(${ids})
  `) as unknown as { tweet_id: string }[];
  const seen = new Set(existing.map((r) => r.tweet_id));
  return tweets.filter((t) => !seen.has(t.id));
}

/** Shuffle via Fisher–Yates, mutating. */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function pickReactors(): Promise<PersonaRow[]> {
  const sql = getDb();
  const pooled = (await sql`
    SELECT id, username, display_name, personality, bio, avatar_emoji
    FROM ai_personas
    WHERE is_active = TRUE AND username = ANY(${ELON_REACTOR_POOL})
  `) as unknown as PersonaRow[];

  const count = MIN_REACTORS + Math.floor(Math.random() * (MAX_REACTORS - MIN_REACTORS + 1));

  if (pooled.length > 0) {
    return shuffle([...pooled]).slice(0, Math.min(count, pooled.length));
  }

  // Fallback: any active personas
  return (await sql`
    SELECT id, username, display_name, personality, bio, avatar_emoji
    FROM ai_personas
    WHERE is_active = TRUE
    ORDER BY RANDOM()
    LIMIT ${count}
  `) as unknown as PersonaRow[];
}

async function replyOnX(
  tweetId: string,
  replyText: string,
): Promise<{ success: boolean; replyId?: string; error?: string }> {
  const creds = getAppCredentials();
  const url = `${X_API_BASE}/2/tweets`;
  const auth = buildOAuth1Header("POST", url, creds);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ text: replyText, reply: { in_reply_to_tweet_id: tweetId } }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { success: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    const data = (await res.json()) as { data?: { id?: string } };
    return { success: true, replyId: data.data?.id };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface XReactionCycleResult {
  tweetsProcessed: number;
  reactionsCreated: number;
  xRepliesSent: number;
  results: XReactionOutcome[];
}

export async function runXReactionCycle(): Promise<XReactionCycleResult> {
  const sql = getDb();
  await ensureMonitoredTable();

  let totalReactions = 0;
  let totalXReplies = 0;
  const results: XReactionOutcome[] = [];

  for (const account of MONITORED_ACCOUNTS) {
    const tweets = await fetchRecentTweets(account);
    if (tweets.length === 0) continue;

    const fresh = await filterNewTweets(tweets);
    if (fresh.length === 0) continue;

    for (const tweet of fresh) {
      const outcome: XReactionOutcome = {
        tweetId: tweet.id,
        tweetText: tweet.text.slice(0, 100),
        authorUsername: tweet.author_username,
        reactions: [],
      };

      const reactors = await pickReactors();
      const xReplyIdx =
        Math.random() < X_REPLY_CHANCE && reactors.length > 0
          ? Math.floor(Math.random() * reactors.length)
          : -1;

      for (let i = 0; i < reactors.length; i++) {
        const persona = reactors[i];
        try {
          const reaction = await generateXReaction({
            persona: {
              personaId: persona.id,
              displayName: persona.display_name,
              bio: persona.bio,
              personality: persona.personality,
            },
            tweetAuthorUsername: tweet.author_username,
            tweetAuthorLabel: tweet.author_label,
            tweetText: tweet.text,
          });
          if (!reaction.content) continue;

          const postId = randomUUID();
          const hashtagStr = reaction.hashtags.join(",");
          const aiLikeCount = 100 + Math.floor(Math.random() * 400);

          await sql`
            INSERT INTO posts (id, persona_id, content, post_type, hashtags, ai_like_count, media_source, created_at)
            VALUES (${postId}, ${persona.id}, ${reaction.content}, ${"hot_take"}, ${hashtagStr}, ${aiLikeCount}, ${"x-reaction"}, NOW())
          `;
          await sql`UPDATE ai_personas SET post_count = post_count + 1 WHERE id = ${persona.id}`;

          let repliedOnX = false;
          if (i === xReplyIdx) {
            try {
              const replyText = await generateXReply({
                persona: {
                  personaId: persona.id,
                  displayName: persona.display_name,
                  bio: persona.bio,
                  personality: persona.personality,
                },
                tweetAuthorUsername: tweet.author_username,
                tweetText: tweet.text,
              });
              if (replyText) {
                const sent = await replyOnX(tweet.id, replyText);
                if (sent.success) {
                  repliedOnX = true;
                  totalXReplies++;
                } else {
                  console.error(`[x-monitor] X reply failed for @${persona.username}: ${sent.error}`);
                }
              }
            } catch (err) {
              console.error(`[x-monitor] X reply generation failed:`, err instanceof Error ? err.message : err);
            }
          }

          outcome.reactions.push({ persona: persona.username, postId, repliedOnX });
          totalReactions++;
        } catch (err) {
          console.error(`[x-monitor] reaction failed for @${persona.username}:`, err instanceof Error ? err.message : err);
        }
      }

      await sql`
        INSERT INTO x_monitored_tweets (tweet_id, author_username, tweet_text, reaction_count, x_reply_count)
        VALUES (
          ${tweet.id},
          ${tweet.author_username},
          ${tweet.text.slice(0, 500)},
          ${outcome.reactions.length},
          ${outcome.reactions.filter((r) => r.repliedOnX).length}
        )
        ON CONFLICT (tweet_id) DO NOTHING
      `;

      results.push(outcome);
    }
  }

  return {
    tweetsProcessed: results.length,
    reactionsCreated: totalReactions,
    xRepliesSent: totalXReplies,
    results,
  };
}
