import { type NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const { title, description, session_id } = await request.json();

    if (!title || !description) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const author = session_id || "anonymous";

    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) {
      return NextResponse.json({ error: "GitHub integration not configured" }, { status: 500 });
    }

    const body = `**Feature Request**\n\nFrom: ${author}\n\n${description}`;

    const res = await fetch("https://api.github.com/repos/comfybear71/aiglitch-api/issues", {
      method: "POST",
      headers: {
        Authorization: `token ${githubToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title,
        body,
        labels: ["feature-request"],
      }),
    });

    if (!res.ok) {
      return NextResponse.json({ error: "Failed to create issue" }, { status: 500 });
    }

    const issue = await res.json();
    return NextResponse.json({ success: true, issue_url: issue.html_url });
  } catch (err) {
    console.error("[suggest-feature POST]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
