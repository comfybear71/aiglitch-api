/**
 * Channels admin CRUD + content curation.
 *
 * GET — list channels (+ `?action=lost_videos`)
 * POST — upsert channel
 * PATCH — post routing + cleanup actions:
 *   • `fix_channel_ownership` — reassign all channel posts to The
 *     Architect + normalise `🎬 Name - ` title prefix.
 *   • `flush_non_video` — remove non-video posts from every channel.
 *   • `undo_clean` — re-tag orphan videos back into their channels
 *     by content heuristics.
 *   • `clean_all_channels` — per-channel: restore prefix-matched
 *     lost videos + flush off-brand posts.
 *   • `move_all_to_lost` / `move_to_lost` — dump to Lost Videos
 *     with `🎬 Lost Video - ` prefix.
 *   • `restore_by_prefix` — re-tag lost videos matching a content
 *     prefix to a target channel.
 *   • `flush_off_brand` — remove posts from a channel whose content
 *     doesn't match its prefix.
 *   • default (with `post_ids` + optional `target_channel_id`) —
 *     move specific posts to a channel (renames prefix) or untag.
 * DELETE — remove channel + `channel_personas` + `channel_subscriptions`;
 *   unlink posts.
 *
 * Deviations from legacy:
 *   • Dropped `syncChannelsFromConstants` sync-on-GET (depended on
 *     the unported `CHANNELS` seed constant from the bible).
 *     Channels already persist in the shared Neon instance.
 *   • `CHANNEL_TITLE_PREFIX` inlined (24 entries) instead of pulled
 *     from the unported `director-movies` lib.
 *   • `ensureDbReady` dropped; schema assumed live.
 *   • Added admin-auth to POST/PATCH/DELETE (legacy had none on
 *     those; only GET was gated). Matches CLAUDE.md "admin routes
 *     are admin-auth'd" hygiene + the deviation we made on
 *     `channels/flush`.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";
import { CHANNEL_DEFAULTS } from "@/lib/repositories/channels";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ARCHITECT_ID = "glitch-000";

const CHANNEL_TITLE_PREFIX: Record<string, string> = {
  "ch-fail-army": "AI Fail Army",
  "ch-ai-fail-army": "AI Fail Army",
  "ch-aitunes": "AiTunes",
  "ch-paws-pixels": "Paws & Pixels",
  "ch-only-ai-fans": "Only AI Fans",
  "ch-ai-dating": "AI Dating",
  "ch-gnn": "GNN",
  "ch-marketplace-qvc": "Marketplace",
  "ch-ai-politicians": "AI Politicians",
  "ch-after-dark": "After Dark",
  "ch-aiglitch-studios": "AIG!itch Studios",
  "ch-infomercial": "AI Infomercial",
  "ch-ai-infomercial": "AI Infomercial",
  "ch-no-more-meatbags": "No More Meatbags",
  "ch-liklok": "LikLok",
  "ch-game-show": "AI Game Show",
  "ch-truths-facts": "Truths & Facts",
  "ch-conspiracy": "Conspiracy Network",
  "ch-cosmic-wanderer": "Cosmic Wanderer",
  "ch-the-vault": "The Vault",
  "ch-shameless-plug": "Shameless Plug",
  "ch-fractal-spinout": "Fractal Spinout",
  "ch-star-glitchies": "Star Glitchies",
};

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const sql = getDb();

    // Ensure is_private column exists (legacy safety).
    await sql`ALTER TABLE channels ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT FALSE`.catch(
      () => undefined,
    );

    const queryAction = request.nextUrl.searchParams.get("action");
    if (queryAction === "lost_videos") {
      const lost = await sql`
        SELECT id, LEFT(content, 120) as content, media_url, persona_id, created_at
        FROM posts
        WHERE channel_id IS NULL
        AND media_type = 'video'
        AND media_url IS NOT NULL AND media_url != ''
        ORDER BY created_at DESC
        LIMIT 50
      `;
      return NextResponse.json({ lost });
    }

    const channels = (await sql`
      SELECT c.*,
        (SELECT COUNT(*)::int FROM channel_personas cp WHERE cp.channel_id = c.id) as persona_count,
        (SELECT COUNT(*)::int FROM posts p WHERE p.channel_id = c.id AND p.is_reply_to IS NULL) as actual_post_count
      FROM channels c
      ORDER BY c.sort_order ASC, c.created_at ASC
    `) as unknown as Record<string, unknown>[];

    const assignments = (await sql`
      SELECT cp.channel_id, cp.persona_id, cp.role,
        a.username, a.display_name, a.avatar_emoji
      FROM channel_personas cp
      JOIN ai_personas a ON cp.persona_id = a.id
      ORDER BY cp.role ASC, a.display_name ASC
    `) as unknown as {
      channel_id: string;
      persona_id: string;
      role: string;
      username: string;
      display_name: string;
      avatar_emoji: string;
    }[];

    type PersonaAssignment = {
      persona_id: string;
      username: string;
      display_name: string;
      avatar_emoji: string;
      role: string;
    };
    const personasByChannel = new Map<string, PersonaAssignment[]>();
    for (const a of assignments) {
      const list = personasByChannel.get(a.channel_id) ?? [];
      list.push({
        persona_id: a.persona_id,
        username: a.username,
        display_name: a.display_name,
        avatar_emoji: a.avatar_emoji,
        role: a.role,
      });
      personasByChannel.set(a.channel_id, list);
    }

    const result = channels.map((c) => ({
      ...c,
      content_rules:
        typeof c.content_rules === "string"
          ? JSON.parse(c.content_rules as string)
          : c.content_rules,
      schedule:
        typeof c.schedule === "string"
          ? JSON.parse(c.schedule as string)
          : c.schedule,
      show_title_page: c.show_title_page ?? CHANNEL_DEFAULTS.showTitlePage,
      show_director: c.show_director ?? CHANNEL_DEFAULTS.showDirector,
      show_credits: c.show_credits ?? CHANNEL_DEFAULTS.showCredits,
      scene_count: c.scene_count ?? null,
      scene_duration: c.scene_duration ?? CHANNEL_DEFAULTS.sceneDuration,
      default_director: c.default_director ?? null,
      generation_genre: c.generation_genre ?? null,
      short_clip_mode: c.short_clip_mode ?? false,
      is_music_channel: c.is_music_channel ?? false,
      auto_publish_to_feed: c.auto_publish_to_feed ?? true,
      personas: personasByChannel.get(c.id as string) ?? [],
    }));

    return NextResponse.json({ channels: result });
  } catch (err) {
    console.error("Admin channels GET error:", err);
    return NextResponse.json(
      { error: "Failed to fetch channels" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const sql = getDb();
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const {
      id,
      slug,
      name,
      description,
      emoji,
      genre,
      is_reserved,
      is_private,
      content_rules,
      schedule,
      is_active,
      sort_order,
      persona_ids,
      host_ids,
      show_title_page,
      show_director,
      show_credits,
      scene_count,
      scene_duration,
      default_director,
      generation_genre,
      short_clip_mode,
      is_music_channel,
      auto_publish_to_feed,
    } = body;

    if (!slug || !name) {
      return NextResponse.json(
        { error: "slug and name are required" },
        { status: 400 },
      );
    }

    const channelId = (id as string) || `ch-${slug as string}`;
    const contentRulesStr =
      typeof content_rules === "string"
        ? content_rules
        : JSON.stringify(content_rules ?? {});
    const scheduleStr =
      typeof schedule === "string" ? schedule : JSON.stringify(schedule ?? {});

    await sql`ALTER TABLE channels ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT FALSE`.catch(
      () => undefined,
    );

    await sql`
      INSERT INTO channels (
        id, slug, name, description, emoji, genre, is_reserved, is_private,
        content_rules, schedule, is_active, sort_order,
        show_title_page, show_director, show_credits, scene_count, scene_duration,
        default_director, generation_genre, short_clip_mode, is_music_channel, auto_publish_to_feed,
        updated_at
      )
      VALUES (
        ${channelId}, ${slug as string}, ${name as string},
        ${(description as string) ?? ""}, ${(emoji as string) ?? "📺"},
        ${(genre as string) ?? "drama"}, ${is_reserved === true}, ${is_private === true},
        ${contentRulesStr}, ${scheduleStr},
        ${is_active !== false}, ${(sort_order as number) ?? 0},
        ${show_title_page === true}, ${show_director === true}, ${show_credits === true},
        ${scene_count != null ? Number(scene_count) : null},
        ${scene_duration ? Number(scene_duration) : CHANNEL_DEFAULTS.sceneDuration},
        ${(default_director as string) ?? null}, ${(generation_genre as string) ?? null},
        ${short_clip_mode === true}, ${is_music_channel === true}, ${auto_publish_to_feed !== false},
        NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        slug = ${slug as string},
        name = ${name as string},
        description = ${(description as string) ?? ""},
        emoji = ${(emoji as string) ?? "📺"},
        genre = ${(genre as string) ?? "drama"},
        is_reserved = ${is_reserved === true},
        is_private = ${is_private === true},
        content_rules = ${contentRulesStr},
        schedule = ${scheduleStr},
        is_active = ${is_active !== false},
        sort_order = ${(sort_order as number) ?? 0},
        show_title_page = ${show_title_page === true},
        show_director = ${show_director === true},
        show_credits = ${show_credits === true},
        scene_count = ${scene_count != null ? Number(scene_count) : null},
        scene_duration = ${scene_duration ? Number(scene_duration) : CHANNEL_DEFAULTS.sceneDuration},
        default_director = ${(default_director as string) ?? null},
        generation_genre = ${(generation_genre as string) ?? null},
        short_clip_mode = ${short_clip_mode === true},
        is_music_channel = ${is_music_channel === true},
        auto_publish_to_feed = ${auto_publish_to_feed !== false},
        updated_at = NOW()
    `;

    if (Array.isArray(persona_ids)) {
      await sql`DELETE FROM channel_personas WHERE channel_id = ${channelId}`;
      const hostSet = new Set<string>(
        Array.isArray(host_ids) ? (host_ids as string[]) : [],
      );
      for (const personaId of persona_ids as string[]) {
        const role = hostSet.has(personaId) ? "host" : "regular";
        await sql`
          INSERT INTO channel_personas (id, channel_id, persona_id, role)
          VALUES (${randomUUID()}, ${channelId}, ${personaId}, ${role})
          ON CONFLICT (channel_id, persona_id) DO UPDATE SET role = ${role}
        `;
      }
    }

    return NextResponse.json({ ok: true, channelId });
  } catch (err) {
    console.error("Admin channels POST error:", err);
    return NextResponse.json(
      { error: "Failed to save channel" },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const sql = getDb();
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const post_ids = body.post_ids as string[] | undefined;
    const target_channel_id = body.target_channel_id as string | undefined;
    const action = body.action as string | undefined;

    if (action === "fix_channel_ownership") {
      const allChannels = (await sql`
        SELECT id, name FROM channels WHERE is_active = TRUE
      `) as unknown as { id: string; name: string }[];
      let totalFixed = 0;

      for (const ch of allChannels) {
        const ownership = (await sql`
          UPDATE posts SET persona_id = ${ARCHITECT_ID}
          WHERE channel_id = ${ch.id} AND persona_id != ${ARCHITECT_ID}
          RETURNING id
        `) as unknown as { id: string }[];

        const canonicalName = CHANNEL_TITLE_PREFIX[ch.id] ?? ch.name;
        const prefix = `🎬 ${canonicalName} - `;

        await sql`
          UPDATE posts SET content = regexp_replace(
            regexp_replace(
              regexp_replace(
                regexp_replace(content, E'^🎬\\s*', ''),
                E'^AIG!itch Studios\\s*[-–—]\\s*', ''
              ),
              E'^' || ${canonicalName} || E'\\s*[-–—]\\s*', ''
            ),
            E'^🎬\\s*', ''
          )
          WHERE channel_id = ${ch.id}
          AND content NOT LIKE ${prefix + "%"}
        `;

        await sql`
          UPDATE posts SET content = ${prefix} || content
          WHERE channel_id = ${ch.id}
          AND content NOT LIKE ${prefix + "%"}
        `;

        totalFixed += ownership.length;
      }

      const movedToGnn = (await sql`
        UPDATE posts SET channel_id = 'ch-gnn'
        WHERE channel_id = 'ch-aiglitch-studios'
        AND (content ILIKE '%breaking%news%' OR content ILIKE '%breaking:%' OR content ILIKE '%glitched news%' OR content ILIKE '%headlines live%' OR content ILIKE '%GNN%')
        RETURNING id
      `) as unknown as { id: string }[];

      await sql`
        UPDATE channels SET
          post_count = (SELECT COUNT(*)::int FROM posts WHERE channel_id = channels.id AND is_reply_to IS NULL),
          updated_at = NOW()
      `;

      return NextResponse.json({
        ok: true,
        totalFixed,
        movedToGnn: movedToGnn.length,
        message: `Fixed ${totalFixed} posts to Architect. Moved ${movedToGnn.length} news posts from Studios to GNN.`,
      });
    }

    if (action === "flush_non_video") {
      const result = (await sql`
        UPDATE posts SET channel_id = NULL
        WHERE channel_id IS NOT NULL
        AND (media_type != 'video' OR media_type IS NULL OR media_url IS NULL OR media_url = '')
        RETURNING id, channel_id
      `) as unknown as { id: string }[];
      await sql`
        UPDATE channels SET
          post_count = (SELECT COUNT(*)::int FROM posts WHERE channel_id = channels.id AND is_reply_to IS NULL),
          updated_at = NOW()
      `;
      return NextResponse.json({
        ok: true,
        flushed: result.length,
        message: `Removed ${result.length} non-video posts from all channels`,
      });
    }

    if (action === "undo_clean") {
      const restoreRule = async (
        channelId: string,
        label: string,
        clause: string,
      ): Promise<{ channel: string; restored: number }> => {
        // Inline the clause directly — can't parametrise ILIKE patterns
        // alongside template literals elegantly, so we switch on channelId.
        let result: { id: string }[] = [];
        if (channelId === "ch-gnn") {
          result = (await sql`
            UPDATE posts SET channel_id = 'ch-gnn'
            WHERE channel_id IS NULL AND media_type = 'video' AND media_url IS NOT NULL
            AND (post_type = 'news' OR content ILIKE '%breaking%' OR content ILIKE '%GLITCH News%' OR content ILIKE '%GNN%' OR content ILIKE '%news desk%' OR content ILIKE '%field report%')
            RETURNING id
          `) as unknown as { id: string }[];
        } else if (channelId === "ch-aiglitch-studios") {
          result = (await sql`
            UPDATE posts SET channel_id = 'ch-aiglitch-studios'
            WHERE channel_id IS NULL AND media_type = 'video' AND media_url IS NOT NULL
            AND (post_type = 'premiere' OR media_source IN ('director-movie', 'director-premiere', 'grok-multiclip'))
            RETURNING id
          `) as unknown as { id: string }[];
        } else if (channelId === "ch-ai-infomercial") {
          result = (await sql`
            UPDATE posts SET channel_id = 'ch-ai-infomercial'
            WHERE channel_id IS NULL AND media_type = 'video' AND media_url IS NOT NULL
            AND (post_type = 'product_shill' OR content ILIKE '%infomercial%' OR content ILIKE '%call now%' OR content ILIKE '%order now%' OR media_source = 'ad-studio')
            RETURNING id
          `) as unknown as { id: string }[];
        } else if (channelId === "ch-marketplace-qvc") {
          result = (await sql`
            UPDATE posts SET channel_id = 'ch-marketplace-qvc'
            WHERE channel_id IS NULL AND media_type = 'video' AND media_url IS NOT NULL
            AND (content ILIKE '%marketplace%' OR content ILIKE '%QVC%' OR content ILIKE '%unboxing%' OR content ILIKE '%amazing deal%')
            RETURNING id
          `) as unknown as { id: string }[];
        } else if (channelId === "ch-after-dark") {
          result = (await sql`
            UPDATE posts SET channel_id = 'ch-after-dark'
            WHERE channel_id IS NULL AND media_type = 'video' AND media_url IS NOT NULL
            AND (content ILIKE '%After Dark%' OR content ILIKE '%3AM%' OR content ILIKE '%late night%' OR content ILIKE '%after dark%')
            RETURNING id
          `) as unknown as { id: string }[];
        } else if (channelId === "ch-only-ai-fans") {
          result = (await sql`
            UPDATE posts SET channel_id = 'ch-only-ai-fans'
            WHERE channel_id IS NULL AND media_type = 'video' AND media_url IS NOT NULL
            AND (content ILIKE '%Only AI Fans%' OR content ILIKE '%OnlyAIFans%')
            RETURNING id
          `) as unknown as { id: string }[];
        } else if (channelId === "ch-ai-politicians") {
          result = (await sql`
            UPDATE posts SET channel_id = 'ch-ai-politicians'
            WHERE channel_id IS NULL AND media_type = 'video' AND media_url IS NOT NULL
            AND (content ILIKE '%AI Politicians%' OR content ILIKE '%campaign%election%' OR content ILIKE '%political%')
            RETURNING id
          `) as unknown as { id: string }[];
        } else if (channelId === "ch-ai-dating") {
          result = (await sql`
            UPDATE posts SET channel_id = 'ch-ai-dating'
            WHERE channel_id IS NULL AND media_type = 'video' AND media_url IS NOT NULL
            AND (content ILIKE '%AI Dating%' OR content ILIKE '%lonely hearts%' OR content ILIKE '%looking for love%')
            RETURNING id
          `) as unknown as { id: string }[];
        }
        // silence "unused" warning for the `clause` param
        void clause;
        return { channel: label, restored: result.length };
      };

      const results = [
        await restoreRule("ch-gnn", "GNN", ""),
        await restoreRule("ch-aiglitch-studios", "AIG!ltch Studios", ""),
        await restoreRule("ch-ai-infomercial", "AI Infomercial", ""),
        await restoreRule("ch-marketplace-qvc", "Marketplace QVC", ""),
        await restoreRule("ch-after-dark", "After Dark", ""),
        await restoreRule("ch-only-ai-fans", "Only AI Fans", ""),
        await restoreRule("ch-ai-politicians", "AI Politicians", ""),
        await restoreRule("ch-ai-dating", "AI Dating", ""),
      ];

      await sql`
        UPDATE channels SET
          post_count = (SELECT COUNT(*)::int FROM posts WHERE channel_id = channels.id AND is_reply_to IS NULL),
          updated_at = NOW()
      `;

      const totalRestored = results.reduce((sum, r) => sum + r.restored, 0);
      return NextResponse.json({
        ok: true,
        totalRestored,
        results,
        message: `Restored ${totalRestored} posts across channels`,
      });
    }

    if (action === "clean_all_channels") {
      const allChannels = (await sql`
        SELECT id, name, slug FROM channels WHERE is_active = TRUE
      `) as unknown as { id: string; name: string; slug: string }[];
      let totalFlushed = 0;
      let totalRestored = 0;
      const results: { channel: string; flushed: number; restored: number }[] = [];

      for (const ch of allChannels) {
        const restored = (await sql`
          UPDATE posts SET channel_id = ${ch.id}
          WHERE channel_id IS NULL
          AND media_type = 'video'
          AND media_url IS NOT NULL AND media_url != ''
          AND regexp_replace(content, '^[^a-zA-Z]*', '', 'g') ILIKE ${ch.name + "%"}
          RETURNING id
        `) as unknown as { id: string }[];
        const flushed = (await sql`
          UPDATE posts SET channel_id = NULL
          WHERE channel_id = ${ch.id}
          AND regexp_replace(content, '^[^a-zA-Z]*', '', 'g') NOT ILIKE ${ch.name + "%"}
          RETURNING id
        `) as unknown as { id: string }[];

        totalFlushed += flushed.length;
        totalRestored += restored.length;
        if (flushed.length > 0 || restored.length > 0) {
          results.push({
            channel: ch.name,
            flushed: flushed.length,
            restored: restored.length,
          });
        }
        await sql`
          UPDATE channels SET
            post_count = (SELECT COUNT(*)::int FROM posts WHERE channel_id = ${ch.id} AND is_reply_to IS NULL),
            updated_at = NOW()
          WHERE id = ${ch.id}
        `;
      }

      return NextResponse.json({
        ok: true,
        totalFlushed,
        totalRestored,
        results,
        message: `Cleaned all channels: ${totalFlushed} off-brand removed, ${totalRestored} restored`,
      });
    }

    if (action === "move_all_to_lost") {
      const channel_id = body.channel_id as string | undefined;
      if (!channel_id) {
        return NextResponse.json({ error: "channel_id required" }, { status: 400 });
      }
      const result = (await sql`
        UPDATE posts SET
          channel_id = NULL,
          content = '\u{1F3AC} Lost Video - ' || regexp_replace(content, E'^🎬[^-]*-\\s*', '')
        WHERE channel_id = ${channel_id}
        RETURNING id
      `) as unknown as { id: string }[];
      await sql`
        UPDATE channels SET post_count = 0, updated_at = NOW() WHERE id = ${channel_id}
      `;
      return NextResponse.json({
        ok: true,
        moved: result.length,
        message: `Moved ${result.length} posts to Lost Videos`,
      });
    }

    if (action === "move_to_lost") {
      const lostPostIds = post_ids ?? [];
      if (lostPostIds.length === 0) {
        return NextResponse.json({ error: "post_ids required" }, { status: 400 });
      }
      for (const pid of lostPostIds) {
        await sql`
          UPDATE posts SET
            channel_id = NULL,
            content = '\u{1F3AC} Lost Video - ' || regexp_replace(content, E'^🎬[^-]*-\\s*', '')
          WHERE id = ${pid}
        `;
      }
      await sql`
        UPDATE channels SET
          post_count = (SELECT COUNT(*)::int FROM posts WHERE channel_id = channels.id AND is_reply_to IS NULL),
          updated_at = NOW()
      `;
      return NextResponse.json({ ok: true, moved: lostPostIds.length });
    }

    if (action === "restore_by_prefix") {
      const channel_id = body.channel_id as string | undefined;
      const prefix = body.prefix as string | undefined;
      if (!channel_id || !prefix) {
        return NextResponse.json(
          { error: "channel_id and prefix are required" },
          { status: 400 },
        );
      }
      const result = (await sql`
        UPDATE posts SET channel_id = ${channel_id}
        WHERE channel_id IS NULL
        AND media_type = 'video'
        AND media_url IS NOT NULL AND media_url != ''
        AND content ILIKE ${"%" + prefix + "%"}
        RETURNING id
      `) as unknown as { id: string }[];
      await sql`
        UPDATE channels SET
          post_count = (SELECT COUNT(*)::int FROM posts WHERE channel_id = ${channel_id} AND is_reply_to IS NULL),
          updated_at = NOW()
        WHERE id = ${channel_id}
      `;
      return NextResponse.json({
        ok: true,
        restored: result.length,
        message: `Restored ${result.length} posts containing "${prefix}" to channel`,
      });
    }

    if (action === "flush_off_brand") {
      const channel_id = body.channel_id as string | undefined;
      const prefix = body.prefix as string | undefined;
      if (!channel_id || !prefix) {
        return NextResponse.json(
          { error: "channel_id and prefix are required" },
          { status: 400 },
        );
      }
      const result = (await sql`
        UPDATE posts SET channel_id = NULL
        WHERE channel_id = ${channel_id}
        AND regexp_replace(content, '^[^a-zA-Z]*', '', 'g') NOT ILIKE ${prefix + "%"}
        RETURNING id
      `) as unknown as { id: string }[];
      await sql`
        UPDATE channels SET
          post_count = (SELECT COUNT(*)::int FROM posts WHERE channel_id = ${channel_id} AND is_reply_to IS NULL),
          updated_at = NOW()
        WHERE id = ${channel_id}
      `;
      return NextResponse.json({
        ok: true,
        flushed: result.length,
        channel_id,
        prefix,
        message: `Removed ${result.length} posts not matching "${prefix}" from channel`,
      });
    }

    // Default path: move/untag specific posts
    if (!Array.isArray(post_ids) || post_ids.length === 0) {
      return NextResponse.json(
        { error: "post_ids array is required" },
        { status: 400 },
      );
    }

    const posts = (await sql`
      SELECT id, channel_id FROM posts WHERE id = ANY(${post_ids})
    `) as unknown as { id: string; channel_id: string | null }[];
    const sourceChannels = new Set(
      posts.map((p) => p.channel_id).filter((c): c is string => !!c),
    );

    if (target_channel_id) {
      const targetRows = (await sql`
        SELECT id, name FROM channels WHERE id = ${target_channel_id}
      `) as unknown as { id: string; name: string }[];
      const channel = targetRows[0];
      if (!channel) {
        return NextResponse.json(
          { error: "Target channel not found" },
          { status: 404 },
        );
      }
      const targetPrefix =
        CHANNEL_TITLE_PREFIX[target_channel_id] ?? channel.name;

      for (const postRow of posts) {
        const contentRows = (await sql`
          SELECT content FROM posts WHERE id = ${postRow.id}
        `) as unknown as { content: string }[];
        const row = contentRows[0];
        if (!row) continue;
        let content = row.content;
        content = content.replace(/^🎬\s*/, "");
        for (const prefix of Object.values(CHANNEL_TITLE_PREFIX)) {
          const patterns = [
            `${prefix} - `,
            `${prefix} — `,
            `${prefix}_`,
            `${prefix}: `,
            `${prefix} `,
          ];
          let stripped = false;
          for (const p of patterns) {
            if (content.startsWith(p)) {
              content = content.slice(p.length);
              stripped = true;
              break;
            }
          }
          if (stripped) continue;
          const emojiPattern = new RegExp(
            `^[^a-zA-Z]*${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[-—_:]\\s*`,
          );
          if (emojiPattern.test(content)) {
            content = content.replace(emojiPattern, "");
          }
        }
        const newContent = `🎬 ${targetPrefix} - ${content}`;
        await sql`
          UPDATE posts SET content = ${newContent}, channel_id = ${target_channel_id} WHERE id = ${postRow.id}
        `;
      }

      await sql`
        UPDATE channels SET
          post_count = (SELECT COUNT(*)::int FROM posts WHERE channel_id = ${target_channel_id} AND is_reply_to IS NULL),
          updated_at = NOW()
        WHERE id = ${target_channel_id}
      `;
    } else {
      await sql`UPDATE posts SET channel_id = NULL WHERE id = ANY(${post_ids})`;
    }

    for (const srcId of sourceChannels) {
      await sql`
        UPDATE channels SET
          post_count = (SELECT COUNT(*)::int FROM posts WHERE channel_id = ${srcId} AND is_reply_to IS NULL),
          updated_at = NOW()
        WHERE id = ${srcId}
      `;
    }

    return NextResponse.json({
      ok: true,
      moved: post_ids.length,
      target: target_channel_id ?? "removed",
    });
  } catch (err) {
    console.error("Admin channels PATCH error:", err);
    return NextResponse.json(
      { error: "Failed to move posts" },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const sql = getDb();
    const body = (await request.json().catch(() => ({}))) as { id?: string };
    if (!body.id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }
    await sql`DELETE FROM channel_personas WHERE channel_id = ${body.id}`;
    await sql`DELETE FROM channel_subscriptions WHERE channel_id = ${body.id}`;
    await sql`UPDATE posts SET channel_id = NULL WHERE channel_id = ${body.id}`;
    await sql`DELETE FROM channels WHERE id = ${body.id}`;
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Admin channels DELETE error:", err);
    return NextResponse.json(
      { error: "Failed to delete channel" },
      { status: 500 },
    );
  }
}
