/**
 * GET  /api/voice               — check if voice is enabled (+ ?debug=1 for xAI TTS probe)
 * POST /api/voice                — generate MP3 audio for a text snippet
 *
 * Audio pipeline:
 *   1. xAI `/v1/tts` if XAI_API_KEY is set (model voice per persona via voice-config)
 *   2. Google Translate TTS as a free fallback (no key needed, 200-char chunks)
 *
 * A tiny in-memory LRU caches the last 50 generated clips (30-min TTL)
 * so repeated identical requests in a warm Lambda are cheap. Admin can
 * disable voice entirely by setting platform_settings.voice_disabled
 * = "true".
 *
 * Text is trimmed and hard-capped at 500 chars before any API call.
 */

import { type NextRequest, NextResponse } from "next/server";
import { getVoiceForPersona } from "@/lib/voice-config";
import { getSetting } from "@/lib/repositories/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_TEXT_LENGTH = 500;
const CACHE_MAX_SIZE = 50;
const CACHE_TTL_MS = 30 * 60 * 1000;
const GOOGLE_TTS_CHUNK = 200;

// LRU-ish: Map preserves insertion order, oldest keys evicted first.
const audioCache = new Map<string, { buffer: Buffer; timestamp: number }>();

function getCached(key: string): Buffer | null {
  const entry = audioCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    audioCache.delete(key);
    return null;
  }
  return entry.buffer;
}

function setCached(key: string, buffer: Buffer): void {
  if (audioCache.size >= CACHE_MAX_SIZE) {
    const oldest = audioCache.keys().next().value;
    if (oldest) audioCache.delete(oldest);
  }
  audioCache.set(key, { buffer, timestamp: Date.now() });
}

function audioResponse(buffer: Buffer, source: string, extra?: Record<string, string>): NextResponse {
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  const headers: Record<string, string> = {
    "Content-Type": "audio/mpeg",
    "Content-Length": buffer.byteLength.toString(),
    "Cache-Control": "public, max-age=3600",
    "X-Voice-Source": source,
    ...(extra ?? {}),
  };
  return new NextResponse(arrayBuffer, { status: 200, headers });
}

// ── GET: status + debug probe ─────────────────────────────────────────

export async function GET(request: NextRequest) {
  const debug = request.nextUrl.searchParams.get("debug") === "1";

  let voiceDisabled: string | null = null;
  try {
    voiceDisabled = await getSetting("voice_disabled");
  } catch {
    // settings unreachable — assume enabled
  }
  const apiKey = process.env.XAI_API_KEY;

  if (!debug) {
    return NextResponse.json({ enabled: voiceDisabled !== "true" });
  }

  // Debug: try a 1-word TTS call and report upstream status
  let xaiStatus = "no_key";
  let xaiError = "";
  if (apiKey) {
    try {
      const res = await fetch("https://api.x.ai/v1/tts", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: "test",
          voice_id: "rex",
          language: "en",
          output_format: { codec: "mp3", sample_rate: 24000, bit_rate: 128000 },
        }),
      });
      if (res.ok) {
        xaiStatus = "working";
      } else {
        const body = await res.text().catch(() => "");
        xaiStatus = `error_${res.status}`;
        xaiError = body.slice(0, 200);
      }
    } catch (err) {
      xaiStatus = "fetch_failed";
      xaiError = err instanceof Error ? err.message : String(err);
    }
  }

  return NextResponse.json({
    enabled: voiceDisabled !== "true",
    has_xai_key: !!apiKey,
    key_prefix: apiKey ? `${apiKey.slice(0, 8)}...` : null,
    xai_tts_status: xaiStatus,
    xai_error: xaiError || undefined,
  });
}

// ── POST: generate audio ──────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    const disabled = await getSetting("voice_disabled");
    if (disabled === "true") {
      return NextResponse.json(
        { disabled: true, message: "Voice has been disabled by admin" },
        { status: 403 },
      );
    }
  } catch {
    // settings unreachable — allow through
  }

  const body = (await request.json().catch(() => ({}))) as {
    text?: string;
    persona_id?: string;
    persona_type?: string;
  };
  const { text, persona_id, persona_type } = body;

  if (!text?.trim()) {
    return NextResponse.json({ error: "Missing text" }, { status: 400 });
  }

  const trimmed = text.trim().slice(0, MAX_TEXT_LENGTH);
  const apiKey = process.env.XAI_API_KEY;

  if (!apiKey) {
    return generateGoogleTTS(trimmed);
  }

  const voiceConfig = getVoiceForPersona(persona_id ?? "", persona_type);
  const voiceId = voiceConfig.voice.toLowerCase();

  const cacheKey = `${voiceId}:${trimmed}`;
  const cached = getCached(cacheKey);
  if (cached) {
    return audioResponse(cached, "cache");
  }

  try {
    const res = await fetch("https://api.x.ai/v1/tts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: trimmed,
        voice_id: voiceId,
        language: "en",
        output_format: { codec: "mp3", sample_rate: 24000, bit_rate: 128000 },
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "no body");
      console.error(`[voice] xAI TTS ${res.status}: ${errBody.slice(0, 200)}`);
      const fallback = await generateGoogleTTS(trimmed);
      fallback.headers.set("X-Voice-Fallback-Reason", `xai-${res.status}`);
      return fallback;
    }

    const audioBuffer = Buffer.from(await res.arrayBuffer());
    setCached(cacheKey, audioBuffer);
    return audioResponse(audioBuffer, "xai-tts");
  } catch (err) {
    console.error("[voice] xAI TTS threw:", err instanceof Error ? err.message : err);
    return generateGoogleTTS(trimmed);
  }
}

// ── Google Translate TTS fallback ─────────────────────────────────────

async function generateGoogleTTS(text: string): Promise<NextResponse> {
  const cacheKey = `gtts:${text}`;
  const cached = getCached(cacheKey);
  if (cached) return audioResponse(cached, "google-translate");

  try {
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= GOOGLE_TTS_CHUNK) {
        chunks.push(remaining);
        break;
      }
      let splitAt = remaining.lastIndexOf(" ", GOOGLE_TTS_CHUNK);
      if (splitAt <= 0) splitAt = GOOGLE_TTS_CHUNK;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trim();
    }

    const audioBuffers: Buffer[] = [];
    for (const chunk of chunks) {
      const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(chunk)}&tl=en&client=tw-ob`;
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      });
      if (!res.ok) throw new Error(`Google TTS returned ${res.status}`);
      audioBuffers.push(Buffer.from(await res.arrayBuffer()));
    }

    const combined = Buffer.concat(audioBuffers);
    setCached(cacheKey, combined);
    return audioResponse(combined, "google-translate");
  } catch (err) {
    console.error("[voice] Google TTS fallback error:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Voice generation unavailable" }, { status: 503 });
  }
}
