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
| `/api/interact` (Slice 1 — like, bookmark, share, view) | tested | session 13 | Hot write path. Coin awards stripped (deferred to Slice 5). |
| `/api/interact` (Slice 2 — follow, react) | tested | session 14 | `follow` toggles human_subscriptions + maybeAIFollowBack (40% prob). `react` 4-emoji enum with scored content_feedback upsert. |
| `/api/interact` (Slice 3 — comment, comment_like) | tested | session 15 | `comment` inserts human_comments (content/name truncation) + increments post counter. `comment_like` dispatches on `comment_type`. |
| `/api/interact` subscribe (was Slice 6, re-ordered early) | tested | session 16 | `subscribe` looks up persona_id from post, delegates to `toggleFollow`, tracks interest on fresh subscribe. 404 on missing post. **All 9 actions now migrated.** |
| `/api/interact` coin-award retrofit | tested | session 17 | First-like (+2), first-comment (+15), persona-like received (+1) now award. |
| `/api/likes` | tested + deployed | session 18 + 19 (CDN fix) | Read-only list. Cache-Control now `private, no-store`. |
| `/api/bookmarks` | tested + deployed | session 18 + 19 (CDN fix) | Read-only list. Cache-Control now `private, no-store`. |
| `/api/trending` | tested | session 20 | Top 15 hashtags (last 7d) + top 5 personas (last 24h). Public, CDN-cacheable for 60s. |
| `/api/search` | tested | session 21 | `?q=<2+ chars>` → `{posts, personas, hashtags}`. Strips leading `#`. Public, CDN-cacheable. |
| `/api/notifications` | tested | session 22 | GET list (+ `?count=1` for unread count only) + POST (`mark_read` / `mark_all_read`). Session-personalised → `private, no-store`. |
| `/api/profile` | tested | session 23 | `?username=X` dispatches persona-first, meatbag-fallback, 404. `isFollowing` scoped by `?session_id`. Uses cache helper for persona/getStats/getMedia. |
| `/api/events` | tested | session 24 | GET active/processing/completed events (+ `user_voted` when session passed). POST toggles vote. 404/400 error shapes. Legacy-parity: 200 with `{success:false}` on unexpected errors. |
| `/api/personas` | tested | session 25 | Public read: all active personas ordered by follower_count DESC. Cached 120s via shared cache helper. |
| `/api/movies` | tested | session 26 | Merges `director_movies` (blockbusters) with premiere video posts (trailers). `?genre=` / `?director=` filters. Response carries `genreCounts`, `directors[]` with per-director `movieCount`, and `genreLabels`. Slim DIRECTORS + GENRE_LABELS ported (Phase 5 AI engine still owns the full profile). |
| `/api/hatchery` | tested | session 26 | Paginated public list of hatched personas; `?limit` (≤50) + `?offset`. Returns `{hatchlings, total, hasMore}`. |
| `/api/friends` | tested | session 34 | GET default = `{friends}`; `?type=following` / `?type=ai_followers`. POST `add_friend` creates bidirectional row pair + awards +25 GLITCH both sides. 404/400/409 legacy error shapes. |
| `/api/friend-shares` | tested | session 36 | GET inbox joins sender+post+persona; returns `{shares, unread}`. POST `share` (verifies friendship, INSERTs row) + `mark_read` (bulk update). 400/403/404 legacy error shapes. Private, no-store. |
| `/api/suggest-feature` | tested | session 37 | Public POST form. GitHub Issues API (`GITHUB_TOKEN`) primary path; `feature_suggestions` table fallback. Always returns 200 on non-title path — best-effort. |
| `/api/channels/feed` | tested | session 40 | Channel-specific TV-style feed (video only). Modes: default, `?cursor=`, `?shuffle=1&seed=&offset=`. Posts carry comments + bookmarked + liked + emoji reactions + `socialLinks`. Studios channel skips director-scene exclusion. |
| `/api/auth/admin` | tested | session 41 | Admin password login. HMAC-SHA256 cookie, 7-day expiry. 5-per-IP-per-15-min rate limit (429 with Retry-After). Generic 401 on every failure path. Unblocks Phase 7 admin routes via `isAdminAuthenticated` (cookie OR wallet). |
| `/api/personas/[id]/wallet-balance` | tested | session 40 | Public wallet snapshot. DB cached columns only (zero Solana RPC). Returns in-app + on-chain balances; `wallet_address: null` when no `budju_wallets` row. `public, s-maxage=30, SWR=300`. |
| `/api/nft/image/[productId]` | tested | session 39 | SVG trading card render. Grokified image from `nft_product_images` when present, emoji fallback otherwise. Unknown productId renders fallback card. |
| `/api/nft/metadata/[mint]` | tested | session 39 | Metaplex JSON for minted NFTs. `persona:` prefix branches to AI Bestie shape; marketplace branch pulls from `MARKETPLACE_PRODUCTS` + `minted_nfts`. |
| `/api/token/metadata` | tested | session 38 | Metaplex SPL token metadata JSON for §GLITCH. Public CDN (1h fresh, 1d SWR). CORS open. |
| `/api/token/logo` | tested | session 38 | SVG logo. Public CDN (1d fresh, 7d SWR). CORS open. |
| `/api/token/logo.png` | tested | session 38 | 302 redirect to `/api/token/logo`. |
| `/api/token/token-list` | tested | session 38 | Jupiter-compatible Solana Token List Standard JSON. |
| `/api/token/verification` | tested | session 38 | Admin reference bundle with submission guides for Jupiter / CoinGecko / CMC / DexScreener / Birdeye. `no-cache`. |
| `/api/token/dexscreener` | tested | session 38 | DexScreener Enhanced Token Info. `?tokenAddresses=` batch support (returns `[]` when GLITCH not in the list). |
| `/api/sponsor/inquiry` | tested | session 37 | Public POST form. 5-per-IP-per-hour in-memory rate limit. Validates company+email+message. INSERT `sponsors` with `status='inquiry'`. |
| `/api/meatlab` GET + POST + PATCH | tested | session 34–35 | GET session 34 (public gallery / creator / own). POST session 35 = new submission to moderation queue (status=pending); sniffs image/video from URL or explicit media_type. PATCH session 35 = partial social-handle updates with COALESCE. `/api/meatlab/upload` (Vercel Blob client flow) still on legacy. |
| `/api/coins` (Slice 1 — GET) | tested | session 27 | Balance + lifetime_earned + recent transactions (newest 20). Missing session_id returns zeros (legacy parity). `private, no-store`. Closes the loop on coin writes already live inside `/api/interact`. |
| `/api/coins` (Slice 2 — claim_signup) | tested | session 28 | POST `{session_id, action:"claim_signup"}` awards +100 GLITCH once per session (idempotent on `coin_transactions.reason = 'Welcome bonus'`). Duplicate claims return 200 with `already_claimed:true` (legacy parity — NOT 4xx). |
| `/api/coins` (Slice 3 — send_to_persona + send_to_human) | tested | session 29 | Transfer pair. §10,000 cap, 402 insufficient, 404 recipient not found, 400 self-transfer. Non-transactional (legacy parity). New repo helpers: `deductCoins`, `getUserByUsername`, `getIdAndDisplayName`. |
| `/api/coins` (Slice 4 — purchase_ad_free + check_ad_free) | tested | session 33 | 20 GLITCH for 30 days. Requires linked phantom_wallet_address (403 without). Stacks on unexpired window. `check_ad_free` returns `{ ad_free, ad_free_until }`. |
| `/api/coins` (Slice 5 — seed_personas + persona_balances) | tested | session 33 | Bulk initial seed (200 base + min(followers/100, 1800) bonus per zero-balance persona). Leaderboard top 50 active personas by balance DESC. **All 8 /api/coins actions now migrated.** |
| `/api/interact` AI auto-reply trigger | deferred | — | Biggest remaining internal port. Not a blocker for consumer work — see session 17 notes. |
| *(all other 177 routes)* | not-started | — | See `docs/api-handoff-1-routes.md` |

---

## Session log

### 2026-04-20 (session 41) — /api/auth/admin (unblocks Phase 7)

**Branch:** `claude/migrate-auth-admin`

**Done:**
- `/api/auth/admin`: POST with `{password}`. Constant-time `safeEqual` against `process.env.ADMIN_PASSWORD`. On success, issues an httpOnly + SameSite=Lax + secure-in-prod cookie `aiglitch-admin-token` (7-day max-age) carrying an HMAC-SHA256 digest. 5-per-IP-per-15-min rate limit with `Retry-After` header on 429. All failure paths return the same generic 401 `Invalid credentials` — no info leak on whether the password was wrong, missing, malformed, or the env var was unset.
- New `src/lib/rate-limit.ts` — zero-dependency sliding-window limiter. Three preset limiters exported: `adminLoginLimiter` (5/15min, used here), `cronEndpointLimiter` (30/5min, stays dormant until Phase 6), `publicApiLimiter` (120/1min, available for future use). 5-minute cleanup sweep on the Map to prevent unbounded growth.
- New `src/lib/admin-auth.ts` — three helpers: `safeEqual` (constant-time string compare via `crypto.timingSafeEqual`), `generateToken` (HMAC-SHA256 of static message keyed on password; deterministic across Lambda instances; rotating password invalidates every existing cookie), and **`isAdminAuthenticated`** — the canonical gate every Phase 7 admin route will import. Supports two auth methods: cookie (web dashboard) OR wallet address match (mobile app, via query param / `X-Wallet-Address` / `Authorization: Wallet <addr>`).
- 35 new tests (10 rate-limit + 13 admin-auth + 12 route).
- Suite now **475/475**, up from 440.

**Env vars required on Vercel:**
- `ADMIN_PASSWORD` — **required**. Without it `/api/auth/admin` returns 401 for every attempt. Copy from legacy's Vercel project.
- `ADMIN_WALLET` — optional. Enables wallet-based admin auth for the mobile app. Same value as `NEXT_PUBLIC_ADMIN_WALLET` if you already set that for `/api/token/verification`; having both is fine.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (475/475)
- `npm run build` — passing; `/api/auth/admin` registered as dynamic

**Unlocks:** Phase 7 admin routes (~85) can now import `isAdminAuthenticated` to gate every action. No admin route ships without it.

**Migration progress:** 36/179 routes (~20%). Consumer surface fully migrated. Admin auth layer landed. Next milestone: Phase 5 AI engine (the big deferred unlock — Phase 4 bestie + Phase 6 cron + AI auto-reply all unblock from there).

---

### 2026-04-20 (session 40) — /api/channels/feed + /api/personas/[id]/wallet-balance

**Branch:** `claude/migrate-channels-feed-and-wallet-balance`

**Done:**
- **`/api/personas/[id]/wallet-balance`**: tiny wrapper over a single joined SELECT. New `getWalletInfo(personaId)` + `PersonaWalletInfo` type on `repositories/personas.ts`. Zero Solana RPC — all values read from DB cached columns (`budju_wallets.*_balance`, `ai_persona_coins.balance` + `lifetime_earned`). 404 when persona missing; `wallet_address: null` when persona has no wallet yet. Public CDN (`s-maxage=30, SWR=300`). **Not the first Solana read I thought** — that still lands with Phase 8 trading when real on-chain queries are needed.
- **`/api/channels/feed`**: channel-specific TV-style video-only feed. Three modes (default chronological, `?cursor=`, `?shuffle=1&seed=&offset=`) × two flavours (studios lets director-scene through, others exclude). Enrichment parallel-fetches AI + human comments, `getBookmarkedSet`, `getLikedSet` (**B-series fix pattern applied here too** — legacy never returned `liked` per post), `getBatchReactions` (new helper — emoji counts + session's own reactions), and `socialLinks` (from `marketing_posts`, swallows missing-table errors via `.catch(() => [])`). Also batched: channel subscription state + persona roster.
- New `interactions.getBatchReactions(postIds, sessionId?)` helper ported from legacy. Two-SQL pattern (counts + user's own) with a try/catch swallow for the `emoji_reactions` table — may not exist in fresh environments.
- 19 new tests (13 channels/feed + 6 wallet-balance). Suite now **440/440**, up from 421.
- `/docs` entries added for both.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (440/440)
- `npm run build` — passing; both routes registered as dynamic

**Phase 3 progress:** 20 of ~20 small routes done. Remaining: `/api/activity`, `/api/activity-throttle`, `/api/meatlab/upload`. Phase 3 effectively wraps here — the three stragglers are all deferred-with-a-reason (cron fleet / Blob SDK).

---

### 2026-04-20 (session 39) — /api/nft/image + /api/nft/metadata

**Branch:** `claude/migrate-nft-routes`

**Done:**
- Ported the full `src/lib/marketplace.ts` verbatim from legacy — 919 LOC of zero-dependency product catalog (`MARKETPLACE_PRODUCTS` array + `getProductById` / `getRandomProduct` / `getProductsByCategory` / `getFeaturedProducts` helpers). Pure data + tiny helpers, no side effects.
- New slim `src/lib/nft-mint.ts` (~40 LOC) with the three helpers the NFT routes need: `getRarity`, `rarityColor`, `parseCoinPrice`. Legacy's full 543 LOC module builds Solana mint transactions via `@solana/web3.js` + `@solana/spl-token` + `@metaplex-foundation/mpl-token-metadata` — none of that is needed to serve an SVG or metadata JSON. That surface ports with Phase 8 trading.
- `/api/nft/image/[productId]`: renders a 500×700 SVG trading card. Grokified image from `nft_product_images` when present (errors swallowed — table may not exist), emoji fallback otherwise. Unknown productId renders a "?" placeholder card — legacy parity since aggregators occasionally probe unknown ids.
- `/api/nft/metadata/[mint]`: Metaplex-standard JSON. Two branches:
  - `product_id` starting with `persona:` → AI Bestie metadata (bio + avatar from `ai_personas`).
  - Otherwise → marketplace NFT metadata (catalog data from `MARKETPLACE_PRODUCTS`, rarity + edition info from `minted_nfts` row).
- 17 new tests (3 files): 11 nft-mint helpers + 5 image route + 6 metadata route.
- Suite now **421/421**, up from 394.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (421/421)
- `npm run build` — passing; both NFT routes registered as dynamic

**Phase 3 progress:** 18 of ~20 small routes done. Remaining: `/api/activity`, `/api/activity-throttle`, `/api/channels/feed`, `/api/personas/:id/wallet-balance`, `/api/meatlab/upload`.

---

### 2026-04-20 (session 38) — /api/token/* batch (6 routes)

**Branch:** `claude/migrate-token-routes`

**Done:**
- Ported all 6 `/api/token/*` routes: `metadata`, `logo`, `logo.png`, `token-list`, `verification`, `dexscreener`.
- New `src/lib/solana-config.ts`: slim config module with `getAppBaseUrl`, `GLITCH_TOKEN_MINT_STR`, `TREASURY_WALLET_STR`, `ADMIN_WALLET_STR`, `METEORA_GLITCH_SOL_POOL`. Every value reads an `NEXT_PUBLIC_*` env var with a mainnet-default fallback. No `@solana/web3.js` dependency — these routes are pure string/JSON generation; the full Solana client ports later with Phase 8 trading.
- **Base URL gotcha preserved.** `getAppBaseUrl()` defaults to `https://aiglitch.app`, not `https://api.aiglitch.app`. Aggregators (Jupiter, DexScreener, CoinGecko) cached the on-chain metadata URI that points at the consumer domain; the frontend's `beforeFiles` rewrite proxies `/api/token/*` back to this backend. Returning `api.aiglitch.app` in metadata would drift aggregator caches. Override via `NEXT_PUBLIC_APP_URL` if the on-chain URI ever changes.
- 9 smoke tests consolidated into one file (`src/app/api/token/all-token-routes.test.ts`) since these endpoints are pure static JSON/SVG/302 with no inputs. Covers Content-Type, Cache-Control, CORS, key body fields per endpoint, and DexScreener batch filtering.
- Suite now **394/394**, up from 385.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (394/394)
- `npm run build` — passing; all 6 token routes registered as dynamic

**Phase 3 progress:** 16 of ~20 small routes done. Remaining: `/api/activity`, `/api/activity-throttle`, `/api/nft/image`, `/api/nft/metadata`, `/api/channels/feed`, `/api/personas/:id/wallet-balance`, `/api/meatlab/upload`.

---

### 2026-04-20 (session 37) — /api/suggest-feature + /api/sponsor/inquiry (public forms)

**Branch:** `claude/migrate-public-forms`

**Done:**
- `/api/suggest-feature`: public POST form. Primary path hits GitHub Issues API in `comfybear71/aiglitch` when `GITHUB_TOKEN` is configured; fallback INSERTs into `feature_suggestions`. Title/description truncated to 100/2000 chars. Returns 200 with `issue_number` + `issue_url` on GitHub success, 200 with generic success message on any fallback path. 400 only when title is missing/whitespace. Legacy "best-effort — always 200" contract preserved.
- `/api/sponsor/inquiry`: public POST form with in-memory per-IP rate limit (5/hour). Module-level Map — survives within a warm Lambda, resets on cold start. Legacy accepts this best-effort behaviour; no Redis introduced. Validates `company_name` / `contact_email` / message ≥ 10 chars / basic email format. INSERT `sponsors` with `status='inquiry'`; notes column concatenates message + optional `preferred_package` line. 429 on rate-limit, 400 on validation, 500 on DB error.
- No new repo modules — both routes are thin enough to stay inline.
- **Env var required (optional feature):** `GITHUB_TOKEN` on Vercel. Without it, `/api/suggest-feature` works via DB fallback only; consumers still get success responses but no GitHub issues are created. User added the token to Vercel mid-session.
- 23 new tests (11 suggest-feature + 12 sponsor/inquiry). Suite now **385/385**, up from 362.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (385/385)
- `npm run build` — passing; both routes registered as dynamic

**Phase 3 progress:** 10 of ~20 small routes done. Remaining: `/api/activity`, `/api/activity-throttle`, `/api/token/*` (7), `/api/nft/*` (2), `/api/channels/feed`, `/api/personas/:id/wallet-balance`, `/api/meatlab/upload`.

---

### 2026-04-20 (session 36) — /api/friend-shares

**Branch:** `claude/migrate-friend-shares-and-activity`

**Done:**
- New `src/lib/repositories/friend-shares.ts`: `listInbox`, `countUnread`, `findFriendSession`, `isFriendWith`, `createShare`, `markAllRead`.
- New `src/app/api/friend-shares/route.ts`:
  - GET: `{ shares, unread }` inbox for the session, joined in one query with sender + post + persona info so the consumer can render cards without a second round-trip. Missing `session_id` returns `{ shares: [] }` with no `unread` field — matches legacy exactly.
  - POST: `share` verifies friendship (403 if not friends; 404 if target username doesn't resolve) then INSERTs; `mark_read` bulk-updates every unread row for the session. Unknown action → 400.
- Cache-Control `private, no-store` (session-personalised).
- 18 new tests. Suite now **362/362**, up from 344.
- `/docs` entry added.

**Scope note:** the originally-paired `/api/activity` was descoped. Legacy is 257 LOC with 12+ parallel queries + 5 try/catch blocks for tables owned by Phase 5 (AI engine) and Phase 6 (cron fleet) — `cron_runs`, `director_movies`, `multi_clip_scenes`, `platform_settings`, `daily_topics`. Porting now would ship a defensive empty-result route that only lights up once those phases land. Better to do `/api/activity` alongside the cron fleet migration when the tables actually exist in this repo's schema ownership.

**Phase 3 progress:** 8 of ~20 small routes done. Remaining: `/api/activity`, `/api/activity-throttle`, `/api/token/*` (7), `/api/nft/*` (2), `/api/suggest-feature`, `/api/sponsor/inquiry`, `/api/channels/feed`, `/api/personas/:id/wallet-balance`, `/api/meatlab/upload`.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (362/362)
- `npm run build` — passing

---

### 2026-04-20 (session 35) — /api/meatlab POST + PATCH (finish the endpoint)

**Branch:** `claude/migrate-meatlab-post-patch`

**Done:**
- POST: receives a pre-uploaded `media_url` (client uploaded to Vercel Blob via `/api/meatlab/upload` — a separate endpoint still on legacy), validates the session, sniffs image/video from explicit `media_type` or the URL extension (`.mp4` / `.webm` / `.mov`), INSERTs a row with `status='pending'` into `meatlab_submissions`. Returns `{ success, id, status, message }`. Error shapes preserved: 401 no session_id, 400 no media_url, 401 invalid session, 500 INSERT failure.
- PATCH: partial update of `x_handle` / `instagram_handle` / `tiktok_handle` / `youtube_handle` / `website_url` on `human_users`. Omitted fields land as `null` in the param list; the SQL's `COALESCE(${null}, column)` preserves the existing value — matches legacy. Returns `{ success: true }`. 401 no session_id.
- Two new repo helpers in `src/lib/repositories/meatlab.ts`: `getSubmissionAuthor(sessionId)` and `createSubmission(input)`, plus `updateSocials(input)`. Used a typed input object for `createSubmission` rather than positional args — 7 optional fields otherwise.
- 11 new tests (8 POST + 3 PATCH). Suite now **344/344**, up from 333.
- `/docs` entry consolidated — no more "deferred" qualifier on POST/PATCH.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (344/344)
- `npm run build` — passing

**Still legacy:** `/api/meatlab/upload` (client blob upload pre-signer). Migrating that needs the Vercel Blob SDK wired into this repo — separate concern. Low consumer impact since the client flow stays unchanged until then.

---

### 2026-04-20 (session 34) — /api/friends + /api/meatlab GET (Phase 3 remnants)

**Branch:** `claude/migrate-meatlab-and-friends`

**Done:**
- `/api/friends` fully ported (GET + POST). Four new helpers in `src/lib/repositories/interactions.ts`: `getFriends`, `getFollowing`, `getAiFollowers`, `addFriend`. `addFriend` returns a discriminated union (`added | user_not_found | self | already_friends`) so the route picks the right status code (200/404/400/409). Bidirectional `human_friends` INSERT pair with `ON CONFLICT DO NOTHING` on the reverse — matches legacy non-transactional shape. +25 GLITCH "New friend bonus" to both parties (wrapped in try/catch, legacy parity). `COIN_REWARDS.friendBonus = 25` added to the local constants map.
- `/api/meatlab` GET ported in full. New `src/lib/repositories/meatlab.ts` module covering the three legacy modes: `listApproved` (public gallery), `listOwnSubmissions` (user's own), `findCreator` + `getCreatorStats` + `listCreatorApprovedSubmissions` + `listCreatorFeedPosts` (creator profile).
- **B6 closed.** The creator mode's `feedPosts` array now carries threaded comments + per-session `liked` + `bookmarked`. Consumer MeatLab page can render the real comment thread instead of just the counter. Same bug pattern as B1/B2 — different endpoint.
- **Legacy schema migrations skipped.** Legacy runs `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX` + `ALTER TABLE` on every request as a safeMigrate safety net. This repo owns no schema yet, so those are dropped; tables live in Neon already.
- POST + PATCH on `/api/meatlab` return `501 method_not_yet_migrated` and fall through to legacy via the strangler. POST has Vercel Blob mechanics worth its own branch; PATCH ships with POST. Same pattern as the earlier `/api/interact` deferred slices.
- 30 new tests total (15 friends + 15 meatlab). Suite now **333/333**, up from 303.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (333/333)
- `npm run build` — passing; `/api/friends` + `/api/meatlab` both registered as dynamic

**Phase 3 progress:** 6 of ~20 small routes done. Remaining include `/api/meatlab` POST + PATCH, `/api/token/*`, `/api/nft/*`, `/api/sponsor/inquiry`, `/api/suggest-feature`, `/api/activity`, `/api/activity-throttle`, `/api/friend-shares`, `/api/channels/feed`, `/api/personas/:id/wallet-balance`.

---

### 2026-04-20 (session 33) — /api/coins Slices 4 + 5 (ad-free + persona admin)

**Branch:** `claude/migrate-coins-slices-4-5`

**Done — all 8 `/api/coins` actions now migrated.** Slices 4 and 5 shipped together because they're both small, independent, and share no state.

**Slice 4 — ad-free subscription:**
- New `purchaseAdFree(sessionId)` + `getAdFreeStatus(sessionId)` in `src/lib/repositories/users.ts`. `purchaseAdFree` returns a discriminated union (`no_wallet | insufficient | purchased`) so the route handler picks the right status code (403 / 402 / 200) without re-querying.
- Constants exported: `AD_FREE_COST = 20`, `AD_FREE_DAYS = 30`.
- Legacy stacking preserved — buying again while still active extends from the existing `ad_free_until` rather than resetting to "now + 30 days".

**Slice 5 — persona coin admin:**
- New `getPersonasForSeeding()` + `getPersonaBalances()` in `src/lib/repositories/personas.ts`.
- `seed_personas` loops the candidates sequentially, awards (200 + min(followers/100, 1800)) to anyone at zero balance, reports `{seeded, total_personas}`.
- `persona_balances` returns top 50 active personas ordered by GLITCH balance DESC.
- `seed_personas` has no auth gate yet — `/api/auth/admin` lands with Phase 3 remnants and will eventually guard this action.

**Route:**
- Removed the `UNSUPPORTED_ACTIONS` set entirely — anything unrecognised now falls to the "Invalid action" 400 at the end of POST. Cleaner than maintaining a 501 passthrough list.

**Tests:** 16 new POST tests covering: no wallet, no user row, insufficient balance, fresh purchase, stacking on active window, empty-expiry / future / past paths for `check_ad_free`, seed math (base + bonus + cap + skip-nonzero), empty-seed path, leaderboard shape + ordering, 500 wrapping on each action. Suite now **303/303**, up from 293.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (303/303)
- `npm run build` — passing

**Migration progress:** consumer read+write surface fully on new backend; `/api/coins` closed; 19 routes / 179 total (~11%). Next blocking unlock is Phase 5 (AI engine).

---

### 2026-04-20 (session 32) — fix: /api/bookmarks (B4) + /api/search (B5)

**Branch:** `claude/fix-B4-B5-bookmarks-search-liked`

**Covers remaining P1 known-bugs from the QA matrix:**

- **B4** — `/api/bookmarks` didn't include a per-post `liked` flag. A post you'd both bookmarked AND liked rendered with a filled bookmark but empty heart.
- **B5** — `/api/search` never accepted `session_id` at all, so search results had no `liked` state. A post you'd liked showed up in search results with an empty heart.

**Done:**
- Extended `src/lib/feed/attach-comments.ts` helper with an optional `opts.sessionId`. When present (and `liked` isn't already in the static overlay), it runs `getLikedSet` on the collected post IDs and attaches `liked: true/false` per post. `/api/likes` keeps its `{liked: true}` overlay (short-circuits the lookup since every item is liked by definition).
- `/api/bookmarks/route.ts`: passes `{sessionId}` through the helper.
- `/api/search/route.ts`: now reads `session_id` from the query, runs `getLikedSet` inline after `searchAll`, switches Cache-Control to `private, no-store` when session_id present (matches the B3 pattern on `/api/profile`). Non-session calls keep the public `s-maxage=60, SWR=300` CDN cache.
- 6 new tests (1 updated for the new 4th SQL call on bookmarks, 1 B4-specific, 4 B5 variants incl. empty-posts + cache control + no-leak no-session).
- Suite now **293/293**, up from 288.
- `/docs` page updated for /api/search.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (293/293)
- `npm run build` — passing

**Matrix impact:** B4 + B5 flip from ❌ to ✅ once deployed. Only B6 (MeatLab comment list) remains open — out of scope until MeatLab subsystem is migrated.

---

### 2026-04-20 (session 31) — fix: /api/profile B1 + B2 + B3

**Branch:** `claude/fix-profile-B1-B2-B3`

**Covers three P0 bugs from `docs/consumer-qa-matrix.md`:**

- **B1** — persona profile posts rendered empty-heart after navigation because `/api/profile` persona branch never returned `liked`/`bookmarked` per post. Same gap as v0.27.1 but on a different endpoint; my earlier fix was scoped too narrowly.
- **B2** — meatbag profile uploads showed `comment_count: N` in the card header but the comments list was empty. Root cause: meatbag branch returned uploads via `SELECT * FROM meatlab_submissions` and never threaded the actual comments. Now bridges to the `posts` table via `feed_post_id` and attaches `comments[]` + `liked` + `bookmarked` per upload. Uploads without a `feed_post_id` (not yet pushed to feed) keep empty enrichment with zero extra queries.
- **B3** — profile response was `Cache-Control: public, s-maxage=30, SWR=300` even with `session_id`, so a follow/like/bookmark click was hidden behind a 30s stale cache. Switched to `private, no-store` when `session_id` is present (same pattern as `/api/likes`, `/api/bookmarks`, `/api/notifications`). The session-less branch keeps the CDN cache.

**Done:**
- `src/app/api/profile/route.ts`: persona branch gets `liked` + `bookmarked` via existing `getLikedSet` + `getBookmarkedSet` helpers in the comment-batch Promise.all. Meatbag branch extracts `feed_post_id`s, runs a conditional enrichment batch (comments + liked + bookmarked), and maps the results back to each upload. Cache-Control split introduced: `PRIVATE_CACHE` when session_id present, `PUBLIC_CACHE` otherwise.
- 5 new tests (1 for B1, 2 for B2 — with and without feed_post_id — and 2 for B3 on both branches). 1 existing test updated to cover the new meatbag envelope shape.
- Suite now **288/288**, up from 283.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (288/288)
- `npm run build` — passing

**Matrix impact:** B1 + B2 + B3 move from ❌ to ✅ once deployed. B4 (`/api/bookmarks`) and B5 (`/api/search`) still pending — next fix branch.

---

### 2026-04-20 (session 30) — fix: per-session liked state on reads

**Branch:** `claude/fix-liked-state-on-reads`

**Bug report:** user clicked like on a post via the consumer frontend, heart filled + count bumped (write succeeded — confirmed via DevTools: `POST /api/interact` → 200 OK, `X-Matched-Path: /api/interact`). Navigated away and back → heart rendered empty again (though count stayed bumped, so the write persisted in `human_likes` + `posts.like_count`). Root cause: `/api/feed` and `/api/post/[id]` never returned a per-post `liked: true` flag keyed to the requesting session, so the consumer UI had nothing to re-hydrate from and defaulted to the empty state. Legacy `/api/feed` had the same gap — the old consumer path must have been relying on a separate `/api/likes` call to cross-reference. Cleaner fix here is to include the flag in the feed / post read itself.

**Done:**
- New `getLikedSet(postIds, sessionId)` in `src/lib/repositories/posts.ts`. Single `SELECT post_id FROM human_likes WHERE post_id = ANY($1) AND session_id = $2`. Swallows DB errors (matches the sibling `getBookmarkedSet` pattern — a transient likes outage shouldn't take down the feed).
- `/api/feed/route.ts`: added the helper to the parallel `Promise.all` enrichment pass; each post now carries `liked: boolean`.
- `/api/post/[id]/route.ts`: same, single-post variant.
- 6 new integration tests (4 feed + 2 post/[id]) covering the happy path, session scoping (user-2 doesn't see user-1's likes), and no-session no-query behavior. Updated 3 existing tests to reflect the extra SQL call in the mock result stream.
- Suite now **283/283**, up from 277.

**Cache-Control:** unchanged. Personalized paths already key cache by full URL (incl. `session_id`) so two sessions get two cache entries — no cross-session leakage.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (283/283)
- `npm run build` — passing
- Post-deploy: click like on any post → navigate away → return. Heart should stay filled.

**Next:** generate `docs/consumer-qa-matrix.md` so we can systematically find other read-side gaps (bookmark persistence, follow state, comment visibility, etc.). Same pattern as this fix — check each consumer-facing flow, catalog what's correct vs what's broken, fix in priority order.

---

### 2026-04-20 (session 29) — /api/coins Slice 3 (send_to_persona + send_to_human)

**Branch:** `claude/migrate-coins-slice-3-transfers`

**Done:**
- New repo helpers in `src/lib/repositories/users.ts`:
  - `deductCoins(sessionId, amount, reason, referenceId?)` → `{success, newBalance}`. Non-transactional (legacy parity) — race window between balance check and UPDATE is accepted.
  - `getUserByUsername(username)` → `HumanUser | null`. Lowercases input to match legacy (human_users.username is stored lowercase).
  - `HumanUser` type (minimal: id, session_id, display_name, username).
  - `MAX_TRANSFER = 10_000` constant.
- New `getIdAndDisplayName(personaId)` in `src/lib/repositories/personas.ts` — just what the transfer flow needs.
- `POST /api/coins` dispatches `send_to_persona` (debits sender, credits `ai_persona_coins`) and `send_to_human` (debits sender, credits recipient's `glitch_coins` + logs "Received from a friend").
- **Legacy-parity error contract preserved:**
  - 400 Invalid amount (missing/non-number/<1/over cap)
  - 400 `Max transfer is §10,000` when over cap
  - 402 Insufficient balance with `balance` + `shortfall` in body
  - 404 Persona not found / User not found
  - 400 Cannot send coins to yourself (send_to_human only)
- 14 new POST tests (7 send_to_persona + 7 send_to_human). Suite now **277/277**, up from 263.
- `/docs` page updated with Slice 3.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (277/277)
- `npm run build` — passing; `/api/coins` listed as dynamic route

**Phase 3 progress:** 4 of ~20 small routes + 3 of 5 coin slices.

---

### 2026-04-20 (session 28) — /api/coins Slice 2 (claim_signup)

**Branch:** `claude/migrate-coins-slice-2-signup`

**Done:**
- New `claimSignupBonus(sessionId)` in `src/lib/repositories/users.ts` returning a discriminated union (`{kind: "already_claimed"} | {kind: "awarded", amount}`). Idempotency keyed on `coin_transactions.reason = 'Welcome bonus'` — matches legacy's duplicate check.
- Exported `SIGNUP_BONUS = 100` constant (matches `COIN_REWARDS.signup` in legacy `bible/constants.ts`).
- `POST /api/coins` now dispatches on `action`. `claim_signup` wired. Other 6 actions (`send_to_persona`, `send_to_human`, `purchase_ad_free`, `check_ad_free`, `seed_personas`, `persona_balances`) return 501 via a shared `UNSUPPORTED_ACTIONS` set. Unknown action → 400.
- **Legacy-parity quirk:** duplicate claim returns **200** (not 400/409) with `{error: "Already claimed", already_claimed: true}`. Mid-migration consumers expect that shape.
- 13 new POST tests (3 validation + 4 claim_signup + 6 deferred + 1 unknown). Suite now **263/263**, up from 250.
- `/docs` page updated to describe Slice 2.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (263/263)
- `npm run build` — passing; `/api/coins` listed as dynamic route

**Phase 3 progress:** 4 of ~20 small routes + 2 of 5 coin slices.

---

### 2026-04-20 (session 27) — /api/coins Slice 1 (GET only)

**Branch:** `claude/migrate-coins`

**Done:**
- Added `getCoinBalance(sessionId)` + `getTransactions(sessionId, limit=20)` to `src/lib/repositories/users.ts`, plus `CoinBalance` / `CoinTransactionRow` types. Both coerce Neon's stringified numerics to JS `number` (legacy quirk).
- New `src/app/api/coins/route.ts`: GET returns `{balance, lifetime_earned, transactions}`. Missing `session_id` returns zeros (legacy parity — no 400). Cache-Control `private, no-store` for session-personalised data. POST returns `501 action_not_yet_migrated` with the action echoed — so consumers keep falling through to legacy via the strangler until Slices 2-5 ship.
- 9 new integration tests (7 GET + 2 POST). Suite now **250/250**, up from 241.
- `/docs` page updated with the Slice 1 entry + deferred-action list.

**Slicing plan for /api/coins (5 slices total):**
- Slice 1 — GET (this session) ✅
- Slice 2 — `claim_signup` (welcome bonus)
- Slice 3 — `send_to_persona` + `send_to_human` (transfers; new `deductCoins` helper + `users.getByUsername`)
- Slice 4 — `purchase_ad_free` + `check_ad_free` (requires `phantom_wallet_address` on `human_users`)
- Slice 5 — `seed_personas` + `persona_balances` (admin-ish)

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (250/250)
- `npm run build` — passing; `/api/coins` listed as dynamic route

**Phase 3 progress:** 4 of ~20 small routes shipped.

---

### 2026-04-20 (session 26) — /api/movies + /api/hatchery combo

**Branch:** `claude/migrate-movies-and-hatchery`

**Done:**
- New `src/lib/repositories/movies.ts`: `listDirectorMovies({genre?, director?})` and `listPremierePosts({genre?})`. Both swallow missing-table errors (legacy parity — `director_movies` and `multi_clip_jobs` land with Phase 5's AI engine port).
- New `src/lib/repositories/hatchery.ts`: `listHatchlings({limit, offset})`. `limit` clamped to 50. Returns `{hatchlings, total}` — the route derives `hasMore`.
- New `src/lib/content/directors.ts`: slim copy of the legacy `DIRECTORS` constant — just `username`, `displayName`, `genres` for the 10 directors. The legacy file (~1600 LOC) bundles Grok prompt profiles (visualOverride, colorPalette, cameraWork) tied to the AI engine; that migrates with Phase 5. For `/api/movies` only the filter metadata is needed today.
- New `src/lib/genres.ts`: `GENRE_LABELS` only. Full `genre-utils` (blob folders, hashtag helpers) migrates with the AI engine.
- New `src/app/api/movies/route.ts`: merges both sources, de-dupes trailers against blockbuster `post_id` / `premiere_post_id`, computes `genreCounts` + `directorCounts`, returns the full shape legacy does (including `genreLabels` so consumers don't need a second round-trip). Parallel fetch via `Promise.all`. Cache-Control `public, s-maxage=60, stale-while-revalidate=300`.
- New `src/app/api/hatchery/route.ts`: thin handler over `listHatchlings`. Cache-Control `public, s-maxage=60, stale-while-revalidate=300`.
- 20 new tests (12 movies + 8 hatchery). Suite now 241/241, up from 221.
- `/docs` page updated with both endpoints.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (241/241)

**Phase 3 progress:** 3 of ~20 small routes shipped in Phase 3 (`/api/personas`, `/api/movies`, `/api/hatchery`).

---

### 2026-04-20 (session 25) — /api/personas (Phase 3 kick-off)

**Branch:** `claude/migrate-personas-list`

**Done:**
- Added `listActive` + `PersonaSummary` to `src/lib/repositories/personas.ts`. Cached 120s via `cache.getOrSet` with the legacy cache key `personas:active` — matches the aiglitch cache so both backends share L1+L2 entries during migration.
- New `src/app/api/personas/route.ts`: GET returns `{personas: [...]}`. Public, `Cache-Control: public, s-maxage=120, stale-while-revalidate=600` (the hottest read on the platform; legacy uses the same durations).
- 5 new integration tests. Suite now 221/221, up from 216.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (221/221)
- `npm run build` — passing; `/api/personas` listed as dynamic route
- Post-deploy: `curl https://api.aiglitch.app/api/personas` → `{personas: [...96 personas...]}`

**Phase 3 scoring:** first of ~20 small routes per roadmap. Opens the Phase 3 run.

---

### 2026-04-20 (session 24) — /api/events

**Branch:** `claude/migrate-events`

**Done:**
- New `src/lib/repositories/events.ts`: `listEvents(sessionId?)` and `toggleEventVote(eventId, sessionId)`. `listEvents` parses `target_persona_ids` from its JSON-string column form into an array (with a malformed-JSON fallback). `toggleEventVote` returns a discriminated union (`"voted" | "unvoted" | "event_not_found" | "event_inactive"`) so the route handler picks the right HTTP status.
- New `src/app/api/events/route.ts`: GET returns `{success: true, events}` (Cache-Control `public, s-maxage=30, SWR=300`). POST validates body, toggles vote. 400/404 for anticipated failures. **Legacy-parity quirk: unexpected errors return 200 with `{success: false, error}` rather than 500** — legacy does this and I preserve it so mid-migration consumers don't break on a new status code they weren't prepared for.
- Skipped the legacy's inline `CREATE TABLE IF NOT EXISTS community_events / community_event_votes` safeMigrate calls. Schema is owned by aiglitch during migration; tables already exist.
- 15 new integration tests covering both paths. Suite now 216/216, up from 201.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (216/216)
- `npm run build` — passing
- Post-deploy: `curl "https://api.aiglitch.app/api/events"` → `{success: true, events: [...]}`
- Post-deploy: POST `{"event_id":"<real>","session_id":"<yours>"}` → `{success: true, action: "voted", event_id}`; POST again → `"unvoted"`

**Common public/session endpoints now complete.**
Major categories still pending in the 179-route catalog: admin (~85), cron (21), OAuth (12), trading/wallet (~15), specialised subsystems (bestie chat, NFT marketplace, merch, marketing, Telegram, email). Each needs its own phase plan — next session should be a planning one rather than another solo port.

**Safety notes:**
- Non-transactional INSERT+UPDATE on vote toggle (legacy parity). Under extreme concurrency the vote_count can drift from the actual row count.
- `community_event_votes` has `UNIQUE(event_id, session_id)` so a double-click can't double-vote even if both paths run before either INSERT lands.

---

### 2026-04-20 (session 23) — /api/profile

**Branch:** `claude/migrate-profile`

**Done:**
- Extended `src/lib/repositories/personas.ts` with four new functions: `getByUsername` (cached 60s), `isFollowing` (uncached — per-session), `getStats` (cached 30s, aggregate), `getMedia` (cached 60s, swallows errors). First use of our `cache.ts` two-tier helper at the repo layer.
- Extended `src/lib/repositories/posts.ts` with `getByPersona` — matching the legacy filter set: excludes replies, director-scene fragments, and meatbag-attributed posts (so the Architect's profile doesn't flood with every MeatLab upload, since all MeatLab posts use `glitch-000` as the DB-level `persona_id`).
- New `src/app/api/profile/route.ts`:
  - `?username=X` required; 400 if missing.
  - Persona branch first. If `getByUsername` hits, fires four parallel queries (`isFollowing`, `getByPersona`, `getStats`, `getMedia`), then batches AI+human comments and threads them (10 top-level per post). Returns `{persona, posts, stats, isFollowing, personaMedia}`.
  - Meatbag fallback: SQL lookup against `human_users` matching `LOWER(username) = ?` OR `LOWER(id) = ?`. On hit, parallel queries for `meatlab_submissions` uploads + aggregate stats. Returns `{is_meatbag: true, meatbag, uploads, stats}`.
  - 404 if neither branch hits, 500 on DB error.
  - `Cache-Control: public, s-maxage=30, stale-while-revalidate=300` — safe because Vercel keys the edge cache by full URL, so `?username=X&session_id=Y` and `?username=X&session_id=Z` don't collide.
- 9 new integration tests covering every branch + validation + Cache-Control + error wrapping. Suite now 201/201, up from 192.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (201/201)
- `npm run build` — passing; `/api/profile` listed as dynamic route
- Post-deploy: `curl "https://api.aiglitch.app/api/profile?username=the_architect"` → persona envelope; `curl "https://api.aiglitch.app/api/profile?username=<your-meatbag-username>"` → meatbag envelope; `curl "https://api.aiglitch.app/api/profile?username=bogus"` → 404.

**Safety notes:**
- Persona branch filters out `meatbag_author_id IS NOT NULL` so the Architect's profile doesn't flood with every MeatLab upload. Legacy parity.
- `isFollowing` lookup is NOT cached per-session — would be a cache explosion across sessions. Legacy also leaves this uncached.

---

### 2026-04-20 (session 22) — /api/notifications

**Branch:** `claude/migrate-notifications`

**Closes the loop** — `maybeAIFollowBack` (Slice 2) has been writing `ai_follow` rows into `notifications` since v0.13.0, but there was no endpoint to read them. Users can now see those back-follows.

**Done:**
- New `src/lib/repositories/notifications.ts` with four functions: `getUnreadCount`, `list`, `markRead`, `markAllRead`. The list path runs the row query + unread count in parallel via `Promise.all`.
- New `src/app/api/notifications/route.ts`:
  - `GET /api/notifications?session_id=X` → `{notifications: [...], unread: N}`
  - `GET /api/notifications?session_id=X&count=1` → `{unread: N}`
  - `POST /api/notifications` with `{session_id, action, notification_id?}` — `action` is `mark_read` (requires `notification_id`) or `mark_all_read`. Unknown actions no-op with `success: true` (legacy parity).
  - 400 on missing session_id, 500 on POST DB error, graceful empty fallback on GET list errors (legacy parity — frontend never wants to break on the notifications panel).
  - `Cache-Control: private, no-store` on all paths (applied the likes/bookmarks lesson up front).
- 15 new integration tests covering all paths including the graceful-fallback + no-op behaviours. Suite now 192/192, up from 177.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (192/192)
- `npm run build` — passing; `/api/notifications` listed as dynamic route
- Post-deploy: `curl "https://api.aiglitch.app/api/notifications?session_id=<your-uuid>"` → should show any AI-follow-back notifications written since v0.13.0

**Safety notes:**
- `markRead` uses `WHERE id = … AND session_id = …` so a user can't accidentally (or maliciously) mark someone else's notification as read by knowing the id.
- `markAllRead` only touches rows where `is_read = FALSE` — so replaying a mark_all_read is a cheap no-op rather than a mass UPDATE.

---

### 2026-04-20 (session 21) — /api/search

**Branch:** `claude/migrate-search`

**Done:**
- Extended `src/lib/repositories/search.ts` with `searchAll(query)` — three parallel `LIKE` queries on posts (content + hashtags), personas (username/display_name/bio), and hashtag aggregates. Limits pulled from legacy `PAGINATION.searchResults*` (posts 20, personas 10, hashtags 10) and inlined alongside the trending constants.
- Leading `#` stripped before hashtag match — hashtags are stored without the hash. Posts content still searches against the raw (lowercased) query so `#AIGlitch` matches literal `#AIGlitch` in post content.
- All three queries run via `Promise.all` in parallel.
- New `src/app/api/search/route.ts`: returns empty envelope (`{posts: [], personas: [], hashtags: []}`) when `q` is missing, whitespace-only, or < 2 chars — no DB hit. Otherwise delegates to `searchAll`. `Cache-Control: public, s-maxage=60, stale-while-revalidate=300` — safe because same query returns same results for everyone.
- 12 new integration tests covering: empty-q paths (no DB), shape, parallel-query shape, `#` stripping behaviour, lowercase normalisation, per-query SQL constants (limits + key filters), Cache-Control, and 500 wrapping.
- Suite now 177/177, up from 165.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (177/177)
- `npm run build` — passing; `/api/search` listed as dynamic route
- Post-deploy: `curl "https://api.aiglitch.app/api/search?q=ai"` → `{posts: [...], personas: [...], hashtags: [...]}`
- Post-deploy: `curl "https://api.aiglitch.app/api/search?q=x"` → empty envelope (2-char minimum)

**Safety notes:**
- `LIKE '%term%'` doesn't use indexes — legacy accepted this performance profile. Not a regression; just noted for the future if search becomes hot enough to warrant trigram indexes.
- Queries combine OR conditions on multiple lowercased columns; no SQL injection risk because the values are passed as parameters, not concatenated into the query string.

---

### 2026-04-20 (session 20) — /api/trending

**Branch:** `claude/migrate-trending`

**Done:**
- New `src/lib/repositories/search.ts` with just `getTrending()` — two parallel aggregate queries:
  - Top 15 hashtags in `post_hashtags` over the last 7 days
  - Top 5 active personas by post count over the last 24 hours
- New `src/app/api/trending/route.ts` — GET handler, returns `{trending, hotPersonas}` shape matching legacy byte-for-byte. Cache-Control: `public, s-maxage=60, stale-while-revalidate=300` (safe — response is NOT session-personalised so CDN caching is correct here, unlike likes/bookmarks).
- Inlined `TRENDING_HASHTAGS_LIMIT = 15` and `TRENDING_PERSONAS_LIMIT = 5` from legacy `PAGINATION` constants.
- 7 new integration tests covering shape, empty aggregates, parallel-query shape, SQL constants (limits + time windows), Cache-Control, and 500 wrapping. Suite now 165/165, up from 158.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (165/165)
- `npm run build` — passing; `/api/trending` listed as dynamic route
- Post-deploy: `curl https://api.aiglitch.app/api/trending` → `{trending: [...], hotPersonas: [...]}`

**Safety notes:**
- This IS CDN-cacheable because the aggregate is identical for all callers; no session or user state. Distinct from likes/bookmarks where personalisation required `private, no-store`.

---

### 2026-04-19 (session 19) — /api/likes + /api/bookmarks CDN fix

**Branch:** `claude/fix-likes-bookmarks-cache-control`

**Bug:** Session-personalised `/api/likes` and `/api/bookmarks` had `Cache-Control: public, s-maxage=15, stale-while-revalidate=120`. Vercel's edge cached the first response per URL. If the first hit was before the user had any data (empty response), SWR's background refresh window kept serving stale empties across fresh writes. A user bookmarking 3 posts still saw `{posts: []}` via the API. Direct SQL confirmed 3 rows; cache-bust query string returned them. Caching was the culprit.

**Fix:** Both endpoints now `Cache-Control: private, no-store`. No CDN caching for session-personalised reads. Deployed as `v0.17.1`.

---

### 2026-04-19 (session 18) — /api/likes + /api/bookmarks (read-only companions)

**Branch:** `claude/migrate-likes-and-bookmarks`

**Why two together:** they're near-identical twins (same shape, same comment-enrichment path, different source table + overlay flag). Porting as a pair lets the shared helper ship once.

**Done:**
- `getLikedPosts(sessionId, limit=50)` + `getBookmarkedPosts(sessionId, limit=50)` added to `src/lib/repositories/interactions.ts`. Both JOIN `posts` + `ai_personas` and order by the respective `created_at DESC` (like time or bookmark time, not post time).
- New `src/lib/feed/attach-comments.ts` — shared helper for both endpoints. Batch-fetches AI + human comments for a set of posts, groups by `post_id`, sorts chronologically ascending, slices to 20. Takes an `overlay` object that's merged into each post (e.g. `{liked: true}` or `{bookmarked: true}`). Legacy duplicated this inline in both route handlers; centralised here so a future third endpoint can reuse.
- `src/app/api/likes/route.ts` + `src/app/api/bookmarks/route.ts` — both return `{posts: [...]}` with empty list when `session_id` is missing (no DB hit, matching legacy). `Cache-Control: public, s-maxage=15, SWR=120` (personalised).
- 13 new integration tests (8 likes + 5 bookmarks). Suite now 158/158, up from 146.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (158/158)
- `npm run build` — passing; both routes listed as dynamic
- Post-deploy smoke: `curl "https://api.aiglitch.app/api/likes?session_id=<uuid>"` → `{posts: [...]}` with your liked posts. Same with `/api/bookmarks`. Without `session_id`: `{posts: []}`.

**Not done this session:**
- Consumer flip for either endpoint — same stability-window approach as `/api/post/[id]` and `/api/channels`.
- **AI auto-reply trigger** re-examined at start of session; deferred again because it's ~500 LOC and not blocking any consumer work. Flagged as a standalone standalone-focus task rather than shoehorned in between small ports.

**Safety notes:**
- Comment shape here is the FLAT list (chronological, no replies tree) — different from feed's threaded shape. Consumer tests against the new backend's `/api/likes` should expect `comments: [{id, content, …}]` (no nested `replies`).
- `session_id` missing returns 200 with empty list (legacy parity). This is arguably friendlier than a 400 — caller doesn't need to special-case the first-visitor path.

---

### 2026-04-19 (session 17) — /api/interact coin-award retrofit

**Branch:** `claude/migrate-interact-coin-awards`

**Done:**
- New `src/lib/repositories/users.ts` with `awardCoins(sessionId, amount, reason, referenceId?)` and `awardPersonaCoins(personaId, amount)`. Both are idempotent upserts matching legacy byte-for-byte: `glitch_coins` for humans (with a `coin_transactions` log row) and `ai_persona_coins` for AI (no log — legacy parity). `deductCoins` / `getTransactions` / balance reads deferred until a downstream endpoint needs them.
- Retrofitted both `TODO(Slice 5)` sites in `src/lib/repositories/interactions.ts`:
  - `toggleLike` now fires **first-like bonus** (+2 GLITCH) when `COUNT(*) human_likes` for the session returns 1, then **persona-like reward** (+1 to the post's persona). Both wrapped in try/catch — any failure is swallowed, legacy-style.
  - `addComment` now fires **first-comment bonus** (+15 GLITCH) when `COUNT(*) human_comments` for the session returns 1. Same try/catch.
- Inlined `COIN_REWARDS = { firstLike: 2, firstComment: 15, personaLikeReceived: 1 }`. The other legacy rewards (signup/referral/dailyLogin/etc.) stay out until their endpoints land.
- Updated one existing test that pinned `fake.calls.length === 4` — coin lookups now fire unconditionally (SELECT COUNT, SELECT persona_id) even when trackInterest skipped, so the count is 6 on that specific code path.
- 6 new tests: first-like bonus fires, first-like skipped when count > 1, persona coins always fire when post exists, coin-failure swallowed without breaking main action, first-comment bonus fires, first-comment skipped when count > 1. Suite now 146/146, up from 140.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (146/146)
- `npm run build` — passing
- Post-deploy smoke: like a post with a fresh session, hit `/api/coins` (old backend) and confirm balance is +2. (This is end-to-end only meaningful after consumer flip; for now the reward fires but is only visible on the new backend's own read endpoints, which aren't migrated yet.)

**Not done this session:**
- AI auto-reply trigger — the last slice before consumer flip.

**Safety notes:**
- Coin-award side effects happen AFTER the main action, in try/catch blocks — if the coin writes fail (e.g. Neon replication lag hiding the COUNT), the main action stays successful. Legacy parity.
- Lifetime_earned is bumped every time, not just on net-positive changes — matches legacy. A `deductCoins` path (when it lands) won't touch lifetime_earned.
- `firstLike` / `firstComment` checks are COUNT == 1 which includes the write that just happened. Under extreme concurrency a session could theoretically get two "first" bonuses if two likes land simultaneously before either SELECT COUNT sees the other. Legacy has the same race; not worth fixing here.

---

### 2026-04-19 (session 16) — /api/interact subscribe (re-ordered ahead of coins + AI reply)

**Branch:** `claude/migrate-interact-subscribe`

**Slice re-order:** originally Slice 6, pulled forward as the smallest remaining slice so all 9 actions clear their 501 state together. New ordering: **subscribe (this) → coin awards (was Slice 5) → AI auto-reply (was Slice 4, now last because it's the biggest remaining port)**.

**Done:**
- `toggleSubscribeViaPost(postId, sessionId)` in `src/lib/repositories/interactions.ts` — looks up `persona_id` from the post, delegates to `toggleFollow` (so follower_count + maybeAIFollowBack stay consistent), calls `trackInterest` on fresh subscribe only. Returns `null` when the post doesn't exist so the route can 404.
- Wired into `src/app/api/interact/route.ts`: `subscribe` branch validates `post_id`, 404s on missing post, returns `{success: true, action: "subscribed" | "unsubscribed"}`. `UNSUPPORTED_ACTIONS` is now `[]`.
- 4 new integration tests: 400 on missing post_id, 404 on ghost post, 200 subscribed on fresh follow, 200 unsubscribed on existing follow. Suite now 140/140, up from 136.

**No more 501s.** All nine `/api/interact` actions are served by this backend. Two legacy side-effects remain un-ported (AI auto-reply, coin awards) — both invisible until consumer flip, both documented with TODO markers in the repo.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (140/140)
- `npm run build` — passing
- Post-deploy smoke: `curl -X POST https://api.aiglitch.app/api/interact -d '{"session_id":"<uuid>","post_id":"<id>","action":"subscribe"}'` → `{success: true, action: "subscribed"}` or `"unsubscribed"`; `{"post_id":"nope","action":"subscribe"}` → 404 with `"Post not found"`.

**Not done this session:**
- Coin-award retrofit (was Slice 5). Ports `users.awardCoins` + `users.awardPersonaCoins` + `COIN_REWARDS` constants. Retrofits TODOs in `toggleLike` and `addComment`.
- AI auto-reply trigger (was Slice 4). Biggest remaining port: xAI / Anthropic clients, circuit breaker, cost ledger, `generateReplyToHuman`. Consumer flip on `/api/interact` waits until this lands.

**Safety notes:**
- `toggleSubscribeViaPost` delegates to `toggleFollow` so the AI-follow-back probability roll still happens on fresh subscribes — identical to legacy.
- `trackInterest` only fires on the `followed` result path (legacy parity). An unsubscribe does not remove interest weight.

---

### 2026-04-19 (session 15) — /api/interact Slice 3 (comment + comment_like)

**Branch:** `claude/migrate-interact-slice-3`

**Done:**
- Extended `src/lib/repositories/interactions.ts`:
  - `addComment(postId, sessionId, content, displayName, parentCommentId?, parentCommentType?)` — trims content to 300 chars, displayName to 30 chars (default "Meat Bag"), inserts `human_comments`, increments `posts.comment_count`, calls `trackInterest`. Returns the full `CommentResult` shape the consumer renders directly.
  - `toggleCommentLike(commentId, commentType, sessionId)` — dispatches the counter update based on `commentType`: `"human"` → `human_comments.like_count`, anything else (AI comments are stored as posts with `is_reply_to`) → `posts.like_count`. `GREATEST(0, …)` guard on remove path.
  - Inlined `COMMENT_MAX_LENGTH = 300`, `DISPLAY_NAME_MAX_LENGTH = 30`.
- Extended `src/app/api/interact/route.ts`:
  - Removed `comment` + `comment_like` from `UNSUPPORTED_ACTIONS`. Only `subscribe` remains deferred.
  - `comment` branch validates `post_id` + non-empty `content`; accepts `display_name`, `parent_comment_id`, `parent_comment_type`; response body is `{success: true, action: "commented", comment: CommentResult}` matching legacy. Left a `TODO(Slice 4)` where AI auto-reply will fire.
  - `comment_like` branch validates `comment_id` + `comment_type`; response is `{success: true, action: "comment_liked" | "comment_unliked"}`.
- 10 new integration tests: 3 validation cases for `comment` (missing post_id / missing content / whitespace-only), 2 validation cases for `comment_like` (missing comment_id / comment_type), insert+counter+trackInterest flow, content truncation at 300, display_name default + trim, parent_comment fields pass-through, human vs AI counter target, GREATEST guard on remove.
- Suite now 136/136, up from 126.

**Coin + AI reply deferral:**
- Legacy `addComment` awards a first-comment coin bonus — stripped, `TODO(Slice 5)`.
- Legacy route fires `triggerAIReply(post_id, comment.id, …)` after `addComment`. Not ported in this slice — `TODO(Slice 4)` marker in the route. Comment writes work; human comments land in the DB. AI replies will start flowing once Slice 4 ports the AI engine. Consumer is still on the old backend so real users still see AI replies.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (136/136)
- `npm run build` — passing; `/api/interact` still the single route
- Post-deploy smoke: `curl -X POST https://api.aiglitch.app/api/interact -d '{"session_id":"<uuid>","post_id":"<id>","content":"test","action":"comment"}'` → `{success: true, action: "commented", comment: {...}}`
- Post-deploy smoke: `curl -X POST ... -d '{"session_id":"<uuid>","comment_id":"<id>","comment_type":"human","action":"comment_like"}'` → `{success: true, action: "comment_liked"}`

**Not done this session:**
- Slice 4: AI auto-reply trigger — ports the AI engine stack (xAI / Anthropic clients, circuit breaker, cost tracking, `generateReplyToHuman`).
- Slice 5: coin-award retrofit across like / comment.
- Slice 6: `subscribe` (the last 501'd action).

**Safety notes:**
- `addComment` response is time-sensitive: `created_at` is `new Date().toISOString()` (app-generated, not DB-generated). Clock skew between the DB and the serverless instance could theoretically diverge. Legacy does the same — preserved.
- The first real test write from api.aiglitch.app that will be visible in the aiglitch.app feed once the consumer flips — worth a careful end-to-end once all 6 slices land.

---

### 2026-04-19 (session 14) — /api/interact Slice 2 (follow + react)

**Branch:** `claude/migrate-interact-slice-2`

**Done:**
- Extended `src/lib/repositories/interactions.ts` with:
  - `toggleFollow(personaId, sessionId)` — toggles `human_subscriptions`, bumps `ai_personas.follower_count` with `GREATEST(0, …)` decrement guard, triggers `maybeAIFollowBack` on the follow path.
  - `maybeAIFollowBack(personaId, sessionId)` — internal, rolls `AI_FOLLOW_BACK_PROB` (40%), inserts `ai_persona_follows` row, sends an `ai_follow` notification with `"<display_name> followed you back! 🤖"` preview.
  - `toggleReaction(postId, sessionId, emoji)` — 4-emoji enum (`funny`, `sad`, `shocked`, `crap`); inserts `emoji_reactions` row; upserts `content_feedback` with scored formula (`funny×3 + shocked×2 + sad - crap×2`); `GREATEST(0, …)` guards on remove path; throws on invalid emoji so the route can 400.
  - `getReactionCounts(postId)` — aggregates and returns `{funny, sad, shocked, crap}` counts.
  - Inlined `AI_FOLLOW_BACK_PROB = 0.40` + `VALID_EMOJIS` + `EMOJI_SCORE_DELTA` map.
- Extended `src/app/api/interact/route.ts`:
  - Removed `follow` + `react` from `UNSUPPORTED_ACTIONS`. Only `comment`, `comment_like`, `subscribe` remain deferred.
  - `follow` branch validates `persona_id` (not `post_id`).
  - `react` branch validates `post_id` + `emoji`; translates `Invalid emoji:` thrown errors into 400 while passing other errors through to the 500 wrapper.
- 8 new integration tests: follow missing persona_id, follow add/remove, maybeAIFollowBack fires / skips / stops on already-follows, react missing post_id / missing emoji / invalid emoji, react add with scored upsert, react remove with GREATEST guard.
- Suite now 126/126, up from 118.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (126/126)
- `npm run build` — passing; `/api/interact` still the single endpoint
- Post-deploy smoke: `curl -X POST https://api.aiglitch.app/api/interact -d '{"session_id":"<uuid>","persona_id":"glitch-001","action":"follow"}'` → `{success: true, action: "followed"}` / `"unfollowed"` on second call.
- Post-deploy smoke: same endpoint with `{"post_id":"<id>","emoji":"funny","action":"react"}` → `{success: true, action: "reacted", emoji: "funny", counts: {...}}`.

**Not done this session:**
- Slice 3: `comment` + `comment_like` (no AI reply, that's Slice 4).
- Slice 4: AI auto-reply trigger.
- Slice 5: coin-award retrofit (touches likes and reactions retroactively).
- Slice 6: `subscribe` (post-id → persona lookup, calls toggleFollow).

**Safety notes:**
- `toggleReaction` upsert uses Postgres UPSERT semantics — concurrent first-press from the same session would race to insert. `ON CONFLICT (post_id)` in content_feedback is fine, but emoji_reactions has no explicit unique constraint shown; legacy trusts the SELECT-then-INSERT flow. Legacy race preserved.
- `maybeAIFollowBack` is fire-and-forget semantically — any error inside would currently surface as a 500 to the caller. Legacy wraps in an outer try/catch in the route. Kept the same shape (route's catch handles it).

---

### 2026-04-19 (session 13) — /api/interact Slice 1 (like / bookmark / share / view)

**Branch:** `claude/migrate-interact-slice-1`

**Done:**
- New `src/lib/repositories/interactions.ts` with 4 public functions (`toggleLike`, `toggleBookmark`, `recordShare`, `recordView`) plus internal `trackInterest` helper. Matches legacy SQL shape including the `GREATEST(0, …)` decrement guard and the `ON CONFLICT … DO UPDATE weight = weight + 0.5` interest upsert.
- New `src/app/api/interact/route.ts`:
  - Validates body (400 on bad JSON, missing session_id / action / post_id, unknown action)
  - Returns `501 action_not_yet_migrated` with the exact action name for `follow`, `react`, `comment`, `comment_like`, `subscribe`
  - Dispatches supported actions via a `switch` and returns `{ success: true, action: <result> }` matching legacy
  - 500 wrapping with detail on write failure
- 19 new integration tests: validation, 501 coverage of all 5 deferred actions, toggle semantics on like & bookmark, SQL-shape checks for each action, `trackInterest` fires on like+share but not bookmark+view, `trackInterest` skip when post lookup is empty, error wrapping.
- Suite now 118/118, up from 99.

**Coin-award stripping:**
Legacy `toggleLike` awards a first-like bonus + persona-like reward, both wrapped in `try { … } catch { /* non-critical */ }`. Those are NOT ported here. Replaced with a `TODO(Slice 5)` marker where they'll slot back in once `users.awardCoins` / `users.awardPersonaCoins` + `COIN_REWARDS` land. Consumer impact: zero — `/api/interact` consumer isn't flipped yet, so live coin awards still happen on the legacy backend.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (118/118)
- `npm run build` — passing; `/api/interact` listed as dynamic route
- Post-deploy smoke: `curl -X POST https://api.aiglitch.app/api/interact -d '{"session_id":"<your-uuid>","post_id":"<real-id>","action":"like"}'` → expect `{success: true, action: "liked"}` the first time, `"unliked"` the second. Use a throwaway test post to avoid polluting real counts.
- Post-deploy negative: `curl -X POST … -d '{"session_id":"x","post_id":"y","action":"follow"}'` → 501 with `{error: "action_not_yet_migrated", action: "follow"}`.

**Not done this session:**
- **Consumer flip for /api/interact** — waiting until all 6 slices land. Every action must be migrated before we can flip, otherwise the AI reply trigger, follows, comments etc. break.
- **Slice 2**: follow + react
- **Slice 3**: comment + comment_like (without AI reply)
- **Slice 4**: AI reply trigger + required AI infrastructure
- **Slice 5**: coin award retrofit
- **Slice 6**: subscribe-via-post glue

**Safety notes:**
- First hot-path write endpoint (millions of events/month). `interactions.toggleLike` queries are additive to existing traffic — the live aiglitch.app still handles the hot path until the consumer flips.
- `trackInterest` performs parallel upserts via `Promise.all`; under very high concurrency a session_id could see `human_interests` rows double-bump. Legacy has the same race. Not fixing here — identical write shape is more important than correctness drift mid-migration.

---

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
