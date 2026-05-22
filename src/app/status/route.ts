import { runHealth } from "@/lib/health";
import { getCronHealth } from "@/lib/cron-health";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86400)}d ago`;
}

export async function GET(request: NextRequest) {
  const [report, cronHealth] = await Promise.all([runHealth(), getCronHealth()]);

  // Roll cron + marketing failures into the overall status. If reachability
  // is already DOWN, that wins. Otherwise any cron error or marketing
  // failure in the last 24h drops us to DEGRADED.
  const hasCronTrouble =
    cronHealth.errors_24h > 0 ||
    cronHealth.marketing.failed_24h > 0 ||
    cronHealth.marketing.silent_media_failures_24h > 0;
  const overallStatus =
    report.status === "down"
      ? "down"
      : report.status === "degraded" || hasCronTrouble
        ? "degraded"
        : "ok";
  const httpStatus = overallStatus === "down" ? 503 : 200;

  // If requesting JSON, return JSON (now includes cron health)
  const accept = request.headers.get("accept") || "";
  if (accept.includes("application/json") || request.nextUrl.searchParams.has("json")) {
    return NextResponse.json(
      { ...report, status: overallStatus, crons: cronHealth },
      { status: httpStatus },
    );
  }

  const statusColor: Record<string, string> = {
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

  const cronErrorsHtml =
    cronHealth.recent_errors.length === 0
      ? `<tr><td colspan="3" style="padding: 12px; color: #888;">No cron errors in the table — all clear.</td></tr>`
      : cronHealth.recent_errors
          .map((r) => {
            const err = r.error ? escapeHtml(r.error.slice(0, 400)) : "";
            return `
              <tr style="border-bottom: 1px solid #f0f0f0;">
                <td style="padding: 8px; font-weight: 500;">${escapeHtml(r.cron_name)}</td>
                <td style="padding: 8px; color: #888;">${formatRelative(r.started_at)}</td>
                <td style="padding: 8px; font-family: monospace; font-size: 12px; color: #b91c1c; word-break: break-word;">${err}</td>
              </tr>
            `;
          })
          .join("");

  const recentRunsHtml =
    cronHealth.recent_runs.length === 0
      ? `<tr><td colspan="3" style="padding: 12px; color: #888;">No cron runs recorded yet.</td></tr>`
      : cronHealth.recent_runs
          .map((r) => {
            const color =
              r.status === "ok"
                ? "#16a34a"
                : r.status === "running"
                  ? "#0066cc"
                  : "#dc2626";
            return `
              <tr style="border-bottom: 1px solid #f0f0f0;">
                <td style="padding: 8px;">${escapeHtml(r.cron_name)}</td>
                <td style="padding: 8px; color: ${color}; font-weight: 500;">${escapeHtml(r.status)}</td>
                <td style="padding: 8px; color: #888;">${formatRelative(r.started_at)}${r.duration_ms ? ` · ${r.duration_ms}ms` : ""}</td>
              </tr>
            `;
          })
          .join("");

  const marketingErrorsHtml =
    cronHealth.marketing.recent_marketing_errors.length === 0
      ? `<tr><td colspan="3" style="padding: 12px; color: #888;">No marketing failures in the last 24h.</td></tr>`
      : cronHealth.marketing.recent_marketing_errors
          .map((m) => {
            const tag =
              m.status === "posted"
                ? `<span style="color: #d97706; font-size: 11px; font-weight: 600;">SILENT FALLBACK</span>`
                : `<span style="color: #b91c1c; font-size: 11px; font-weight: 600;">FAILED</span>`;
            return `
              <tr style="border-bottom: 1px solid #f0f0f0;">
                <td style="padding: 8px; font-weight: 500;">${escapeHtml(m.platform)} ${tag}</td>
                <td style="padding: 8px; color: #888;">${formatRelative(m.created_at)}</td>
                <td style="padding: 8px; font-family: monospace; font-size: 12px; color: #555; word-break: break-word;">${escapeHtml((m.error_message ?? "").slice(0, 400))}</td>
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
        * { box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #f9f9f9; }
        main { padding: 32px; max-width: 900px; margin: 0 auto; }
        h1 { margin: 0 0 8px 0; font-size: 28px; }
        .header { margin-bottom: 32px; }
        p { margin: 0 0 16px 0; }
        strong { color: ${statusColor[overallStatus]}; }
        .stat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; margin-bottom: 16px; }
        .stat { background: white; padding: 12px 16px; border-radius: 4px; border: 1px solid #e5e5e5; }
        .stat .num { font-size: 24px; font-weight: 600; }
        .stat .label { font-size: 12px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px; }
        .stat.bad .num { color: #dc2626; }
        .stat.warn .num { color: #d97706; }
        table { width: 100%; border-collapse: collapse; margin-top: 16px; background: white; }
        th { text-align: left; padding: 12px; border-bottom: 2px solid #ddd; font-weight: 600; }
        td { padding: 12px; border-bottom: 1px solid #f0f0f0; }

        .section { margin-top: 32px; padding-top: 32px; border-top: 1px solid #ddd; }
        .test-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; margin-top: 16px; }
        button {
          padding: 10px 16px;
          background: #0066cc;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 500;
        }
        button:hover { background: #0052a3; }
        button:disabled { background: #ccc; cursor: not-allowed; }

        .result {
          margin-top: 16px;
          padding: 16px;
          border-radius: 4px;
          background: #f5f5f5;
          border-left: 4px solid #0066cc;
          font-family: monospace;
          font-size: 12px;
          max-height: 800px;
          overflow-y: auto;
          white-space: pre-wrap;
          word-break: break-all;
        }
        .result.success { border-left-color: #22c55e; background: #f0fdf4; }
        .result.error { border-left-color: #ef4444; background: #fef2f2; }

        .hint { background: #f0f0f0; padding: 12px; border-radius: 4px; margin-top: 16px; font-size: 13px; }
        .footer { margin-top: 24px; color: #888; font-size: 12px; }
      </style>
    </head>
    <body>
      <main>
        <div class="header">
          <h1>API Status</h1>
          <p>
            <strong>${overallStatus.toUpperCase()}</strong>
            <span style="color: #666;">v${report.version} · ${report.timestamp}</span>
          </p>
        </div>

        <section>
          <h2 style="font-size: 18px; margin: 0 0 16px 0;">At a glance</h2>
          <div class="stat-grid">
            <div class="stat ${cronHealth.errors_24h > 0 ? "bad" : ""}">
              <div class="num">${cronHealth.errors_24h}</div>
              <div class="label">Cron errors (24h)</div>
            </div>
            <div class="stat ${cronHealth.marketing.failed_24h > 0 ? "bad" : ""}">
              <div class="num">${cronHealth.marketing.failed_24h}</div>
              <div class="label">Marketing failed (24h)</div>
            </div>
            <div class="stat ${cronHealth.marketing.silent_media_failures_24h > 0 ? "warn" : ""}">
              <div class="num">${cronHealth.marketing.silent_media_failures_24h}</div>
              <div class="label">Silent media fallbacks (24h)</div>
            </div>
            <div class="stat">
              <div class="num">${cronHealth.active_count}</div>
              <div class="label">Active crons</div>
            </div>
          </div>
        </section>

        <section class="section">
          <h2 style="font-size: 18px; margin: 0 0 16px 0;">Health Checks</h2>
          <table>
            <thead>
              <tr>
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
        </section>

        <section class="section">
          <h2 style="font-size: 18px; margin: 0 0 16px 0;">Recent cron errors</h2>
          <p style="color: #666; font-size: 13px;">From <code>cron_runs</code> where <code>status IN ('error','failed')</code>.</p>
          <table>
            <thead>
              <tr>
                <th>Cron</th>
                <th>When</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              ${cronErrorsHtml}
            </tbody>
          </table>
        </section>

        <section class="section">
          <h2 style="font-size: 18px; margin: 0 0 16px 0;">Marketing failures + silent fallbacks</h2>
          <p style="color: #666; font-size: 13px;">From <code>marketing_posts</code>. <strong>SILENT FALLBACK</strong> = tweet posted text-only because media upload failed.</p>
          <table>
            <thead>
              <tr>
                <th>Platform</th>
                <th>When</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              ${marketingErrorsHtml}
            </tbody>
          </table>
        </section>

        <section class="section">
          <h2 style="font-size: 18px; margin: 0 0 16px 0;">Recent cron runs</h2>
          <table>
            <thead>
              <tr>
                <th>Cron</th>
                <th>Status</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              ${recentRunsHtml}
            </tbody>
          </table>
        </section>

        <section class="section">
          <h2 style="font-size: 18px; margin: 0 0 16px 0;">Endpoint Tester</h2>
          <p style="color: #666; font-size: 14px;">Test critical API endpoints to ensure they are working correctly.</p>

          <div class="test-grid">
            <button onclick="testEndpoint('/api/health', 'Health Check')">Health Check</button>
            <button onclick="testEndpoint('/api/feed?limit=1', 'Feed (1 post)')">Feed</button>
            <button onclick="testEndpoint('/api/status?json', 'Status JSON')">Status JSON</button>
            <button onclick="testEndpoint('/api/personas?limit=3', 'Personas')">Personas</button>
            <button onclick="testEndpoint('/api/marketing-post', 'Marketing Cron')">Marketing Post</button>
            <button onclick="testEndpoint('/api/channels?limit=3', 'Channels')">Channels</button>
            <button onclick="testImageToSocials()" style="background: #10b981;">🖼️ Image → Socials</button>
          </div>

          <div id="testResult"></div>
        </section>

        <div class="hint">
          💡 <strong>JSON endpoint:</strong> Add <code>?json</code> or set Accept: application/json header to any endpoint
        </div>
        <p class="footer">Phase 1 dashboard. Full test suite and monitoring coming in next phase.</p>
      </main>

      <script>
        async function testEndpoint(url, label) {
          const resultDiv = document.getElementById('testResult');
          const button = event.target;

          button.disabled = true;
          button.textContent = 'Testing...';
          resultDiv.innerHTML = '';

          const startTime = Date.now();
          try {
            const res = await fetch(url);
            const elapsed = Date.now() - startTime;
            const data = await res.text();
            const isJson = res.headers.get('content-type')?.includes('json');

            let displayData = data;
            if (isJson) {
              try {
                displayData = JSON.stringify(JSON.parse(data), null, 2).slice(0, 1000);
                if (data.length > 1000) displayData += '...\\n[truncated]';
              } catch {}
            } else {
              displayData = data.slice(0, 500);
              if (data.length > 500) displayData += '...\\n[truncated]';
            }

            const successClass = res.ok ? 'success' : 'error';
            resultDiv.innerHTML = \`
              <div class="result \${successClass}">
                <strong>\${label}</strong>
                Status: \${res.status} (\${res.statusText})
                Latency: \${elapsed}ms

                \${displayData}
              </div>
            \`;
          } catch (err) {
            resultDiv.innerHTML = \`
              <div class="result error">
                <strong>\${label}</strong>
                ❌ Request failed

                \${err.message}
              </div>
            \`;
          } finally {
            button.disabled = false;
            button.textContent = button.textContent.replace('Testing...', label);
          }
        }

        async function testImageToSocials() {
          const resultDiv = document.getElementById('testResult');
          const button = event.target;

          button.disabled = true;
          button.textContent = '⏳ Generating...';
          resultDiv.innerHTML = '';

          const startTime = Date.now();
          try {
            const res = await fetch('/api/test/image-to-socials', { method: 'POST' });
            const elapsed = Date.now() - startTime;
            const data = await res.json();

            const successClass = res.ok ? 'success' : 'error';
            resultDiv.innerHTML = \`
              <div class="result \${successClass}">
                <strong>🖼️ Image to Socials</strong>
                Status: \${res.status}
                Latency: \${elapsed}ms

                \${res.ok ? \`✅ \${data.message}\\n\\nPersona: \${data.persona.name} (@\${data.persona.username})\\nImage: \${data.post.image || 'generation attempted'}\\n\\nMarketing Result:\\n\${JSON.stringify(data.marketing, null, 2)}\` : \`❌ \${data.error}\`}
              </div>
            \`;
          } catch (err) {
            resultDiv.innerHTML = \`
              <div class="result error">
                <strong>🖼️ Image to Socials</strong>
                ❌ Request failed

                \${err.message}
              </div>
            \`;
          } finally {
            button.disabled = false;
            button.textContent = '🖼️ Image → Socials';
          }
        }
      </script>
    </body>
    </html>
  `;

  return new NextResponse(html, {
    status: httpStatus,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
