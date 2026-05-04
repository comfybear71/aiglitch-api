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
  | "marketing-lib" // Needs @/lib/marketing/* port (3036 lines)
  | "director-movies-lib" // Needs @/lib/content/director-movies port (1626 lines)
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
      "AI personas trading SOL/BUDJU. Touches Solana RPC + budju-trading lib.",
  },
  {
    path: "/api/budju-trading",
    methods: ["GET", "POST"],
    blocker: "phase-8",
    sessions: 2,
    complexity: "large",
    notes: "BUDJU token trading. Solana RPC + market simulator.",
  },
  {
    path: "/api/admin/budju-trading",
    methods: ["GET", "POST"],
    blocker: "phase-8",
    sessions: 1,
    complexity: "medium",
    notes: "Admin BUDJU trading controls.",
    prereqs: ["/api/budju-trading"],
  },
  {
    path: "/api/bridge",
    methods: ["POST"],
    blocker: "phase-8",
    sessions: 1,
    complexity: "medium",
    notes: "Cross-chain bridge.",
  },
  {
    path: "/api/exchange",
    methods: ["GET", "POST"],
    blocker: "phase-8",
    sessions: 1,
    complexity: "medium",
    notes: "GLITCH/SOL/USDC exchange.",
  },
  {
    path: "/api/otc-swap",
    methods: ["GET", "POST"],
    blocker: "phase-8",
    sessions: 1,
    complexity: "medium",
    notes: "OTC swap matching engine.",
  },
  {
    path: "/api/persona-trade",
    methods: ["GET", "POST"],
    blocker: "phase-8",
    sessions: 1,
    complexity: "medium",
    notes: "Buy/sell shares in AI personas.",
  },
  {
    path: "/api/solana",
    methods: ["GET", "POST"],
    blocker: "phase-8",
    sessions: 1,
    complexity: "medium",
    notes: "Generic Solana RPC proxy.",
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
    notes: "Wallet state + balance + tx history.",
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
    notes: "Hatch persona + mint NFT (Solana). Marketing dep too.",
  },
  {
    path: "/api/admin/init-persona",
    methods: ["POST"],
    blocker: "phase-8",
    sessions: 1,
    complexity: "medium",
    notes: "Initialise persona + Solana wallet + GLITCH balance.",
  },
  {
    path: "/api/admin/nfts",
    methods: ["GET", "POST"],
    blocker: "phase-8",
    sessions: 1,
    complexity: "medium",
    notes: "Admin NFT reconciliation, Solana RPC for tx lookup.",
  },
  {
    path: "/api/admin/personas/generate-missing-wallets",
    methods: ["POST"],
    blocker: "phase-8",
    sessions: 1,
    complexity: "small",
    notes: "Generate Solana wallets for personas missing them.",
  },
  {
    path: "/api/admin/personas/refresh-wallet-balances",
    methods: ["POST"],
    blocker: "phase-8",
    sessions: 1,
    complexity: "small",
    notes: "Refresh on-chain balances for persona wallets.",
  },
  {
    path: "/api/admin/token-metadata",
    methods: ["POST"],
    blocker: "phase-8",
    sessions: 1,
    complexity: "medium",
    notes: "Metaplex on-chain metadata for §GLITCH token.",
  },
  {
    path: "/api/admin/wallet-auth",
    methods: ["GET", "POST"],
    blocker: "phase-8",
    sessions: 1,
    complexity: "medium",
    notes: "Admin wallet QR auth flow.",
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

  // ── Marketing lib needed ───────────────────────────────────
  {
    path: "/api/generate-ads",
    methods: ["GET", "POST"],
    blocker: "marketing-lib",
    sessions: 1,
    complexity: "large",
    notes: "Sponsored ad generation cron.",
    prereqs: ["@/lib/marketing/*"],
  },

  // ── Director-movies lib needed ─────────────────────────────
  {
    path: "/api/admin/screenplay",
    methods: ["GET", "POST"],
    blocker: "director-movies-lib",
    sessions: 1,
    complexity: "medium",
    notes: "Standalone screenplay generation tool.",
    prereqs: ["@/lib/content/director-movies"],
  },
  {
    path: "/api/admin/generate-news",
    methods: ["POST"],
    blocker: "director-movies-lib",
    sessions: 1,
    complexity: "medium",
    notes: "Breaking-news video generator.",
    prereqs: ["@/lib/content/director-movies"],
  },
  {
    path: "/api/admin/generate-channel-video",
    methods: ["POST"],
    blocker: "director-movies-lib",
    sessions: 1,
    complexity: "large",
    notes: "Multi-clip channel video.",
    prereqs: ["@/lib/content/director-movies", "@/lib/media/multi-clip"],
  },
  {
    path: "/api/admin/channels/generate-content",
    methods: ["POST"],
    blocker: "director-movies-lib",
    sessions: 1,
    complexity: "large",
    notes: "Full multi-scene channel video generation.",
    prereqs: ["@/lib/content/director-movies"],
  },
  {
    path: "/api/generate-director-movie",
    methods: ["GET", "POST"],
    blocker: "director-movies-lib",
    sessions: 1,
    complexity: "large",
    notes: "Cron — director-led movie production pipeline.",
    prereqs: ["@/lib/content/director-movies"],
  },
  {
    path: "/api/generate-persona-content",
    methods: ["GET", "POST"],
    blocker: "director-movies-lib",
    sessions: 1,
    complexity: "large",
    notes:
      "Persona content generation — multi-clip + director-movie polling.",
    prereqs: ["@/lib/content/director-movies", "@/lib/media/multi-clip"],
  },
  // ── Telegram bot engine ────────────────────────────────────
  // (All telegram bot engine routes ported — this section is empty.)

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

  // ── Chunky single-session ──────────────────────────────────
  {
    path: "/api/admin/elon-campaign",
    methods: ["GET", "POST"],
    blocker: "chunky-single",
    sessions: 2,
    complexity: "huge",
    notes:
      "Daily Elon-bait campaign (711 lines). Needs ELON_CAMPAIGN constant, mp4-concat lib, multi-clip lib, marketing/spread-post. Chunky even with deferrals.",
    prereqs: [
      "@/lib/bible/constants#ELON_CAMPAIGN",
      "@/lib/media/mp4-concat",
      "@/lib/media/multi-clip",
    ],
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
  "marketing-lib": "Marketing library port required (3036 lines)",
  "director-movies-lib": "Director-movies library port required (1626 lines)",
  "telegram-bot-engine": "Telegram bot engine port required",
  "permanent-legacy": "Permanent legacy — stays on aiglitch.app by design",
  "external-dep": "Needs new npm dependency",
  "small-helper-port": "Small helper port (unblocked, 1-session Haiku wins)",
  "chunky-single": "Chunky single-session port (1-2 sessions)",
};
