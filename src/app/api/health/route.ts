import { NextResponse } from "next/server";
import { runHealth } from "@/lib/health";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const report = await runHealth();
  const httpStatus = report.status === "down" ? 503 : 200;
  return NextResponse.json(report, { status: httpStatus });
}
