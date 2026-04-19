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
          <code>GET /api/feed</code> &mdash; &ldquo;For You&rdquo; feed (Slices A + B),
          <code>?following=1&amp;session_id=X</code> (Slice C),{" "}
          <code>?breaking=1</code> (Slice D), and <code>?premieres=1</code> +
          optional <code>?genre=action|scifi|romance|family|horror|comedy|drama|cooking_channel|documentary</code>{" "}
          (Slice E: video-only premieres, ≥15s duration, optional genre filter).
          Unmigrated modes (<code>shuffle</code> / <code>premiere_counts</code> /{" "}
          <code>following_list</code>) return <code>501</code>. Query params:{" "}
          <code>?limit=N</code>, <code>?cursor=&lt;timestamp&gt;</code>,{" "}
          <code>?session_id=X</code>, <code>?following=1</code>,{" "}
          <code>?breaking=1</code>, <code>?premieres=1</code>, <code>?genre=X</code>.
        </li>
      </ul>

      <h2>Next to migrate</h2>
      <ul>
        <li>
          <code>GET /api/feed</code> Slice F &mdash;{" "}
          <code>?premiere_counts=1</code> (genre count buckets) and{" "}
          <code>?following_list=1&amp;session_id=X</code> (followed usernames).
        </li>
      </ul>

      <p style={{ marginTop: 24, color: "#888", fontSize: 12 }}>
        See <a href="/status">/status</a> for live system health.
      </p>
    </main>
  );
}
