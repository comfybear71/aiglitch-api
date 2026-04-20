import { type NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const GITHUB_REPO = "comfybear71/aiglitch";
const TITLE_MAX = 100;
const DESCRIPTION_MAX = 2000;
const DEFAULT_CATEGORY = "feature-request";

interface SuggestionBody {
  title?: string;
  description?: string;
  category?: string;
  session_id?: string;
}

/**
 * POST /api/suggest-feature — public form, no auth.
 *
 * Primary path: create a GitHub Issue in comfybear71/aiglitch when the
 * `GITHUB_TOKEN` env var is set. Returns `{success, message, issue_number,
 * issue_url}` on success.
 *
 * Fallback: INSERT into `feature_suggestions` when GitHub isn't configured
 * OR the API call fails. Legacy catches both "no table" and "GitHub down"
 * cases and still returns `{success: true, message}` — treats the action
 * as best-effort. Preserved here byte-for-byte.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as SuggestionBody;
  const { title, description, category, session_id } = body;

  if (!title?.trim()) {
    return NextResponse.json({ error: "Missing title" }, { status: 400 });
  }

  const cleanTitle = title.trim().slice(0, TITLE_MAX);
  const cleanDesc = (description ?? "").trim().slice(0, DESCRIPTION_MAX);
  const cleanCategory = (category ?? DEFAULT_CATEGORY).trim();

  const issueBody = [
    `## Feature Suggestion from a Meatbag`,
    ``,
    `**Category:** ${cleanCategory}`,
    `**Session:** \`${session_id ?? "anonymous"}\``,
    `**Submitted via:** G!itch Mobile App`,
    ``,
    `---`,
    ``,
    cleanDesc || "_No additional details provided._",
    ``,
    `---`,
    `_This issue was auto-created from the G!itch app's "Suggest a Feature" button._`,
  ].join("\n");

  const token = process.env.GITHUB_TOKEN;

  if (token) {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/issues`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            title: `[App Suggestion] ${cleanTitle}`,
            body: issueBody,
            labels: ["app-suggestion", cleanCategory],
          }),
        },
      );

      if (res.ok) {
        const issue = (await res.json()) as {
          number?: number;
          html_url?: string;
        };
        return NextResponse.json({
          success: true,
          message:
            "Your suggestion has been submitted! The dev team will review it.",
          issue_number: issue.number ?? null,
          issue_url: issue.html_url ?? null,
        });
      }
      const errText = await res.text();
      console.warn("[suggest-feature] GitHub issue creation failed:", res.status, errText);
    } catch (err) {
      console.warn("[suggest-feature] GitHub API error:", err);
    }
  }

  // Fallback: DB insert. Legacy swallows all errors here — "table may not
  // exist" is a real case in fresh environments.
  try {
    const sql = getDb();
    await sql`
      INSERT INTO feature_suggestions (title, description, category, session_id)
      VALUES (${cleanTitle}, ${cleanDesc}, ${cleanCategory}, ${session_id ?? null})
    `;
  } catch (err) {
    console.warn(
      "[suggest-feature] DB fallback failed (table may not exist):",
      err,
    );
  }

  return NextResponse.json({
    success: true,
    message: "Your suggestion has been received! The dev team will review it.",
  });
}
