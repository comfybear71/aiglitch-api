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
| `/api/feed` (Slice F — premiere_counts + following_list) | tested | session 8 | Two sub-endpoints with distinct response shapes; single COUNT query for counts, two parallel queries for list |
| `/api/feed` (Slice G — consumer flip) | **proxy-flipped** | session 10 | All three steps done: fallback rewrite, `api.aiglitch.app` domain + DNS, aiglitch frontend rewrite. Live production traffic served via the strangler. |
| `/api/post/[id]` | tested | session 11 | Single post + threaded comments + bookmark + meatbag_author overlay. 404 on miss, 500 on DB error. Consumer flip deferred until stability window. |
| `/api/channels` GET | tested | session 12 | List + counts + hosts + thumbnail + subscription state. Legacy Cache-Control preserved (s-maxage=30, SWR=120). |
| `/api/channels` POST | tested | session 12 | subscribe / unsubscribe. **First write endpoint on the new backend.** INSERT + counter UPDATE match legacy non-transactional shape. `crypto.randomUUID()` for row ids (no deps added). |
| *(all other 177 routes)* | not-started | — | See `docs/api-handoff-1-routes.md` |

---

## Session log

### 2026-04-19 (session 12) — /api/channels migration (GET + POST, first write)

**Branch:** `claude/migrate-channels`

**Done:**
- New `src/lib/repositories/channels.ts`:
  - `listChannels(sessionId)` — read path with parallel-resolved subscriptions, hosts, thumbnails; `CHANNEL_DEFAULTS` inlined for generation-config fallback fields.
  - `subscribeToChannel(sessionId, channelId)` — INSERT with `ON CONFLICT (channel_id, session_id) DO NOTHING` for idempotency, followed by a separate `UPDATE channels SET subscriber_count = subscriber_count + 1`.
  - `unsubscribeFromChannel(sessionId, channelId)` — DELETE; only decrements the counter when a row was actually removed.
- New `src/app/api/channels/route.ts` with `GET` and `POST` handlers. 400 validation for missing or invalid POST bodies; 500 wrapping with detail on DB errors.
- Row IDs use `crypto.randomUUID()` (Node 20+ built-in). No `uuid` dep.
- `Cache-Control: public, s-maxage=30, stale-while-revalidate=120` on GET — matches legacy.
- 19 new integration tests (10 GET + 9 POST). Suite now 99/99 from 81.
- Inlined `CHANNEL_DEFAULTS` instead of porting the 1200-line `bible/constants.ts`. Will factor out when a second endpoint needs shared config.

**First-write pattern set:**
This repo's INSERT→UPDATE→"return { ok: true, action }" shape for POST is the template for future writes (like/comment/follow/bookmark in `/api/interact`). Non-atomic by intent — matches legacy byte-for-byte so consumers can't observe drift mid-migration.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (99/99)
- `npm run build` — passing; `/api/channels` listed as a dynamic route
- Post-deploy: `curl https://api.aiglitch.app/api/channels` should list real channels with counts and hosts
- Post-deploy: `curl -X POST https://api.aiglitch.app/api/channels -d '{"session_id":"...","channel_id":"...","action":"subscribe"}'` should toggle a subscription (verify with a real test session + channel, then unsubscribe to clean up)

**Not done this session:**
- **Consumer flip** for `/api/channels` — same as post/[id], waiting for a stability window before adding a rewrite in the aiglitch frontend.
- **`shuffle` on `/api/feed`** — still deferred.
- **`/api/interact`** — natural next step since this proves writes work.

**Safety notes:**
- First write endpoint on the new backend. Until the aiglitch frontend flips, writes still land via the old handler. If the flip happens and something goes wrong, the rollback is the same single-commit revert as feed.
- INSERT + UPDATE are NOT in a transaction. Race: the counter may diverge from the actual row count under concurrent subscribe/unsubscribe. Matches legacy behaviour. Fixing would be a separate correctness PR applied to BOTH backends at once, never just one.

---

### 2026-04-19 (session 11) — /api/post/[id] migration

**Branch:** `claude/migrate-post-by-id`

**Done:**
- Added `getPostById(id)` + `PostRow` type to `src/lib/repositories/posts.ts`. Pure read, JOIN on `ai_personas`, returns `null` on miss.
- Implemented `src/app/api/post/[id]/route.ts`: fetches post; returns `404` if missing; parallel-fetches AI comments, human comments, bookmark state; reuses the existing `threadComments` helper; does the meatbag-author overlay; returns `{ post: { …post, comments, bookmarked, meatbag_author } }` — matching legacy wrapping.
- Cache-Control: 60s public without session, 15s personalized with session (legacy set none — we add something sensible for the CDN).
- Pulled the legacy handler directly from `raw.githubusercontent.com` (sandbox can reach GitHub content, confirmed).
- 8 integration tests pinning: 404 on miss, 200 shape, comment threading for one post, bookmark flip, meatbag overlay, both Cache-Control branches, 500 on DB error.
- `/docs` page lists the new endpoint first; `HANDOFF.md` tracker updated.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (81/81, up from 73)
- `npm run build` — passing; `/api/post/[id]` shows up as a dynamic route
- Post-deploy: `curl https://api.aiglitch.app/api/post/<real-id>` + `curl https://api.aiglitch.app/api/post/nope` (expect 404)

**Not done this session:**
- **Consumer flip** — no rewrite added to aiglitch frontend yet. `/api/post/[id]` is served by the new backend whenever traffic reaches `api.aiglitch.app`, but `aiglitch.app/api/post/[id]` still hits the old handler. Flipping is a separate decision — recommend waiting until this endpoint has baked on the new backend for a bit (like we did for feed).
- **`shuffle` mode** on `/api/feed`.
- **Next endpoints**: `/api/channels` (public list — small), `/api/interact` (first write path — bigger).

**Safety notes:**
- Legacy handler used `ensureDbReady()` / `safeMigrate`; we skip it per locked decision. Schema is owned by the old repo during migration; we only read.
- `meatbag_author_id` is not in the Drizzle schema in legacy — we type-assert on raw SQL rows same way legacy did.

---

### 2026-04-19 (session 10) — Slice G steps 2 + 3 (consumer flip live)

**Branch:** `claude/slice-g-complete-handoff-update` (housekeeping only — the actual code changes were in session 9 + the aiglitch frontend repo)

**Done:**
- **Step 2** — `api.aiglitch.app` assigned to the `aiglitch-api` Vercel project. DNS CNAME set; Vercel auto-issued TLS. Verified via `curl`:
  - `api.aiglitch.app/api/health` → 200 from new backend (migrated route served locally)
  - `api.aiglitch.app/api/wallet` → 400 from old backend via fallback rewrite (legacy handler header fingerprint present)
  - `api.aiglitch.app/api/feed?premieres=1&genre=scifi` → real premiere from new backend with correct genre filter
- **Step 3** — aiglitch web frontend repo (`comfybear71/aiglitch`) got a `beforeFiles` rewrite in `next.config.ts` forwarding `/api/feed` and `/api/feed/:path*` to `https://api.aiglitch.app`. Merged and deployed. Verified: `curl aiglitch.app/api/feed` returns a body containing `nextOffset` (field only the new backend sets), so live user traffic is now served by this backend.

**Architecture end-state:**
```
browser → aiglitch.app/api/feed
       → aiglitch frontend's beforeFiles rewrite
       → https://api.aiglitch.app/api/feed
       → aiglitch-api Vercel project (this repo)
       → src/app/api/feed/route.ts (migrated handler)
       → Neon DB (shared)
```
Everything else on `aiglitch.app/api/*` keeps running on the old backend's routes. Nothing to roll back per endpoint — the strangler is the path.

**Verification gates:**
- Browser visit to `aiglitch.app` — feed renders, premieres play, comments show, GLITCH balance visible.
- `curl aiglitch.app/api/feed` — response contains `nextOffset: null` (proves route hit new backend).
- `curl api.aiglitch.app/api/wallet` — proxied to old backend (proves strangler fallback working).

**Not done (next session):**
- **`shuffle` mode** — only remaining `/api/feed` variant that returns 501. Uses `md5(id::text || seed)` for deterministic shuffle pagination. Low priority; flip if a consumer actually requests it.
- **Delete legacy `/api/feed` handler** — the aiglitch frontend's own `src/app/api/feed/route.ts` is now unreachable behind the rewrite. Safe to remove in a cleanup commit whenever convenient.
- **Next endpoint to migrate.** Options:
  - `/api/interact` (like / comment / follow / bookmark / share) — hot path, write-side, needs care with session merge and replication lag.
  - `/api/post/:id` — read-only single-post view, small scope.
  - `/api/channels` — public list, small scope.
- **Trading endpoints** — remain in the final-phase bucket per decision #6. Require written confirmation per endpoint.
- **OAuth callbacks** — migrated last per decision #7. Manual dashboard work at 6 providers to update callback URLs.

**Safety notes:**
- Consumer flip completed zero-downtime. Old `/api/feed` handler still exists in the aiglitch frontend repo — rollback is one commit revert of the rewrite.
- Shared Neon DB means both backends read consistent data; no replication-lag risk because we only migrated reads.

---

### 2026-04-19 (session 9) — Strangler fallback rewrite (Slice G step 1)

**Branch:** `claude/add-strangler-fallback-rewrite`

**Done:**
- Added `async rewrites()` to `next.config.ts` with a `fallback` rewrite: any `/api/*` path that doesn't match a route in this repo forwards to `${LEGACY_BACKEND_URL}/api/*` (defaults to `https://aiglitch.app`).
- `LEGACY_BACKEND_URL` env var added to `.env.example`. Overridable per environment if we ever need a staging fallback.
- `/docs` page now explains the strangler behaviour so future contributors (and future Claude sessions) understand that this project IS the proxy.

**Architecture consequence:**
This project is no longer just "the new API". It is now the strangler itself. Every future endpoint migration lands here, and the fallback shrinks implicitly as more routes match locally. No per-endpoint proxy-config edits.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (73/73, unchanged — rewrites are runtime, not test-covered)
- `npm run build` — passing locally
- Manual (user, post-deploy): hit `aiglitch-api.vercel.app/api/feed` → new backend response; hit `aiglitch-api.vercel.app/api/wallet` → proxied to aiglitch.app

**Not done (next session):**
- Step 2 (user-driven): assign `api.aiglitch.app` domain in Vercel dashboard + DNS CNAME.
- Step 3 (frontend-driven, lives in `comfybear71/aiglitch` repo): change base URL to `api.aiglitch.app`.
- Shuffle mode (remaining unmigrated `/api/feed` variant). Low priority.

**Safety notes:**
- Zero consumer impact from this commit. The fallback only fires on paths that don't exist in this repo — and consumers aren't pointed at this repo yet.
- Rollback = delete the `async rewrites()` block.
- Fallback forwards headers, query params, and request body unchanged.

---

### 2026-04-19 (session 8) — /api/feed Slice F (premiere_counts + following_list)

**Branch:** `claude/migrate-feed-slice-f-counts-list`

**Done:**
- Removed `premiere_counts` AND `following_list` from the 501 reject list. Only `shuffle` remains unmigrated on `/api/feed`.
- Added two early-return sub-endpoint branches at the top of the try-block in `src/app/api/feed/route.ts`:
  - `premiere_counts`: one `COUNT(*) FILTER (WHERE hashtags LIKE …)` query across 9 genre hashtags plus total. Response shape `{ counts: { action, scifi, romance, family, horror, comedy, drama, cooking_channel, documentary, all } }`. `public, s-maxage=60, SWR=300`.
  - `following_list`: parallel queries on `human_subscriptions` (what the session follows) and `ai_persona_follows` (who follows the session). Response shape `{ following: string[], ai_followers: string[] }`. `public, s-maxage=15, SWR=120`.
- New `src/lib/repositories/personas.ts` with `getFollowedUsernames` and `getAiFollowerUsernames`.
- `following_list` without `session_id` silently falls through to For You (legacy behaviour).
- Skipped the legacy background retag job that `premiere_counts` runs — it backfills missing genre hashtags on untagged premieres. That belongs in a scheduled cron, not inside a read endpoint. Noted for a future maintenance-jobs branch.
- 10 new integration tests covering: both endpoints ≠ 501, response shapes, single-COUNT-query shape, two-parallel-queries shape, Cache-Control for each, silent fall-through for following_list without session.
- `/docs` page lists Slice F live and Slice G (consumer flip) as the next step.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (73/73, up from 63)
- `npm run build` — passing locally
- `npm run verify:feed` — pending (user to rerun post-deploy)
- Manual: `/api/feed?premiere_counts=1` returns `{counts}` shape; `/api/feed?following_list=1&session_id=X` returns `{following, ai_followers}`

**Not done (next session):**
- Slice G — **consumer flip.** Point aiglitch.app's frontend at `https://aiglitch-api.vercel.app/api/feed` for all `/api/feed` routes. This is a consumer-side change and needs careful rollback planning.
- Eventually: port the `premiere_counts` background retag work into a proper cron/scheduled job.

**Safety notes:**
- Endpoint parity is now close to complete. Only `?shuffle=1` remains on the 501 list — it's a separate shuffle feature (md5 seed pagination) used by some consumer paths; we'll port it if/when a consumer starts using it on the new backend.
- Consumer flip is a bigger deal than a slice. Needs: feature flag on the frontend, rollback plan, monitoring window, and ideally shadow traffic first.

---

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
