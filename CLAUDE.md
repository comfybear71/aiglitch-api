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
