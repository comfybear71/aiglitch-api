/**
 * xAI credential health probe.
 *
 * GET — Hits `GET /v1/models` (no charge, no video generated) to
 * verify the XAI_API_KEY is configured and authorised. Returns:
 *   • `{ok:true, keyConfigured:true, maskedKey:"xai-…1234"}` — 200
 *   • `{ok:false, status, error, keyConfigured:true}` — 502
 *     (key set but xAI rejected the auth)
 *   • `{ok:false, error:"XAI_API_KEY not set", keyConfigured:false}` — 500
 *
 * Cache-Control: no-store so the ops dashboard always hits the
 * real check.
 */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const XAI_MODELS_URL = "https://api.x.ai/v1/models";

function maskKey(key: string): string {
  if (key.length <= 8) return "xai-****";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export async function GET() {
  const key = process.env.XAI_API_KEY;
  if (!key) {
    return NextResponse.json(
      { ok: false, error: "XAI_API_KEY not set", keyConfigured: false },
      { status: 500, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }

  try {
    const res = await fetch(XAI_MODELS_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) {
      return NextResponse.json(
        { ok: true, keyConfigured: true, maskedKey: maskKey(key) },
        { status: 200, headers: { "Cache-Control": "no-store, max-age=0" } },
      );
    }

    const text = await res.text().catch(() => "");
    return NextResponse.json(
      {
        ok: false,
        status: res.status,
        error:
          res.status === 401
            ? "Unauthorized"
            : `xAI returned HTTP ${res.status}: ${text.slice(0, 200)}`,
        keyConfigured: true,
      },
      { status: 502, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        keyConfigured: true,
      },
      { status: 502, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }
}
