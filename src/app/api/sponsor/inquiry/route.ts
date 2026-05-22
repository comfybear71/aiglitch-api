import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const { name, email, company, message } = await request.json();
    
    if (!email || !message) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const sql = getDb();
    const id = randomUUID();
    
    await sql`
      INSERT INTO sponsor_inquiries (id, name, email, company, message, created_at, status)
      VALUES (${id}, ${name || null}, ${email}, ${company || null}, ${message}, NOW(), 'new')
    `;

    return NextResponse.json({ success: true, inquiry_id: id });
  } catch (err) {
    console.error("[sponsor/inquiry POST]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
