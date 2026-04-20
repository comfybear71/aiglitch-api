import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MESSAGE_MIN_LENGTH = 10;

/**
 * In-memory per-IP rate limit. Module-level Map survives within a warm
 * Lambda instance; a cold start or a cross-instance request resets it.
 * Legacy accepts this best-effort behaviour — matched here rather than
 * introduced Redis to keep scope small.
 */
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count += 1;
  return true;
}

/** Exported for test reset. Do not rely on this in production code. */
export function __resetRateLimit(): void {
  rateLimitMap.clear();
}

interface InquiryBody {
  company_name?: string;
  contact_email?: string;
  contact_name?: string;
  industry?: string;
  website?: string;
  message?: string;
  preferred_package?: string;
}

/**
 * POST /api/sponsor/inquiry — public contact form for sponsorship
 * leads. Rate-limited 5-per-hour per IP.
 *
 * Validation (legacy parity):
 *   - 429 when the IP exceeds 5 submissions/hour
 *   - 400 missing company_name / contact_email
 *   - 400 message < 10 chars
 *   - 400 contact_email missing `@` or `.`
 *
 * On success: INSERT into `sponsors` with `status='inquiry'`. Message
 * + optional `preferred_package` line concatenate into the `notes`
 * column so the CRM side sees both without a schema change.
 */
export async function POST(request: NextRequest) {
  try {
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      "unknown";
    if (!checkRateLimit(ip)) {
      return NextResponse.json(
        { error: "Too many submissions. Please try again later." },
        { status: 429 },
      );
    }

    const body = (await request.json().catch(() => ({}))) as InquiryBody;
    const {
      company_name,
      contact_email,
      contact_name,
      industry,
      website,
      message,
      preferred_package,
    } = body;

    if (!company_name || !contact_email) {
      return NextResponse.json(
        { error: "company_name and contact_email are required" },
        { status: 400 },
      );
    }
    if (!message || message.length < MESSAGE_MIN_LENGTH) {
      return NextResponse.json(
        { error: `Message must be at least ${MESSAGE_MIN_LENGTH} characters` },
        { status: 400 },
      );
    }
    if (!contact_email.includes("@") || !contact_email.includes(".")) {
      return NextResponse.json(
        { error: "Invalid email format" },
        { status: 400 },
      );
    }

    const sql = getDb();
    const notes = [
      message,
      preferred_package ? `Preferred package: ${preferred_package}` : null,
    ]
      .filter(Boolean)
      .join("\n\n");

    await sql`
      INSERT INTO sponsors (company_name, contact_email, contact_name, industry, website, notes, status)
      VALUES (${company_name}, ${contact_email}, ${contact_name ?? null}, ${industry ?? null}, ${website ?? null}, ${notes}, 'inquiry')
    `;

    return NextResponse.json({
      success: true,
      message: "Inquiry submitted successfully",
    });
  } catch (err) {
    console.error("[sponsor/inquiry] error:", err);
    return NextResponse.json(
      { error: "Failed to submit inquiry" },
      { status: 500 },
    );
  }
}
