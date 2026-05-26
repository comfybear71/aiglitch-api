/**
 * Pending-route catalogue — what's NOT yet ported.
 *
 * Single source of truth for the migration backlog. Drives:
 *   • `/api/admin/migration/status` (JSON for the dashboard)
 *   • `BACKLOG.md` (human-readable, regenerated from this file)
 *
 * Add/remove rows here as routes ship. Each entry carries its
 * blocker category so the dashboard can group them and you can
 * pick a category when you're ready to spend a session on it.
 */

export type Blocker =
  | "phase-8" // Trading/wallet/Solana — explicit greenlight per CLAUDE.md #6
  | "phase-9" // OAuth callbacks — last per CLAUDE.md #7
  | "dead-code" // Depends on retired pipeline — delete from legacy, do NOT port
  | "telegram-bot-engine" // Needs persona-mode + content-handler libs
  | "permanent-legacy" // Stays on legacy domain by design
  | "external-dep" // Needs new npm dep
  | "small-helper-port" // Needs small (<200 line) helper ported into existing lib
  | "chunky-single"; // Doable single-session, but big

export type Complexity = "small" | "medium" | "large" | "huge";

export interface PendingRoute {
  path: string;
  /** HTTP methods the legacy route exposes. */
  methods: string[];
  blocker: Blocker;
  /** Rough estimate of session count to ship (1 session ≈ $20-40 cost). */
  sessions: number;
  complexity: Complexity;
  /** Why it's blocked + what would unblock it. */
  notes: string;
  /** Other routes/libs this route waits on. */
  prereqs?: string[];
}

export const PENDING_ROUTES: PendingRoute[] = [
  // ── Phase 8 — Trading / Wallet / Solana ────────────────────
  {
    path: "/api/exchange",
    methods: ["GET", "POST"],
    blocker: "phase-8",
    sessions: 1,
    complexity: "medium",
    notes:
      "GLITCH/SOL/USDC exchange. Audit 2026-05-26: pure DB ledger + Jupiter price API (read-only). Last route in the Phase 8 simulation batch under existing approval.",
  },
  {
    path: "/api/marketplace",
    methods: ["GET", "POST"],
    blocker: "phase-8",
    sessions: 1,
    complexity: "large",
    notes: "NFT marketplace purchase + Phantom signing.",
  },
  {
    path: "/api/hatch",
    methods: ["POST"],
    blocker: "phase-8",
    sessions: 1,
    complexity: "large",
    notes:
      "Hatch persona + mint NFT (Solana). Phase 4 deferred per decision #9 (iOS).",
  },
  {
    path: "/api/auth/sign-tx",
    methods: ["GET", "POST"],
    blocker: "phase-8",
    sessions: 1,
    complexity: "medium",
    notes: "Cross-device tx signing bridge (iPad QR → phone signs).",
  },
  {
    path: "/api/auth/wallet-qr",
    methods: ["GET", "POST"],
    blocker: "phase-8",
    sessions: 1,
    complexity: "small",
    notes: "Public wallet QR auth (Ed25519 signature verify).",
  },

  // ── Dead code (depends on retired director-movies pipeline) ─
  // These routes import @/lib/content/director-movies which was
  // intentionally deleted from aiglitch-api in v1.13.1. They will
  // never be ported — they'll be deleted from the legacy aiglitch
  // repo as part of Phase 10 cleanup.
  {
    path: "/api/admin/screenplay",
    methods: ["GET", "POST"],
    blocker: "dead-code",
    sessions: 0,
    complexity: "small",
    notes: "Director-movies-dependent. Delete from legacy.",
    prereqs: ["@/lib/content/director-movies (retired)"],
  },
  {
    path: "/api/admin/generate-news",
    methods: ["POST"],
    blocker: "dead-code",
    sessions: 0,
    complexity: "small",
    notes: "Director-movies-dependent. Delete from legacy.",
    prereqs: ["@/lib/content/director-movies (retired)"],
  },
  {
    path: "/api/admin/generate-channel-video",
    methods: ["POST"],
    blocker: "dead-code",
    sessions: 0,
    complexity: "small",
    notes: "Director-movies-dependent. Delete from legacy.",
    prereqs: ["@/lib/content/director-movies (retired)"],
  },
  {
    path: "/api/admin/channels/generate-content",
    methods: ["POST"],
    blocker: "dead-code",
    sessions: 0,
    complexity: "small",
    notes: "Director-movies-dependent. Delete from legacy.",
    prereqs: ["@/lib/content/director-movies (retired)"],
  },
  {
    path: "/api/generate-director-movie",
    methods: ["GET", "POST"],
    blocker: "dead-code",
    sessions: 0,
    complexity: "small",
    notes:
      "Cron — director-led movie production pipeline. Delete from legacy (cron entry already removed in v1.13.1).",
    prereqs: ["@/lib/content/director-movies (retired)"],
  },

  // ── Permanent legacy ───────────────────────────────────────
  {
    path: "/api/image-proxy",
    methods: ["GET"],
    blocker: "permanent-legacy",
    sessions: 0,
    complexity: "small",
    notes:
      "Instagram can't fetch Vercel Blob URLs — this proxy must stay reachable on aiglitch.app domain. Per CLAUDE.md, treat as permanent legacy. Sharp dep + image resize.",
  },
  {
    path: "/api/video-proxy",
    methods: ["GET"],
    blocker: "permanent-legacy",
    sessions: 0,
    complexity: "small",
    notes: "Same as image-proxy — IG can't fetch Blob videos.",
  },
];

/** Group pending routes by their blocker for the dashboard. */
export function groupByBlocker(): Record<Blocker, PendingRoute[]> {
  const groups = {} as Record<Blocker, PendingRoute[]>;
  for (const route of PENDING_ROUTES) {
    (groups[route.blocker] ??= []).push(route);
  }
  return groups;
}

export const BLOCKER_LABELS: Record<Blocker, string> = {
  "phase-8": "Phase 8 — Trading / Wallet / Solana (needs greenlight)",
  "phase-9": "Phase 9 — OAuth callbacks (last per migration plan)",
  "dead-code": "Dead code — depends on retired pipeline, delete from legacy",
  "telegram-bot-engine": "Telegram bot engine port required",
  "permanent-legacy": "Permanent legacy — stays on aiglitch.app by design",
  "external-dep": "Needs new npm dependency",
  "small-helper-port": "Small helper port (unblocked, 1-session Haiku wins)",
  "chunky-single": "Chunky single-session port (1-2 sessions)",
};
