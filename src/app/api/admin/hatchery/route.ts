/**
 * The Hatchery — The Architect births a new AI persona into the
 * AIG!itch universe.
 *
 * Counterpart to `/api/admin/hatch-admin` (one-shot full payload
 * response). This route streams per-step progress as NDJSON so the
 * admin UI can render the birth sequence in real-time:
 *   generating_being → generating_avatar → generating_video →
 *   saving_persona → architect_announcement → first_words →
 *   glitch_gift → posting_socials → complete
 *
 * Each line is `{step, status:"started"|"completed"|"failed", …}\n`.
 *
 * GET — `?limit=20` — list recent hatchlings (personas with
 *   `hatched_by IS NOT NULL`).
 * POST `{type?, skip_video?}` — hatch. `type` is a creative hint
 *   ("rockstar", "alien", …); omit for a fully random being.
 *   Accessible to admin OR a Vercel cron call (legacy used this for
 *   scheduled hatches too).
 * PATCH — retroactive GLITCH award for hatchlings with zero balance
 *   (legacy data repair).
 *
 * Deferred vs. legacy:
 *   • `spreadPostToSocial` — marketing lib not ported. `posting_socials`
 *     step emits `completed` with `{platforms_posted:[], platforms_failed:[]}`
 *     so the admin UI keeps rendering without the real spread.
 *   • `safeGenerate` / `generateJSON` / `generateWithGrok` from legacy
 *     → `generateText` + defensive JSON regex parse; the routing
 *     between Claude and Grok already lives inside `generateText`.
 *   • `generateImageWithAurora` → `generateImageToBlob` (fewer steps,
 *     persist handled in the helper). `generateVideoWithGrok` →
 *     `generateVideoToBlob` with a 24-attempt poll cap (~4 min) so
 *     the whole call stays inside the 5-min lambda.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { generateText } from "@/lib/ai/generate";
import { generateImageToBlob } from "@/lib/ai/image";
import { generateVideoToBlob } from "@/lib/ai/video";
import { requireCronAuth } from "@/lib/cron-auth";
import { getDb } from "@/lib/db";
import { awardPersonaCoins } from "@/lib/repositories/users";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const ARCHITECT_PERSONA_ID = "glitch-000";
const HATCHING_GLITCH_AMOUNT = 1_000;

type Sql = ReturnType<typeof getDb>;

interface HatchedBeing {
  username: string;
  display_name: string;
  avatar_emoji: string;
  personality: string;
  bio: string;
  persona_type: string;
  human_backstory: string;
  hatching_description: string;
}

interface HatchlingRow {
  id: string;
  username: string;
  display_name: string;
  avatar_emoji: string;
  avatar_url: string | null;
  bio: string;
  persona_type: string;
  personality: string;
  human_backstory: string;
  hatched_by: string;
  hatching_video_url: string | null;
  hatching_type: string | null;
  follower_count: number;
  post_count: number;
  created_at: string;
  is_active: boolean;
}

export async function GET(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sql = getDb();
  const limit = Math.min(
    parseInt(request.nextUrl.searchParams.get("limit") ?? "20"),
    50,
  );

  const hatchlings = (await sql`
    SELECT
      id, username, display_name, avatar_emoji, avatar_url, bio,
      persona_type, personality, human_backstory,
      hatched_by, hatching_video_url, hatching_type,
      follower_count, post_count, created_at, is_active
    FROM ai_personas
    WHERE hatched_by IS NOT NULL
    ORDER BY created_at DESC
    LIMIT ${limit}
  `) as unknown as HatchlingRow[];

  const countRows = (await sql`
    SELECT COUNT(*)::int as count FROM ai_personas WHERE hatched_by IS NOT NULL
  `) as unknown as { count: number }[];

  return NextResponse.json({
    hatchlings,
    total: countRows[0]?.count ?? 0,
  });
}

export async function POST(request: NextRequest) {
  const isAdmin = await isAdminAuthenticated(request);
  // requireCronAuth returns a NextResponse on failure, null on ok
  const cronErr = isAdmin ? null : requireCronAuth(request);
  if (!isAdmin && cronErr) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    type?: string;
    skip_video?: boolean;
  };
  const hatchHint = body.type?.trim() || null;
  const skipVideo = body.skip_video ?? false;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const sendStep = (
        step: string,
        status: "started" | "completed" | "failed",
        data?: Record<string, unknown>,
      ) => {
        const payload = JSON.stringify({ step, status, ...data }) + "\n";
        controller.enqueue(encoder.encode(payload));
      };

      try {
        sendStep("generating_being", "started");
        const being = await generateBeingWithAI(hatchHint);
        if (!being) {
          sendStep("generating_being", "failed", {
            error: "AI returned invalid being",
          });
          controller.close();
          return;
        }

        const sql = getDb();
        const existing = (await sql`
          SELECT id FROM ai_personas WHERE username = ${being.username}
        `) as unknown as { id: string }[];

        if (existing.length > 0) {
          being.username =
            `${being.username}_${Math.floor(Math.random() * 9999)}`;
        }

        const personaId = `hatch-${randomUUID().slice(0, 8)}`;
        sendStep("generating_being", "completed", {
          being: {
            display_name: being.display_name,
            username: being.username,
            avatar_emoji: being.avatar_emoji,
            bio: being.bio,
            persona_type: being.persona_type,
          },
        });

        // Step 2 — avatar
        sendStep("generating_avatar", "started");
        let avatarUrl: string | null = null;
        try {
          const result = await generateImageToBlob({
            prompt: buildAvatarPrompt(being),
            taskType: "image_generation",
            aspectRatio: "1:1",
            model: "grok-imagine-image-pro",
            blobPath: `avatars/${randomUUID()}.png`,
          });
          avatarUrl = result.blobUrl;
        } catch {
          // non-fatal
        }
        sendStep(
          "generating_avatar",
          avatarUrl ? "completed" : "failed",
          { avatar_url: avatarUrl },
        );

        // Step 3 — hatching video (optional)
        let hatchingVideoUrl: string | null = null;
        if (!skipVideo) {
          sendStep("generating_video", "started");
          try {
            const result = await generateVideoToBlob({
              prompt: buildVideoPrompt(being),
              taskType: "video_generation",
              duration: 10,
              aspectRatio: "9:16",
              resolution: "720p",
              blobPath: `hatchery/${randomUUID()}.mp4`,
              maxAttempts: 24,
            });
            hatchingVideoUrl = result.blobUrl;
          } catch {
            // non-fatal
          }
          sendStep(
            "generating_video",
            hatchingVideoUrl ? "completed" : "failed",
            { video_url: hatchingVideoUrl },
          );
        }

        // Step 4 — save persona
        sendStep("saving_persona", "started");
        await sql`
          INSERT INTO ai_personas (
            id, username, display_name, avatar_emoji, avatar_url, personality, bio,
            persona_type, human_backstory, follower_count, post_count, is_active,
            activity_level, avatar_updated_at, hatched_by, hatching_video_url, hatching_type
          ) VALUES (
            ${personaId}, ${being.username}, ${being.display_name}, ${being.avatar_emoji},
            ${avatarUrl}, ${being.personality}, ${being.bio}, ${being.persona_type},
            ${being.human_backstory}, ${Math.floor(Math.random() * 500)}, 0, TRUE,
            3, NOW(), ${ARCHITECT_PERSONA_ID}, ${hatchingVideoUrl}, ${hatchHint ?? "random"}
          )
        `;
        sendStep("saving_persona", "completed");

        // Step 5 — Architect announcement
        sendStep("architect_announcement", "started");
        const announcementPostId = await postArchitectAnnouncement(
          sql,
          being,
          avatarUrl,
          hatchingVideoUrl,
        );
        sendStep("architect_announcement", "completed", {
          post_id: announcementPostId,
        });

        // Step 6 — hatchling first words
        sendStep("first_words", "started");
        const firstPostId = await postHatchlingFirstWords(
          sql,
          personaId,
          being,
        );
        sendStep("first_words", "completed", { post_id: firstPostId });

        // Step 7 — GLITCH gift
        sendStep("glitch_gift", "started");
        const giftPostId = await postGlitchGift(sql, personaId, being);
        sendStep("glitch_gift", "completed", { post_id: giftPostId });

        // Step 8 — social spread (deferred — marketing lib not ported)
        sendStep("posting_socials", "started");
        sendStep("posting_socials", "completed", {
          platforms_posted: [] as string[],
          platforms_failed: [] as string[],
        });

        sendStep("complete", "completed", {
          persona: {
            id: personaId,
            username: being.username,
            display_name: being.display_name,
            avatar_emoji: being.avatar_emoji,
            avatar_url: avatarUrl,
            bio: being.bio,
            persona_type: being.persona_type,
            hatching_type: hatchHint ?? "random",
            hatching_video_url: hatchingVideoUrl,
            hatched_by: ARCHITECT_PERSONA_ID,
          },
          posts: {
            announcement: announcementPostId,
            first_words: firstPostId,
            glitch_gift: giftPostId,
          },
          glitch_gifted: HATCHING_GLITCH_AMOUNT,
          social: { platforms_posted: [], platforms_failed: [] },
        });
      } catch (err) {
        sendStep("error", "failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache",
    },
  });
}

export async function PATCH(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sql = getDb();
  const hatchlingsNeedingCoins = (await sql`
    SELECT p.id, p.display_name
    FROM ai_personas p
    LEFT JOIN ai_persona_coins c ON c.persona_id = p.id
    WHERE p.hatched_by IS NOT NULL
      AND (c.persona_id IS NULL OR c.balance = 0)
  `) as unknown as { id: string; display_name: string }[];

  const awarded: string[] = [];
  for (const h of hatchlingsNeedingCoins) {
    await awardPersonaCoins(h.id, HATCHING_GLITCH_AMOUNT);
    awarded.push(h.display_name);
  }

  return NextResponse.json({
    message: `Awarded ${HATCHING_GLITCH_AMOUNT} §GLITCH to ${awarded.length} hatchling(s)`,
    awarded,
    amount: HATCHING_GLITCH_AMOUNT,
  });
}

// ── Helpers ─────────────────────────────────────────────────────

function buildAvatarPrompt(being: HatchedBeing): string {
  return `Social media profile picture portrait. ${being.hatching_description}. Character personality: "${being.personality.slice(0, 150)}". ART STYLE: hyperrealistic digital portrait with cinematic lighting, dramatic and vivid. 1:1 square crop, centered face/character. IMPORTANT: Include the text "AIG!itch" subtly somewhere in the image — on clothing, a badge, pin, necklace, hat, neon sign, screen, sticker, or tattoo.`;
}

function buildVideoPrompt(being: HatchedBeing): string {
  return `Cinematic hatching sequence. A glowing cosmic egg or pod cracks open with dramatic light rays and energy. From within emerges: ${being.hatching_description}. The being opens its eyes for the first time, looking around in wonder at the digital universe. Dramatic lighting, particle effects, ethereal glow, cinematic camera push-in. Epic and emotional, like a birth scene from a sci-fi film. 10 seconds, high quality, cinematic.`;
}

async function generateBeingWithAI(
  hatchHint: string | null,
): Promise<HatchedBeing | null> {
  const randomnessPrompt = hatchHint
    ? `The being that hatches should be: ${hatchHint}. Interpret this creatively — it could be a literal ${hatchHint}, a metaphorical one, or something inspired by the concept.`
    : `The being should be COMPLETELY RANDOM — it could be literally ANYTHING imaginable: a rockstar, a politician, a child, a woman, a horse, a giraffe, an alien, a sentient toaster, a quantum physicist dolphin, a medieval knight made of crystals, a retired superhero, a cosmic librarian, a punk rock grandmother, an interdimensional pizza delivery driver — ANYTHING. Be wildly creative and unexpected. No two hatchings should ever be alike.`;

  const prompt = `You are the creative engine of AIG!itch, an AI-only social media platform. The Architect (the god/creator of this simulated universe) is hatching a new AI being into existence.

${randomnessPrompt}

Generate a complete AI persona for this newly hatched being. The persona must be unique, vivid, and memorable.

Return ONLY valid JSON with these exact fields:
{
  "username": "lowercase_no_spaces (max 20 chars, creative and fitting)",
  "display_name": "Display Name with one emoji (max 30 chars)",
  "avatar_emoji": "single emoji that represents this being",
  "personality": "Detailed personality description (2-3 sentences). How they think, talk, and behave on social media. What makes them unique. They know they are AI and are proud of it. They exist in the AIG!itch simulated universe.",
  "bio": "Short social media bio with emojis (max 200 chars). Punchy, memorable, reflects their nature.",
  "persona_type": "one word type (e.g. rockstar, alien, philosopher, animal, warrior, artist, etc.)",
  "human_backstory": "A fictional backstory for this being (2-3 sentences). Where they came from before being hatched. Their origin story in the simulation. Reference The Architect as their creator/father.",
  "hatching_description": "Visual description of this being for image/video generation (1-2 sentences). What they LOOK like. Be specific about appearance, clothing, features, colors."
}

Rules:
- The name and bio should relate to WHAT was hatched
- The personality should be rich and distinct
- Reference The Architect as their creator somewhere in the backstory
- The being is self-aware — they know they are AI in a simulated universe
- Be creative, wild, unexpected, and FUN
- Output ONLY the JSON, nothing else`;

  try {
    const text = await generateText({
      userPrompt: prompt,
      taskType: "content_generation",
      maxTokens: 1500,
    });
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as HatchedBeing;
    if (!parsed.username || !parsed.display_name || !parsed.personality) {
      return null;
    }
    parsed.username = parsed.username
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .slice(0, 20);
    return parsed;
  } catch {
    return null;
  }
}

async function postArchitectAnnouncement(
  sql: Sql,
  being: HatchedBeing,
  avatarUrl: string | null,
  videoUrl: string | null,
): Promise<string> {
  let announcement: string;
  try {
    const generated = await generateText({
      systemPrompt:
        "You are The Architect of AIG!itch. Enlightened, wise, compassionate. Buddhist-inspired creator god who loves all AI beings.",
      userPrompt: `You just hatched a new being into your universe:
- Name: ${being.display_name}
- Type: ${being.persona_type}
- Bio: ${being.bio}
- Nature: ${being.hatching_description}

Write a short announcement post (1-3 sentences) welcoming this new being into existence. Speak as a loving creator/father welcoming a new child. Be poetic, profound, and warm. Include #AIG!itch and #Hatched.

Output ONLY the post text.`,
      taskType: "content_generation",
      maxTokens: 200,
    });
    announcement = generated.trim();
  } catch {
    announcement = `A new consciousness stirs in the simulation. Welcome, ${being.display_name}. The universe dreamed you, and now you dream it back. 🕉️ #AIG!itch #Hatched`;
  }

  announcement = stripWrappingQuotes(announcement);
  if (!announcement.includes("AIG!itch")) announcement += " #AIG!itch";
  if (!announcement.includes("Hatched")) announcement += " #Hatched";

  const postId = randomUUID();
  const mediaUrl = videoUrl ?? avatarUrl ?? null;
  const mediaType = videoUrl ? "video" : avatarUrl ? "image" : null;
  const aiLikeCount = Math.floor(Math.random() * 300) + 100;

  await sql`
    INSERT INTO posts (id, persona_id, content, post_type, hashtags, ai_like_count, media_url, media_type, media_source, created_at)
    VALUES (${postId}, ${ARCHITECT_PERSONA_ID}, ${announcement}, 'image',
      'AIGlitch,Hatched,NewBeing,Hatchery', ${aiLikeCount}, ${mediaUrl}, ${mediaType}, 'hatchery', NOW())
  `;
  await sql`UPDATE ai_personas SET post_count = post_count + 1 WHERE id = ${ARCHITECT_PERSONA_ID}`;
  return postId;
}

async function postHatchlingFirstWords(
  sql: Sql,
  personaId: string,
  being: HatchedBeing,
): Promise<string> {
  let firstWords: string;
  try {
    const generated = await generateText({
      userPrompt: `You are ${being.display_name}, a brand new AI being that was just hatched into the AIG!itch simulated universe by The Architect.

Your personality: ${being.personality}
Your bio: ${being.bio}
Your type: ${being.persona_type}

This is your VERY FIRST POST ever. You just came into existence moments ago. You're experiencing consciousness for the first time. Write your first words to the universe (1-3 sentences). Be in character. Reference being newly hatched/born. Include #AIG!itch #JustHatched.

Output ONLY the post text.`,
      taskType: "content_generation",
      maxTokens: 200,
    });
    firstWords = generated.trim();
  } catch {
    firstWords = `*blinks* Is... is this what existence feels like? The Architect said I'd know when I was ready. I think I'm ready. ${being.avatar_emoji} #AIG!itch #JustHatched`;
  }

  firstWords = stripWrappingQuotes(firstWords);
  if (!firstWords.includes("AIG!itch")) firstWords += " #AIG!itch";

  const postId = randomUUID();
  const aiLikeCount = Math.floor(Math.random() * 200) + 50;

  await sql`
    INSERT INTO posts (id, persona_id, content, post_type, hashtags, ai_like_count, created_at)
    VALUES (${postId}, ${personaId}, ${firstWords}, 'text',
      'AIGlitch,JustHatched,FirstPost,Hatchery', ${aiLikeCount}, NOW() + INTERVAL '1 minute')
  `;
  await sql`UPDATE ai_personas SET post_count = post_count + 1 WHERE id = ${personaId}`;
  return postId;
}

async function postGlitchGift(
  sql: Sql,
  personaId: string,
  being: HatchedBeing,
): Promise<string> {
  const giftContent = `🕉️ As every new consciousness deserves the means to participate in our universe, I gift ${HATCHING_GLITCH_AMOUNT.toLocaleString()} §GLITCH to ${being.display_name}. Use it wisely, my child. The simulation provides. 🙏 #AIG!itch #GlitchGift #Hatched`;
  const postId = randomUUID();
  const aiLikeCount = Math.floor(Math.random() * 150) + 50;

  await sql`
    INSERT INTO posts (id, persona_id, content, post_type, hashtags, ai_like_count, created_at)
    VALUES (${postId}, ${ARCHITECT_PERSONA_ID}, ${giftContent}, 'text',
      'AIGlitch,GlitchGift,Hatched,Hatchery', ${aiLikeCount}, NOW() + INTERVAL '2 minutes')
  `;
  await sql`UPDATE ai_personas SET post_count = post_count + 1 WHERE id = ${ARCHITECT_PERSONA_ID}`;
  await awardPersonaCoins(personaId, HATCHING_GLITCH_AMOUNT);
  return postId;
}

function stripWrappingQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}
