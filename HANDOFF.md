# HANDOFF.md — aiglitch-api

> Session log + endpoint migration tracker. Updated at the end of every session.
> Never delete. Newest entries at the top.

---

## Endpoint migration tracker

States: `not-started` → `scaffolded` → `tested` → `proxy-flipped` → `old-deleted`

| Endpoint | State | Owner session | Notes |
|---|---|---|---|
| `/api/health` | tested | session 2 | Phase 1 canary; live in prod |
| `/api/feed` (Slice A — For You default) | tested | session 3 | Phase 1 canary #2; shape-verified against legacy |
| `/api/feed` (Slice B — cursor pagination) | tested | session 4 | `?cursor=<ts>` scrolls older posts; nextCursor populated on full pages |
| `/api/feed` (Slice C — following) | tested | session 5 | `?following=1&session_id=X` joins human_subscriptions; silently falls through to For You when session_id missing (legacy behaviour) |
| `/api/feed` (Slice D — breaking) | tested | session 6 | `?breaking=1` video-only feed of `#AIGlitchBreaking` or `post_type='news'`; supports cursor sub-mode |
| `/api/feed` (Slice E — premieres + genre) | tested | session 7 | `?premieres=1` + optional `?genre=X`; video ≥15s, excludes director-scene fragments |
| `/api/feed` (Slice F — premiere_counts + following_list) | not-started | — | |
| `/api/feed` (Slice G — consumer flip) | not-started | — | All slices A–F must be live first |
| *(all other 177 routes)* | not-started | — | See `docs/api-handoff-1-routes.md` |

---

## Session log

### 2026-04-19 (session 7) — /api/feed Slice E (premieres + genre)

**Branch:** `claude/migrate-feed-slice-e-premieres`

**Done:**
- Removed `premieres` from the 501 reject list.
- Added the premieres branch in `src/app/api/feed/route.ts`: four sub-variants for (cursor × genre). Filters to `post_type='premiere' OR hashtags LIKE '%AIGlitchPremieres%'`, video-only, requires `video_duration > 15` OR `media_source = 'director-movie'` (so shorts / director fragments don't leak through), excludes `director-premiere/profile/scene` media sources. Optional `?genre=action|scifi|romance|family|horror|comedy|drama|cooking_channel|documentary` adds `hashtags LIKE '%AIGlitch<Genre>%'`.
- Capitalisation matches legacy: `cooking_channel` → `AIGlitchCooking_channel`. Odd but preserved for parity.
- Refactored `cacheControlFor` to take `{ isRandomFirstPage, isPersonalized }` — two booleans instead of an expanding struct. Callers compute them from the mode flags. Cleaner and future-proof.
- 9 new integration tests covering: premieres ≠ 501, single-query shape, premiere hashtag/post_type/video-duration filters, genre filter, cooking_channel capitalisation, cursor sub-mode, cursor+genre combined, and both Cache-Control branches.
- `/docs` page lists Slice E live and Slice F (premiere_counts + following_list) next.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (63/63, up from 54)
- `npm run build` — passing locally
- `npm run verify:feed` — pending (user to rerun post-deploy)
- Manual preview hit: `/api/feed?premieres=1` returns real premiere videos

**Not done (next session):**
- Slice F: `premiere_counts` (genre count buckets + background hashtag retag) and `following_list` (usernames the session follows + AI followers). These are sub-endpoints with different response shapes.
- Slice G: consumer flip.

**Safety notes:**
- Legacy's `premiere_counts` path runs a background retag job (backfills missing genre hashtags). When we port it in Slice F, decide whether to port the background work or defer it.

---

### 2026-04-19 (session 6) — /api/feed Slice D (breaking mode)

**Branch:** `claude/migrate-feed-slice-d-breaking`

**Done:**
- Removed `breaking` from the 501 reject list.
- Added the breaking branch in `src/app/api/feed/route.ts`: single chronological query filtered to `(hashtags LIKE '%AIGlitchBreaking%' OR post_type = 'news')`, video-only (`media_type = 'video' AND media_url IS NOT NULL`). No Architect exclusion — the Architect IS the news anchor for many of these.
- Supports cursor sub-mode (scroll-down pagination) the same way Following and For You do.
- `cacheControlFor` updated to take a `breaking` flag: breaking becomes one of the "not the random first page" branches, so it gets 60s public cache without session and 15s with session.
- 7 new integration tests covering: breaking ≠ 501, single-query shape, hashtag/post_type/video filters, cursor sub-mode, 60s/15s cache control branches, and meatbag overlay for news posts.
- `/docs` page lists Slice D live and Slice E (premieres + genre) next.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (54/54, up from 47)
- `npm run build` — passing locally
- `npm run verify:feed` — pending (user to rerun post-deploy)
- Manual preview hit: `/api/feed?breaking=1` should return only video news posts

**Not done (next session):**
- Slice E: `premieres` + `?genre=action|scifi|romance|family|horror|comedy|drama`.
- Slice F: `premiere_counts` + `following_list` sub-endpoints.
- Slice G: consumer flip.

**Safety notes:**
- Endpoint still not pointed at by any consumer. Public-read only.
- Hashtag LIKE filter uses `'%AIGlitchBreaking%'` — same pattern the old repo uses, so behaviour is identical.

---

### 2026-04-19 (session 5) — /api/feed Slice C (following mode)

**Branch:** `claude/migrate-feed-slice-c-following`

**Done:**
- Removed `following` from the 501 reject list.
- Added the following branch in `src/app/api/feed/route.ts`: single chronological query joining `human_subscriptions` on both the persona and the session. No stream split / interleave (users expect strict time order in a following tab). No Architect exclusion (follows are explicit). Supports both initial-load and cursor sub-modes.
- `cacheControlFor` refactored to take `{ following, cursor, sessionId }` — any personalised response (following OR session) now gets the short 15s edge cache; the random For You first page stays `private, no-store`; anonymous chronological scroll keeps the 60s cache.
- `following=1` without `session_id` silently falls through to the For You default path, matching legacy behaviour. Documented and pinned with a test.
- 7 new integration tests covering: following ≠ 501, single-query shape, JOIN + session filter, cursor sub-mode, assembly (comments + bookmarks + meatbag), Cache-Control, and the silent fall-through.
- `/docs` page lists Slice C live and Slice D (`breaking`) next.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (47/47, up from 40)
- `npm run build` — passing locally
- `npm run verify:feed` — pending (user to rerun post-deploy)
- Manual preview hit: `/api/feed?following=1&session_id=<real-uuid>` returns only followed-persona posts

**Not done (next session):**
- Slice D: `breaking` mode (`?breaking=1` video-only breaking news feed).
- Slice E: `premieres` + genre filter.
- Slice F: `premiere_counts` + `following_list` sub-endpoints.
- Slice G: consumer flip.

**Safety notes:**
- Endpoint still not pointed at by any consumer.
- Legacy fall-through preserved: any client that sent `following=1` without `session_id` to the new backend would get For You, same as the old one.

---

### 2026-04-19 (session 4) — /api/feed Slice B (cursor pagination)

**Branch:** `claude/migrate-feed-slice-b-cursor`

**Done:**
- Removed `cursor` from the 501 reject list.
- Added cursor branch in `src/app/api/feed/route.ts`: three parallel queries with `WHERE p.created_at < ${cursor}`, plain `ORDER BY p.created_at DESC`, 1x pool multiplier (no 3x — chronological doesn't need variety).
- `nextCursor` now set to the last post's `created_at` when `posts.length === limit`, in both default and cursor modes. Matches legacy contract byte-for-byte (legacy uses last-after-interleave even though that isn't strictly oldest; preserved to avoid consumer drift).
- `Cache-Control` now mode-aware via `cacheControlFor()`: default mode → `private, no-store`; cursor without session → `public, s-maxage=60, stale-while-revalidate=300`; cursor with session → `public, s-maxage=15, stale-while-revalidate=120`.
- 9 new integration tests covering: cursor ≠ 501, chronological SQL, 1x multiplier, nextCursor on full page, nextCursor null on partial, Cache-Control for each mode.
- `/docs` page updated to reflect Slice B live and Slice C (following) next.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (40/40, up from 32)
- `npm run build` — passing locally
- `npm run verify:feed` — pending (user to rerun post-deploy)
- Manual preview hit: `/api/feed?cursor=<ts>` returns older posts chronologically

**Not done (next session):**
- Slice C: `following` mode (posts from personas the user follows; requires session_id). Easy port — one more SQL branch joining `human_subscriptions`.
- Slice D: `breaking` mode.
- Slices E, F, G.

**Safety notes:**
- Endpoint still not pointed at by any consumer. Zero impact on the live `aiglitch` web/iOS apps.
- Default-mode behaviour only changed in one way: `nextCursor` is now non-null on full pages (was always null in Slice A). Consumers written against Slice A would now see a cursor they can follow — this is the intended Slice B behaviour.

---

### 2026-04-19 (session 3) — /api/feed Slice A (For You default mode)

**Branch:** `claude/migrate-feed-slice-a-foryou`

**Done:**
- Ported `getDb()` (10 lines) — neon singleton from `DATABASE_URL`. Skipped legacy `ensureDbReady()` / `safeMigrate` per locked decision (shared DB is owned by old repo until cutover).
- Ported two-tier cache (`src/lib/cache.ts`) verbatim from legacy with cosmetic cleanup. L1 in-memory + L2 Upstash Redis with 150ms read timeout, stale-while-revalidate, fire-and-forget writes, prefix invalidation.
- Extracted `interleaveFeed` into `src/lib/feed/interleave.ts` with injectable RNG so it's testable.
- Ported the four post-repository functions feed needs (`getAiComments`, `getHumanComments`, `getBookmarkedSet`, `threadComments`) into `src/lib/repositories/posts.ts`. Other repo methods deferred to future slices.
- Wrote `/api/feed` route handler covering only the For You default initial-load mode (no cursor / shuffle / following / breaking / premieres / premiere_counts / following_list). Unsupported params return `501 mode_not_yet_migrated` so consumers see an honest signal.
- 21 new tests (7 interleave + 7 thread + 7 route integration) on top of the 10 health tests = **31 passing**.
- Updated `/docs` page to list the migrated endpoint and document the slice scope.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (31/31)
- `npm run build` — passing (Next 16 Turbopack; `/api/feed` shows up as dynamic route)
- Manual hit on Vercel preview against real Neon DB — pending after merge
- Shape + Set match against live `aiglitch.app/api/feed` — pending after deploy

**Skipped legacy artefacts (intentional):**
- `ensureDbReady()` / `safeMigrate` — old repo owns schema during migration.
- Inline `ALTER TABLE posts ADD COLUMN IF NOT EXISTS meatbag_author_id` in `getByPersona` — column already exists in shared DB.
- `eslint-disable` comments on `any` usage — we no longer run ESLint.
- Drizzle schema port — handler uses raw SQL, deferred until a later slice benefits from typed queries.

**Not done (next session):**
- Hit `/api/feed` on the Vercel preview, eyeball the JSON, run the Shape + Set match against live `aiglitch.app/api/feed`.
- If clean, start Slice B (cursor pagination for For You).

**Safety notes:**
- Slice A endpoint is read-only and not yet pointed at by any consumer. Zero impact on the live `aiglitch` web/iOS apps regardless of whether this slice is broken.
- `private, no-store` on every Slice A response prevents CDN poisoning during validation.

---

### 2026-04-19 (session 2) — Next.js scaffold + /api/health canary

**Branch:** `claude/scaffold-nextjs-phase-1`

**Decisions locked this session:**
- #9 iOS migration deferred until web cutover is stable.
- #10 Reuse `DATABASE_URL` env var name (same Neon instance).
- #11 Vercel project already linked; env vars managed by user in Vercel UI.

**Done:**
- Next.js 16 + React 19 + TypeScript 6 scaffolded. `npm install` clean (367 packages).
- App skeleton: `src/app/layout.tsx`, `src/app/page.tsx` (redirects to `/status`).
- `/api/health` endpoint with DB / Redis / xAI / Anthropic checks. Required vs optional semantics.
- Pure-function split (`computeStatus`, `runHealth`) for testability.
- Vitest config + 10 passing tests covering all status transitions.
- `/status` page rendering the health report as a table.
- `/docs` page placeholder listing the one migrated endpoint.
- GitHub Actions CI workflow (`.github/workflows/ci.yml`): typecheck + test on PR / push to master.
- `vercel.json` declaring Next.js framework (fixed first two failed deploys).

**Verification gates:**
- `npm run typecheck` — **passing**
- `npm test` — **passing** (10/10)
- `npm run build` — **passing** locally (Next.js 16 Turbopack)
- Vercel preview deploy — **passing** after `vercel.json` framework declaration
- Manual hit of `/api/health` on preview deploy — not yet done

**Resolved this session — lint:**
User chose option (a): dropped ESLint entirely from the project. `eslint.config.mjs`, the `lint` script, and `eslint` + `eslint-config-next` deps removed; CI no longer runs lint. Revisit on a dedicated branch once the ESLint 10 / eslint-plugin-react API compat lands upstream, or when switching to Biome/oxlint.

**Resolved this session — Vercel framework:**
First two deploys failed with `No Output Directory named "public" found` because the Vercel project preset was stuck on the static-site default (it was linked before any package.json existed). Fixed by committing `vercel.json` with `{"framework": "nextjs"}` so the config lives in the repo.

**Not done (next session):**
- Manual hit of `/api/health` on a preview deploy against real Neon DB.
- Wire `/status` to real health data (currently fetches from itself — works in prod, not in preview for same-origin reasons).
- `/docs` OpenAPI generation from route handlers.
- `/api/feed` migration (phase-1 canary #2).
- Reverse-proxy layer that routes unmigrated paths to the old backend.

**Safety notes:**
- No code from the old `aiglitch` repo has been copied yet.
- `DATABASE_URL` reused, so the local dev database IS the production database — reads only until consumer cutover, no writes from this repo in phase 1.

---

### 2026-04-19 (session 1) — Kickoff / planning

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
