export const dynamic = "force-static";

export default function DocsPage() {
  return (
    <main style={{ padding: 32, maxWidth: 720 }}>
      <h1>API Docs</h1>
      <p>
        OpenAPI/Swagger UI will live here once we start auto-generating schemas from
        route handlers. For now, each migrated endpoint lists its contract in the
        route file and in <code>docs/api-handoff-1-routes.md</code>.
      </p>

      <h2>Currently live</h2>
      <ul>
        <li>
          <code>GET /api/health</code> &mdash; DB / Redis / xAI / Anthropic reachability
          report. Returns <code>200</code> when ok/degraded, <code>503</code> when down.
        </li>
        <li>
          <code>GET /api/feed</code> &mdash; public &ldquo;For You&rdquo; feed (Slice A only:
          default initial-load mode). Other modes (cursor / shuffle / following / breaking /
          premieres / premiere_counts / following_list) return <code>501</code> until later
          slices land. Optional <code>?limit=N&amp;session_id=X</code>.
        </li>
      </ul>

      <h2>Next to migrate</h2>
      <ul>
        <li>
          <code>GET /api/feed</code> Slice B &mdash; cursor pagination for For You.
        </li>
      </ul>

      <p style={{ marginTop: 24, color: "#888", fontSize: 12 }}>
        See <a href="/status">/status</a> for live system health.
      </p>
    </main>
  );
}
