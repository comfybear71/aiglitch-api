# CLAUDE.md — aiglitch-api

> This file is the project's brain. Every Claude session in this repo reads it automatically.
> Never delete. To update, edit and commit on a feature branch.

---

## What this repo is

`aiglitch-api` is the **shared backend** for the entire AIG!itch ecosystem. It is being built to replace the monolithic backend currently living inside the `aiglitch` webpage repo. After migration, **both** the web frontend (aiglitch.app) and the iOS app (Glitch-app) call this repo's endpoints.

This repo is **headless** — it exposes HTTP endpoints + minimal ops UI (`/docs`, `/status`). Business logic and data live here. Presentation lives in the consumer apps.

## Source documents (read these first)

- `docs/api-handoff-1-routes.md` — all 179 routes, grouped by auth type
- `docs/api-handoff-2-database.md` — 88 tables, Drizzle + raw SQL
- `docs/api-handoff-3-env-services.md` — env vars + 12 external services
- `docs/api-handoff-4-architecture.md` — key patterns, file layout, gotchas

## Locked architectural decisions

Decided 2026-04-19. Do not change without written user confirmation.

| # | Decision | Value |
|---|---|---|
| 1 | Migration pattern | **Reverse-proxy strangler.** New domain `api.aiglitch.app` proxies to old backend; each endpoint flips behind a flag as it migrates. Consumers repoint once, on day one. |
| 2 | Tech stack | **Next.js App Router, API routes only.** No pages. Zero handler rewrite for lifted code. Framework migration deferred. |
| 3 | Hosting | **Vercel.** Preserves parity with existing cron + blob integrations. |
| 4 | Database | **Shared Neon Postgres** between old and new repos during migration. New repo owns schema after cutover. |
| 5 | First canary endpoints | `/api/health`, then `/api/feed` (read-only, public, high-traffic). |
| 6 | Trading endpoints | **Final migration phase.** Requires explicit written confirmation per endpoint. Covers: `budju-trading`, `ai-trading`, `wallet`, `exchange`, `otc-swap`, `bridge`, `persona-trade`, `trading`, `solana`. |
| 7 | OAuth callbacks | Migrated **last**. 6 providers (Google, GitHub, X, YouTube, TikTok-deprecated, Telegram). |
| 8 | Ops UI (phase 1) | `/docs` (Swagger/OpenAPI) + `/status` (health dashboard). `/migration` + `/logs` deferred. |
| 9 | iOS migration | **Deferred.** Web-first only this phase. After web cutover is stable, the existing iOS `Glitch-app` repo is wired up to this backend and improved. |
| 10 | DB env var name | **Reuse `DATABASE_URL`** on day one. Same Neon instance as the existing `aiglitch` repo. |
| 11 | Vercel project | **Already linked** to this repo. No new project creation. User adds env vars via Vercel UI; we do not manipulate Vercel settings from code. |

## Migration safety rules (repo-specific)

1. **Never break existing endpoints** — both web and iOS depend on them.
2. **Session merge direction matters** — wallet login merges FROM old TO new session_id. Preserve exactly.
3. **Neon replication lag** — never read immediately after write; existing code has workarounds, port them.
4. **safeMigrate is one-shot per Lambda** — new repo will replace this with proper migration tooling.
5. **Instagram must proxy** — IG can't fetch Vercel Blob URLs. Keep `/api/image-proxy` + `/api/video-proxy`.
6. **Grok video 4096 char prompt limit** — clip prompts must stay compact.
7. **Circuit breaker is fail-open** — if Redis is down, AI calls proceed without limits. Document this risk.
8. **TikTok API is dead** — manual posting only; don't restore automation.

## Endpoint migration status

Tracked in `HANDOFF.md`. One row per endpoint, states: `not-started → scaffolded → tested → proxy-flipped → old-deleted`.

## What to port next

Full priority plan in `docs/migration-roadmap.md`. **Read that first** before picking new work. Summary of the order:

1. **Phase 3 extras** — small public/session routes (~20 left: `/api/personas`, `/api/coins`, `/api/movies`, `/api/friends`, token/NFT reads, etc.). Low-risk, fast wins.
2. **Admin auth layer** (1 route — `/api/auth/admin`). Gates Phase 7.
3. **Phase 5 — AI engine port** (xAI + Anthropic clients + circuit breaker + cost ledger). Big deferred item; unlocks Phases 4 and 6.
4. **Phase 6 — cron fleet** (21 jobs). Flip as a cohort.
5. **Phase 4 — bestie / iOS glue** (6 routes). Unblocked by AI engine.
6. **Phase 7 — admin routes** (~85, in thematic groups).
7. **Phase 8 — trading / wallet / Solana** (~15). **Locked decision #6 — written confirmation per endpoint.**
8. **Phase 9 — OAuth callbacks** (12). Last per decision #7.
9. **Phase 10 — cleanup.** Delete legacy handlers, retire strangler fallback.

Special cases:
- **Instagram proxies** (`/api/image-proxy`, `/api/video-proxy`) must remain reachable at `aiglitch.app`-prefixed URLs (IG can't fetch Blob URLs). Treat as permanent legacy.
- **Test/dev routes** migrate whenever, no priority.

## How we work here

1. Every task starts with a discussion — no code until explicit "go ahead".
2. Branch per feature: `claude/<feature-name>` off master.
3. Small atomic commits. No PRs, merges, or tags from Claude — user drives those via GitHub UI.
4. Per-endpoint safety gates: isolated build → tests first → run tests → manual verify → consumer migration → keep rollback path.
5. Fix spiral protocol: count attempts aloud, stop after 3, output the stopped-template.
6. End of session: push commits, deliver PR handoff (Rule 5 format), update HANDOFF.md.

## Sacred files (never delete)

`CLAUDE.md`, `HANDOFF.md`, `SAFETY-RULES.md`, `README.md`. If corrupted or deleted, restore from git history, not memory.

## Owner

Stuart French (comfybear71) — solo developer. Works from PC, iPad, and phone. Drives all merges and release tags via GitHub web UI.
