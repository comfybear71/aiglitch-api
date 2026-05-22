import { runHealth } from "@/lib/health";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const report = await runHealth();
  const httpStatus = report.status === "down" ? 503 : 200;

  // If requesting JSON, return JSON
  const accept = request.headers.get("accept") || "";
  if (accept.includes("application/json") || request.nextUrl.searchParams.has("json")) {
    return NextResponse.json(report, { status: httpStatus });
  }

  // Otherwise render HTML dashboard
  const statusColor: Record<typeof report.status, string> = {
    ok: "#22c55e",
    degraded: "#eab308",
    down: "#ef4444",
  };

  const checksHtml = Object.entries(report.checks)
    .map(([name, c]) => {
      const result = c.skipped ? "skipped" : c.ok ? "ok" : "fail";
      const optional = c.optional ? " (optional)" : "";
      return `
        <tr style="border-bottom: 1px solid #f0f0f0;">
          <td style="padding: 8px;">${name}</td>
          <td style="padding: 8px;">${result}${optional}</td>
          <td style="padding: 8px;">${c.latency_ms}ms</td>
          <td style="padding: 8px; color: #888;">${c.error ?? ""}</td>
        </tr>
      `;
    })
    .join("");

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>API Status</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #f9f9f9; }
        main { padding: 32px; max-width: 720px; }
        h1 { margin: 0 0 16px 0; }
        p { margin: 0 0 16px 0; }
        strong { color: ${statusColor[report.status]}; }
        table { width: 100%; border-collapse: collapse; margin-top: 16px; }
        th { text-align: left; padding: 8px; border-bottom: 1px solid #ddd; }
        td { padding: 8px; }
        .footer { margin-top: 24px; color: #888; font-size: 12px; }
        .hint { background: #f0f0f0; padding: 12px; border-radius: 4px; margin-top: 16px; font-size: 13px; }
      </style>
    </head>
    <body>
      <main>
        <h1>Status</h1>
        <p>
          <strong>${report.status.toUpperCase()}</strong>
          <span style="color: #666;">v${report.version} · ${report.timestamp}</span>
        </p>
        <table>
          <thead>
            <tr style="border-bottom: 1px solid #ddd;">
              <th>Check</th>
              <th>Result</th>
              <th>Latency</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            ${checksHtml}
          </tbody>
        </table>
        <div class="hint">
          <strong>JSON endpoint:</strong> Add <code>?json</code> or set Accept: application/json header
        </div>
        <p class="footer">Phase 1 dashboard. Auto-refresh and richer visualizations come in a later branch.</p>
      </main>
    </body>
    </html>
  `;

  return new NextResponse(html, {
    status: httpStatus,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
