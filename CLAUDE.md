# CLAUDE.md — aiglitch-api

> This file is the project's brain. Every Claude session in this repo reads it automatically.
> Never delete. To update, edit and commit on a feature branch.

---

## ⚠️ MANDATORY — Sister repo (`comfybear71/aiglitch`)

**This is not optional. Read this section before doing anything else.**

This API repo is HALF of one project. The other half is the legacy
`aiglitch` repo at https://github.com/comfybear71/aiglitch — which
serves the web app at `aiglitch.app`, owns the frontend rendering,
service worker, crons, content generation, and DB schema.

**They are one project, not two.** Every Claude session in this repo
MUST have the sister repo cloned and pulled fresh before answering
any question that could touch both sides.

### Run this at the start of every session (no exceptions)

```bash
if [ -d /home/user/aiglitch ]; then
  git -C /home/user/aiglitch pull --ff-only
else
  git clone https://github.com/comfybear71/aiglitch /home/user/aiglitch
fi
```

Public repo, no auth needed. Read-only. Never edit, never push from there.

### Before answering ANY of these questions, read the sister repo first

- Anything about the frontend rendering (`src/components/Feed.tsx`,
  channel pages, post components)
- Anything about caching the user is seeing (service worker in
  `public/sw.js`, in-memory caches in components)
- Anything about DB schema or how rows are inserted (the sister repo
  owns the schema — `src/lib/db/schema.ts` is canonical)
- Anything about content generation, persona crons, blob folder
  structure
- Anything about why an endpoint isn't actually reaching users
  (check the sister repo's `next.config.ts` `beforeFiles` rewrites
  — only routes listed there forward to api.aiglitch.app)
- ANY user-reported bug — odds are it spans both repos

### Division of responsibility

| Concern | Repo | File / Location |
|---|---|---|
| Migrated API routes (e.g. `/api/feed`) | **this repo** | `src/app/api/*` |
| API routes still on legacy | **aiglitch** | `src/app/api/*` (in aiglitch) |
| Strangler rewrite list | **aiglitch** | `next.config.ts` `beforeFiles` |
| Frontend rendering (Feed, Channel pages, etc.) | **aiglitch** | `src/components/*` |
| Service worker (offline cache) | **aiglitch** | `public/sw.js` |
| In-memory frontend caches | **aiglitch** | `src/components/Feed.tsx` `_feedCache` |
| Cron content generators | **aiglitch** | `src/app/api/generate-*` (in aiglitch) |
| Database schema | **aiglitch** | `src/lib/db/schema.ts` (canonical) |
| Vercel Blob writers | **aiglitch** | `src/lib/media/*` (in aiglitch) |

### Verification rules — learned from the For You debugging saga (v1.8.12-v1.8.18)

These rules came out of 6 attempts and ~$300 of wasted compute. Don't repeat them.

1. **A migration is NOT shipped until the public domain serves the new response.**
   "Merged + tagged + deployed" on api.aiglitch.app means nothing if
   `aiglitch.app/api/<route>` still hits legacy code. Always curl the
   public domain after deploy and verify the response shape changed.

2. **Listing counts ≠ feed-eligible counts.** Endpoints that
   `COUNT(*)` by `channel_id` will report supply bigger than what
   feeds surface, because feeds add extra filters (`media_url IS
   NOT NULL`, host denylists, etc.). Always check the actual
   feed-eligible count, not the listing count.

3. **Frontend has MULTIPLE cache layers.** At minimum:
   - Service worker (`public/sw.js`) — TTL configurable per route
   - In-memory `_feedCache` Map (`src/components/Feed.tsx`) — currently
     10s
   - React component state
   - Safari/Chrome HTTP cache
   - Vercel edge CDN
   When a user reports "I see the same posts every refresh," check
   ALL cache layers, not just the one you know about. The CACHE_TTL
   constant in Feed.tsx specifically has bitten us — two cache layers
   with different TTLs doing the same job.

4. **SQL `LIKE` can silently fail on legacy data.** Encoding quirks
   (invisible chars, BOM, zero-width spaces) can make obviously-
   matching strings fail LIKE patterns. Prefer denylists for known-bad
   hosts over allowlists for known-good hosts.

5. **`INNER JOIN` filters rows silently.** When debugging "why isn't
   X showing in the response," check whether the JOIN is dropping
   rows where the foreign key doesn't match.

6. **Spiral protocol matters MORE on this codebase than usual.**
   Stop at 3 attempts. The system has 6+ cache layers, 2 repos, 2
   Claude sessions. Each fix can reveal a deeper layer. Going past
   3 attempts without external help (frontend Claude reading your
   code) wastes money fast.

### Cross-session coordination protocol

When working on a problem that touches both repos:

1. **Pull the sister repo first.** Always. Before reading any code in
   your own repo for a cross-repo question.

2. **Read both sides before proposing a fix.** If the bug is "user
   sees X in UI," you need to understand both the API response shape
   AND the frontend rendering that consumes it. Reading one side is
   guessing.

3. **Hand off via the user, not directly.** Each Claude session only
   has GitHub access to its own repo. The user is the bridge between
   them. Always.

4. **Be brief in handoff messages** — the other Claude reads them
   cold. State the problem, the data, the proposed fix in <10 lines.
   No tutorial.

5. **Don't ship code in both repos in the same round.** Wait for one
   side's PR to merge + deploy + verify before the other ships.
   Concurrent shipping is impossible to debug.

6. **If you're at 3 spiral-protocol attempts and still stuck, STOP
   and ask the sister repo's Claude to look at your code.** They have
   your repo cloned per the same mandatory section in their CLAUDE.md.
   Fresh eyes catch what you can't see in your own writing.



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
6. End of session: push commits, deliver PR handoff (Rule 5 format, pinned below), update HANDOFF.md.

## Rule 5 — PR handoff format (MANDATORY, pinned from Master Rules v9)

> Pinned verbatim so sessions can't drift. When a branch is ready to ship,
> deliver the handoff in this EXACT format. Every section must be copy-paste
> ready for GitHub's UI.

**Required sections, in this order:**

### 1. Compare URL
Plain text, clickable:
`https://github.com/comfybear71/<REPO>/compare/master...claude/<BRANCH>`

### 2. PR Title
Inside a code block:
````
```
<one-line title, max 70 chars>
```
````

### 3. PR Description
Inside a markdown code block:
````
```markdown
## Summary
<1-3 sentence overview>

## Changes
- <file>: <what changed>

## Test plan
- [x] Type check passes
- [ ] <manual verification steps>
```
````

### 4. Merge instructions
1. Open the Compare URL above
2. Click "Create pull request"
3. Scroll to bottom → ▼ dropdown → "Squash and merge"
4. Click "Confirm squash and merge"
5. Click "Delete branch"

### 5. Release tag (MANDATORY)
As a table:

| Field | Value |
|---|---|
| **Tag name** | `v<semver>-<YYYY-MM-DD>` |
| **Target** | `master` |
| **Title** | `v<semver> — <short title>` |
| **Create via** | `https://github.com/comfybear71/<REPO>/releases/new` |

Then the tag description inside a code block:
````
```markdown
## v<semver>

### New
- <what shipped>

### Fixed
- <what was fixed>
```
````

**Rules about release tags:**
- Every PR gets a tag. No exceptions. Small or large change.
- Check existing tags first (`git tag --list` or GitHub Releases page).
- Tag naming: patch `v1.2.3`, minor `v1.3.0`, major `v2.0.0`, docs `v1.2.3-docs`, recovery `v1.2.3-recovery`.
- Never create the tag yourself — only suggest it. User creates via GitHub UI.

**Enforcement:** before writing a handoff, re-read this section. Do not reconstruct the template from memory — use what's pinned here.

## Sacred files (never delete)

`CLAUDE.md`, `HANDOFF.md`, `SAFETY-RULES.md`, `README.md`. If corrupted or deleted, restore from git history, not memory.

## Owner

Stuart French (comfybear71) — solo developer. Works from PC, iPad, and phone. Drives all merges and release tags via GitHub web UI.
