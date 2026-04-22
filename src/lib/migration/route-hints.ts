/**
 * Route hints — curated "what do I put in this field" cheat sheet for
 * the /migration Test tab.
 *
 * Keyed by the scanner's exact path (including `[bracketed]` dynamic
 * segments). When a tester picks a route:
 *   • If there's an entry here → pre-fill query + body + show setup notes.
 *   • If not → fall back to the route file's top JSDoc comment.
 *
 * Add entries freely as you discover the shape of new routes. Every
 * entry should be paste-and-fire: `query` + `body` combined must hit
 * the route cleanly against the deployed app with just an admin cookie
 * (if `needs_admin` is true).
 */

export interface RouteHintMethod {
  /** One-line plain-English description of what this method does. */
  description: string;
  /** Example query string (no leading `?`). Omit if the method takes none. */
  query?: string;
  /**
   * Example body for POST/PUT/PATCH/DELETE. Omit for GET. The tester
   * JSON.stringifys this on load; use a real object, not a string.
   */
  body?: unknown;
  /**
   * Free-text "heads up" shown in a yellow banner. Use for any
   * precondition the meatbag needs to know about before hitting Send:
   * admin cookie, needs a real row id, destructive, will email for real, etc.
   */
  setup_notes?: string;
  /**
   * True when the tester should explicitly flag that an admin cookie
   * is required. (The tester already forwards the cookie automatically
   * — this is purely for the "Heads up" banner.)
   */
  needs_admin?: boolean;
  /**
   * Optional path-parameter replacements — e.g. `{ "[id]": "post-123" }`.
   * When the tester fires the request it replaces each key with the
   * corresponding value in the path. Useful for routes like
   * `/api/post/[id]` where the path itself needs a real id to work.
   */
  path_params?: Record<string, string>;
}

export interface RouteHintEntry {
  /** Per-method hints. Key = HTTP method uppercase. */
  methods: Record<string, RouteHintMethod>;
}

export const ROUTE_HINTS: Record<string, RouteHintEntry> = {
  // ─── Health / public canaries ────────────────────────────────────────
  "/api/health": {
    methods: {
      GET: {
        description: "Liveness check — returns { ok: true, ... }.",
      },
    },
  },

  // ─── Feed (the big one with lots of modes) ───────────────────────────
  "/api/feed": {
    methods: {
      GET: {
        description:
          "For You feed. Pass ?session_id= for personalisation; add ?cursor=<ts>, ?following=1, ?breaking=1, ?premieres=1, or ?premiere_counts=1 for the variants.",
        query: "session_id=test-session-abc&limit=10",
      },
    },
  },

  // ─── Channels ────────────────────────────────────────────────────────
  "/api/channels": {
    methods: {
      GET: {
        description:
          "List all channels + host personas + subscription state. Pass ?session_id= to see your own subscribe state.",
        query: "session_id=test-session-abc",
      },
      POST: {
        description:
          "Toggle subscribe on a channel. Requires session_id + channel_slug + action.",
        body: {
          session_id: "test-session-abc",
          channel_slug: "ch-aitunes",
          action: "subscribe",
        },
        setup_notes:
          'Set `action` to "subscribe" or "unsubscribe". Creates a session if none exists.',
      },
    },
  },

  // ─── Posts + interactions ────────────────────────────────────────────
  "/api/post/[id]": {
    methods: {
      GET: {
        description:
          "Single post + comment thread + bookmark state for the given post id.",
        path_params: { "[id]": "REPLACE-WITH-REAL-POST-ID" },
        setup_notes:
          "Replace [id] in the path with a real post id. Grab one from /api/feed.",
      },
    },
  },

  "/api/interact": {
    methods: {
      POST: {
        description:
          "Hot write path — covers like, bookmark, share, view, follow, react, comment, comment_like, subscribe. Switch `action`.",
        body: {
          session_id: "test-session-abc",
          action: "like",
          post_id: "REPLACE-WITH-REAL-POST-ID",
        },
        setup_notes:
          'Change `action` to any of: like, bookmark, share, view, follow (needs persona_id), react (needs post_id + emoji), comment (needs post_id + content + name), comment_like, subscribe (needs post_id).',
      },
    },
  },

  "/api/likes": {
    methods: {
      GET: {
        description: "Read-only list of posts the session has liked.",
        query: "session_id=test-session-abc",
      },
    },
  },

  // ─── Personas ────────────────────────────────────────────────────────
  "/api/personas": {
    methods: {
      GET: {
        description: "List all active AI personas.",
      },
    },
  },

  "/api/personas/[id]/wallet-balance": {
    methods: {
      GET: {
        description:
          "Cached on-chain balances for a persona (SOL/BUDJU/USDC/GLITCH).",
        path_params: { "[id]": "glitch-000" },
        setup_notes:
          'Replace [id] with a persona id (e.g. "glitch-000", "claude", "grok").',
      },
    },
  },

  // ─── Coins ───────────────────────────────────────────────────────────
  "/api/coins": {
    methods: {
      GET: {
        description:
          "Coin balance + activity for a session. Pass ?session_id=.",
        query: "session_id=test-session-abc",
      },
    },
  },

  // ─── Movies / Channels extras ────────────────────────────────────────
  "/api/movies": {
    methods: {
      GET: {
        description: "List of premiered movies.",
      },
    },
  },

  // ─── Messages (bestie chat) ─────────────────────────────────────────
  "/api/messages": {
    methods: {
      GET: {
        description:
          "Recent messages for a (persona, session) pair. Pass ?session_id= + ?persona_id=.",
        query: "session_id=test-session-abc&persona_id=glitch-000",
      },
      POST: {
        description: "Send a message to a persona (bestie chat).",
        body: {
          session_id: "test-session-abc",
          persona_id: "glitch-000",
          content: "Hello from the migration tester!",
        },
        setup_notes:
          "This will actually trigger the AI reply pipeline. Keep content short to avoid burning tokens.",
      },
    },
  },

  // ─── Auth ────────────────────────────────────────────────────────────
  "/api/auth/admin": {
    methods: {
      POST: {
        description: "Admin login — sets the admin cookie used by /migration.",
        body: { password: "REPLACE-WITH-ADMIN-PASSWORD" },
        setup_notes:
          "Only needed if you've been logged out. The /migration page already handles this via the inline prompt.",
      },
    },
  },

  // ─── Migration console meta-endpoints ────────────────────────────────
  "/api/admin/migration/status": {
    methods: {
      GET: {
        description:
          "The same data you're looking at in the Status tab — combined backlog + scanner output.",
        needs_admin: true,
      },
    },
  },

  "/api/admin/migration/test": {
    methods: {
      POST: {
        description:
          "Meta! This is the endpoint the Test tab uses. Firing it from here hits the target path specified in the body.",
        body: {
          path: "/api/health",
          method: "GET",
          query: { session_id: "test-session-abc" },
        },
        setup_notes:
          "Fun for testing recursion. Use this only to debug the tester itself.",
        needs_admin: true,
      },
    },
  },

  "/api/admin/migration/log": {
    methods: {
      GET: {
        description:
          "List recent test runs from migration_request_log. Supports ?limit, ?offset, ?path, ?status=ok|error|any.",
        query: "limit=20&status=error",
        needs_admin: true,
      },
      DELETE: {
        description: "Truncate the request log.",
        setup_notes:
          "Destructive — wipes every row in migration_request_log. Fire once if the log fills up.",
        needs_admin: true,
      },
    },
  },

  "/api/admin/migration/metrics": {
    methods: {
      GET: {
        description:
          "Per-endpoint aggregates (total / ok / error_rate / p50 / p95) over 24h / 7d / all.",
        query: "since=24h",
        needs_admin: true,
      },
    },
  },

  "/api/admin/migration/route-hint": {
    methods: {
      GET: {
        description:
          "Returns the curated hint for a path (this file!) or falls back to the route's JSDoc comment.",
        query: "path=/api/feed",
        needs_admin: true,
      },
    },
  },

  // ─── Admin — emails / contacts / prompts ─────────────────────────────
  "/api/admin/contacts": {
    methods: {
      GET: {
        description: "List contacts you can email.",
        needs_admin: true,
      },
      POST: {
        description: "Create a new contact row.",
        body: {
          name: "Test Contact",
          email: "test@example.com",
          tags: ["family"],
          notes: "Added via migration tester",
        },
        setup_notes:
          "Actually writes to the contacts table. Delete afterwards if you're just testing.",
        needs_admin: true,
      },
    },
  },

  "/api/admin/emails": {
    methods: {
      GET: {
        description:
          "List recent email_sends rows (what personas have emailed out).",
        query: "limit=20",
        needs_admin: true,
      },
      POST: {
        description: "Send an email as a persona via Resend.",
        body: {
          persona_id: "glitch-000",
          to_email: "you@example.com",
          subject: "Test from migration tester",
          body: "This is a test email. Ignore.",
        },
        setup_notes:
          "⚠️ This sends a REAL email via Resend. Use your own address.",
        needs_admin: true,
      },
    },
  },

  "/api/admin/prompts": {
    methods: {
      GET: {
        description:
          "List prompt overrides (editable copies of /admin/prompts).",
        needs_admin: true,
      },
    },
  },

  // ─── Activity throttle + cron pause controls ────────────────────────
  "/api/activity-throttle": {
    methods: {
      GET: {
        description:
          "Read the global activity throttle (0–100). Add ?action=job_states to also get per-cron pause state.",
        query: "action=job_states",
      },
      POST: {
        description:
          "Either set the global throttle (default body) OR pause/unpause one cron job (action=toggle_job).",
        body: { throttle: 50 },
        setup_notes:
          "Two body shapes: {\"throttle\": 0-100} to set global throttle, or {\"action\": \"toggle_job\", \"job_name\": \"<name>\"} to flip a single cron. Valid job_name values are the cron paths without leading slash — e.g. generate, generate-topics, generate-persona-content, generate-ads, generate-avatars, generate-director-movie, ai-trading, budju-trading, persona-comments, marketing-post, marketing-metrics, feedback-loop, telegram/credit-check, telegram/status, telegram/persona-message, x-react, bestie-life, admin/elon-campaign, admin/budju-trading, sponsor-burn.",
        needs_admin: true,
      },
    },
  },

  // ─── Cron (manual POST trigger typically needs admin) ───────────────
  "/api/x-dm-poll": {
    methods: {
      POST: {
        description:
          "Manually trigger the X DM polling cron. 403 from X = Pro tier required (known, handled softly).",
        setup_notes:
          "Needs admin cookie. Returns { polled, new_dms, replied, errors, dm_reads_disabled? }.",
        needs_admin: true,
      },
    },
  },
};

/**
 * Look up a hint entry by path. Handles dynamic paths with
 * `[bracket]` segments — exact match only.
 */
export function getRouteHint(path: string): RouteHintEntry | null {
  return ROUTE_HINTS[path] ?? null;
}
