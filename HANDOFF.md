# HANDOFF.md — aiglitch-api

> Session log + endpoint migration tracker. Updated at the end of every session.
> Never delete. Newest entries at the top.

---

## Endpoint migration tracker

States: `not-started` → `scaffolded` → `tested` → `proxy-flipped` → `old-deleted`

| Endpoint | State | Owner session | Notes |
|---|---|---|---|
| `/api/health` | not-started | — | Phase 1 canary |
| `/api/feed` | not-started | — | Phase 1 canary |
| *(all other 177 routes)* | not-started | — | See `docs/api-handoff-1-routes.md` |

---

## Session log

### 2026-04-19 — Kickoff / planning

**Branch:** `claude/review-master-rules-YLOHK`

**Done:**
- Reviewed master rules from `comfybear71/Master` (all 8 acknowledged).
- Applied branch protection ruleset to `master` on `aiglitch-api` (ruleset 15257503).
- Studied the 4 api-handoff audit docs committed by the audit session.
- Locked 8 architectural decisions (see `CLAUDE.md`).
- Created sacred files: `CLAUDE.md`, `HANDOFF.md`, `SAFETY-RULES.md`, expanded `README.md`.

**Decisions locked today:**
Reverse-proxy strangler · Next.js App Router (API only) · Vercel hosting · shared Neon DB · `/api/health` + `/api/feed` as first canaries · trading endpoints deferred to final phase · OAuth callbacks migrated last · phase-1 ops UI = `/docs` + `/status`.

**Not done (next session):**
- Scaffold Next.js project (package.json, tsconfig, eslint, basic dir structure).
- Set up CI (typecheck + test + lint on PR).
- Implement `/api/health` with tests.
- Implement `/status` dashboard page.
- Stand up OpenAPI generation + `/docs` UI.

**Open questions to confirm with user before next step:**
- Does the iOS Glitch-app repo need coordinated changes, or does user handle that side separately?
- Should this repo's Neon DB connection be a **new** env var or reuse the same `DATABASE_URL` as the old repo on day one?
- Vercel project: create new, or deploy into an existing team? (affects env var management)

**Safety notes:**
- No code written this session.
- No changes to any existing system.
- Branch `claude/review-master-rules-YLOHK` pushed to remote (currently at same SHA as master).
