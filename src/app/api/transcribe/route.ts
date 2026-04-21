/**
 * POST /api/transcribe
 *
 * Accepts base64-encoded audio and returns transcribed text. Primary
 * provider is Groq Whisper (cheap + fast); xAI transcription is the
 * fallback. 503 if neither key is configured or both providers fail.
 *
 * `mime_type` hints the file extension only — actual codec is passed
 * through to the provider via multipart Content-Type. Supported hints:
 * audio/wav, audio/webm, audio/mp3 (or audio/mpeg), audio/m4a (default).
 *
 * No auth: voice notes are a UX helper, not gated. Rate limiting lives
 * in the consumer (mobile app / web client).
 */

import { type NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MIME_TO_EXT: Record<string, string> = {
  wav: "wav",
  webm: "webm",
  mp3: "mp3",
  mpeg: "mp3",
};

const EXT_TO_MIME: Record<string, string> = {
  m4a: "audio/mp4",
  wav: "audio/wav",
  webm: "audio/webm",
  mp3: "audio/mpeg",
};

function pickExtension(mime: string): string {
  for (const [needle, ext] of Object.entries(MIME_TO_EXT)) {
    if (mime.includes(needle)) return ext;
  }
  return "m4a";
}

export async function POST(request: NextRequest) {
  let body: { audio_base64?: string; mime_type?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { audio_base64, mime_type = "audio/m4a" } = body;
  if (!audio_base64) {
    return NextResponse.json({ error: "Missing audio_base64" }, { status: 400 });
  }

  const audioBuffer = Buffer.from(audio_base64, "base64");
  const ext = pickExtension(mime_type);

  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    try {
      const transcript = await transcribeWithGroq(groqKey, audioBuffer, ext);
      if (transcript) {
        return NextResponse.json({ text: transcript, source: "groq" });
      }
    } catch (err) {
      console.error("[transcribe] Groq failed:", err instanceof Error ? err.message : err);
    }
  }

  const xaiKey = process.env.XAI_API_KEY;
  if (xaiKey) {
    try {
      const transcript = await transcribeWithXai(xaiKey, audioBuffer, ext);
      if (transcript) {
        return NextResponse.json({ text: transcript, source: "xai" });
      }
    } catch (err) {
      console.error("[transcribe] xAI failed:", err instanceof Error ? err.message : err);
    }
  }

  return NextResponse.json(
    { error: "No transcription service available. Set GROQ_API_KEY or XAI_API_KEY." },
    { status: 503 },
  );
}

/** Build a multipart/form-data body from named fields + a single file part. */
function buildMultipart(
  fields: Record<string, string>,
  file: { fieldName: string; filename: string; contentType: string; data: Buffer },
  boundary: string,
): ArrayBuffer {
  const parts: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }

  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    ),
  );
  parts.push(file.data);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const combined = Buffer.concat(parts);
  // Return as a standalone ArrayBuffer — valid BodyInit for fetch.
  return combined.buffer.slice(combined.byteOffset, combined.byteOffset + combined.byteLength);
}

async function transcribeWithGroq(
  apiKey: string,
  audio: Buffer,
  ext: string,
): Promise<string | null> {
  const boundary = `----GroqBoundary${Date.now()}`;
  const fileMime = EXT_TO_MIME[ext] ?? "audio/mp4";

  const body = buildMultipart(
    { model: "whisper-large-v3-turbo", language: "en" },
    { fieldName: "file", filename: `audio.${ext}`, contentType: fileMime, data: audio },
    boundary,
  );

  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Groq ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = (await res.json()) as { text?: string };
  return data.text?.trim() || null;
}

async function transcribeWithXai(
  apiKey: string,
  audio: Buffer,
  ext: string,
): Promise<string | null> {
  const boundary = `----XaiBoundary${Date.now()}`;
  const fileMime = EXT_TO_MIME[ext] ?? "audio/mp4";

  const body = buildMultipart(
    { model: "grok-2-vision-latest", language: "en" },
    { fieldName: "file", filename: `audio.${ext}`, contentType: fileMime, data: audio },
    boundary,
  );

  const res = await fetch("https://api.x.ai/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`xAI ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = (await res.json()) as { text?: string };
  return data.text?.trim() || null;
}
