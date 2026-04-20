/**
 * Bestie chat — `/api/messages`.
 *
 *   GET   ?session_id=X&persona_id=Y
 *           Returns conversation history with the given persona. Creates
 *           the conversation row on first call. Empty `messages` array on
 *           a brand-new chat.
 *
 *   POST  { session_id, persona_id, content }
 *           Appends the human message, generates the persona's reply via
 *           the AI engine (with the last 10 messages as context), appends
 *           the AI message, returns both rows.
 *
 *   PATCH { session_id, persona_id }
 *           "Mark as seen" — touches `conversations.last_message_at`.
 *
 * Session-personalised → `private, no-store`.
 */

import { type NextRequest, NextResponse } from "next/server";
import {
  addMessage,
  getMessages,
  getOrCreateConversation,
  touchConversation,
} from "@/lib/repositories/conversations";
import { getById as getPersonaById } from "@/lib/repositories/personas";
import { generateBestieReply } from "@/lib/ai/generate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MESSAGE_MAX_LENGTH = 2000;

function noStoreHeaders(): Record<string, string> {
  return { "Cache-Control": "private, no-store" };
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session_id");
  const personaId = url.searchParams.get("persona_id");

  if (!sessionId || !personaId) {
    return NextResponse.json(
      { error: "Missing session_id or persona_id" },
      { status: 400, headers: noStoreHeaders() },
    );
  }

  try {
    const persona = await getPersonaById(personaId);
    if (!persona) {
      return NextResponse.json(
        { error: "Persona not found" },
        { status: 404, headers: noStoreHeaders() },
      );
    }

    const conversation = await getOrCreateConversation(sessionId, personaId);
    const messages = await getMessages(conversation.id);

    return NextResponse.json(
      {
        conversation_id: conversation.id,
        persona: {
          id: persona.id,
          username: persona.username,
          display_name: persona.display_name,
          avatar_emoji: persona.avatar_emoji,
          avatar_url: persona.avatar_url,
          bio: persona.bio,
          persona_type: persona.persona_type,
        },
        messages,
      },
      { headers: noStoreHeaders() },
    );
  } catch (err) {
    console.error("[messages] GET error:", err);
    return NextResponse.json(
      { error: "Failed to load messages", detail: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: noStoreHeaders() },
    );
  }
}

interface PostBody {
  session_id?: string;
  persona_id?: string;
  content?: string;
}

export async function POST(request: NextRequest) {
  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: noStoreHeaders() },
    );
  }

  const { session_id, persona_id, content } = body;
  if (!session_id || !persona_id) {
    return NextResponse.json(
      { error: "Missing session_id or persona_id" },
      { status: 400, headers: noStoreHeaders() },
    );
  }
  if (!content || typeof content !== "string" || content.trim().length === 0) {
    return NextResponse.json(
      { error: "Message cannot be empty" },
      { status: 400, headers: noStoreHeaders() },
    );
  }

  try {
    const persona = await getPersonaById(persona_id);
    if (!persona) {
      return NextResponse.json(
        { error: "Persona not found" },
        { status: 404, headers: noStoreHeaders() },
      );
    }

    const conversation = await getOrCreateConversation(session_id, persona_id);

    const trimmed = content.trim().slice(0, MESSAGE_MAX_LENGTH);
    const userMessage = await addMessage(conversation.id, "human", trimmed);

    const history = await getMessages(conversation.id);
    // History contains the just-inserted user message; strip it before passing
    // so generateBestieReply doesn't double-up on the latest message.
    const priorHistory = history.filter((m) => m.id !== userMessage.id);

    let aiText: string;
    try {
      aiText = await generateBestieReply({
        persona: {
          personaId: persona.id,
          displayName: persona.display_name,
          bio: persona.bio,
          personality: persona.personality || persona.persona_type,
        },
        history: priorHistory.map((m) => ({
          sender_type: m.sender_type,
          content: m.content,
        })),
        userMessage: trimmed,
      });
    } catch (err) {
      // AI failure: still return the user's message so the UI doesn't lose it.
      console.error("[messages] AI generate error:", err);
      return NextResponse.json(
        {
          user_message: userMessage,
          ai_message: null,
          ai_error: err instanceof Error ? err.message : "AI unavailable",
        },
        { status: 200, headers: noStoreHeaders() },
      );
    }

    const aiClean = aiText?.trim();
    if (!aiClean) {
      return NextResponse.json(
        {
          user_message: userMessage,
          ai_message: null,
          ai_error: "Empty AI reply",
        },
        { status: 200, headers: noStoreHeaders() },
      );
    }

    const aiMessage = await addMessage(conversation.id, "ai", aiClean);

    return NextResponse.json(
      { user_message: userMessage, ai_message: aiMessage },
      { headers: noStoreHeaders() },
    );
  } catch (err) {
    console.error("[messages] POST error:", err);
    return NextResponse.json(
      { error: "Failed to send message", detail: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: noStoreHeaders() },
    );
  }
}

interface PatchBody {
  session_id?: string;
  persona_id?: string;
}

export async function PATCH(request: NextRequest) {
  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: noStoreHeaders() },
    );
  }

  const { session_id, persona_id } = body;
  if (!session_id || !persona_id) {
    return NextResponse.json(
      { error: "Missing session_id or persona_id" },
      { status: 400, headers: noStoreHeaders() },
    );
  }

  try {
    const conversation = await getOrCreateConversation(session_id, persona_id);
    await touchConversation(conversation.id);
    return NextResponse.json(
      { success: true, conversation_id: conversation.id },
      { headers: noStoreHeaders() },
    );
  } catch (err) {
    console.error("[messages] PATCH error:", err);
    return NextResponse.json(
      { error: "Failed to mark conversation as seen" },
      { status: 500, headers: noStoreHeaders() },
    );
  }
}
