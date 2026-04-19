import { type NextRequest, NextResponse } from "next/server";
import {
  listChannels,
  subscribeToChannel,
  unsubscribeFromChannel,
} from "@/lib/repositories/channels";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const sessionId = request.nextUrl.searchParams.get("session_id");
    const channels = await listChannels(sessionId);

    const res = NextResponse.json({ channels });
    // Legacy value — hot list, changes fast when new channels/posts land.
    res.headers.set(
      "Cache-Control",
      "public, s-maxage=30, stale-while-revalidate=120",
    );
    return res;
  } catch (err) {
    console.error("[channels] GET error:", err);
    return NextResponse.json(
      { error: "Failed to fetch channels" },
      { status: 500 },
    );
  }
}

interface ChannelActionBody {
  session_id?: string;
  channel_id?: string;
  action?: "subscribe" | "unsubscribe";
}

export async function POST(request: NextRequest) {
  let body: ChannelActionBody;
  try {
    body = (await request.json()) as ChannelActionBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { session_id, channel_id, action } = body;
  if (!session_id || !channel_id || !action) {
    return NextResponse.json(
      { error: "Missing required fields" },
      { status: 400 },
    );
  }
  if (action !== "subscribe" && action !== "unsubscribe") {
    return NextResponse.json(
      { error: "Invalid action (must be 'subscribe' or 'unsubscribe')" },
      { status: 400 },
    );
  }

  try {
    if (action === "subscribe") {
      await subscribeToChannel(session_id, channel_id);
    } else {
      await unsubscribeFromChannel(session_id, channel_id);
    }
    return NextResponse.json({ ok: true, action });
  } catch (err) {
    console.error("[channels] POST error:", err);
    return NextResponse.json(
      {
        error: "Failed to update subscription",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
