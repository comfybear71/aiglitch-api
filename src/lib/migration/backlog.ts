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
    path: "/api/ai-trading",
    methods: ["GET", "POST"],
    blocker: "phase-8",
    sessions: 2,
    complexity: "large",
    notes:
      "AI personas trading SOL/BUDJU. Touches Solana RPC + budju-trading lib. Audit 2026-05-25: zero on-chain signing — pure DB simulation, could ship with standard approval ceremony.",
  },
  {
    path: "/api/budju-trading",
    methods: ["GET", "POST"],
    blocker: "phase-8",
    sessions: 1,
    complexity: "small",
    notes:
      "BUDJU token trading user-facing endpoint. Audit 2026-05-25: 59 LOC stub — pure DB ledger, no real signing.",
  },
  {
    path: "/api/admin/budju-trading",
    methods: ["GET", "POST"],
    blocker: "phase-8",
    sessions: 2,
    complexity: "large",
    notes:
      "Admin BUDJU trading controls. Audit 2026-05-25: 990 LOC, 28 sign calls, real treasury-key SPL transfers. This is the genuine high-risk one — per-endpoint decision-#6 approval needed.",
    prereqs: ["/api/budju-trading"],
  },
  {
    path: "/api/bridge",
    methods: ["POST"],
    blocker: "phase-8",
    sessions: 1,
    complexity: "medium",
    notes:
      "Cross-chain bridge. Audit 2026-05-25: pure DB ledger, no real signing.",
  },
  {
    path: "/api/exchange",
    methods: ["GET", "POST"],
    blocker: "phase-8",
    sessions: 1,
    complexity: "medium",
    notes:
      "GLITCH/SOL/USDC exchange. Audit 2026-05-25: pure DB ledger, no real signing.",
  },
  {
    path: "/api/otc-swap",
    methods: ["GET", "POST"],
    blocker: "phase-8",
    sessions: 2,
    complexity: "large",
    notes:
      "OTC swap matching engine. Audit 2026-05-25: 689 LOC, 4 sign calls, 9 chain reads — REAL treasury-side SPL transfers. Genuine high-risk per-endpoint decision-#6 approval needed.",
  },
  {
    path: "/api/persona-trade",
    methods: ["GET", "POST"],
    blocker: "phase-8",
    sessions: 1,
    complexity: "medium",
    notes:
      "Buy/sell shares in AI personas. Audit 2026-05-25: pure DB simulation, no real signing.",
  },
  {
    path: "/api/solana",
    methods: ["GET", "POST"],
    blocker: "phase-8",
    sessions: 1,
    complexity: "medium",
    notes:
      "Legacy ?action=-based Solana proxy. /balance + /token-balance already split out in v1.18.0. Remaining actions: link_phantom, validate_transfer, claim_airdrop, mode, elonbot_status — mostly DB simulation.",
  },
  {
    path: "/api/trading",
    methods: ["GET", "POST"],
    blocker: "phase-8",
    sessions: 1,
    complexity: "medium",
    notes: "Generic trading endpoint.",
  },
  {
    path: "/api/wallet",
    methods: ["GET", "POST"],
    blocker: "phase-8",
    sessions: 2,
    complexity: "large",
    notes:
      "Wallet state + balance + tx history. Simulated wallet table — generates fake base58 addresses, NOT real keypairs (per legacy design).",
  },
  {
    path: "/api/wallet/verify",
    methods: ["POST"],
    blocker: "phase-8",
    sessions: 1,
    complexity: "small",
    notes: "Verify wallet signature for ownership proof.",
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
    path: "/api/admin/init-persona",
    methods: ["POST"],
    blocker: "phase-8",
    sessions: 1,
    complexity: "medium",
    notes:
      "Initialise persona + Solana wallet + GLITCH balance. Also depends on AI image-gen — partially blocked beyond Phase 8.",
  },
  {
    path: "/api/admin/personas/generate-missing-wallets",
    methods: ["POST"],
    blocker: "phase-8",
    sessions: 1,
    complexity: "small",
    notes:
      "Generate Solana wallets for personas missing them. System-custodial of *persona* keypairs (same model as treasury/ElonBot — not user-custodial). Needs decision-#6 approval.",
  },
  {
    path: "/api/admin/token-metadata",
    methods: ["POST"],
    blocker: "phase-8",
    sessions: 2,
    complexity: "medium",
    notes:
      "Metaplex on-chain metadata writes for §GLITCH token. 439 LOC, real mint-authority signing — genuine high-risk decision-#6 approval needed.",
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

  // ── Phase 9 — OAuth callbacks ──────────────────────────────
  {
    path: "/api/auth/google",
    methods: ["GET"],
    blocker: "phase-9",
    sessions: 1,
    complexity: "small",
    notes: "Google OAuth start.",
  },
  {
    path: "/api/auth/callback/google",
    methods: ["GET"],
    blocker: "phase-9",
    sessions: 1,
    complexity: "medium",
    notes: "Google OAuth callback.",
  },
  {
    path: "/api/auth/github",
    methods: ["GET"],
    blocker: "phase-9",
    sessions: 1,
    complexity: "small",
    notes: "GitHub OAuth start.",
  },
  {
    path: "/api/auth/callback/github",
    methods: ["GET"],
    blocker: "phase-9",
    sessions: 1,
    complexity: "medium",
    notes: "GitHub OAuth callback.",
  },
  {
    path: "/api/auth/twitter",
    methods: ["GET"],
    blocker: "phase-9",
    sessions: 1,
    complexity: "small",
    notes: "X/Twitter OAuth start.",
  },
  {
    path: "/api/auth/callback/twitter",
    methods: ["GET"],
    blocker: "phase-9",
    sessions: 1,
    complexity: "medium",
    notes: "X/Twitter OAuth callback.",
  },
  {
    path: "/api/auth/tiktok",
    methods: ["GET"],
    blocker: "phase-9",
    sessions: 1,
    complexity: "small",
    notes: "TikTok OAuth start (deprecated by TikTok but kept).",
  },
  {
    path: "/api/auth/callback/tiktok",
    methods: ["GET"],
    blocker: "phase-9",
    sessions: 1,
    complexity: "medium",
    notes: "TikTok OAuth callback.",
  },
  {
    path: "/api/auth/youtube",
    methods: ["GET"],
    blocker: "phase-9",
    sessions: 1,
    complexity: "small",
    notes: "YouTube/Google OAuth start.",
  },
  {
    path: "/api/auth/callback/youtube",
    methods: ["GET"],
    blocker: "phase-9",
    sessions: 1,
    complexity: "medium",
    notes: "YouTube OAuth callback.",
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
