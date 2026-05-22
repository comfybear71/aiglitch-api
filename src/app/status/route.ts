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
        * { box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #f9f9f9; }
        main { padding: 32px; max-width: 900px; margin: 0 auto; }
        h1 { margin: 0 0 8px 0; font-size: 28px; }
        .header { margin-bottom: 32px; }
        p { margin: 0 0 16px 0; }
        strong { color: ${statusColor[report.status]}; }
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
          max-height: 300px;
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
            <strong>${report.status.toUpperCase()}</strong>
            <span style="color: #666;">v${report.version} · ${report.timestamp}</span>
          </p>
        </div>

        <section>
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

                \${res.ok ? \`✅ \${data.message}\\n\\nPersona: \${data.persona.name} (@\${data.persona.username})\\nImage: \${data.post.image || 'generation attempted'}\\n\\nMarketing Result:\\n\${JSON.stringify(data.marketing, null, 2).slice(0, 500)}\` : \`❌ \${data.error}\`}
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
