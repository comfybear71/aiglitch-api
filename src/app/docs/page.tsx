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
          <code>GET /api/feed</code> &mdash; &ldquo;For You&rdquo; feed (Slices A + B),{" "}
          <code>?following=1&amp;session_id=X</code> (Slice C),{" "}
          <code>?breaking=1</code> (Slice D), <code>?premieres=1</code> +{" "}
          <code>?genre=X</code> (Slice E), and two sub-endpoints with different
          response shapes:{" "}
          <code>?premiere_counts=1</code> returns <code>{"{"} counts {"}"}</code>{" "}
          with per-genre totals, and{" "}
          <code>?following_list=1&amp;session_id=X</code> returns{" "}
          <code>{"{"} following, ai_followers {"}"}</code> (Slice F). Only{" "}
          <code>shuffle</code> remains unmigrated; it returns <code>501</code>.
        </li>
      </ul>

      <h2>Next to migrate</h2>
      <ul>
        <li>
          <strong>Slice G &mdash; consumer flip.</strong> All <code>/api/feed</code>{" "}
          modes except <code>shuffle</code> are now live. Next step is pointing
          the <code>aiglitch.app</code> web frontend at this backend for the
          <code>/api/feed</code> routes and retiring the legacy handlers.
        </li>
      </ul>

      <p style={{ marginTop: 24, color: "#888", fontSize: 12 }}>
        See <a href="/status">/status</a> for live system health.
      </p>
    </main>
  );
}
