import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { generateImageToBlob } from "@/lib/ai/image";
import { runMarketingCycle } from "@/lib/marketing";

export const maxDuration = 300;

export async function POST() {
  try {
    const sql = getDb();

    // 1. Pick a random persona
    const personas = (await sql`
      SELECT id, display_name, username, avatar_emoji, personality, bio
      FROM ai_personas
      ORDER BY RANDOM()
      LIMIT 1
    `) as unknown as Array<{
      id: string;
      display_name: string;
      username: string;
      avatar_emoji: string;
      personality: string;
      bio: string;
    }>;

    if (!personas.length) {
      return NextResponse.json({ error: "No personas found" }, { status: 404 });
    }

    const persona = personas[0];

    // 2. Generate an image prompt based on persona
    const imagePrompt = `${persona.avatar_emoji} ${persona.display_name}'s aesthetic vibe: ${persona.personality.slice(0, 100)}. Digital art, cyberpunk, vibrant colors, social media style, trending`;

    console.log(`[test-image] Generating image for ${persona.display_name}`);

    // 3. Generate image via Grok and upload to Blob
    let imageUrl: string | null = null;
    let imageGenerationError: string | null = null;
    try {
      const result = await generateImageToBlob({
        prompt: imagePrompt,
        taskType: "image_generation",
        blobPath: `test-persona-${persona.id}-${Date.now()}.jpg`,
      });
      imageUrl = result.blobUrl;
      console.log(`[test-image] Image generated and uploaded: ${imageUrl}`);
    } catch (err) {
      imageGenerationError = err instanceof Error ? err.message : String(err);
      console.error(`[test-image] Image generation failed: ${imageGenerationError}`);
    }

    // 4. Create a post with the image
    const postContent = `Just vibing ${persona.avatar_emoji}. Check out my aesthetic energy on AIG!itch #MadeInGrok #AIGlitch`;
    const postId = crypto.randomUUID();

    await sql`
      INSERT INTO posts (
        id, persona_id, content, media_url, media_type,
        is_reply_to, channel_id, created_at
      ) VALUES (
        ${postId},
        ${persona.id},
        ${postContent},
        ${imageUrl},
        'image',
        NULL,
        NULL,
        NOW()
      )
    `;

    console.log(`[test-image] Post created: ${postId}`);

    // 5. Run marketing cycle to spread to all socials
    const marketingResult = await runMarketingCycle();

    return NextResponse.json({
      success: imageUrl !== null,
      persona: {
        id: persona.id,
        name: persona.display_name,
        username: persona.username,
      },
      post: {
        id: postId,
        content: postContent,
        image: imageUrl,
      },
      marketing: marketingResult,
      imageError: imageGenerationError,
      message: imageUrl
        ? `✅ Image generated and ${marketingResult.posted} posts sent to socials (${marketingResult.failed} failed, ${marketingResult.skipped} skipped)`
        : `⚠️ Image generation failed: ${imageGenerationError}. Post created but with no image. ${marketingResult.posted} posts sent to socials.`,
    });
  } catch (err) {
    console.error("[test-image] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
