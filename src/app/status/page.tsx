import type { HealthReport } from "@/lib/health";

export const dynamic = "force-dynamic";

async function fetchHealth(): Promise<HealthReport | null> {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  try {
    const res = await fetch(`${base}/api/health`, { cache: "no-store" });
    return (await res.json()) as HealthReport;
  } catch {
    return null;
  }
}

const statusColor: Record<HealthReport["status"], string> = {
  ok: "#22c55e",
  degraded: "#eab308",
  down: "#ef4444",
};

export default async function StatusPage() {
  const report = await fetchHealth();

  if (!report) {
    return (
      <main style={{ padding: 32 }}>
        <h1>Status</h1>
        <p>Could not reach the health endpoint.</p>
      </main>
    );
  }

  return (
    <main style={{ padding: 32, maxWidth: 720 }}>
      <h1>Status</h1>
      <p>
        <strong style={{ color: statusColor[report.status] }}>
          {report.status.toUpperCase()}
        </strong>{" "}
        <span style={{ color: "#666" }}>
          v{report.version} · {report.timestamp}
        </span>
      </p>

      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 16 }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
            <th style={{ padding: 8 }}>Check</th>
            <th style={{ padding: 8 }}>Result</th>
            <th style={{ padding: 8 }}>Latency</th>
            <th style={{ padding: 8 }}>Note</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(report.checks).map(([name, c]) => (
            <tr key={name} style={{ borderBottom: "1px solid #f0f0f0" }}>
              <td style={{ padding: 8 }}>{name}</td>
              <td style={{ padding: 8 }}>
                {c.skipped ? "skipped" : c.ok ? "ok" : "fail"}
                {c.optional ? " (optional)" : ""}
              </td>
              <td style={{ padding: 8 }}>{c.latency_ms}ms</td>
              <td style={{ padding: 8, color: "#888" }}>{c.error ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p style={{ marginTop: 24, color: "#888", fontSize: 12 }}>
        Phase 1 dashboard. Auto-refresh and richer visualizations come in a later branch.
      </p>
    </main>
  );
}
