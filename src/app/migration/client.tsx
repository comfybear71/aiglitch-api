"use client";

import { useEffect, useMemo, useState } from "react";

// ── Types mirroring /api/admin/migration/status response ──────────

type Blocker =
  | "phase-8"
  | "phase-9"
  | "marketing-lib"
  | "director-movies-lib"
  | "telegram-bot-engine"
  | "permanent-legacy"
  | "external-dep"
  | "chunky-single";

interface PortedRoute {
  path: string;
  methods: string[];
  file: string;
}
interface PendingRoute {
  path: string;
  methods: string[];
  blocker: Blocker;
  sessions: number;
  complexity: "small" | "medium" | "large" | "huge";
  notes: string;
  prereqs?: string[];
}
interface StatusResponse {
  summary: {
    ported_count: number;
    pending_count: number;
    total_count: number;
    percent_done: number;
    by_blocker: Record<Blocker, { count: number; sessions: number }>;
  };
  ported: PortedRoute[];
  pending: PendingRoute[];
  groups: {
    blocker: Blocker;
    label: string;
    count: number;
    sessions_estimated: number;
    routes: PendingRoute[];
  }[];
}

interface TestResponse {
  ok: boolean;
  status: number | null;
  duration_ms: number;
  body: unknown;
  error: string | null;
  log_id: string | null;
}

// ── Styles — inline to match the existing /status page vibe ───────

const styles = {
  main: {
    padding: 32,
    maxWidth: 1100,
    margin: "0 auto",
    fontFamily:
      "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
  } as const,
  h1: { marginTop: 0, marginBottom: 4 } as const,
  sub: { color: "#666", marginTop: 0, marginBottom: 24 } as const,
  tabs: {
    display: "flex",
    gap: 4,
    borderBottom: "1px solid #e5e7eb",
    marginBottom: 24,
  } as const,
  tab: (active: boolean) =>
    ({
      padding: "10px 16px",
      border: "none",
      background: active ? "#111" : "transparent",
      color: active ? "#fff" : "#444",
      borderRadius: "6px 6px 0 0",
      cursor: "pointer",
      fontSize: 14,
      fontWeight: 500,
    }) as const,
  card: {
    background: "#f9fafb",
    border: "1px solid #e5e7eb",
    borderRadius: 8,
    padding: 16,
    marginBottom: 16,
  } as const,
  stat: {
    display: "inline-block",
    marginRight: 24,
    fontSize: 14,
  } as const,
  statNum: { fontSize: 22, fontWeight: 600, display: "block" } as const,
  progressBar: {
    background: "#e5e7eb",
    borderRadius: 4,
    overflow: "hidden",
    height: 8,
    width: "100%",
    marginTop: 6,
    marginBottom: 6,
  } as const,
  progressFill: (pct: number) =>
    ({
      background: "#22c55e",
      height: "100%",
      width: `${pct}%`,
      transition: "width 300ms",
    }) as const,
  table: {
    width: "100%",
    borderCollapse: "collapse" as const,
    fontSize: 13,
  } as const,
  th: {
    textAlign: "left" as const,
    padding: "8px 6px",
    borderBottom: "1px solid #e5e7eb",
    fontWeight: 600,
    color: "#374151",
  } as const,
  td: {
    padding: "8px 6px",
    borderBottom: "1px solid #f3f4f6",
    verticalAlign: "top" as const,
  } as const,
  code: {
    fontFamily: "ui-monospace, Menlo, monospace",
    fontSize: 12,
    background: "#f3f4f6",
    padding: "1px 4px",
    borderRadius: 3,
  } as const,
  btn: (kind: "primary" | "ghost" = "ghost") =>
    ({
      padding: "4px 10px",
      border: "1px solid #d1d5db",
      borderRadius: 4,
      background: kind === "primary" ? "#111" : "#fff",
      color: kind === "primary" ? "#fff" : "#111",
      cursor: "pointer",
      fontSize: 12,
      fontWeight: 500,
    }) as const,
  input: {
    width: "100%",
    padding: "6px 8px",
    border: "1px solid #d1d5db",
    borderRadius: 4,
    fontSize: 13,
    fontFamily: "ui-monospace, Menlo, monospace",
    boxSizing: "border-box" as const,
  } as const,
  select: {
    padding: "6px 8px",
    border: "1px solid #d1d5db",
    borderRadius: 4,
    fontSize: 13,
  } as const,
  responseBox: {
    background: "#0a0a0a",
    color: "#e5e7eb",
    padding: 12,
    borderRadius: 6,
    maxHeight: 400,
    overflow: "auto",
    fontFamily: "ui-monospace, Menlo, monospace",
    fontSize: 12,
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
  } as const,
  row: { display: "flex", gap: 8, alignItems: "center", marginBottom: 8 } as const,
  label: {
    fontSize: 12,
    fontWeight: 600,
    color: "#374151",
    marginBottom: 4,
    display: "block",
  } as const,
};

const BLOCKER_COLOUR: Record<Blocker, string> = {
  "phase-8": "#dc2626",
  "phase-9": "#ea580c",
  "marketing-lib": "#ca8a04",
  "director-movies-lib": "#7c3aed",
  "telegram-bot-engine": "#0891b2",
  "permanent-legacy": "#6b7280",
  "external-dep": "#2563eb",
  "chunky-single": "#db2777",
};

// ── Main component ────────────────────────────────────────────────

export default function MigrationClient() {
  const [tab, setTab] = useState<"status" | "test" | "logs">("status");
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusErr, setStatusErr] = useState<string | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);

  const loadStatus = async () => {
    try {
      const res = await fetch("/api/admin/migration/status");
      if (res.status === 401) {
        setNeedsLogin(true);
        setStatusErr(null);
        return;
      }
      if (!res.ok) {
        setStatusErr(`HTTP ${res.status}`);
        return;
      }
      setNeedsLogin(false);
      setStatus((await res.json()) as StatusResponse);
    } catch (err) {
      setStatusErr(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void loadStatus();
  }, []);

  return (
    <main style={styles.main}>
      <h1 style={styles.h1}>Migration Dashboard</h1>
      <p style={styles.sub}>
        Live status, endpoint tester, and request logs for the
        aiglitch.app → aiglitch-api strangler migration.
      </p>

      <div style={styles.tabs}>
        <button style={styles.tab(tab === "status")} onClick={() => setTab("status")}>
          Status
        </button>
        <button style={styles.tab(tab === "test")} onClick={() => setTab("test")}>
          Test
        </button>
        <button style={styles.tab(tab === "logs")} onClick={() => setTab("logs")}>
          Logs (coming soon)
        </button>
      </div>

      {needsLogin ? (
        <LoginPrompt onSuccess={loadStatus} />
      ) : statusErr ? (
        <div style={{ ...styles.card, borderColor: "#fecaca", background: "#fef2f2" }}>
          <strong>Couldn&apos;t load status:</strong> {statusErr}
        </div>
      ) : !status ? (
        <div style={styles.card}>Loading…</div>
      ) : tab === "status" ? (
        <StatusTab status={status} />
      ) : tab === "test" ? (
        <TestTab status={status} />
      ) : (
        <div style={styles.card}>Logs tab ships in session 3.</div>
      )}
    </main>
  );
}

// ── Admin login prompt ────────────────────────────────────────────

function LoginPrompt({ onSuccess }: { onSuccess: () => void | Promise<void> }) {
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setErr(null);
    try {
      const res = await fetch("/api/auth/admin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        setErr("Invalid credentials");
        setSubmitting(false);
        return;
      }
      setPassword("");
      await onSuccess();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ ...styles.card, maxWidth: 400 }}>
      <h2 style={{ marginTop: 0, fontSize: 18 }}>Admin login required</h2>
      <p style={{ color: "#6b7280", fontSize: 13, marginTop: 0 }}>
        Enter the admin password to access the dashboard. Session lasts 7 days.
      </p>
      <form onSubmit={submit}>
        <input
          type="password"
          autoFocus
          placeholder="Admin password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ ...styles.input, marginBottom: 8 }}
        />
        {err && (
          <div style={{ color: "#ef4444", fontSize: 12, marginBottom: 8 }}>{err}</div>
        )}
        <button
          type="submit"
          style={styles.btn("primary")}
          disabled={submitting || !password}
        >
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

// ── Status tab ────────────────────────────────────────────────────

function StatusTab({ status }: { status: StatusResponse }) {
  const [expandedBlocker, setExpandedBlocker] = useState<Blocker | null>(null);
  const [portedFilter, setPortedFilter] = useState("");

  const filteredPorted = useMemo(() => {
    if (!portedFilter) return status.ported;
    const q = portedFilter.toLowerCase();
    return status.ported.filter((r) => r.path.toLowerCase().includes(q));
  }, [status.ported, portedFilter]);

  return (
    <>
      <div style={styles.card}>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
          <div style={styles.stat}>
            <span style={styles.statNum}>{status.summary.ported_count}</span>
            <span>ported</span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statNum}>{status.summary.pending_count}</span>
            <span>pending</span>
          </div>
          <div style={styles.stat}>
            <span style={styles.statNum}>{status.summary.percent_done}%</span>
            <span>done</span>
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={styles.progressBar}>
              <div style={styles.progressFill(status.summary.percent_done)} />
            </div>
            <div style={{ fontSize: 12, color: "#6b7280" }}>
              {status.summary.ported_count} of {status.summary.total_count} routes
            </div>
          </div>
        </div>
      </div>

      <h2 style={{ fontSize: 18, marginTop: 32, marginBottom: 12 }}>
        Pending — by blocker
      </h2>
      {status.groups.map((group) => (
        <div key={group.blocker} style={styles.card}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              cursor: "pointer",
            }}
            onClick={() =>
              setExpandedBlocker(expandedBlocker === group.blocker ? null : group.blocker)
            }
          >
            <div>
              <span
                style={{
                  display: "inline-block",
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: BLOCKER_COLOUR[group.blocker],
                  marginRight: 8,
                }}
              />
              <strong>{group.label}</strong>
              <span style={{ color: "#6b7280", marginLeft: 12 }}>
                {group.count} routes • ~{group.sessions_estimated} sessions
              </span>
            </div>
            <button style={styles.btn()}>
              {expandedBlocker === group.blocker ? "Hide" : "Show"}
            </button>
          </div>
          {expandedBlocker === group.blocker && (
            <table style={{ ...styles.table, marginTop: 12 }}>
              <thead>
                <tr>
                  <th style={styles.th}>Route</th>
                  <th style={styles.th}>Methods</th>
                  <th style={styles.th}>Sessions</th>
                  <th style={styles.th}>Notes</th>
                </tr>
              </thead>
              <tbody>
                {group.routes.map((r) => (
                  <tr key={r.path}>
                    <td style={styles.td}>
                      <code style={styles.code}>{r.path}</code>
                    </td>
                    <td style={styles.td}>{r.methods.join(", ")}</td>
                    <td style={styles.td}>{r.sessions}</td>
                    <td style={styles.td}>
                      {r.notes}
                      {r.prereqs?.length ? (
                        <div style={{ color: "#6b7280", marginTop: 4 }}>
                          <strong>Prereqs:</strong>{" "}
                          {r.prereqs.map((p) => (
                            <code key={p} style={styles.code}>
                              {p}
                            </code>
                          ))}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}

      <h2 style={{ fontSize: 18, marginTop: 32, marginBottom: 12 }}>
        Ported ({status.ported.length})
      </h2>
      <input
        type="text"
        placeholder="Filter ported routes…"
        value={portedFilter}
        onChange={(e) => setPortedFilter(e.target.value)}
        style={{ ...styles.input, marginBottom: 12 }}
      />
      <div style={styles.card}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Route</th>
              <th style={styles.th}>Methods</th>
              <th style={styles.th}>File</th>
            </tr>
          </thead>
          <tbody>
            {filteredPorted.map((r) => (
              <tr key={r.path}>
                <td style={styles.td}>
                  <code style={styles.code}>{r.path}</code>
                </td>
                <td style={styles.td}>{r.methods.join(", ")}</td>
                <td style={styles.td}>
                  <code style={{ ...styles.code, fontSize: 11 }}>{r.file}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ── Test tab ──────────────────────────────────────────────────────

function TestTab({ status }: { status: StatusResponse }) {
  const allRoutes = useMemo(() => {
    const portedPaths = new Set(status.ported.map((r) => r.path));
    return status.ported.map((r) => ({
      path: r.path,
      methods: r.methods,
      ported: true,
      note: portedPaths.has(r.path) ? "ported" : "pending",
    }));
  }, [status.ported]);

  const [path, setPath] = useState(allRoutes[0]?.path ?? "");
  const [method, setMethod] = useState("GET");
  const [query, setQuery] = useState("");
  const [body, setBody] = useState("");
  const [response, setResponse] = useState<TestResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // When route changes, reset method to first available
  useEffect(() => {
    const hit = allRoutes.find((r) => r.path === path);
    if (hit && !hit.methods.includes(method)) {
      setMethod(hit.methods[0] ?? "GET");
    }
  }, [path, allRoutes, method]);

  const currentMethods =
    allRoutes.find((r) => r.path === path)?.methods ?? ["GET"];

  const send = async () => {
    setLoading(true);
    setErr(null);
    setResponse(null);
    try {
      const queryObj: Record<string, string> = {};
      if (query.trim()) {
        for (const pair of query.split("&").filter(Boolean)) {
          const [k, v] = pair.split("=");
          if (k) queryObj[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
        }
      }
      let parsedBody: unknown = undefined;
      if (body.trim() && method !== "GET") {
        try {
          parsedBody = JSON.parse(body);
        } catch {
          setErr("Body is not valid JSON");
          setLoading(false);
          return;
        }
      }
      const res = await fetch("/api/admin/migration/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path,
          method,
          query: Object.keys(queryObj).length ? queryObj : undefined,
          body: parsedBody,
        }),
      });
      if (res.status === 401) {
        setErr("Not logged in as admin.");
        return;
      }
      const json = (await res.json()) as TestResponse;
      setResponse(json);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const curl = useMemo(() => {
    const queryStr = query.trim() ? `?${query.trim()}` : "";
    const base =
      typeof window !== "undefined" ? window.location.origin : "https://api.aiglitch.app";
    const escaped = (body || "").replace(/'/g, "'\\''");
    const bodyPart =
      body.trim() && method !== "GET"
        ? ` \\\n  -H 'content-type: application/json' \\\n  -d '${escaped}'`
        : "";
    return `curl -X ${method} '${base}${path}${queryStr}'${bodyPart}`;
  }, [method, path, query, body]);

  return (
    <>
      <div style={styles.card}>
        <div style={styles.row}>
          <div style={{ flex: 3 }}>
            <label style={styles.label}>Route</label>
            <select
              style={{ ...styles.select, width: "100%" }}
              value={path}
              onChange={(e) => setPath(e.target.value)}
            >
              {allRoutes.map((r) => (
                <option key={r.path} value={r.path}>
                  {r.path}
                </option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label style={styles.label}>Method</label>
            <select
              style={{ ...styles.select, width: "100%" }}
              value={method}
              onChange={(e) => setMethod(e.target.value)}
            >
              {currentMethods.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label style={styles.label}>Query (e.g. session_id=abc&limit=10)</label>
          <input
            type="text"
            placeholder="key=value&key2=value2"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={styles.input}
          />
        </div>

        {method !== "GET" && (
          <div style={{ marginTop: 8 }}>
            <label style={styles.label}>Body (JSON)</label>
            <textarea
              placeholder='{"key": "value"}'
              value={body}
              onChange={(e) => setBody(e.target.value)}
              style={{ ...styles.input, minHeight: 100, resize: "vertical" }}
            />
          </div>
        )}

        <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
          <button
            style={styles.btn("primary")}
            onClick={send}
            disabled={loading || !path}
          >
            {loading ? "Sending…" : "Send"}
          </button>
          <button
            style={styles.btn()}
            onClick={() => navigator.clipboard.writeText(curl)}
            title={curl}
          >
            Copy as curl
          </button>
        </div>
      </div>

      {err && (
        <div style={{ ...styles.card, borderColor: "#fecaca", background: "#fef2f2" }}>
          <strong>Error:</strong> {err}
        </div>
      )}

      {response && (
        <div style={styles.card}>
          <div
            style={{
              display: "flex",
              gap: 16,
              marginBottom: 12,
              fontSize: 13,
              alignItems: "center",
            }}
          >
            <span>
              <strong>Status:</strong>{" "}
              <span
                style={{
                  color:
                    response.status && response.status >= 400
                      ? "#ef4444"
                      : response.ok
                        ? "#22c55e"
                        : "#6b7280",
                }}
              >
                {response.status ?? "network error"}
              </span>
            </span>
            <span>
              <strong>Duration:</strong> {response.duration_ms}ms
            </span>
            {response.log_id && (
              <span style={{ color: "#6b7280", fontSize: 12 }}>
                log: <code style={styles.code}>{response.log_id}</code>
              </span>
            )}
          </div>
          <pre style={styles.responseBox}>
            {response.error
              ? `Error: ${response.error}`
              : typeof response.body === "string"
                ? response.body
                : JSON.stringify(response.body, null, 2)}
          </pre>
        </div>
      )}
    </>
  );
}
