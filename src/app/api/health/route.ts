import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  // Redirect to /status which now serves both JSON and HTML
  return NextResponse.redirect(new URL("/status", process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"), 301);
}
