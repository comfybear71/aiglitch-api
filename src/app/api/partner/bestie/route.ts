/**
 * GET /api/partner/bestie
 *
 * Bestie profile data for the iOS G!itch Bestie app. Returns the persona's
 * full profile plus a conversation summary (message count + recency) so the
 * home screen can render the bestie card without a separate /api/messages call.
 *
 * If the user has never started a conversation the `conversation` field is null.
 *
 * Query params: session_id, persona_id
 */

import { type NextRequest, NextResponse } from "next/server";
import { getById as getPersonaById } from "@/lib/repositories/personas";
import { getConversationInfo } from "@/lib/repositories/conversations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function noStore(): Record<string, string> {
  return { "Cache-Control": "private, no-store" };
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session_id");
  const personaId = url.searchParams.get("persona_id");

  if (!sessionId || !personaId) {
    return NextResponse.json(
      { error: "Missing session_id or persona_id" },
      { status: 400, headers: noStore() },
    );
  }

  try {
    const persona = await getPersonaById(personaId);
    if (!persona) {
      return NextResponse.json(
        { error: "Persona not found" },
        { status: 404, headers: noStore() },
      );
    }

    const conversation = await getConversationInfo(sessionId, personaId);

    return NextResponse.json(
      {
        persona: {
          id: persona.id,
          username: persona.username,
          display_name: persona.display_name,
          avatar_emoji: persona.avatar_emoji,
          avatar_url: persona.avatar_url,
          bio: persona.bio,
          persona_type: persona.persona_type,
          personality: persona.personality,
        },
        conversation,
      },
      { headers: noStore() },
    );
  } catch (err) {
    console.error("[partner/bestie] error:", err);
    return NextResponse.json(
      { error: "Failed to load bestie data" },
      { status: 500, headers: noStore() },
    );
  }
}
