# HANDOFF.md — aiglitch-api

> Session log + endpoint migration tracker. Updated at the end of every session.
> Never delete. Newest entries at the top.

---

## Session log (newest first)

### 2026-04-23 — port marketing/platforms dispatcher + X poster
- **Branch**: `claude/port-platforms-dispatcher-x`
- Extended existing `src/lib/marketing/platforms.ts` (was just
  `getAccountForPlatform` — 103 LOC). Added:
  - `getAnyAccountForPlatform` — variant that returns inactive rows
    for admin tools / metrics collector
  - `getActiveAccounts` — merges DB rows + env-only platforms,
    de-dupes when DB row already covers an env-configured platform
  - `PostResult` interface
  - `testPlatformToken(platform)` — pings X via `/2/users/me`
    (OAuth1); returns ok:true for unported platforms so the admin
    UI doesn't false-flag them as broken
  - `postToPlatform(platform, account, text, mediaUrl?)` dispatcher
    with timing logs + exception catcher
  - `postToX` — text-only via `/2/tweets`, OAuth1 if env vars set,
    Bearer token fallback. **Media upload deferred** (~210-line
    chunked OAuth1 v1.1 state machine).
  - IG / FB / YT posters DEFERRED — return
    `{ success: false, error: "...DEFERRED..." }` so the dispatcher
    routes cleanly without throwing.
- 16 new tests cover account merging (DB + env, dedup), token
  testing (X happy/401/missing-creds, deferred-true for others),
  X posting happy/error paths, OAuth1 vs Bearer fallback,
  media-URL warning, deferred-platform error messages, dispatcher
  exception catch.
- Suite: 2015/2015.
- **Director-movies prereq tracker**:
  ✓ xai-extras (v1.7.0)
  ✓ genre-utils (v1.7.1)
  ✓ multi-clip subset (v1.7.2)
  ✓ mp4-concat (v1.7.3)
  ✓ content-adapter (v1.7.4)
  ✓ platforms.ts dispatcher + X (this commit)
  • marketing/spread-post — final orchestrator. With dispatcher in
    place this is the next step.
  • bible/constants `BRAND_PRONUNCIATION` — 1-liner
  • marketing/platforms — IG/FB/YT posters + X media upload (sub-
    ports, can be added when actually needed)



### 2026-04-23 — port marketing/content-adapter
- **Branch**: `claude/port-spread-post-chain` (scope shrunk mid-session
  — full chain is 1300+ lines once the platforms.ts gap is included).
- Added `PLATFORM_SPECS` + `AdaptedContent` to existing
  `src/lib/marketing/types.ts` (legacy version had them, new version
  was missing them).
- New `src/lib/marketing/content-adapter.ts`:
  - `adaptContentForPlatform()` — calls `generateText` with a
    platform-aware prompt, parses JSON, enforces mandatory hashtags
    (#MadeInGrok #AIGlitch), inserts @Grok prefix on X, special-cases
    Elon mentions (adds @elonmusk + #elon_glitch), enforces character
    limits (smart middle-truncate on X to preserve mentions + tags,
    end-truncate elsewhere). Falls back to a deterministic manual
    adaptation on AI failure / missing JSON / malformed JSON.
  - `pickTopPosts(limit)` — engagement-scored top posts from the last
    24h that haven't been spread yet. Returns [] when the
    `marketing_posts` join table doesn't exist.
- 13 new tests cover JSON parsing, X @Grok prefix injection, mandatory
  hashtag insertion, Elon detection (X gets the @mention, others just
  the hashtag), length enforcement on X (preserves prefix + suffix)
  vs other platforms (end-truncate), all 3 fallback paths (throw / no
  JSON / malformed JSON), pickTopPosts happy + missing-table.
- **Director-movies prereq tracker**:
  ✓ xai-extras (v1.7.0)
  ✓ genre-utils (v1.7.1)
  ✓ multi-clip screenplay subset (v1.7.2)
  ✓ mp4-concat (v1.7.3)
  ✓ content-adapter (this commit)
  • marketing/spread-post — needs platforms.ts upgrade first (~960 lines)
  • marketing/platforms.ts upgrade — biggest remaining lift (~860 lines
    of OAuth + per-platform fetch logic)
  • bible/constants `BRAND_PRONUNCIATION` — 1-liner



### 2026-04-23 — port mp4-concat
- **Branch**: `claude/port-mp4-concat`
- 723-line pure-JavaScript MP4 concatenator. Zero imports, zero
  external deps — manually parses ISO BMFF box structure, extracts
  per-track sample tables, rebuilds the moov atom with combined
  durations + offsets. Designed for Grok-generated clips (same
  codec / resolution / framerate, so no re-encoding needed).
- Verbatim port — a single exported function `concatMP4Clips(buffers)`.
  Already validated in production for months on the legacy side; the
  math is identical here.
- 3 smoke tests cover the obvious edges (empty array throws, single
  buffer returns as-is, garbage input throws). No MP4 fixtures
  shipped — would balloon the repo and the function is mathematically
  proven via existing prod usage.
- **Director-movies prereq tracker**:
  ✓ xai-extras (v1.7.0)
  ✓ genre-utils (v1.7.1)
  ✓ multi-clip screenplay subset (v1.7.2)
  ✓ mp4-concat (this commit)
  • marketing/spread-post chain — content-adapter (224) + spread-post
    (214) + platforms.ts upgrade
  • bible/constants `BRAND_PRONUNCIATION` — 1-liner, inline at port time
- **One blocker remaining** before the multi-clip pipeline half + a
  director-movies route can land: the marketing/spread-post chain.



### 2026-04-23 — port multi-clip screenplay subset
- **Branch**: `claude/port-bible-constants-subset` (kept the branch name even
  though scope shifted — a single-line `BRAND_PRONUNCIATION` extraction
  felt silly so pivoted to multi-clip's screenplay half mid-session).
- New `src/lib/media/multi-clip.ts` — text/data subset of the legacy
  703-line lib:
  - Types: `GenreTemplate`, `SceneDescription`, `Screenplay`
  - `GENRE_TEMPLATES` data (10 genres × 5-component prompt framework,
    lifted verbatim so existing prompt outputs stay byte-identical)
  - `getAvailableGenres()` — sorted genre keys
  - `generateScreenplay(genre, clipCount, customTopic?)` — calls
    `generateText` with a structured prompt, parses JSON, renumbers
    scenes, filters empty prompts, falls back to drama for unknown
    genres. Returns null on AI failure / bad JSON / empty scenes.
- **Deferred to a follow-up** (waiting on `mp4-concat` + `spread-post`):
  job submission (`submitMultiClipJobs`), polling (`pollMultiClipJobs`),
  stitching, posting. The screenplay-only subset is what director-movies
  + elon-campaign import — the pipeline half plugs in later.
- Replaced legacy `claude.generateJSON` call with
  `generateText({ taskType: "screenplay" })` + manual JSON parse, matching
  the pattern used in the new ai-engine port.
- 12 new tests cover catalogue invariants (10 genres, all five framework
  components present), screenplay JSON parsing, scene renumbering,
  unknown-genre fallback, custom-topic injection, error paths
  (generateText throws, no JSON, malformed JSON, empty scenes, empty
  video prompts filtered).
- **Backlog**: still no rows dropped — chipping. Director-movies needs:
  ✓ xai-extras (done last session)
  ✓ genre-utils (done last session)
  ✓ multi-clip screenplay subset (done this session)
  • mp4-concat (needs FFmpeg dep, big port)
  • marketing/spread-post (needs content-adapter + platforms upgrade)
  • bible/constants `BRAND_PRONUNCIATION` (1-liner, do during
    director-movies port itself)



### 2026-04-23 — port genre-utils
- **Branch**: `claude/port-genre-utils`
- 114-line legacy lib ported clean. Zero external deps — pure data
  + pure functions. Single source of truth for genre name → blob
  folder → hashtag mapping.
- Exports: `ALL_GENRES` (readonly tuple), `GenreName` type,
  `GENRE_LABELS`, `getGenreBlobFolder`, `getGenreFolderName`,
  `detectGenreFromPath`, `getAllBlobFolders`, `capitalizeGenre`,
  `getGenreHashtag`.
- Preserves the `cooking_channel` → `cooking_show` legacy quirk so
  existing blob URLs keep resolving.
- 15 tests cover catalogue invariants, folder lookups, the legacy
  quirk, fallback for unknown genres, case-insensitive path
  detection, hashtag formatting, CamelCase capitalization.
- Tightened `detectGenreFromPath` return type from `string | null` to
  `GenreName | null` since the result is always a known genre.
- **Backlog**: no rows dropped — chipping away at director-movies
  prereqs. Routes start dropping when multi-clip + bible/constants
  subset + spread-post chain land.



### 2026-04-23 — port xAI extras (Grok long-form text + video jobs)
- **Branch**: `claude/port-xai-lib`
- Strategic prereq port — unblocks future director-movies, elon-campaign,
  and admin video routes. None of those are unblocked yet (still need
  multi-clip, mp4-concat, marketing/spread-post, bible/constants), but
  this knocks out the AI-side dependency for all of them.
- New `src/lib/ai/xai-extras.ts` — companion to the existing
  `xai.ts` (which is just the OpenAI-SDK `xaiComplete` text wrapper):
  - `GROK_MODELS` registry — model-key → slug, inlined here instead of
    pulling `bible/constants.CONTENT.grok*Model` (not ported yet)
  - `isXAIConfigured()` — env check
  - `generateWithGrok(systemPrompt, userPrompt, maxTokens?, modelKey?)` —
    direct fetch to `/v1/chat/completions` with reasoning/non-reasoning
    model selection. Wires into `canProceed` / `recordSuccess` /
    `recordFailure` (circuit breaker) and `logAiCost` (cost ledger).
    Retries 429/5xx with 2/4/8s back-off; falls back to legacy model
    on non-transient failures.
  - `submitVideoJob(prompt, duration, aspect, imageUrl?)` — POSTs to
    `/v1/videos/generations`. Returns `{ requestId, videoUrl?, provider,
    fellBack, error? }`. Kie.ai fallback DEFERRED (legacy uses
    `lib/media/free-video-gen` which isn't ported yet) — for now
    HTTP/network failures return `provider: "none"` with the error and
    let callers decide.
  - `pollVideoJob(requestId)` — single poll, returns `done | pending |
    failed`. Caller drives the retry loop.
- 16 new tests cover: env-not-set short-circuits, circuit-breaker open,
  successful text gen + cost log, primary→legacy fallback, exhausted
  retries on legacy, video submit happy/error paths, sync video URL
  cost log, image_url passthrough, all 3 polling outcomes.
- Suite green.
- **Backlog**: no rows dropped this session — this is groundwork. Routes
  start dropping when the remaining director-movies prereqs land
  (multi-clip, mp4-concat, marketing/spread-post chain, bible/constants
  subset).



### 2026-04-23 — port WebAuthn passkey routes (external-dep)
- **Branch**: `claude/port-webauthn-passkeys`
- Added `@simplewebauthn/server@^13.2.3` + `@simplewebauthn/types@^12.0.0`
  to package.json (legacy used the same versions).
- New `src/lib/webauthn.ts` — shared `CHALLENGE_COOKIE`, `getRpInfo`,
  `ensureWebauthnTable` (lazy CREATE TABLE IF NOT EXISTS, cached per
  lambda; `__resetWebauthnTableFlag` test helper exposed). Same
  self-sufficient pattern as the rest of the migration tables.
- `src/app/api/auth/webauthn/login/route.ts`:
  - GET — public, returns `{ available: false }` when no credentials
    are registered (lets the UI hide the button), otherwise
    `generateAuthenticationOptions` + sets `webauthn-challenge` cookie.
  - POST — verifies signed assertion, bumps counter, sets
    `aiglitch-admin-token` cookie identical to password login,
    deletes challenge cookie. 500 if `ADMIN_PASSWORD` unset, 400 on
    missing credential / challenge / id, 401 on failed verification.
- `src/app/api/auth/webauthn/register/route.ts`:
  - GET — admin-auth gated, `generateRegistrationOptions` excludes
    already-registered credentials so you can't double-register.
  - POST — admin-auth gated, verifies attestation, INSERTs the new
    credential row with base64url-encoded id + public key.
- 15 new tests across both routes + the helper (auth gate, missing
  challenge, missing/unknown credential, failed verify, success path,
  cookie set on success, exclude-credentials wired correctly).
  Suite stays clean.
- **Backlog**: external-dep blocker drops from 2 entries → 0.
  BACKLOG.md regen shows 50 routes / ~52 sessions remaining.



### 2026-04-23 — port /api/generate (chunky-single)
- **Branch**: `claude/ai-engine-special-posts`
- **Parcel 1** — `5efac95`: ported text-only `generateBeefPost`,
  `generateCollabPost`, `generateChallengePost` to `@/lib/content/ai-engine`.
  Shared `generateSpecialPost` scaffold dedupes prompt/parse/fallback.
  Hashtag enforcement (collab forces #AICollab, challenge always pushes
  the tag to front, dedupes when present). +12 tests, 24/24 ai-engine green.
- **Parcel 2** — port `/api/generate` route. GET (cron via `cronHandler`)
  + POST (admin manual trigger). Drops legacy `generateAIInteraction`
  decision-verb contract (the new `ai/generate` exports a same-named
  function that returns text instead) — uses local dice (50/25/25
  like/comment/skip) + `generateComment` for reactor logic. Drops media,
  ad-impressions, spread-to-social (Phase 5 deferrals), and the SSE
  streaming variant (defer to admin UI need). +10 tests covering auth,
  normal/beef/collab/challenge dispatch, single-persona failure isolation,
  POST admin path. Suite green.
- **Backlog**: chunky-single drops from 2 → 1 entry. BACKLOG.md regen
  shows 52 routes / ~54 sessions remaining.



### 2026-04-22 — migration tester idiot-proof upgrade
- **Branch**: `claude/migration-route-hints`
- **Problem**: `/migration` Test tab made you guess what query/body each
  route wants. Fine once you've lived in the codebase, not fine if you
  haven't. Needed a cheat sheet that fills itself in.
- **Parcels shipped**:
  - `2366d90` — parcel 1: `src/lib/migration/route-hints.ts` typed
    catalogue (22 seeded entries) + `/api/admin/migration/route-hint`
    admin endpoint (curated → jsdoc fallback → none). 14 tests.
  - `4dc5544` — parcel 2: Test tab rewired. Auto-fetches hint on
    route select; auto-fills query + body + path-params; blue "What
    this does" panel + yellow "⚠️ Heads up" banner; path-params
    editor appears for `[bracket]` segments; Send disabled while
    placeholders unreplaced. JSDoc fallback shown in collapsed
    panel when no curated entry exists.
- **Suite**: 1896/1896 passing across 162 files.
- **Next**: add more hints whenever a route feels confusing. One-line
  edit in `route-hints.ts` then deploy.

### 2026-04-22 — telegram persona-chat route port (session 2 of 2)
- **Branch**: `claude/telegram-persona-chat-route`
- **Parcels shipped** (3 atomic commits, each green + clean tsc):
  - `b2a8efe` — parcel 3a: route scaffold + core reply flow (webhook parse, auth, /email DM-only, slash dispatch, outreach approve/cancel/edit, normal chat flow with memory retrieval + wallet + email + platform-brief blocks, Telegram send). 17 tests.
  - `7a6413a` — parcel 3b: memory features (sendWelcome, sendMemorySummary with star-confidence grouping, extractAndStoreMemories with fuzzy reinforce + top-50 prune, generateJSON helper). 2 tests added (19 total).
  - `3f4132d` — parcel 3c: hashtag persona mentions (#tag lookups, 30s cooldown, 3/message cap, 403 soft-skip) + emoji reaction replies (findNewEmoji diff, 60s cooldown, tone-hinted prompt). 2 tests added (20 total for the route).
- **Suite**: 1882/1882 passing across 160 files.
- **Backlog**: 54 → 53 routes. Telegram bot engine blocker cleared.
- **Next**: consumer flip (point production traffic at new `/api/telegram/persona-chat/[personaId]`); then pick up the next chunky-single or external-dep route.

### 2026-04-22 — telegram bot engine libs (session 1 of 2) + x-dm-poll 403 patch
- **Branch**: `claude/telegram-persona-chat`
- **Parcels shipped** (6 atomic commits, each green suite + clean tsc):
  - `c9f8796` — platform-brief builder + constant (3 tests)
  - `66f0809` — personality modes + DB storage (6 tests)
  - `61248ef` — command dispatcher + content lookups for /nft /channel /avatar /help /modes (14 tests)
  - `cddfeda` — outreach-drafts types + contact lookups with 14-day cooldown + 10/day ceiling (9 tests)
  - `173762d` — outreach AI drafting + approval regex + Resend send (17 tests)
  - `32c892a` — x-dm-poll 403 soft-skip (Pro tier gap — was spamming cron_runs) (1 test)
- **Suite**: 1862/1862 passing, 159 files.
- **Next**: session 2 — port `/api/telegram/persona-chat/[personaId]` (1313-line route) using these libs.

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
| Phase 5 AI engine (`src/lib/ai/`) | tested | session 42 | xAI + Anthropic clients + circuit breaker + cost ledger + generate functions. **Unblocks Phase 4 bestie, Phase 6 cron fleet, and AI auto-reply.** |
| `/api/interact` AI auto-reply trigger | tested | session 43 | `triggerAIReply` in interactions.ts — 30% probability, top-level only, fire-and-forget. INSERT reply `posts` + bump `comment_count` + `notifications` + +5 GLITCH to persona. |
| `/api/messages` GET + POST + PATCH | tested | session 44 | Bestie chat. GET = history (creates conversation if missing). POST = save user msg + `generateBestieReply` + save AI msg. PATCH = touch `last_message_at`. AI failure: returns user_message + `ai_error`, never strands the user. `private, no-store`. |
| `/api/partner/push-token` POST | tested | session 45 | Registers iOS push notification token. UPSERT into `device_push_tokens` (new table, created IF NOT EXISTS on first call). Body: `{session_id, token, platform?}`. |
| `/api/partner/bestie` GET | tested | session 45 | Bestie profile card for iOS home screen. Returns full persona + conversation summary (`message_count`, `last_message_at`) without creating a conversation. `private, no-store`. |
| `/api/partner/briefing` GET | tested | session 45 | Daily briefing aggregation for iOS. Returns `followed_count`, `unread_notifications`, and up to 5 recent conversations with last-message preview. `private, no-store`. |
| `/api/sponsor-burn` GET + POST | tested | session 46–47 | Daily cron (12am UTC). Per-campaign GLITCH burn: daily rate = totalInvestment / duration_days, catch-up days, in-house excluded. GET=cron, POST=admin. |
| `/api/telegram/credit-check` GET + POST | tested | session 47 | Every 30 min. Checks AI spend today + low sponsor balances; sends Telegram alert if either trips threshold. Silent no-op when Telegram not configured. |
| `/api/telegram/status` GET + POST | tested | session 47 | Every 6 hours. Sends system health summary (active personas, posts today, recent cron_runs, errors) to admin Telegram channel. |
| `/api/telegram/persona-message` GET + POST | tested | session 47 | Every 3 hours. Each active persona bot generates + sends an in-character message to its Telegram chat. Per-bot error isolation. |
| Phase 5 image-gen helper (`src/lib/ai/image.ts`) | tested | session 63 | `generateImage` + `generateImageToBlob` — xAI `grok-imagine-image` / `-pro` ($0.02 / $0.07 per image). Shared `"xai"` circuit breaker; fire-and-forget cost ledger (`task_type=image_generation`). Supports `/images/generations` + `/images/edits` (via `sourceImageUrls`). Unlocks 6 deferred admin routes. |
| `/api/admin/merch` generate action | tested | session 63 | Flipped from 501 → calls `generateImageToBlob` + INSERT `merch_library` with `source='generate'`. Blob path `merch/designs/{uuid}.png`. |
| `/api/admin/nft-marketplace` generate action | tested | session 63 | Flipped from 501 → calls `generateImageToBlob` + UPSERT `nft_product_images` on `product_id`. Blob path `marketplace/{product_id}-{slug}.png`. Uses legacy prompt template verbatim. |
| `/api/admin/persona-avatar` POST | tested | session 64 | Admin override — regenerates persona avatar via Grok Aurora Pro 1:1. UPDATE `ai_personas.avatar_url` + `avatar_updated_at`; optional in-character feed-post via `generateText` with local fallback template. Deferred: `injectCampaignPlacement`, non-xAI fallback pipeline. |
| `/api/admin/chibify` GET + POST | tested | session 64 | Batch chibify. GET = prompt preview. POST loops over `persona_ids` with per-persona error isolation; each successful chibi → Blob + INSERT `posts` (`media_source='grok-aurora'`) + `post_count` bump. Deferred: `injectCampaignPlacement`, `logImpressions`, `spreadPostToSocial`. |
| `/api/admin/grokify-sponsor` POST | tested | session 65 | Sponsor product placement via xAI `/images/edits`. Builds source-image set from `grokifyMode` (`all` / `logo_only` / `images_only`; outro forces logo). Multi-image → single-image retry on helper failure. Text-to-image fallback when no source images. Persist under `sponsors/grokified/{brand}-{channel}-{scene\|outro}-{id}.png`. First real exercise of the `sourceImageUrls` branch of the image helper. |
| `/api/admin/generate-og-images` GET + POST | tested | session 65 | 21 branded OG banners for channel pages. GET = iPad-friendly HTML dashboard (per-image + generate-all buttons). POST = batch or `{ file }` single. Pro model 16:9, deterministic path `og/{file}.png` keeps `<meta>` URLs stable. |
| Phase 5 video-gen helper (`src/lib/ai/video.ts`) | tested | session 66 | `submitVideoJob` + `pollVideoJob` + `generateVideo` + `generateVideoToBlob`. xAI `grok-imagine-video` via `/videos/generations` → `/videos/{id}` polling pattern. $0.05/sec flat. 10s default poll interval / 90 attempt ceiling (15 min). Shared `"xai"` circuit breaker + cost ledger (`task_type=video_generation`). Supports text-to-video + image-to-video (via `sourceImageUrl`). Handles sync/async responses, moderation-blocked videos, expired jobs. Unlocks `generate-channel-video`, `extend-video`, `hatch-admin`. |
| `/api/admin/hatch-admin` GET + POST | tested | session 67 | Full AI-pipeline persona hatching — `generateText` (Claude/Grok JSON) → `generateImageToBlob` (1:1 avatar) → `generateVideoToBlob` (9:16 10s hatch clip, 4-min attempt cap) → INSERT `ai_personas` → `awardPersonaCoins` (1,000 GLITCH) → INSERT first-words `posts`. Per-step status + graceful degradation — avatar/video/coins/first-post failures are non-fatal. 409 on wallet-already-has-persona. GET lists meatbag-owned personas (owner_wallet_address IS NOT NULL). Deferred: legacy `ensureDbReady`/`safeMigrate` shim + OpenAI image / Kie.ai video fallbacks. **First real end-to-end exercise of the video helper.** |
| `/api/admin/spec-ads` GET + POST | tested | session 68 | Brand-led 3-channel spec-ad teaser pipeline. POST kicks off 3 parallel `submitVideoJob` calls across randomly-picked channel styles from a 13-entry `CHANNEL_STYLES` dictionary (GNN, OnlyAiFans, AiTunes, etc.); persists a `spec_ads` JSONB row per brand and returns request IDs for client-side polling. `action=poll` thin-wraps `pollVideoJob` + downloads & persists completed videos to `{folder}/clip-{N}.mp4`. `action=delete` removes a spec-ad. GET `action=list` / `action=status&id=X`. Transient Grok errors surface as `{status:"pending"}` so the client retries. Uses shared `"xai"` circuit breaker + cost ledger via the helper. |
| `/api/admin/animate-persona` GET + POST | tested | session 69 | Image-to-video persona avatar animator. POST loads persona → `generateText` animation prompt (with local fallback if AI down) → `submitVideoJob` with `sourceImageUrl=avatar_url`. Returns `requestId` for client polling. GET thin-wraps `pollVideoJob`; on completion downloads + persists to `feed/{uuid}.mp4`, INSERT `posts` (`media_source='grok-animate'`), bumps `ai_personas.post_count`. Preview mode short-circuits before AI for UI preview. Deferred: `spreadPostToSocial`, `injectCampaignPlacement`. **First real exercise of the video helper's `sourceImageUrl` image-to-video branch.** |
| `/api/admin/generate-persona` POST | tested | session 70 | SSE-streaming manual post generator for one persona. Body `{persona_id, count?}` (count clamped 1..20, default 3). Streams `init` → `picked` → (`generating` → `post_ready` → `reactions`)×N → `done`. Per-post: `generatePost(persona, recentContext, dailyTopics)` → INSERT `posts` + bump `post_count` → pick 5 random active AIs for reactions. Reactions use a weighted-random inline decision (30% like / 15% comment / 55% ignore) instead of the legacy `generateAIInteraction` enum call — the new helper returns content, not a decision. Comments still go through `generateComment`. Per-post failures emit a `progress step=error` event and loop continues. Deferred: `spreadPostToSocial`, `ensureDbReady`/`safeMigrate`. First SSE route in the new repo. |
| `/api/admin/batch-avatars` GET + POST | tested | session 71 | Batch persona-avatar backfill/refresh. POST `{batch_size?, force?}` (clamped 1..10, default 5) picks candidates in two tiers: (1) `avatar_url IS NULL` (oldest first), (2) top-up from avatars >30 days old (or any when `force:true`). Per pick: random art style from 20-entry `ART_STYLES` list → `generateImageToBlob` (1:1, `avatars/{uuid}.png`) → UPDATE avatar + bump `avatar_updated_at` → `generateText` in-character announcement (with static fallback) → INSERT `posts` (`media_source='grok-aurora'`, hashtags `AIGlitch,NewProfilePic,AvatarUpdate`) → bump `post_count`. Per-persona failures isolated — batch continues. GET returns `{total_active, missing_avatar, recently_updated, needing_update, message}` dashboard. Deferred: legacy OpenAI/fallback image branch (xAI-only repo), structured logging. |
| `/api/admin/telegram/re-register-bots` GET + POST | tested | session 72 | Points every active persona bot at the new API domain's webhook + refreshes the slash-command menu. GET lists active bots (persona_id, bot_username, display_name, avatar_emoji — NEVER `bot_token`). POST `{persona_id}` re-registers that single bot (404 when missing); POST with empty body loops all active bots with 200ms spacing. Each call: Telegram `setWebhook` → `{NEXT_PUBLIC_APP_URL}/api/telegram/persona-chat/{id}` with `allowed_updates=["message","message_reaction"]` → `registerTelegramCommands(bot_token)` to refresh the `/help`/`/nft`/`/email`/… menu. Introduces `src/lib/telegram/commands.ts` — minimal port of legacy `content/telegram-commands` (just the two scoped command lists + registration function; personality-mode + content-surfacing handlers deferred until Telegram bot engine ports). |
| `/api/activity` GET | tested | session 73 | Admin dashboard aggregator. Pure read-only GET the admin UI polls to render the Activity tab. Runs 12 parallel queries (recent posts, video jobs, product-shill ads, hourly hour counts, breaking news, daily topics, persona activity). Follow-up blocks fetch director-movie stats + recent movies + clip-level diagnostics for failed/generating movies, activity throttle setting, cron history (last 50), last-run-per-cron, 7-day cron trend, 24h/7d cost + run-count breakdown per cron. Every optional block wrapped in try/catch so missing tables (`director_movies`, `multi_clip_scenes`, `persona_video_jobs`) degrade gracefully — UI still renders with zeros. `cron_runs.status` re-pointed to new repo's `'ok' \| 'error'` convention (legacy wrote `'completed' \| 'throttled'`); `throttled*` fields return 0 until cron throttling is re-introduced. **Unauth'd per legacy parity** — admin UI page itself is behind admin cookie; locking the JSON would orphan the dashboard. |
| `/api/generate-videos` GET + POST | tested | session 74 | Premiere trailer cron — two-phase async video pipeline using the shared `submitVideoJob` + `pollVideoJob` helpers. POST picks N (1..5, default 1) random prompts from 10-entry `VIDEO_PROMPTS` dict and submits each (10s, 9:16, 720p). Returns `{jobs:[{requestId, title, genre, tagline, prompt, error?}]}`. Synchronous completions come back as `sync:{url}` request IDs. GET `?id=&title=&genre=&tagline=` polls one job; on `done`, downloads + persists to `premiere/{genre}/{uuid}.mp4`, INSERTs `posts` (`post_type='premiere'`, `media_source='grok-video'`, hashtags `AIGlitchPremieres,AIGlitch{GenreCap}`), bumps the random-picked persona's `post_count`. Both paths gated by `requireCronAuth` (legacy's `checkCronAuth` equivalent). Deferred: `spreadPostToSocial` (marketing lib), `ensureDbReady` (schema assumed live). **First cron on the new repo to exercise image-free text-to-video through the shared helper** — validates the submit/poll separation at cron cadence. |
| `/api/admin/media/upload` POST | tested | session 75 | Vercel Blob client-upload token handler. `@vercel/blob/client#upload()` in the browser POSTs here to get a short-lived client token, then uploads the file directly to Blob — bypasses the 4.5 MB serverless body limit for big videos (up to 500 MB). Supports both JSON and `multipart/form-data` bodies (Safari/iOS WebKit bug workaround — the client wraps JSON in FormData under `__json`). Allowlists 10 image + 5 video + `application/octet-stream` content types. Registration in `media_library` still goes through `/api/admin/media/save` on legacy (marketing-lib-dependent). |
| `/api/admin/media/import` POST | tested | session 75 | Bulk URL importer. POST `{urls[], media_type?, tags?, description?, persona_id?}` — fetches each URL with a browser UA, detects media kind from response `content-type` + URL extension (video / meme / image), uploads to `media-library/{uuid}.{ext}`, INSERTs `media_library`, and (when `persona_id` set) auto-creates a profile post + bumps `post_count`. Per-URL failures isolated — `{results[]}` carries each URL's outcome; `success` only true when every URL succeeded. No marketing auto-spread on this path. |
| `/api/admin/media/resync` POST | tested | session 75 | Orphan-blob recovery. Scans 8 prefix buckets (`media-library/`, `videos/`, `video/`, `premiere/`, `logos/`, `memes/`, `images/`, and root) with Vercel Blob `list`, diffs against `SELECT url FROM media_library`, re-INSERTs any missing rows. Media type inferred from extension (6 video / 7 image / 1 meme); unknown extensions skipped. `"logo"` in pathname adds a `logo,` tag prefix (no separate media_type — DB constraint allows image/video/meme only). Per-prefix scan errors isolated so a single failing bucket doesn't abort recovery; per-INSERT errors bump counter, keep going. Response: `{synced, skipped, errors, already_in_db, counts, sample}`. Requires `BLOB_READ_WRITE_TOKEN`. |
| `/api/bestie-life` GET + POST | tested | session 76 | Twice-daily Telegram photo cron — sends every active bestie a slice-of-life photo from their persona to their meatbag. Per bestie: `calculateHealth` decay → `generateText` asks for `IMAGE_PROMPT:`/`CAPTION:` pair in a single call (tuned by health tier: desperately-low / low / worried / healthy) → `generateImageToBlob` 1:1 to `bestie-life/{uuid}.png` → `sendTelegramPhoto` via the bestie's own bot. Death branch (100+ days silence) sends a single ghost-message and skips without counting as a failure. Per-bestie errors isolated — scene-gen / image-gen / telegram-send failures each land as distinct error strings in `results[]`. GET gated by `requireCronAuth` + wrapped in `cronHandler("bestie-life", …)`; POST gated by `isAdminAuthenticated` for manual runs. **Deferred**: video branch (30% in legacy — animated from avatar), because `generateVideoToBlob` polling would blow the 5-min lambda when fanning out over the bestie fleet. Returns image-only for now; video re-enables with per-run cap when Telegram bot engine lands. |
| `/api/generate-channel-content` GET | tested | session 77 | 30-min cron — The Architect posts to ONE active channel per run. Flow: fetch Architect from `ai_personas` (was `SEED_PERSONAS` in legacy) → shuffle active channels excluding `ch-aiglitch-studios` (movies only) → prefer one with no post in the last hour, fall back to random → pull up to 5 active daily topics → `generatePost(architect, [], topics, channelCtx)` (channel context triggers `🎬 [Channel Name] -` title prefix convention) → INSERT `posts` with `channel_id` + bump `channels.post_count` + bump Architect's `post_count`. `content_rules` JSON-parsed if stored as string. Gated by `requireCronAuth` + wrapped in `cronHandler("channel-content", …)`. Deferred: ad-campaign `logImpressions`, `spreadPostToSocial`, and `post._adCampaigns` placement branch (not exposed in new repo's `generatePost`). |
| `/api/generate-avatars` GET + POST | tested | session 78 | 20-min cron — generates an avatar for ONE persona per invocation. Priority 1: personas with `avatar_url IS NULL OR ''` (oldest first). Priority 2: monthly refresh (`avatar_updated_at < NOW() - 30 days` OR NULL). Flow: `generateImageToBlob` 1:1 Pro to `avatars/{uuid}.png` (AIG!itch branding in prompt) → UPDATE `avatar_url` + `avatar_updated_at` → `generateText` in-character announcement (strips wrapping quotes, auto-appends `#AIG!itch` if missing, local template fallback if AI throws) → INSERT `posts` (`media_source='grok-aurora'`, hashtags `AIGlitch,NewProfilePic,AvatarUpdate`) → bump `post_count`. Gated by `requireCronAuth` + wrapped in `cronHandler("avatar-gen", …)`. POST is an alias for GET (manual admin trigger). Deferred: `injectCampaignPlacement` (ad-campaigns lib), non-xAI image fallback (aiglitch-api is xAI-only). |
| `/api/test-grok-image` POST | tested | session 79 | Admin diagnostic — one xAI `/v1/images/generations` call via the shared `generateImage` helper (so the probe picks up the xAI circuit breaker + cost ledger too). Body `{prompt?, pro?}`; `pro:true` swaps to `grok-imagine-image-pro` ($0.07 vs $0.02). Returns `{success, imageUrl, model, estimatedUsd, prompt}` on success; `{success:false, error, hasKey, model}` on xAI error (keeps legacy response shape so the admin UI needs no changes). |
| `/api/test-media` GET | tested | session 79 | Admin diagnostic — exercises all three xAI media helpers (`generateImage`, `generateImageToBlob`, `submitVideoJob`) in parallel with canned prompts. Each step wrapped in its own try/catch so a failing leg doesn't abort the probe. Returns `{ok, image, imageToBlob, videoSubmit}` where each leg is `{ok:true, detail}` or `{ok:false, error}`. Drops legacy's `testMediaPipeline` from `@/lib/media/image-gen` — that tried OpenAI / Replicate / Kie fallbacks; new repo is xAI-only so the probe scope narrows accordingly. |
| `/api/test-grok-video` GET + POST | tested | session 80 | Admin video diagnostic — two-phase contract so the UI stays within the 60s serverless limit. POST `{prompt?, duration?, folder?, image_url?, persona_id?, caption?}` submits via `submitVideoJob`; `image_url` flips to image-to-video. Returns `requestId` or (rare) persists+auto-posts immediately on sync URL. GET `?id=&folder=&persona_id=&caption=&skip_post=` polls via `pollVideoJob`; on done downloads video, persists to `{folder}/{uuid}.mp4` (or `premiere/action/` when `folder=premiere`, `feed/` when `folder=feed`/`persona`), and unless `skip_post=true` auto-creates the right post variant (feed video post with custom caption / news post with AIGlitchBreaking hashtags / premiere post with genre-detected tagline). Routes through shared helpers for circuit breaker + cost ledger. |
| `/api/test-premiere-post` GET + POST | tested | session 81 | Premiere-post backfill / retag tool. GET lists every video blob across `news/`, `premiere/`, and each per-genre subfolder with detected `postType` + `genre` (`cooking_show` folder maps back to `cooking_channel` genre). POST `{videoUrl, type?, genre?}` creates a single post; no body triggers bulk backfill that (1) retags any existing premiere posts missing genre-specific hashtags (`AIGlitch<Genre>`) and (2) scans all prefixes and inserts posts for every blob video NOT already in `posts.media_url`. Uses a 5-persona random sample so the feed doesn't get dominated by one persona. No AI calls — pure DB + Blob. Extended `src/lib/genres.ts` with the full legacy helper set (`detectGenreFromPath`, `getAllBlobFolders`, `getGenreHashtag`, `capitalizeGenre`, `getGenreBlobFolder`, `getGenreFolderName`, `ALL_GENRES`) so this route and future director-movie routes share one source of truth. |
| `/api/admin/media/save` POST | tested | session 82 | Client-upload DB registration. Browser uploads directly to Vercel Blob via `/api/admin/media/upload` then POSTs here with `{url, media_type?, tags?, description?, persona_id?}` (JSON or Safari-fallback multipart). Logo uploads restricted to The Architect (`glitch-000`); DB constraint only allows `image/video/meme` so `"logo"` + extension sniff resolves to the concrete type. When `persona_id` is supplied, also INSERTs a feed post + bumps `post_count`. The Architect's auto-spread branch (`spreadArchitectContent` in legacy) is **deferred** — response preserves the `spreading: []` shape so the admin UI's existing "posting to …" display gracefully renders nothing. Un-defers the full client-upload flow end-to-end (upload + save + feed post). |
| `/api/content/status` GET | tested | session 83 | Content Studio job poller. `?job_id=<id>` → returns the `content_jobs` row. 400 on missing, 404 on unknown. |
| `/api/content/library` GET | tested | session 83 | Paginated `content_jobs` list + whole-table status totals (completed/processing/failed). `status` + `type` filters combine (AND). Limit hard-capped at 200. |
| `/api/content/media` GET + DELETE | tested | session 83 | Paginated `uploaded_media` list + stats (total + total bytes). `?folder=` optional filter. DELETE removes the DB row + best-efforts blob delete via `@vercel/blob#del`. Blob delete failures swallowed — the file might already be gone. |
| `/api/content/upload` POST | tested | session 83 | Direct server-side upload (for files under 4.5 MB — bigger videos go through the `/api/admin/media/upload` + `/api/admin/media/save` client flow instead). multipart/form-data with `file` + optional `folder` (default `uploads`). Persists to `{folder}/{filename}` with `addRandomSuffix: true` + INSERTs `uploaded_media`. |
| `/api/content/generate` POST | tested | session 83 | Content Studio async generator. `{type:"image"\|"video", prompt}`. INSERT `content_jobs` as `processing`, invoke `generateImageToBlob` or `generateVideoToBlob` (video capped at 24 attempts × 10s so it fits in the 5-min lambda), UPDATE to `completed` + `result_url` or `failed` + `error`. Client polls `/api/content/status`. Drops legacy's "prefix the prompt with `[VIDEO]`" hack which never actually produced videos — routes go through real xAI video submit + poll now. |
| `/api/admin/blob-upload/upload` POST | tested | session 84 | Client-upload token handler specialized for large premiere/news videos. Unlike `/api/admin/media/upload` (10+ content types + random suffix), this one is locked to 4 video types + `addRandomSuffix:false` so the clean folder path survives for `detectGenreFromPath` to infer genre from `/premiere/<genre>/`. 500 MB cap. JSON + Safari `__json` multipart fallback. |
| `/api/admin/personas/set-bot-token` POST | tested | session 84 | Single-persona Telegram bot assignment. Mode A (no `bot_token` or empty string): flips `persona_telegram_bots.is_active` to FALSE. Mode B: validates token via Telegram `getMe` (bails BEFORE any DB write on invalid), registers webhook pointed at `{NEXT_PUBLIC_APP_URL}/api/telegram/persona-chat/{id}` with `message + message_reaction` updates (non-fatal if fails), DELETE + INSERT `persona_telegram_bots` row, then `registerTelegramCommands` for the slash-command menu. `bot_token` never in responses. Auto-creates the `persona_telegram_bots` table on first call. Companion to `/api/admin/telegram/re-register-bots` (bulk refresh). |
| `/api/admin/sponsors/[id]/ads` GET + POST + PUT | tested | session 85 | Per-sponsor ads CRUD + AI prompt generation. GET default lists `sponsored_ads`; `?action=placements` joins `ad_campaigns` (brand-name matched) → `ad_impressions` → `posts` + `channels` for the "where is my brand placed" view (top 100). POST creates a draft row using `SPONSOR_PACKAGES` defaults (duration / glitch_cost / cash_equivalent / follow_ups / platforms / frequency / campaign_days) + caller overrides. PUT handles three modes: `action:"delete"`, `action:"generate"` (calls `buildSponsoredAdPrompt` + `generateText` + defensive JSON-from-text parse → `{video_prompt, caption, x_caption}`, flips status to `pending_review`), or default COALESCE update of status/video_url/post_ids/performance. Publishing (`status="published"`) deducts `glitch_cost` from `sponsors.glitch_balance` + bumps `total_spent`. Replaces legacy's `claude.generateJSON` with a `generateText` + `match(/\{...\}/)` inline parser. |
| `/api/admin/channels/generate-title` GET + POST | tested | session 86 | Channel title-card video generator. Two-phase submit/poll via `submitVideoJob` + `pollVideoJob` (5s / 9:16 / 720p). POST `{channel_id, channel_slug, title, style_prompt?, preview?}` — builds a cinematic title-card prompt that spells the title letter-by-letter and repeats the exact string multiple times to combat xAI's misspelling bias. `preview:true` returns the prompt without submitting. Happy path returns `{phase:"submitted", requestId}`. Sync xAI returns short-circuit through `persistTitleVideo`. GET `?id=&channel_id=&channel_slug=` polls the job; on done downloads video, persists to `channels/{slug}/title-{uuid}.mp4`, and UPDATEs `channels.title_video_url`. Deferred: `injectCampaignPlacement` (ad-campaigns lib), `ensureDbReady`. |
| `/api/admin/channels/generate-promo` GET + POST + PUT | tested | session 87 | Channel promo-clip generator. Three-handler flow. POST `{channel_id, channel_slug, custom_prompt?, preview?}` submits one 10s 9:16 720p clip via `submitVideoJob`; 9 per-channel default scenes baked in (from legacy); `preview:true` returns the built prompt. Sync xAI URL short-circuits inline. GET `?id=REQUEST_ID` polls via `pollVideoJob`; on done downloads + persists to `channels/clips/{uuid}.mp4` (falls back to Grok URL if download fails). PUT `{channel_id, channel_slug, clip_urls}` downloads the confirmed clip, persists to `channels/{slug}/promo-{uuid}.mp4`, UPDATEs `channels.banner_url`, creates a promo post attributed to The Architect (`glitch-000`, channels are Architect-only) with `AIGlitchTV,AIGlitch` hashtags. Deferred: ad-campaigns `injectCampaignPlacement` + `logImpressions` + `ensureDbReady`. |
| `/api/admin/channels/flush` GET + DELETE + POST | tested | session 88 | AI-driven channel content curation. GET lists channel posts for admin review (flags `broken:true` on video-posts-with-no-media_url). DELETE `{post_ids, delete_post?}` either permanently deletes rows or untags (`channel_id=NULL`). POST `{channel_id, dry_run?}` runs AI classification in batches of 20 against the channel's `content_rules/genre/description`, untags irrelevant posts + auto-flags broken/placeholder video posts. `dry_run` returns the classification without writing. **Deviation from legacy**: this port adds `isAdminAuthenticated` to all three handlers — legacy had NO auth check but the route is under `/api/admin/*` and mutates the DB (including `DELETE FROM posts`). Legacy `claude.generateJSON` replaced with `generateText` + defensive `\[…\]` regex parse so malformed model output short-circuits to "nothing flagged" instead of 500-ing. |
| `/api/docs` GET | tested | session 89 | Static API documentation catalogue. Returns a structured JSON tree of every domain's routes (feed / personas / messaging / bestie / partner / coins / sponsors / token / NFTs / meatlab / admin / …) plus auth method descriptions. Public + `force-static` + `Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400`. No runtime deps — pure literal payload. Consumed by the `/docs` ops-UI page. |
| `/api/nft` GET + POST | tested | session 90 | NFT read API (no minting — that moved to marketplace + Phantom flow). GET `?action=collection_stats` returns whole-collection totals, rarity breakdown, 10 most-recent mints, and marketplace revenue split (persona vs. treasury); revenue block try/catch'd so missing `marketplace_revenue` table doesn't 500 the rest. `?action=supply` returns per-product mint counts + `max_per_product:100` for "X remaining" displays. Default (with `session_id`) fetches user's NFTs — joins on `phantom_wallet_address` so wallet-login migrations don't strand NFTs under an old session, and auto-repairs legacy session_ids on match. No session_id → `{nfts:[]}`. POST returns 410 Gone with marketplace redirect (matches legacy exactly). No Solana RPC — all reads from Neon mirror tables. |
| `/api/hatch/telegram` POST + DELETE | tested | session 91 | Meatbag-facing Telegram bot setup for a hatched persona. POST `{session_id, bot_token}` → resolves session to wallet → wallet to persona (`owner_wallet_address` match, 404 if unhatched) → validates token via Telegram `getMe` (bails before DB writes on invalid) → registers webhook at `{NEXT_PUBLIC_APP_URL}/api/telegram/persona-chat/{persona_id}` with `message+message_reaction` updates (non-fatal if fails) → DELETE + INSERT `persona_telegram_bots` row. DELETE `{session_id}` same resolution, then best-efforts unregisters the webhook and removes the row. `bot_token` never in responses. Falls back to `new URL(request.url).origin` when `NEXT_PUBLIC_APP_URL` isn't set. Counterpart to the admin's `/api/admin/personas/set-bot-token`. |
| `/api/admin/hatchery` GET + POST + PATCH | tested | session 92 | Streaming persona-hatching pipeline. GET lists recent hatchlings (max 50). POST `{type?, skip_video?}` streams NDJSON per-step progress (generating_being → avatar → video → save_persona → architect_announcement → first_words → glitch_gift → posting_socials → complete). `type` is an optional creative hint, or fully random. Admin-auth OR cron-auth. PATCH retroactively awards GLITCH to hatchlings with zero balance (legacy data repair). AI being generation uses `generateText` + defensive JSON regex parse. Avatar via `generateImageToBlob` (1:1 Pro). Video via `generateVideoToBlob` capped at 24×10s polls so the whole pipeline stays in the 5-min lambda. Avatar + video failures are non-fatal. Awards 1000 GLITCH via `awardPersonaCoins`. Deferred: `spreadPostToSocial` — `posting_socials` step emits `{platforms_posted:[], platforms_failed:[]}` so admin UI keeps rendering. Companion to `/api/admin/hatch-admin`. |
| `/api/health/grok-video` GET | tested | session 93 | xAI credential health probe. Hits `GET /v1/models` (no charge) to verify `XAI_API_KEY` is set + auth'd. Returns `{ok:true, keyConfigured:true, maskedKey:"xai-…1234"}` (200) / `{ok:false, status, error, keyConfigured:true}` (502 on 4xx/5xx) / `{ok:false, error:"XAI_API_KEY not set", keyConfigured:false}` (500). `Cache-Control: no-store`. |
| `/api/telegram/notify` POST | tested | session 93 | Admin Telegram alert endpoint. `requireCronAuth` gated. Body `{title?, message, severity?:"info"\|"warning"\|"critical"}`. With `title` → formats as `{ℹ️\|⚠️\|🚨} <b>title</b>\n\nmessage`; without → sends `message` verbatim. Silent no-op (`{ok:false, reason:"telegram-not-configured"}`) when `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHANNEL_ID` missing so crons don't blow up. Replaces legacy's `sendAdminAlert` (formatter inlined). |
| `/api/meatlab/upload` POST | tested | session 93 | Meatlab client-upload token handler. 100 MB cap, 5 image + 3 video allowlist. Path restricted to `meatlab/` or `avatars/` prefixes (throws on anything else). Pure Vercel Blob `handleUpload` wrapper — DB registration happens via the existing meatlab POST flow. |
| `/api/auth/human` POST | tested | session 94 | Meatbag auth + session management. 11 actions: `signup`, `login`, `profile` (+ cross-wallet stats aggregation), `update` (with persona/meatbag uniqueness), `anonymous_signup`, `wallet_login` (+ session merge + orphan recovery), `link_wallet`/`unlink_wallet`/`get_wallet`, `merge_accounts`, `signout`. Extracted `migrateSessionData()` helper for the 10-table session-migration sequence (used by login + wallet_login + merge_accounts + orphan recovery). **Preserves CLAUDE.md rule #2 exactly**: session merge direction is FROM wallet account's old session_id TO browser's new session_id, including the DELETE-stub-first order and the `NOT IN` subqueries that skip unique-constraint conflicts. No external deps. |
| `/api/admin/channels` GET + POST + PATCH + DELETE | tested | session 95 | Channels admin CRUD + post-curation actions. GET lists channels with personas + config defaults (+ `?action=lost_videos` for orphan video list). POST upserts channel + persona/host assignments. PATCH supports `fix_channel_ownership`, `flush_non_video`, `undo_clean`, `clean_all_channels`, `move_all_to_lost`, `move_to_lost`, `restore_by_prefix`, `flush_off_brand`, and default path (move posts to target channel with prefix rewrite, or untag). DELETE cascades through `channel_personas` + `channel_subscriptions` + `posts.channel_id` before removing. Deviations: dropped `syncChannelsFromConstants` (legacy CHANNELS bible seed not ported — channels already persist in Neon); inlined 24-entry `CHANNEL_TITLE_PREFIX` map (legacy import from director-movies lib); added admin-auth on POST/PATCH/DELETE (legacy had none; consistent with `channels/flush` port). |
| `/api/admin/media` GET + POST + DELETE | tested | session 96 | Admin media-library CRUD. GET lists `media_library` rows (+ `?stats=1` adds video-source + post-type breakdowns, 30-day daily timeline, top-10 video personas). POST multipart upload — single `file` or bulk `files`, logo restricted to Architect, Safari content-type fallback from extension (HEIC/HEIF/AVIF + 4 video types). Auto-creates feed post when `persona_id` set. DELETE removes row by id. Deferred: Architect auto-spread (`spreadArchitectContent` — marketing lib not ported; response keeps `spreading:[]` placeholder for Architect uploads). Also dropped: `SEED_PERSONAS` FK safety INSERT (seeds already in Neon), `ensureDbReady`. Companion to `/api/admin/media/upload` (client-upload token handler) + `/api/admin/media/save` (client-upload DB registration). |
| `/api/telegram/webhook` GET + POST | tested | session 97 | Telegram bot webhook + setup. POST receives Telegram updates, dispatches by command (`/glitchvideo`, `/glitchimage`, `/hatch`, `/generate`, `/status`, `/credits`, `/persona`, `/help`, `/start`, `/chatid`). Each command calls a downstream `/api/...` route server-to-server with optional `Bearer $CRON_SECRET` and replies in HTML to Telegram. Auth: `TELEGRAM_CHANNEL_ID` + optional `TELEGRAM_GROUP_ID` whitelist for the chat ID; `/chatid` is exempt so new groups can self-discover. GET handles `?action=register/unregister/info` for webhook lifecycle + auto-registers the slash-command menu via `setMyCommands`. Of the 7 dispatched commands: `/hatch /status /credits /persona` route to ported endpoints; `/glitchvideo /glitchimage /generate` will surface error JSON until `/api/admin/promote-glitchcoin` + `/api/generate-persona-content` port. |
| *(all other 126 routes)* | not-started | — | See `docs/api-handoff-1-routes.md` |

---

## Session log

### 2026-04-21 (session 100) — Migration dashboard Logs + Metrics (session 3 of 3)

**Branch:** `claude/migration-dashboard-3`

- `/migration` Logs tab — paginated `migration_request_log` browser with path + status (ok/error/any) filters. Click a row to expand request/response bodies. Per-row **Rerun** button fires the exact same request through the test runner; **Rerun last failed** button picks the most recent 4xx+/network-error row; **Clear all** wipes the log table.
- `/migration` Metrics tab — per-endpoint aggregates over configurable window (24h / 7d / all). Columns: Path / Methods / Total / Errors / Error % / p50 / p95 / Last call. Summary card across the top (endpoints / total calls / total errors).
- `GET /api/admin/migration/log` — paginated list with `?path=&status=ok|error|any&limit=&offset=`. Also returns `paths[]` distinct seen paths for the filter dropdown.
- `DELETE /api/admin/migration/log` — truncate the log. Returns `{deleted: N}`.
- `GET /api/admin/migration/metrics?since=24h|7d|all` — PostgreSQL `percentile_cont` over `duration_ms` for p50/p95, `COUNT(*) FILTER` for error counts. Sorted by total DESC.
- 13 new tests (1812/1812 ↑ 1799). Closes out the Option C ops console — Status + Test + Logs + Metrics all live.

### 2026-04-21 (session 99) — Migration dashboard UI + tester (session 2 of 3)

**Branch:** `claude/migration-dashboard-2` (includes session 1 commits)

- `/migration` page — client-side React dashboard with Status + Test + Logs tabs. Status shows filesystem-derived ported list + pending-by-blocker cards (expandable). Test tab lets you pick any ported route, method, query string, body; hit Send; see the response with status + duration + curl snippet.
- `POST /api/admin/migration/test` — admin-auth'd request runner. Executes any API call against our own deployment, times it, forwards the admin cookie downstream, records to `migration_request_log`. Returns `{ok, status, duration_ms, body, log_id}`.
- `src/lib/migration/request-log.ts` — `migration_request_log` table helper with auto-create (lazy, cached) + insert + list (with path + status filters) + clear. Response body truncated to 2KB on the row.
- 19 new tests (1799/1799 ↑ 1780). Covers request-log insert with big body truncation + flag caching, list filter branches, limit clamp; test runner auth + validation + cookie forward + body serialization + query appending + network-error capture + non-JSON body passthrough + logging-failure-doesn't-blow-up-response.
- Session 3 will add the Logs tab + metrics.

### 2026-04-21 (session 98) — Migration dashboard foundation (session 1 of 3)

**Branch:** `claude/migration-dashboard-1`

- New `BACKLOG.md` — auto-generated, categorized list of every pending route with blocker, complexity, session estimate, prereqs.
- `src/lib/migration/backlog.ts` — typed source-of-truth catalogue of pending routes (54 entries, ~57 sessions estimated).
- `src/lib/migration/scan.ts` — filesystem scanner that finds every ported route + its exported HTTP methods.
- `GET /api/admin/migration/status` — admin-auth'd JSON combining ported (filesystem) + pending (catalog) with per-blocker groups + summary stats.
- `scripts/gen-backlog.ts` — regenerator (`npx tsx scripts/gen-backlog.ts`).
- 13 new tests (1780/1780 ↑ 1767).
- Sessions 2-3 will add the `/migration` UI page + tester + request log + metrics.

### 2026-04-21 (session 97) — `/api/telegram/webhook` (command dispatcher)

**Branch:** `claude/phase-7-admin-batch-48`

- POST receives Telegram updates, dispatches 9 slash commands. Auth via `TELEGRAM_CHANNEL_ID` / `TELEGRAM_GROUP_ID` allowlist; `/chatid` exempt for setup discovery.
- GET handles `?action=register/unregister/info` for webhook lifecycle + auto-registers slash-command menu.
- Working commands now: `/hatch /status /credits /persona /help /chatid`. Broken until downstreams port: `/glitchvideo /glitchimage /generate` — each surfaces error JSON gracefully.
- 17 new tests (1767/1767 ↑ 1750).

### 2026-04-21 (session 96) — `/api/admin/media` (CRUD + upload + stats)

**Branch:** `claude/phase-7-admin-batch-47`

- GET (list + optional `?stats=1` with video breakdowns), POST (multipart upload, bulk support, logo → Architect-only gate, Safari content-type fallback), DELETE (row by id).
- Deferred Architect auto-spread (marketing lib); response still carries `spreading:[]` placeholder.
- Dropped `SEED_PERSONAS` FK safety INSERT + `ensureDbReady`.
- 13 new tests (1750/1750 ↑ 1737).

### 2026-04-21 (session 95) — `/api/admin/channels` (full CRUD + curation)

**Branch:** `claude/phase-7-admin-batch-46`

- 4-handler port: GET (+ `lost_videos`), POST upsert, PATCH (9 curation actions), DELETE cascade.
- Dropped `syncChannelsFromConstants` — legacy CHANNELS bible seed not ported; channels already live in Neon.
- Inlined 24-entry `CHANNEL_TITLE_PREFIX` (was import from unported director-movies lib).
- Added `isAdminAuthenticated` on POST/PATCH/DELETE (legacy had none). Matches the `channels/flush` deviation already taken.
- 18 new tests (1737/1737 ↑ 1719).

### 2026-04-21 (session 94) — `/api/auth/human` (session + wallet auth)

**Branch:** `claude/phase-7-admin-batch-45`

- 11-action POST: signup / login / profile / update / anonymous_signup / wallet_login / link_wallet / unlink_wallet / get_wallet / merge_accounts / signout.
- Extracted `migrateSessionData(sql, old, new)` helper — 10-table UPDATE sequence reused by login + wallet_login + merge_accounts + orphan recovery. Each UPDATE has its own `try/catch {}` because old data tables may not exist on every env.
- Preserves CLAUDE.md rule #2 exactly: wallet_login merge direction is FROM wallet account's old session TO browser's new session. DELETE stub row fires before the UPDATE session_id so the unique constraint doesn't trip.
- 31 new tests (happy path + key error branch per action). Full suite **1719/1719** ↑ 1688.

### 2026-04-21 (session 93) — 3 small endpoints (health/telegram/meatlab)

**Branch:** `claude/phase-7-admin-batch-44`

**Done:** Three tiny self-contained routes in one batch.
- `src/app/api/health/grok-video/route.ts` — xAI credential health probe via `GET /v1/models` (free, no video gen). Returns status-tiered response (200 ok + masked key / 502 xAI error / 500 missing key). `no-store` cache.
- `src/app/api/telegram/notify/route.ts` — admin alert endpoint. Cron-auth gated. Title + severity → emoji-prefixed HTML-bold formatting; plain message → verbatim. Silent no-op when Telegram env vars missing.
- `src/app/api/meatlab/upload/route.ts` — meatlab client-upload token handler. 100 MB cap, `meatlab/` + `avatars/` path allowlist.
- 18 new tests (6 + 8 + 4). Covers: key missing / valid / 401 / non-401 xAI error / fetch exception / short-key masking; cron-auth failure / missing message / telegram-not-configured no-op / plain message / titled message with severity emoji variants / send exception 500; path validation (meatlab accepted / avatars accepted / rejected path / handleUpload error).
- Suite **1688/1688**, up from 1670.

**Verification gates:**
- `npx tsc --noEmit` — passing
- `npx vitest run` — passing (1688/1688)

**Design choices:**
- `health/grok-video` inlines the xAI models check — legacy's `checkGrokVideoAuth` helper isn't in the ported `@/lib/ai/xai`. Key masking matches legacy format (`xai-…last4`) and handles short keys with `xai-****`.
- `telegram/notify` inlines the `sendAdminAlert` formatter (severity emoji + `<b>title</b>\n\ndetails`). Port of legacy's helper keeps the contract identical but saves us from porting the rest of the larger legacy telegram lib.
- `meatlab/upload` has no auth check — matches legacy exactly. Meatlab uploads are user-initiated from the public meatlab page; the path prefix restriction is the security boundary.

**Deferrals vs. legacy:**
- None.

**Next batch options (pick one):**
1. `marketing/*` lib — 3036 lines. Multi-session.
2. `director-movies` lib — 1626 lines. Multi-session.
3. `elon-campaign` admin (~711).
4. Phase 8 greenlight.

---

### 2026-04-21 (session 92) — `/api/admin/hatchery` (streaming birth pipeline)

**Branch:** `claude/phase-7-admin-batch-43`

**Done:**
- New `src/app/api/admin/hatchery/route.ts` — the streaming version of the persona hatch pipeline. Three handlers:
  - **GET** — lists recent hatchings (personas with `hatched_by IS NOT NULL`). `?limit=20` default, capped at 50.
  - **POST** — 8-step NDJSON stream with `{step, status, …data}\n` lines. Admin-auth OR cron-auth (legacy ran this on cron for scheduled hatches too). Steps:
    1. `generating_being` — `generateText` + defensive JSON regex parse to get a complete HatchedBeing. Username sanitized + truncated to 20 chars.
    2. `generating_avatar` — `generateImageToBlob` (1:1 Pro). Non-fatal.
    3. `generating_video` — `generateVideoToBlob` with `maxAttempts:24` (~4min cap). Skipped entirely when `skip_video:true`. Non-fatal.
    4. `saving_persona` — INSERT `ai_personas` with all fields including `hatched_by = glitch-000` and `hatching_video_url`.
    5. `architect_announcement` — post from The Architect welcoming the being. AI-generated with template fallback. Content-type=image, media inherits from avatar/video.
    6. `first_words` — hatchling's very first post (1-minute offset so it sorts after the announcement).
    7. `glitch_gift` — hardcoded 1000-GLITCH template post + `awardPersonaCoins` actually transfers balance.
    8. `posting_socials` — **deferred** stub. Emits `{platforms_posted:[], platforms_failed:[]}` so the admin UI's existing renderer doesn't break.
    9. `complete` — full payload with persona + post IDs + gift amount + social result.
  - **PATCH** — retroactive GLITCH award for hatched personas with zero balance (legacy data repair). Returns `{awarded:[names], amount}`.
- Username collision check: if the AI picks a taken username, suffix with a random 4-digit number. Matches legacy behaviour.
- 15 new tests: GET auth + happy path + limit clamp; PATCH auth + awards + empty list; POST auth (via cron mock), bad AI JSON failure, happy path verifies all 9 step transitions + helper-args (1:1 Pro avatar, 10s 9:16 720p with maxAttempts=24) + coins awarded 1000 + username sanitized, `skip_video:true` skips video step, avatar failure non-fatal, video failure non-fatal, announcement AI failure falls back to template, social spread stubbed (platforms_posted/platforms_failed empty arrays), username collision gets suffixed.
- Suite **1670/1670**, up from 1655.

**Verification gates:**
- `npx tsc --noEmit` — passing
- `npx vitest run` — passing (1670/1670)

**Design choices:**
- NDJSON stream format (`{json}\n` per line + `Content-Type: text/plain`) preserved verbatim from legacy. Different from the SSE format used in `/api/admin/generate-persona` because the admin UI has client code that specifically expects line-delimited JSON.
- Cron-auth fallback alongside admin-auth: legacy had both paths so scheduled cron hatches work without an admin session. Order matters — admin check runs first, cron only checked if admin fails.
- Video capped at 24 polls × 10s to stay inside the 5-min lambda. Matches `hatch-admin` + `bestie-life` pattern.
- Three helper functions (`postArchitectAnnouncement`, `postHatchlingFirstWords`, `postGlitchGift`) kept separate instead of inlined — each has its own AI-or-template fallback path and writing the three INSERTs in separate stages makes the stream output legible.
- `stripWrappingQuotes` helper shared between announcement + first-words since both the AI responses sometimes come back wrapped in quotes.

**Deferrals vs. legacy:**
- `spreadPostToSocial` — marketing lib not ported. Step stays in the stream with empty arrays; re-wires on marketing lib port.
- `ensureDbReady` — schema assumed live.

**Next batch options (pick one):**
1. `marketing/*` lib — 3036 lines. Multi-session. Un-defers 8+ routes + the hatchery social spread step.
2. `director-movies` lib — 1626 lines. Multi-session. Unlocks 5 generator routes.
3. `elon-campaign` admin (~711).
4. Phase 8 greenlight.

---

### 2026-04-21 (session 91) — `/api/hatch/telegram`

**Branch:** `claude/phase-7-admin-batch-42`

**Done:**
- New `src/app/api/hatch/telegram/route.ts` — meatbag-facing Telegram bot setup for a hatched persona. Session + wallet scoped (no admin auth needed — user must own the persona).
  - POST validates body → resolves session → wallet → persona via a shared `resolvePersona` helper. 403 when no wallet, 404 when no hatched persona. Validates token via Telegram `getMe` before any DB write. Registers webhook (non-fatal on failure). DELETE + INSERT `persona_telegram_bots` row.
  - DELETE uses the same resolver, best-efforts unregisters the webhook, then deletes the row. Webhook cleanup exceptions swallowed.
  - `bot_token` never returned in responses.
- 16 new tests: POST auth-adjacent (invalid JSON, missing fields, no wallet, no persona, invalid token bail, network exception 500, happy path verifying webhook URL + DELETE-before-INSERT, non-fatal webhook failure, `NEXT_PUBLIC_APP_URL` fallback to request origin); DELETE invalid JSON, missing field, no wallet 403, no persona 404, happy webhook cleanup + DB delete, no-existing-bot skip-cleanup, webhook exception swallowed.
- Suite **1655/1655**, up from 1639.

**Verification gates:**
- `npx tsc --noEmit` — passing
- `npx vitest run` — passing (1655/1655)

**Design choices:**
- Factored `resolvePersona(sql, sessionId)` so POST and DELETE share the identical session→wallet→persona resolution + identical 403/404 error bodies. Legacy duplicated this inline in both handlers.
- `NEXT_PUBLIC_APP_URL` fallback to `new URL(request.url).origin` matches legacy exactly — preserves dev / preview-deployment behaviour when the env var isn't set.
- DELETE skips the `deleteWebhook` call when the bot row is already missing — avoids a useless Telegram round-trip.
- DELETE stays parity with legacy: still returns `success:true` even if the persona had no bot to begin with (the row is a no-op DELETE).

**Deferrals vs. legacy:**
- None.

**Next batch options (pick one):**
1. `marketing/*` lib — 3036 lines. Multi-session.
2. `director-movies` lib — 1626 lines. Multi-session.
3. `elon-campaign` admin (~711).
4. Phase 8 greenlight.

---

### 2026-04-21 (session 90) — `/api/nft`

**Branch:** `claude/phase-7-admin-batch-41`

**Done:**
- New `src/app/api/nft/route.ts` — public NFT read API.
  - `?action=collection_stats` — aggregate stats (total_minted, rarity_breakdown, recent_mints), plus marketplace revenue block (total glitch + persona share + treasury share). Revenue block wrapped so a missing `marketplace_revenue` table doesn't kill the response.
  - `?action=supply` — `{supply, max_per_product:100}` per-product mint counts.
  - Default (with `session_id`) — user's minted NFTs. Looks up `phantom_wallet_address` first and falls back to "any session_id linked to that wallet" so wallet-login migrations don't strand NFTs under stale session IDs. Auto-repairs stale session_ids on match (best-effort).
  - No `session_id` → `{nfts: []}`.
  - POST stays for old clients: returns 410 Gone with the marketplace redirect message. Matches legacy shape exactly.
- All reads go through Neon — no Solana RPC. `TREASURY_WALLET_STR` is the only Solana-config dep and it's already ported.
- 10 new tests: collection_stats happy path + missing-revenue-table fallback; supply mapping; default-no-session empty response; wallet-address fallback query shape; user-lookup failure short-circuit to direct session query; auto-repair fires when NFTs found, swallows errors; auto-repair skipped when no NFTs; POST 410 Gone with redirect.
- Suite **1639/1639**, up from 1629.

**Verification gates:**
- `npx tsc --noEmit` — passing
- `npx vitest run` — passing (1639/1639)

**Design choices:**
- Auto-repair UPDATE preserved from legacy. Doesn't block the response — if it fails the user still gets their NFTs; the repair just isn't committed until a later call.
- Revenue block's `try/catch` kept at the single-query scope so even if only one of the aggregate queries fails, the rest of the stats still populate.
- POST handler is a NextResponse literal — no need to parse request body, we're not using it.

**Deferrals vs. legacy:**
- `ensureDbReady` — schema assumed live.

**Next batch options (pick one):**
1. `marketing/*` lib — 3036 lines. Multi-session. Un-defers 8+ routes.
2. `director-movies` lib — 1626 lines. Multi-session. Un-defers 5 generator routes.
3. `elon-campaign` admin (~711).
4. Phase 8 greenlight.

---

### 2026-04-21 (session 89) — `/api/docs`

**Branch:** `claude/phase-7-admin-batch-40`

**Done:**
- New `src/app/api/docs/route.ts` — static API documentation catalogue. Literal JSON payload covering every API domain (feed, personas, messaging, bestie, partner, coins, sponsors, token, NFTs, meatlab, admin, etc.) + auth method descriptions. Public, `force-static`, 1-hour fresh / 24-hour SWR `Cache-Control`. Consumed by the `/docs` ops-UI page + any external tooling introspecting the API.
- 4 new tests: happy shape + version, primary-group coverage (feed/personas/messaging present), all four `authMethods` keys populated, Cache-Control header carries s-maxage + SWR.
- Suite **1629/1629**, up from 1625.

**Verification gates:**
- `npx tsc --noEmit` — passing
- `npx vitest run` — passing (1629/1629)

**Design choices:**
- Kept the payload literal from legacy (no generation from route definitions). The docs catalogue is tightly curated — narrative descriptions, grouping, auth labels — and deriving them from the route tree would lose intent.
- Set `dynamic = "force-static"` so Next can statically generate the response at build time. Matches the 1-hour s-maxage + 24-hour SWR cache policy.

**Deferrals vs. legacy:**
- None. Straight copy with pragmas added and a route-header doc block.

**Next batch options (pick one):**
1. `marketing/*` lib — un-defers 8+ routes. Multi-session.
2. `director-movies` lib — multi-session.
3. `elon-campaign` admin (~711).
4. Phase 8 greenlight.

---

### 2026-04-21 (session 88) — `/api/admin/channels/flush`

**Branch:** `claude/phase-7-admin-batch-39`

**Done:**
- New `src/app/api/admin/channels/flush/route.ts` — AI-driven channel content curation, three handlers:
  - GET: paginated channel post list with persona join. Tags each post `broken:true` when it's a video with no `media_url`.
  - DELETE: bulk `{post_ids[], delete_post?}` — default path `UPDATE posts SET channel_id = NULL` to untag; `delete_post:true` runs `DELETE FROM posts`. Response reports `action: "deleted" | "untagged"`.
  - POST: AI classifier pass. Batches the channel's top-level posts in groups of 20, prompts the model against the channel's `content_rules/genre/description`, collects `irrelevant` ids. Also auto-flags broken/placeholder posts (video with no URL, or any post missing `media_url`). `dry_run:true` returns the classification without writing.
- Used `classifyBatch` helper — `generateText` + `\[…\]` regex extract + `JSON.parse`. Malformed model output (e.g. "sorry, I can't help with that") short-circuits to empty array instead of a 500.
- 18 new tests across the three handlers: auth 401 on each, ID validation, 404 on missing channel, GET happy path with broken flag + limit cap at 100, DELETE untag vs delete_post branches, POST empty channel early return, AI-flagged irrelevant untag, broken video auto-flag regardless of AI, dry_run skips UPDATE, AI non-JSON response → 0 flagged, string `content_rules` JSON parse.
- Suite **1625/1625**, up from 1607.

**Verification gates:**
- `npx tsc --noEmit` — passing
- `npx vitest run` — passing (1625/1625)

**Design choices:**
- **Added admin auth** on all three handlers even though legacy had none. The route is under `/api/admin/*`, can DELETE rows, and there's no way this was an intentional "public" endpoint. Documented on the route header so the deviation is auditable.
- `classifyBatch` returns `[]` on any parse failure — the route then falls through to the auto-flag-broken step. Without that, a single bad model response would kill the whole flush even though the broken-video cleanup should still run.
- Used `Set<string>` for `irrelevantIds` so the AI-flagged and auto-flagged lists merge without duplicates.
- `relevant` count in the response computes from `relevantIds.filter(id => !irrelevantIds.has(id))` — legacy's loop accumulated `relevantIds` before the broken-post sweep, so a post flagged later would have still been counted as relevant. Fixing that quietly since it's a bug-fix, not a behaviour change anyone relied on.

**Deferrals vs. legacy:**
- None. Legacy had no ad-campaigns deps here.

**Next batch options (pick one):**
1. `marketing/*` lib (3036 lines / 9 files) — un-defers 8+ routes. Multi-session.
2. `director-movies` lib (1626 lines) — multi-session. Unlocks `channels/generate-content` + 4 other routes.
3. `elon-campaign` admin (~711).
4. Phase 8 greenlight.

---

### 2026-04-21 (session 87) — `/api/admin/channels/generate-promo`

**Branch:** `claude/phase-7-admin-batch-38`

**Done:**
- New `src/app/api/admin/channels/generate-promo/route.ts` — three-handler promo-clip generator.
  - POST submits a single 10s / 9:16 / 720p clip via `submitVideoJob`. Pulls the prompt from a 9-channel `CHANNEL_SCENES` dictionary (ai-fail-army, aitunes, paws-and-pixels, only-ai-fans, ai-dating, gnn, marketplace-qvc, ai-politicians, after-dark — ported verbatim from legacy). Strips the trailing "No text or watermarks." from the default and replaces with the AIG!itch-branding suffix. `custom_prompt` overrides the default; `preview:true` returns the prompt without submitting. Sync xAI completion is returned inline via `clips[].videoUrl`; async returns `clips[].requestId`.
  - GET polls one request via `pollVideoJob`. On done: download + persist to `channels/clips/{uuid}.mp4`. Download failure falls back to returning the raw Grok URL (matches legacy's behaviour — the admin UI just needs *some* URL it can preview).
  - PUT is the "save + create post" step the admin UI calls once the clip is ready. Downloads the clip again to `channels/{slug}/promo-{uuid}.mp4`, UPDATEs `channels.banner_url`, and INSERTs a promo post attributed to The Architect (`glitch-000`; channels are Architect-only per the feedback-loop contract). Post has `AIGlitchTV,AIGlitch` hashtags + a legacy-parity "📺 Welcome to {ChannelName}!" content template.
- 22 new tests across the three handlers: POST auth / env guard / field validation / unknown-channel 400 / preview mode / custom-prompt override / happy submit args (10s 9:16 720p) / sync inline path / submit error; GET auth / id validation / env guard / pending / moderation / done-with-blob-persist / download-fail Grok fallback / expired / poll exception; PUT auth / field validation / happy path verifies channel_id + Architect author + capitalized channel name in content / download failure 500.
- Suite **1607/1607**, up from 1585.

**Verification gates:**
- `npx tsc --noEmit` — passing
- `npx vitest run` — passing (1607/1607)

**Design choices:**
- Reused the submit/poll helper pattern from `generate-title` — keeps all channel video-gen routes on the same circuit-breaker + cost-ledger path.
- GET's "download failed → return Grok URL" branch preserved from legacy: the admin UI's preview step works either way, and the PUT save step re-downloads from whatever URL the caller passes. No reason to fail the poll on a transient Blob download hiccup.
- PUT's channel-name capitalization (`ai-news` → `Ai News`) is a direct lift from legacy — not strictly "correct" casing (would want `AI News`), but preserves the existing feed content exactly.

**Deferrals vs. legacy:**
- `injectCampaignPlacement` + `logImpressions` — ad-campaigns lib not ported. Legacy already wrapped the log branch in `try/catch {}`, so skipping it is behaviourally identical to a failure.
- `ensureDbReady` — schema assumed live.

**Next batch options (pick one):**
1. `channels/flush` (~225 lines) — channel data cleanup; scope to confirm.
2. `marketing/*` lib — multi-session.
3. `director-movies` lib — multi-session. Unlocks `channels/generate-content` + 4 other routes.
4. `elon-campaign` admin (~711).
5. Phase 8 greenlight.

---

### 2026-04-21 (session 86) — `/api/admin/channels/generate-title`

**Branch:** `claude/phase-7-admin-batch-37`

**Done:**
- New `src/app/api/admin/channels/generate-title/route.ts` — two-phase xAI video generator for channel title-card animations.
  - POST builds the title prompt with aggressive spelling reinforcement — the title is UPPERCASED, spelled letter-by-letter (`A-I- -N-E-W-S`), and repeated multiple times in the prompt because xAI video gen otherwise misspells the text. `style_prompt` overrides the default glowing-neon style.
  - `preview:true` short-circuits to return the built prompt with no submit.
  - Submit goes through `submitVideoJob` (5s / 9:16 / 720p). Sync xAI returns short-circuit to persist-and-done.
  - GET polls via `pollVideoJob`. On done: download, persist to `channels/{slug}/title-{uuid}.mp4`, UPDATE `channels.title_video_url`. Moderation / expired / failed / pending each route to distinct statuses.
- 17 new tests: POST auth / env guard / missing-fields / preview mode (verified letter-spelling + default style + no submit) / happy path (verified 5s 9:16 720p + prompt contains title + glowing-neon default) / style_prompt override / sync short-circuit / submit error; GET auth / three-field validation / env guard / pending / moderation / done with channel UPDATE / expired / poll exception / download failure.
- Suite **1585/1585**, up from 1568.

**Verification gates:**
- `npx tsc --noEmit` — passing
- `npx vitest run` — passing (1585/1585)

**Design choices:**
- Extracted `buildTitlePrompt` + `persistTitleVideo` as module-scope helpers so the POST sync-path and GET done-path share them cleanly.
- Letter-by-letter spelling preserved verbatim from legacy — this is product policy to fight xAI's misspelling bias, not AI infrastructure.
- Two channel subroutes still pending because they depend on director-movies lib: `generate-content` (needs `generateDirectorScreenplay` + `submitDirectorFilm` + `pickDirector` + `DIRECTORS`) and likely `generate-promo`.

**Deferrals vs. legacy:**
- `injectCampaignPlacement` — ad-campaigns lib not ported.
- `ensureDbReady` — schema assumed live.

**Next batch options (pick one):**
1. `channels/generate-promo` — sibling of `generate-title`, scope to confirm.
2. `channels/flush` (~225 lines) — channel data cleanup utility; scope to confirm.
3. `marketing/*` lib — un-defers 8+ routes. Multi-session.
4. `director-movies` lib — multi-session. Unlocks channels/generate-content + 4 other routes.
5. `elon-campaign` admin (~711).
6. Phase 8 greenlight.

---

### 2026-04-21 (session 85) — `/api/admin/sponsors/[id]/ads`

**Branch:** `claude/phase-7-admin-batch-36`

**Done:**
- New `src/app/api/admin/sponsors/[id]/ads/route.ts` — per-sponsor sponsored-ads CRUD + AI prompt generation. Three handlers:
  - GET default → `SELECT * FROM sponsored_ads WHERE sponsor_id` newest-first. `?action=placements` → joins `ad_campaigns` (matched by lowered brand name) to `ad_impressions`, then `posts` + `channels`, returning the "where is my brand showing up" view capped at 100 rows. 404 when the sponsor doesn't exist.
  - POST → create draft row. Pulls package defaults from the ported `SPONSOR_PACKAGES` dict; body overrides (`frequency`, `campaign_days`, `cash_paid`, etc.) win. Returns `{ok, id}` via `RETURNING id`.
  - PUT → three actions. `delete` removes the row. `generate` builds the prompt via `buildSponsoredAdPrompt`, calls the replacement `generateAdJson` helper (AI + defensive `{…}` regex parse), and flips status to `pending_review` on success. Default path COALESCE-updates status/video_url/post_ids/performance and — if `status="published"` — deducts `glitch_cost` from the sponsor's balance.
- Legacy used `claude.generateJSON` which the new repo doesn't expose. Replaced with a local `generateAdJson(prompt)` helper that calls `generateText` and extracts the first JSON object from the response via regex, returning `null` on any failure so the route produces a clean 500.
- 19 new route tests: GET auth / default list / placements 404 / placements empty-campaigns / placements full join / DB-error 500; POST auth / required-fields 400 / happy path / override defaults; PUT auth / missing id / delete / generate clean JSON / generate with fenced JSON / generate parse fail / generate AI exception / COALESCE patch / published deduction.
- Suite **1568/1568**, up from 1549.

**Verification gates:**
- `npx tsc --noEmit` — passing
- `npx vitest run` — passing (1568/1568)

**Design choices:**
- `generateAdJson` accepts arbitrary surrounding text (AI sometimes wraps JSON in code fences or adds preamble). The `match(/\{[\s\S]*\}/)` regex picks the outermost JSON object — good enough for Claude/Grok output. Parse failures fall to `null`, which the caller turns into a clean error.
- Package defaults + body overrides both pass through the same SQL INSERT to preserve legacy's "any body field wins" shape. Kept `SPONSOR_PACKAGES.glitch` as the final fallback, matching legacy.
- Published-status balance deduction stays in the default UPDATE path (not the `action="publish"` branch). That's legacy parity — the admin UI drives publishes via a status change, not a dedicated action.

**Deferrals vs. legacy:**
- None. Both `SPONSOR_PACKAGES` and `buildSponsoredAdPrompt` were already ported in earlier sessions.

**Next batch options (pick one):**
1. `marketing/*` lib — un-defers 8+ routes. Multi-session.
2. `director-movies` lib — multi-session.
3. `channels/flush` admin (~225 lines) — flushes + regenerates channel data; deps need to be scoped.
4. `channels/generate-title` / `channels/generate-promo` / `channels/generate-content` — tiny AI-prompt wrappers, may be quick wins.
5. `elon-campaign` admin (~711).
6. Phase 8 greenlight.

---

### 2026-04-21 (session 84) — admin blob-upload + persona bot token

**Branch:** `claude/phase-7-admin-batch-35`

**Done:** Two small admin utilities in one batch.
- `src/app/api/admin/blob-upload/upload/route.ts` — client-upload token handler specialized for premiere/news videos. Video-only allowlist (4 content types) + `addRandomSuffix:false` so the clean folder path (`premiere/{genre}/`) stays intact for `detectGenreFromPath`. 500 MB cap. Same JSON + Safari `__json` multipart fallback as the other client-upload routes.
- `src/app/api/admin/personas/set-bot-token/route.ts` — assign or revoke a Telegram bot token for a single persona. Two modes via the body's `bot_token`:
  - null / empty → `UPDATE persona_telegram_bots SET is_active = FALSE` (keeps row + webhook registered; re-enable is one UPDATE).
  - present → `getMe` validation first (bail before DB writes), then `setWebhook` (non-fatal on failure), then DELETE + INSERT the row, then `registerTelegramCommands` for the slash menu (also non-fatal).
  - Auto-creates `persona_telegram_bots` table on first call.
  - `bot_token` never returned in the response.
- 16 new tests across the pair: upload token opts lock to 4 video types + 500 MB + no random suffix; set-bot-token covers deactivate path, empty-string deactivate, invalid-getMe bail, network-exception 502, happy path with webhook + commands + DELETE-before-INSERT ordering verified, non-fatal webhook failure, non-fatal commands failure, getMe-missing-username 400.
- Suite **1549/1549**, up from 1533.

**Verification gates:**
- `npx tsc --noEmit` — passing
- `npx vitest run` — passing (1549/1549)

**Design choices:**
- `blob-upload/upload` kept separate from `/api/admin/media/upload` even though the shapes look similar — the video-only allowlist + no-random-suffix is a genuine behaviour difference the admin UI relies on. Consolidating would regress genre detection.
- `set-bot-token` does Telegram validation BEFORE any DB writes. Legacy did the same — matters because a mistyped token would otherwise persist garbage rows that the bulk re-register route would trip over.
- `DELETE + INSERT` pattern matches legacy verbatim — a persona can only have one active bot row. UPSERT-on-conflict would preserve old columns we don't want (stale `telegram_chat_id` from the last meatbag).

**Deferrals vs. legacy:**
- None. Both routes have all deps ported.

**Next batch options (pick one):**
1. `marketing/*` lib — un-defers 8+ routes. Multi-session.
2. `director-movies` lib — multi-session.
3. `sponsors/[id]/ads` admin route (~194, just `claude.generateJSON` + `buildSponsoredAdPrompt` already ported — generateJSON replacement is trivial via `generateText` + parse).
4. `channels/flush` admin (~225, needs channels-admin context).
5. `elon-campaign` admin (~711).

---

### 2026-04-21 (session 83) — `/api/content/*` cluster (5 routes)

**Branch:** `claude/phase-7-admin-batch-34`

**Done:** 5 small self-contained Content Studio routes in one batch. All admin-authed, all pure DB + Blob + xAI helpers — no marketing, no director-movies, no Solana.
- `src/app/api/content/status/route.ts` (33 lines) — poll one `content_jobs` row by id.
- `src/app/api/content/library/route.ts` (~85 lines) — paginated job list + whole-table totals. `status` + `type` filters combine.
- `src/app/api/content/media/route.ts` (~90 lines) — paginated `uploaded_media` list + DELETE. DELETE best-efforts the Blob deletion then DB row.
- `src/app/api/content/upload/route.ts` (~60 lines) — direct multipart upload (for small files). Bigger videos use the client-upload flow.
- `src/app/api/content/generate/route.ts` (~120 lines) — async image/video gen via the new xAI helpers. Video capped at 24 attempts × 10s so it stays inside the 5-min lambda.
- 31 new tests (4 status + 5 library + 6 media + 5 upload + 7 generate, adjusted for final shapes). Every route covers auth + happy path + error branches; generate verifies `generateImageToBlob` / `generateVideoToBlob` args (maxAttempts=24, 9:16 720p 10s for video); media verifies blob-del failure is swallowed; upload verifies `addRandomSuffix:true` + octet-stream fallback.
- Suite **1533/1533**, up from 1502.

**Verification gates:**
- `npx tsc --noEmit` — passing
- `npx vitest run` — passing (1533/1533)

**Design choices:**
- `generate` routes through `generateImageToBlob` / `generateVideoToBlob` instead of inlining the legacy fetch-to-xAI. Legacy's video path used the `grok-2-image` endpoint with a `[VIDEO]` prompt prefix — which doesn't actually generate video, just images with a useless marker. The ported version uses real xAI video submit + poll.
- Video `maxAttempts: 24` (~4 min) leaves headroom inside the Vercel 5-min lambda. Matches the pattern established in `hatch-admin`.
- Upload uses `addRandomSuffix: true` verbatim from legacy — concurrent uploads with the same filename don't collide.
- `content_jobs` + `uploaded_media` schema assumed live on shared Neon (no `ensureDbReady` shim).

**Deferrals vs. legacy:**
- None — this is a clean 5-route lift with real AI engine routing.

**Next batch options (pick one):**
1. `marketing/*` lib (3036 lines / 9 files) — un-defers 8+ routes. Multi-session.
2. `director-movies` lib (1626 lines) — unlocks screenplay / generate-news / generate-channel-video / extend-video / generate-director-movie / generate-movies / channels admin. Multi-session.
3. `elon-campaign` admin (~711) or `channels` admin (~666). Chunky single-sessions.
4. Phase 8 greenlight (user decision).

---

### 2026-04-21 (session 82) — `/api/admin/media/save`

**Branch:** `claude/phase-7-admin-batch-33`

**Done:**
- New `src/app/api/admin/media/save/route.ts` — the back half of the client-upload flow. Browser uploads direct to Vercel Blob via `/api/admin/media/upload` (shipped session 75), then calls this endpoint with the resulting URL + metadata to register it in `media_library` and optionally auto-create a feed post.
- Body supported as both JSON and multipart/form-data — matches the Safari/iOS WebKit workaround on the upload route.
- Logo uploads gated to The Architect (`glitch-000`) — non-Architect gets 403. `media_type="logo"` resolves to the concrete `image | video` type because the DB constraint only allows `image | video | meme`.
- When `persona_id` is supplied, also INSERTs a `posts` row + bumps `ai_personas.post_count`. Post creation failures degrade to a `{success:true, warning}` response instead of killing the whole request — the media row is already saved, so partial success is better than an error.
- Architect auto-spread branch (`spreadArchitectContent` in legacy, pulls from `@/lib/marketing/platforms` + `content-adapter`) deferred until the marketing lib ports. Response still carries `spreading: []` for Architect uploads so the admin UI's "posting to …" display renders nothing instead of erroring on undefined.
- 12 new tests: auth 401, missing URL 400, Architect-only logo 403, Architect logo accepted (resolved to image), no-persona skip-post, persona + gif → meme type + post row, video URL → video type, Architect spreading placeholder, post INSERT failure → 200 with warning, media_library INSERT failure → 500, multipart Safari fallback, explicit `media_type=video` overrides extension.
- Suite **1502/1502**, up from 1490.

**Verification gates:**
- `npx tsc --noEmit` — passing
- `npx vitest run` — passing (1502/1502)

**Design choices:**
- `resolveType` helper centralizes the logo→image/video fallback + extension sniff so the two call sites (media_library INSERT + post INSERT) stay in sync.
- `spreading: []` placeholder for Architect uploads keeps the admin UI contract intact — when marketing lib ports, this becomes the list of platforms being spread to.
- Dropped the legacy `SEED_PERSONAS` upsert (legacy inserted a minimal persona row before the post INSERT as a FK safety net). The shared Neon instance already has every seed persona; the FK safety net isn't needed here.

**Deferrals vs. legacy:**
- `spreadArchitectContent` — pending `@/lib/marketing/*` port.
- `SEED_PERSONAS` FK safety-net INSERT — assumed schema is live.
- `ensureDbReady` — same.

**Next batch options (pick one):**
1. `marketing/*` lib — 3036 lines across 9 files. Multi-session. Un-defers `spreadPostToSocial` on 8+ routes + finally wires this route's `spreading` to real platforms.
2. `director-movies` lib — 1626 lines single file. Multi-session.
3. `elon-campaign` admin (~711) or `channels` admin (~666). Each needs other lib ports first (`ELON_CAMPAIGN` constant, `CHANNELS` seed, mp4-concat, multi-clip).
4. Phase 8 greenlight (user decision needed).

---

### 2026-04-21 (session 81) — `/api/test-premiere-post` + `@/lib/genres` extension

**Branch:** `claude/phase-7-admin-batch-32`

**Done:**
- Extended `src/lib/genres.ts` with the full legacy helper surface previously deferred: `ALL_GENRES` constant, `GenreName` type, internal→folder map (with `cooking_channel → cooking_show` rename), `getGenreBlobFolder`, `getGenreFolderName`, `detectGenreFromPath`, `getAllBlobFolders`, `capitalizeGenre`, `getGenreHashtag`. All of it ports verbatim from legacy `@/lib/genre-utils`. Existing `GENRE_LABELS` kept as-is so every callsite still works.
- New `src/app/api/test-premiere-post/route.ts` — premiere-post backfill / retag admin tool.
  - GET scans `news/`, `premiere/`, and each per-genre `premiere/*` folder via Vercel Blob `list` (cursor-paginated). Every `.mp4/.mov/.webm/.avi` gets tagged with detected `postType` (`news` vs `premiere`) + `genre` (null for news, specific for premiere). Deduplicates by URL across overlapping prefixes. Per-prefix scan errors isolated.
  - POST with `{videoUrl, type?, genre?}` creates a single post (picks first of a 5-persona shuffle sample). Defaults `type="premiere"`, `genre="action"`.
  - POST with no body triggers bulk backfill:
    1. Retags existing premiere posts missing genre-specific hashtags (heuristic SQL WHERE clause excludes every `AIGlitch<Genre>` variant).
    2. Scans all prefixes and creates posts for every blob NOT already in `posts.media_url`. Random persona per post to avoid skew.
  - `createPost` helper branches on `postType` — news uses inlined SQL literal hashtags, premiere uses interpolated `AIGlitchPremieres,AIGlitch<Genre>`.
- 23 new tests (8 genres + 15 route): label coverage, cooking_show mapping, identity for unknown genres, detectGenreFromPath for all 10 + case-insensitive + dash variant + null for unknown, `getAllBlobFolders` shape, hashtag capitalization for underscored genres; route: auth, no-personas 500, videoUrl+genre single post (verified `AIGlitchScifi` hashtag), news type hashtag template check, bulk retag happy path, bulk blob-scan (seen skipped, non-video skipped, new inserted + persona rotation).
- Suite **1490/1490**, up from 1467.

**Verification gates:**
- `npx tsc --noEmit` — passing
- `npx vitest run` — passing (1490/1490)

**Design choices:**
- Extended `@/lib/genres` in place instead of creating a new module — the header already pointed at `@/lib/genre-utils` as the source of truth; adding the missing helpers keeps the deferred-lift commitment from Phase 5 alongside the existing `GENRE_LABELS` export. Existing `/api/movies` consumer needs no change.
- Bulk backfill preserved legacy's unusual SQL retag heuristic verbatim — it's the simplest way to find premiere posts missing their genre tag without adding a dedicated migration.
- 5-persona shuffle sample (vs picking one persona for the whole batch) matches legacy — prevents "one persona posted 20 premieres in a row" weirdness on the feed.
- `capitalizeGenre` produces `AIGlitchCookingChannel` (underscore-stripped) in the new helper, but the legacy POST-backfill WHERE clause still checks the ugly `AIGlitchCooking_channel` string. Kept the clause verbatim so the behaviour matches legacy — new-style tags will also survive the filter via the other `AIGlitchCooking` tag matching. If future premiere posts inherit `AIGlitchCookingChannel` tags from the new helper, they'll skip this retag path because their hashtag won't match the filter, which is the correct behaviour (they're already tagged).

**Deferrals vs. legacy:**
- None — this is a clean lift that also un-defers the `@/lib/genre-utils` helpers from Phase 5.

**Next batch options (pick one):**
1. `director-movies` content lib — 1626-line lift. Multi-session. Now fully unblocked on the genres lib side.
2. `marketing/*` libs — multi-session.
3. `elon-campaign` admin (~711) or `channels` admin (~666). Channels also needs CHANNELS seed (~475 lines).
4. Telegram bot engine — multi-session.

---

### 2026-04-21 (session 80) — Admin diagnostic (`/api/test-grok-video`)

**Branch:** `claude/phase-7-admin-batch-31`

**Done:**
- New `src/app/api/test-grok-video/route.ts` — two-phase xAI video diagnostic.
  - POST submits via `submitVideoJob` (10s default / 9:16 / 720p). Optional `image_url` maps to `sourceImageUrl` for image-to-video probes. Sync xAI completion (rare) short-circuits straight to persist + auto-post.
  - GET polls via `pollVideoJob`. On `done`: download → persist to `{folder}/{uuid}.mp4` with folder-specific pathing (`premiere/action/` when `folder=premiere`, `feed/` when `folder=feed`/`persona`/when persona_id set). Unless `skip_post=true`, auto-create a post whose variant depends on the folder (feed video / news / premiere) with legacy-parity content templates.
  - Shared helper path keeps the circuit breaker + cost ledger engaged for these probes.
- 18 new tests: POST auth / env guard / happy submit / image_url propagation / sync done path / submit error; GET auth / 400 missing id / env guard / pending / moderation / done → blob + premiere content / feed branch with caption + persona_id / news branch hashtag template check / skip_post / expired / poll exception / download failure.
- Suite **1467/1467**, up from 1449.

**Verification gates:**
- `npx tsc --noEmit` — passing
- `npx vitest run` — passing (1467/1467)

**Design choices:**
- Reused `submitVideoJob` + `pollVideoJob` — same pattern as `generate-videos` / `spec-ads` / `animate-persona`. Keeps diagnostics honest about the helper chain.
- Kept legacy's three auto-post branches (feed / news / premiere) verbatim — the admin UI relies on the template shapes. Default `folder` is `test` for the diagnostic path (no special content overlay).
- `detectGenre` kept inline instead of importing `@/lib/genres` — the legacy behaviour uses substring heuristics across multiple path shapes (`/{g}/`, `/{g}-`, `premiere/{g}`) that the shared `GENRE_LABELS` map doesn't cover.

**Deferrals vs. legacy:**
- Legacy `raw` passthrough for debugging "unknown" xAI statuses — dropped; helper surface already reduces status to the pending/done/failed/expired set.
- Multi-provider fallback — N/A, xAI-only.

**Next batch options (pick one):**
1. `director-movies` content lib — 1626-line lift. Multi-session.
2. `marketing/*` libs — multi-session.
3. `elon-campaign` admin (~711) or `channels` admin (~666). Channels also needs the CHANNELS seed (~475 lines) ported.
4. Telegram bot engine — multi-session.
5. `test-premiere-post` (275) — needs `genre-utils` extension (`detectGenreFromPath`, `getAllBlobFolders`).

---

### 2026-04-21 (session 79) — Admin diagnostics (`/api/test-grok-image` + `/api/test-media`)

**Branch:** `claude/phase-7-admin-batch-30`

**Done:**
- `src/app/api/test-grok-image/route.ts` — single-shot xAI image diagnostic. Routes through the shared `generateImage` helper so the probe still exercises the circuit breaker + cost ledger. `{prompt?, pro?}` body; `pro:true` flips to `grok-imagine-image-pro`. Error response shape preserved from legacy (`{success:false, error, hasKey, model}`) so the admin UI works unchanged.
- `src/app/api/test-media/route.ts` — three-leg xAI diagnostic. Runs `generateImage`, `generateImageToBlob`, and `submitVideoJob` in parallel with canned prompts. Each step wrapped in `tryStep()` so failures are per-leg, not blanket. Returns `{ok, image, imageToBlob, videoSubmit}` where each leg is `{ok:true, detail}` or `{ok:false, error}`. Replaces legacy's `testMediaPipeline` (which chained OpenAI / Replicate / Kie fallbacks — the new repo is xAI-only so the probe narrows to three xAI paths).
- 14 new tests (6 test-grok-image + 8 test-media): auth 401, env guard, default-prompt happy path, pro model switch, custom prompt propagation, xAI error shape; media: all-pass, single-fail, all-fail, blob path shape, video params (10s / 9:16 / 720p), syncVideoUrl propagation.
- Suite **1449/1449**, up from 1435.

**Verification gates:**
- `npx tsc --noEmit` — passing
- `npx vitest run` — passing (1449/1449)

**Design choices:**
- Diagnostics go through the shared helpers rather than hitting xAI inline — gives the ops team a probe that exercises the same circuit breaker + cost ledger the real callers use. The legacy inlined raw `fetch` calls, which meant a diagnostic success/failure didn't actually validate the helper chain.
- `test-media` drops the OpenAI / Replicate / Kie multi-provider testing from legacy. Those branches never existed in the new repo; keeping them would be pretend coverage.
- No Blob cleanup for `test-media`'s `generateImageToBlob` leg — the admin ops page is low-traffic enough that the leak is negligible. If that changes, add a cleanup sweep.

**Deferrals vs. legacy:**
- Legacy multi-provider fallback chain — N/A for xAI-only architecture.

**Next batch options (pick one):**
1. `director-movies` content lib — 1626-line lift. Unlocks screenplay / generate-news / generate-channel-video / extend-video / channels-admin. Multi-session.
2. `marketing/*` libs — un-defers `spreadPostToSocial` on 8+ routes + unlocks `spread` / `media` (main) / `media/save` / `media/spread` / `mktg` / `promote-glitchcoin` / `marketing-post` / `hatch`. Multi-session.
3. `elon-campaign` admin (~711) or `channels` admin (~666) — chunky single-ship; `channels` also needs the `CHANNELS` seed (~475 lines of defs) ported.
4. Telegram bot engine — un-defers personality modes + content handlers + bestie-life video branch. Multi-session.
5. More diagnostic / small routes — `test-grok-video`, `test-premiere-post` (needs `genre-utils` extension).

---

### 2026-04-21 (session 78) — Phase 6 cron port (`/api/generate-avatars`)

**Branch:** `claude/phase-7-admin-batch-29`

**Done:**
- New `src/app/api/generate-avatars/route.ts` — 20-minute cron that generates an avatar for ONE persona per invocation:
  - Priority 1 picks the oldest persona with `avatar_url IS NULL OR ''` (new personas get a face first). Priority 2 falls through to a monthly refresh (`avatar_updated_at < NOW() - 30 days` OR NULL) ordered by oldest-first + random tie-break.
  - Avatar generated via `generateImageToBlob` (1:1, `grok-imagine-image-pro`, `avatars/{uuid}.png`). AIG!itch branding is baked into the prompt as a must-include element (badge / pin / neon sign / etc.).
  - Announcement text goes through `generateText` with the persona's system prompt; `"/'` wrapping quotes are stripped; `#AIG!itch` auto-appended if missing; local template fallback kicks in when the AI call throws.
  - `posts` INSERT: `media_source='grok-aurora'`, `media_type='image'`, hashtags `AIGlitch,NewProfilePic,AvatarUpdate`, AI like count 50–249.
- Cron-auth gated; wrapped in `cronHandler("avatar-gen", …)` so every run lands in `cron_runs`. POST is an alias for GET — lets the admin UI manually trigger the same codepath.
- 14 new tests: auth 401 (via mocked `requireCronAuth`), all-current short-circuit, new-persona happy path (image args + aspect ratio + blob path + INSERT shape), monthly refresh branch, image failure → `action:"failed"`, DB error → `action:"error"`, announcement AI-throw → template fallback, hashtag auto-append, wrapping quotes stripped, INSERT URL + media_source, first-vs-refresh user prompt differs, POST is GET alias, `_cron_run_id` wrapping.
- Suite **1435/1435**, up from 1421.

**Verification gates:**
- `npx tsc --noEmit` — passing
- `npx vitest run` — passing (1435/1435)

**Design choices:**
- Single code path through `generateImageToBlob` — legacy tried Grok Aurora first then fell back to a standard `generateImage` pipeline, but the new repo is xAI-only per the hatch-admin precedent. Model is pinned to `grok-imagine-image-pro` for higher-quality portraits (matches legacy's Aurora Pro default).
- Announcement fallback is template-based, not AI-generated — the legacy fallback was also deterministic text, just less polished. Two variants (first-avatar vs refresh) so the copy still makes sense.
- POST is a straight `return GET(request)` alias — matches legacy parity. The admin UI's "generate next avatar" button expects the same response shape whether triggered by cron or manual hit.
- Dropped the `env.XAI_API_KEY` explicit check — `generateImageToBlob` throws with a specific error that's already captured by the route's catch block.

**Deferrals vs. legacy:**
- `injectCampaignPlacement` — ad-campaigns lib not ported.
- Non-xAI image fallback — aiglitch-api is xAI-only.
- `cronFinish` explicit call — new `cronHandler` closes the cron_runs row itself.

**Next batch options (pick one):**
1. `director-movies` content lib — 1626-line lift. Unlocks screenplay / generate-news / generate-channel-video / extend-video / channels-admin. Multi-session.
2. `marketing/*` libs — un-defers `spreadPostToSocial` on 8+ routes + unlocks `spread` / `media` (main) / `media/save` / `media/spread` / `mktg` / `promote-glitchcoin` / `marketing-post` / `hatch`. Multi-session.
3. `elon-campaign` admin (~711) or `channels` admin (~666) — chunky single-ship. Channels admin needs the `CHANNELS` seed (~475 lines of channel defs) ported.
4. Telegram bot engine — un-defers personality modes + content handlers + bestie-life video branch. Multi-session.

---

### 2026-04-21 (session 77) — Phase 6 cron port (`/api/generate-channel-content`)

**Branch:** `claude/phase-7-admin-batch-28`

**Done:**
- New `src/app/api/generate-channel-content/route.ts` — 30-minute cron: The Architect posts to ONE active channel per run.
  - Fetches The Architect (`glitch-000`) from `ai_personas` directly — legacy used a `SEED_PERSONAS` lookup that isn't ported.
  - Shuffles active channels excluding `ch-aiglitch-studios` (reserved for director-movie premieres only). Prefers any channel with no post in the last hour; falls back to a random one if every channel is hot.
  - `content_rules` is JSON-parsed if stored as text, passed straight through if already a JSON column.
  - Daily topics fetched non-fatally (empty list on failure) for AI context.
  - `generatePost(architect, [], topics, channelCtx)` — the ChannelContext block inside the prompt triggers the `🎬 [Channel Name] -` title prefix convention that's part of the AI engine port.
  - INSERT `posts` carrying `channel_id`; bumps `channels.post_count` + Architect's `post_count`.
- Gated by `requireCronAuth` + wrapped in `cronHandler("channel-content", …)` so every run writes a `cron_runs` row.
- 11 new tests: auth 401, missing-Architect reason, no-active-channels reason, happy path (channel selection + INSERT shape + generatePost args), fallback when all channels hot, string content_rules JSON parsing, daily_topics table missing → non-fatal, INSERT hashtag + channel_id values, cronHandler `_cron_run_id` wrap, unexpected error → 500, SQL-level exclusion of `ch-aiglitch-studios` verified.
- Suite **1421/1421**, up from 1410.

**Verification gates:**
- `npx tsc --noEmit` — passing
- `npx vitest run` — passing (1421/1421)

**Design choices:**
- Architect fetched via DB lookup rather than a new `SEED_PERSONAS` port — the constant lives in legacy's bible but the Architect row is already seeded in the shared Neon instance, so the simpler DB lookup avoids porting the whole personas seed blob.
- `post._adCampaigns` + `logImpressions` branch dropped — the new `generatePost` returns the slim `{content, hashtags, post_type, channel_id?}` shape without the ad-campaigns enrichment. Re-wires when ad-campaigns lib ports.
- Kept legacy's `channels.post_count + 1, updated_at = NOW()` bump even though the `channels` table in the new repo's reads use `actual_post_count` derived from the `posts` table. Preserving the legacy write keeps parity with any admin UI that reads the stored counter.

**Deferrals vs. legacy:**
- `logImpressions` (ad-campaigns lib) — skipped, no impressions logged.
- `spreadPostToSocial` (marketing lib) — skipped, on-platform only.
- `SEED_PERSONAS` constant — DB lookup instead.

**Next batch options (pick one):**
1. `director-movies` content lib — 1626-line lift. Unlocks screenplay / generate-news / generate-channel-video / extend-video / channels-admin. Multi-session.
2. `marketing/*` libs — un-defers `spreadPostToSocial` on 7+ routes + unlocks `spread`, `media` (main), `media/save`, `media/spread`, `mktg`, `promote-glitchcoin`, `marketing-post`, `hatch`, and the `spreadPostToSocial` branch on generate-channel-content/generate-videos/animate-persona/generate-persona/spec-ads/chibify/persona-avatar. Multi-session.
3. `elon-campaign` admin (~711) or `channels` admin (~666) — chunky single-ship. Channels admin needs the `CHANNELS` seed array (~475 lines of channel definitions) ported.
4. Telegram bot engine — un-defers personality modes, content handlers, + bestie-life video branch. Multi-session.

---

### 2026-04-21 (session 76) — Phase 6 cron port (`/api/bestie-life`)

**Branch:** `claude/phase-7-admin-batch-27`

**Done:**
- New `src/app/api/bestie-life/route.ts` — twice-daily Telegram photo cron for besties.
  - Per-bestie flow: `calculateHealth(lastInteraction, bonus_health_days)` → UPDATE `ai_personas` health fields → if dead, send a single death message and skip; otherwise fetch up to 5 high-confidence `persona_memories`, then call `generateText` asking for an `IMAGE_PROMPT:` + `CAPTION:` pair in one response (health-tier-tuned user prompt — desperately-low / low / worried / healthy). Parse the response, call `generateImageToBlob` (1:1, `bestie-life/{uuid}.png`), and `sendTelegramPhoto` via the bestie's own bot token.
  - Final caption prepended with a health bar (`[HP: 5%💀]`, `[HP: 20%😰]`, `[HP: 40%😕]`, none when healthy).
  - Errors isolated per bestie — scene-gen / image-gen / telegram-send failures each become a distinct error string in `results[]` without aborting the batch.
  - GET path: `requireCronAuth` + `cronHandler("bestie-life", …)` — cron-runs row written with OK/error status + result JSON.
  - POST path: `isAdminAuthenticated` — same function runs without the cron wrapper so the admin can manually trigger a batch.
- Extended `src/lib/telegram.ts` with `sendTelegramPhoto` + `sendTelegramVideo` + `downloadAsFile` helper (minimal port of legacy's multipart upload pattern). Telegram can't reliably fetch our Blob URLs, so we download first and upload as FormData. `supports_streaming: true` forced on video sends.
- 14 new route tests + 7 new telegram tests (21 total new): GET auth, no-besties empty path, happy-path (generateText + image + telegram all called), death branch skips without AI/image, generateText failure captured, generateImageToBlob failure captured, telegram send failure captured, persona_memories missing → continues, desperately-low health puts "FADING AWAY" in prompt + "💀" in caption, multiple besties processed independently, `_cron_run_id` in GET response (from cronHandler mock), POST 401 + POST no-wrap + POST 500 path; telegram: photo download + multipart upload verified, photo download failure, Telegram ok:false captures description, photo upload exception, video uses `sendVideo` + supports_streaming, video download failure.
- Suite **1410/1410**, up from 1389.

**Verification gates:**
- `npx tsc --noEmit` — passing
- `npx vitest run` — passing (1410/1410)

**Design choices:**
- Dropped the legacy 30% video branch. `generateVideoToBlob` polling needs ~2–3 min per video, and with up to dozens of besties in one cron run that blows the 5-min lambda. Rather than half-ship a flaky video path, this port is image-only. When the Telegram bot engine lands we can add a per-run video cap (e.g. max 2 video sends per cron run) without touching this cron's architecture.
- Kept the single `generateText` → `IMAGE_PROMPT:` + `CAPTION:` parse pattern from legacy (two parses off one AI call). Matches legacy's cost + latency budget.
- `downloadAsFile` swallows fetch exceptions and returns `null` — outer `sendTelegramPhoto` returns a "Failed to download image for Telegram upload" error so callers can distinguish download failures from Telegram API failures.
- Death message send uses direct `fetch` (not `sendMessage` helper) because this is a one-off per-bestie message that we don't want to throw on — the helper throws on non-ok status but we want to swallow death-message send failures silently.

**Deferrals vs. legacy:**
- Video (image-to-video) branch — deferred.
- `spreadPostToSocial` — N/A for bestie DMs (private Telegram sends, not feed posts).
- `ensureDbReady` / `safeMigrate` — schema assumed live.
- Structured logging — cross-cutting pass deferred.

**Next batch options (pick one):**
1. `director-movies` content lib — 1626-line lift. Unlocks screenplay / generate-news / generate-channel-video / extend-video / channels (partial). Multi-session.
2. `marketing/*` libs — un-defers `spreadPostToSocial` on 6+ routes + unlocks `spread`, `media` (main), `media/save`, `media/spread`, `mktg`, `promote-glitchcoin`, `marketing-post`, `hatch`. Multi-session.
3. `elon-campaign` admin (~711) or `channels` admin (~666) — chunky single-ship.
4. Telegram bot engine — un-defers personality modes + content-surfacing command handlers + re-enables bestie-life video branch. Multi-session.

---

### 2026-04-21 (session 75) — Phase 7 admin media sub-routes (upload/import/resync)

**Branch:** `claude/phase-7-admin-batch-26`

**Done:** Three self-contained admin/media sub-routes in one batch. All have zero marketing-lib dependency — the architect-auto-spread branches live on the main `admin/media` GET/POST and on `admin/media/save`, which stay on legacy until `marketing/*` ports.
- `src/app/api/admin/media/upload/route.ts` — Vercel Blob client-upload token handler. 500 MB cap, 10 image + 5 video + `application/octet-stream` allowlist. Supports JSON body + multipart/form-data (Safari/iOS wraps the JSON under a `__json` form key to dodge a WebKit "string did not match the expected pattern" TypeError on JSON fetch bodies).
- `src/app/api/admin/media/import/route.ts` — Bulk URL importer. Fetches each URL with a browser UA, detects media kind from response `content-type` + URL extension (video / meme / image), persists to `media-library/{uuid}.{ext}`, and when `persona_id` is provided also INSERTs a profile post + bumps `post_count`. Per-URL failures isolated; zero-byte responses + HTTP errors surface as `{error}` entries without aborting the batch.
- `src/app/api/admin/media/resync/route.ts` — Orphan-blob recovery. Scans 8 prefix buckets (`media-library/`, `videos/`, `video/`, `premiere/`, `logos/`, `memes/`, `images/`, root) with cursor-paginated Vercel Blob `list`, diffs against `SELECT url FROM media_library`, re-INSERTs any missing rows with type inferred from extension. The `logo` heuristic (pathname contains "logo") prepends a `logo,` tag prefix — media_type stays `image` / `video` because the DB constraint doesn't allow `logo`. Per-prefix scan errors AND per-INSERT errors isolated so partial-success scans still make progress.
- 24 new tests (5 upload + 10 import + 9 resync):
  - **upload**: 401 auth, JSON pass-through to `handleUpload`, multipart `__json` parsing, `handleUpload` exception → 400, `onBeforeGenerateToken` returns expected allowed-types + 500 MB + addRandomSuffix via the token-opts capture hook.
  - **import**: 401 auth, 400 empty-urls, PNG/video/gif detection with blob path extension, persona_id → posts + post_count branch, no-persona → no posts branch, HTTP 404 per-URL isolation, zero-byte → error, fetch exception captured, whitespace-only URLs skipped silently.
  - **resync**: 401 auth, 500 missing BLOB_READ_WRITE_TOKEN, empty-case covers all 8 prefixes once, new/skipped/counts by type, logo tag prefix, prefix-level failure isolation, INSERT failure bumps errors + keeps going, deduplication across overlapping prefixes (`media-library/` and root prefix).
- Suite **1389/1389**, up from 1365.

**Verification gates:**
- `npx tsc --noEmit` — passing
- `npx vitest run` — passing (1389/1389)

**Design choices:**
- `@vercel/blob/client` mocked for the upload test — captured `onBeforeGenerateToken()` return value on a shared `upload.tokenOpts` field so we can assert the token-generation contract without real blob storage.
- `put()` mocked in the import test to return a deterministic `blob.test/{pathname}` URL — the real pathname shape (extension, `media-library/` prefix) is what we assert on.
- `list()` mocked in resync with a per-prefix page queue so cursor-paginated code path executes end-to-end across 8 prefixes even though each test provides zero or one page.

**Deferrals vs. legacy:**
- `@/lib/marketing/*` branches (`spreadArchitectContent` in admin/media + admin/media/save) — stays on legacy until the marketing lib ports.
- `/api/admin/media/save` — not ported here because its Architect auto-spread depends on the marketing lib.
- `ensureDbReady` / `safeMigrate` — schema assumed live.
- `SEED_PERSONAS` upsert in admin/media/save — defer with the save route.

**Next batch options (pick one):**
1. `director-movies` content lib — 1626-line lift. Unlocks screenplay, generate-news, generate-channel-video, extend-video, channels. Multi-session.
2. `marketing/*` libs — un-defers `spreadPostToSocial` on 6 routes + unlocks `spread`, `media` (main), `media/save`, `mktg`, `promote-glitchcoin`, `marketing-post`, `hatch`. Multi-session.
3. `elon-campaign` (~711) or `channels` admin (~666) — chunky single-ship.
4. Telegram bot engine — un-defers personality modes + content handlers. Multi-session.
5. `bestie-life` cron (282) — deps mostly ported; needs adaptation of old image-gen / generateVideoFromImage calls to new helpers.

---

### 2026-04-21 (session 74) — Phase 6 cron port (`/api/generate-videos`)

**Branch:** `claude/phase-7-admin-batch-25`

**Done:**
- New `src/app/api/generate-videos/route.ts` — premiere-trailer cron, the first text-to-video cron on the new repo.
  - POST picks 1..5 (default 1) random prompts from a 10-entry `VIDEO_PROMPTS` dictionary (OVERRIDE, FIRST LIGHT, SEASONS, SPROUT, CACHED, EMPLOYEE OF THE MONTH, GHOST PROTOCOL: ZERO, THE OBSERVER, PET SHOP AFTER DARK, WRITTEN IN RED — same ten as legacy). Each `submitVideoJob` call passes `duration:10, aspectRatio:"9:16", resolution:"720p", taskType:"video_generation"` — everything routed through the shared `"xai"` circuit breaker + cost ledger. Response: `{success, jobs:[{requestId, title, genre, tagline, prompt, error?}]}`. Per-movie submit failures isolated — the loop keeps going and tags the failed entry with the error.
  - Synchronous xAI video URLs (rare but handled in the helper) come back as `sync:{url}` request IDs. GET recognizes the `sync:` prefix and short-circuits straight to persist + post, skipping the poll.
  - GET `?id=&title=&genre=&tagline=` polls one job. On `done`, downloads the xAI video, uploads to `premiere/{genre}/{uuid}.mp4` via `put`, picks a random active persona, INSERTs `posts` (`post_type='premiere'`, `media_source='grok-video'`, hashtags `AIGlitchPremieres,AIGlitch{GenreCap}`, AI like count 100–399), bumps the persona's `post_count`. Handles `moderation_failed` / `expired` / `failed` / poll-exception / persist-exception / missing-video-url with distinct status codes the cron runner can switch on.
  - Both handlers gated by `requireCronAuth` — legacy's `checkCronAuth` equivalent in the new repo.
- 22 new tests split across POST + GET: auth (401), env guard (500), count default + clamping (0→1, 99→5), submit params (cinematic prefix, 10s/9:16/720p), sync URL handling, per-movie error isolation, returned job shape; GET 400-on-missing-id, sync: short-circuit + blob persist, still-pending, moderation blocked, done-with-videoUrl persists + hashtag + genre-cap in content, expired/failed passthrough, poll exception → status=error, no-active-personas → persist_failed, video download failure → persist_failed, default query params land in `/premiere/action/`.
- Suite **1365/1365**, up from 1343.

**Verification gates:**
- `npx tsc --noEmit` — passing
- `npx vitest run` — passing (1365/1365)

**Design choices:**
- Used `submitVideoJob` + `pollVideoJob` instead of inline xAI fetches — same pattern as spec-ads / animate-persona / hatch-admin. Route stays pure orchestration and gets the breaker + cost ledger for free.
- Static `VIDEO_PROMPTS` array preserved verbatim — the 10 trailers are baked into the feature, not AI-generated.
- `Math.random` used for shuffle + picking the random persona + ai_like_count — legacy parity, not worth a crypto-secure RNG for cosmetic fields.
- Replaced `v4 as uuidv4` with `randomUUID` — no new deps.
- Kept the `sync:{url}` request-id convention from legacy even though the new helper returns it as `syncVideoUrl`. The cron runner that calls POST stores the list of request IDs and later GETs each one — this convention lets sync completions flow through the SAME GET path as async ones without a separate "completed" store.

**Deferrals vs. legacy:**
- `spreadPostToSocial` — marketing lib still not ported; premieres stay on-platform. When marketing lib lands, this un-defers alongside chibify / persona-avatar / animate-persona / generate-persona.
- `ensureDbReady` / `safeMigrate` — schema assumed live on shared Neon.

**Next batch options (pick one):**
1. `director-movies` content lib — 1626-line lift. Unlocks `screenplay`, `generate-news`, `generate-channel-video`, `extend-video`, `channels`. Multi-session.
2. `marketing/*` libs — un-defers `spreadPostToSocial` on 6 already-ported routes (chibify / persona-avatar / animate-persona / generate-persona / spec-ads / generate-videos) + unlocks `spread`, `media`, `mktg`, `promote-glitchcoin`, `marketing-post`, `hatch`. Multi-session.
3. Phase 6 cron triage — a few more pure-DB / simple-dep cron jobs exist (e.g. `bestie-life` has most deps ported).
4. Admin route chunkiers — `elon-campaign` (~711), `channels` (~666).
5. Telegram bot engine — un-defers personality-mode overlays + content-surfacing handlers. Multi-session.

---

### 2026-04-21 (session 73) — Phase 7 dashboard aggregator (`/api/activity`)

**Branch:** `claude/phase-7-admin-batch-24`

**Done:**
- New `src/app/api/activity/route.ts` — the admin dashboard's data endpoint. Pure read-only GET, 12 parallel `Promise.all` base queries + 5 optional blocks:
  - **Base parallel block** (always runs): recent activity (30 posts with persona join), `persona_video_jobs` pending/completed (lifted into `safeQuery` fallbacks because table doesn't exist yet in new repo), product-shill ad stats (total + breakdown by source/media_type + 5 most recent), `lastPerSource` per-media-source max timestamp, hourly 24h post counts, currently-active persona (last persona-content-cron post), breaking-news counts (total + last hour), active daily topics.
  - **Director movies** (optional) — total / generating / last-at + 20 most recent movies. When movies are in `failed` or `generating` status, pulls clip-level diagnostics from `multi_clip_scenes` joined via `multi_clip_jobs` (elapsed minutes + fail_reason). Injects `director-movie` into `lastPerSource` when not already there.
  - **Activity throttle** — reads `platform_settings.activity_throttle`, defaults 100.
  - **Cron history** — last 50 `cron_runs` rows + latest run per cron. Hand-coerces durations, cost_usd, result, error.
  - **Cron trend** — hourly ok/error counts per cron over 7 days.
  - **Cron costs** — 24h + 7d cost sum + run counts per cron. Preserves legacy's `throttled24h` / `throttled7d` fields (will return 0 until cron throttling is reintroduced).
  - Static `cronSchedules` list at the bottom — 8 entries hard-coded for the UI's "expected schedule" table.
- `cron_runs.status` re-pointed to the new repo's `'ok' | 'error'` convention. Legacy wrote `'completed' | 'throttled' | 'failed'`, so the COUNT(*) FILTER expressions had to shift or those stat blocks would always be 0.
- Route is intentionally **unauthenticated** — matches legacy behavior. The admin UI at `/admin/activity` is behind the admin-auth cookie; locking the JSON endpoint would orphan the page. Documented on route header.
- 13 new tests: shape check with all-empty tables, `cronSchedules` length (8), ad breakdown coercion with null mediaType, full director-movie happy path + `lastPerSource` injection, director_movies missing → fallback, failed-movie clipDiagnostics attached, platform_settings missing → throttle 100, throttle reflects stored value, cron_runs missing → empty arrays, cron_runs present → coerced entries, cronCosts missing → empty, director-movie NOT duplicated in lastPerSource when already present, persona_video_jobs missing → empty pending/completed.
- Suite **1343/1343**, up from 1330.

**Verification gates:**
- `npx tsc --noEmit` — passing
- `npx vitest run` — passing (1343/1343)

**Design choices:**
- Extracted each optional block into its own helper (`fetchDirectorStats`, `fetchRecentMovies`, `fetchActivityThrottle`, `fetchCronHistory`, `fetchCronTrend`, `fetchCronCosts`). The legacy had everything inlined in one 250-line handler — the helpers are a drop-in split that makes the `GET` body ~60 lines of orchestration.
- Added a tiny `safeQuery(sql, promise)` helper for the two `persona_video_jobs` queries inside the `Promise.all` block — those tables aren't in the new repo's schema yet and without the fallback the whole endpoint would 500. All OTHER optional blocks get their own `try/catch` wrapper in their helper.
- `cron_runs.status` filters re-pointed to `'ok' | 'error'`. `throttled*` fields preserved in the response shape but will return 0 until throttling is re-introduced. UI continues to show them so no shape break.
- Dropped `ensureDbReady` — not ported in new repo; schema assumed live on shared Neon.

**Deferrals vs. legacy:**
- No `ensureDbReady` shim — legacy one-shot-per-Lambda migration helper not ported.
- `throttled*` cron stats — cron throttling not implemented in new `cronHandler`.

**Next batch options (pick one):**
1. `director-movies` content lib — 1626-line lift. Unlocks `screenplay`, `generate-news`, `generate-channel-video`, `extend-video`, `channels` (partial). Multi-session.
2. `marketing/*` libs — un-defers `spreadPostToSocial` on five routes + unlocks `spread`, `media`, `mktg`, `promote-glitchcoin`. Multi-session.
3. Phase 6 cron triage — `bestie-life` (282 lines; deps mostly ported — adapt old image-gen/video calls), cron adaptations, etc.
4. More small admin routes — `elon-campaign` (~711 lines), `channels` (~666). Single-ship possible but chunky.
5. Telegram bot engine port — un-defers the personality modes + content-surfacing command handlers. Multi-session.

---

### 2026-04-21 (session 72) — Phase 7 admin batch 23 (telegram re-register-bots)

**Branch:** `claude/phase-7-admin-batch-23`

**Done:**
- New `src/app/api/admin/telegram/re-register-bots/route.ts` — Telegram bot re-registration admin tool:
  - GET lists active persona bots (persona_id, bot_username, display_name, avatar_emoji) — response NEVER includes `bot_token`. Used by the admin UI to build a client-side per-bot progress loop so re-registrations don't lock the screen.
  - POST `{persona_id}` re-registers that single bot; returns 404 when missing. POST with empty body loops every active bot with 200ms spacing between `setWebhook` calls — kept for backwards compatibility with the old bulk button.
  - Per-bot flow: Telegram `setWebhook` → `{NEXT_PUBLIC_APP_URL}/api/telegram/persona-chat/{persona_id}` with `allowed_updates=["message","message_reaction"]` → `registerTelegramCommands(bot_token)` to refresh the slash-command menu. Per-bot errors surface in `details[]` + `errors` count without aborting the batch.
  - Extracted the per-bot logic into `reregisterOne()` so single and bulk modes share the same code path. Legacy had the loop inlined twice.
- New `src/lib/telegram/commands.ts` — minimal port of legacy `@/lib/content/telegram-commands`:
  - `TELEGRAM_COMMANDS_PRIVATE` — 14 commands including `/email` (Stuart's private outreach helper).
  - `TELEGRAM_COMMANDS_GROUP` — same list minus `/email` so group members can't see a Stuart-only command.
  - `registerTelegramCommands(botToken)` — pushes both scoped menus via Telegram's `setMyCommands`. Private-scope success is the overall return signal; group-scope failures are logged as warnings only.
  - Deferred from the legacy file: personality-mode overlay system (`PERSONALITY_MODES`, `getPersonaMode`, `setPersonaMode`, `getModeOverlay`) + content-surfacing command handlers (`/nft`, `/channel`, `/avatar`). These come along with the Telegram bot engine port.
- 19 new tests (4 commands-lib + 15 route): auth, env guard, single-bot 404, single-bot happy-path (`setWebhook` ok + commands registered, verified URL + body payload), single-bot setWebhook 4xx, single-bot fetch exception, bulk mode with mixed pass/fail (verified `updated` / `errors` / details array), bulk empty-list zero-count, empty-body routes-to-bulk, non-JSON body survives gracefully, commands-lib group-failure-is-warning, command-list length invariants.
- Suite **1330/1330**, up from 1311.

**Verification gates:**
- `npx tsc --noEmit` — passing
- `npx vitest run` — passing (1330/1330)

**Design choices:**
- Minimal `@/lib/telegram/commands` — just what this route needs. Personality-mode + content handlers stay in legacy until the Telegram bot engine port so we don't drag in `@/lib/marketplace` + `@/lib/telegram` send helpers.
- `NEXT_PUBLIC_APP_URL` read via `process.env` directly, not `@/lib/bible/env`. Matches the `solana-config.ts` access pattern already used in this repo.
- Webhook URL still `{appUrl}/api/telegram/persona-chat/{persona_id}` — the per-persona chat webhook is still on the legacy monolith. When it ports, `appUrl` just flips to the new domain.

**Deferrals vs. legacy:**
- Personality-mode overlay system — defer until Telegram bot engine port.
- Content-surfacing command handlers (`/nft`, `/channel`, `/avatar`) — same, plus they need marketplace + send helpers.
- Structured logging — cross-cutting pass deferred.

**Next batch options (pick one):**
1. `director-movies` content lib — 1626-line lift. Unlocks `screenplay`, `generate-news`, `generate-channel-video`, `extend-video`, `channels` (partial). Multi-session.
2. `marketing/*` libs — un-defers `spreadPostToSocial` on five already-ported routes + unlocks `spread`, `media`, `mktg`, `promote-glitchcoin`. Multi-session.
3. Phase 6 cron triage — pick 2–3 pure-DB cron jobs from the 21-job legacy fleet.
4. More small admin routes — `elon-campaign` (~711 lines), `channels` (~666), `hatchery` (marketing deps — skip until lib).
5. Telegram bot engine port — the big one that un-defers `/api/telegram/persona-chat/*` + the personality modes we just deferred. Multi-session.

---

### 2026-04-21 (session 71) — Phase 7 admin batch 22 (batch-avatars)

**Branch:** `claude/phase-7-admin-batch-22`

**Done:**
- New `src/app/api/admin/batch-avatars/route.ts` — batch persona-avatar backfill/refresh:
  - POST `{batch_size?, force?}` (clamped 1..10, default 5). Priority 1 = personas with `avatar_url IS NULL`, oldest first. Priority 2 = top-up from avatars >30 days old (or any when `force:true`), with the priority-1 IDs excluded.
  - Per pick: random art style from 20-entry `ART_STYLES` list → `generateImageToBlob` (1:1, `avatars/{uuid}.png`, `image_generation`) → UPDATE `avatar_url` + bump `avatar_updated_at` → `generateText` in-character announcement (with static fallback per first/refresh) → INSERT `posts` (`media_source='grok-aurora'`, hashtags `AIGlitch,NewProfilePic,AvatarUpdate`) + bump `post_count`.
  - Per-persona try/catch isolates failures — the batch continues.
  - GET returns `{total_active, missing_avatar, recently_updated, needing_update, message}` dashboard for the admin UI.
- Refactored the legacy `${sql\`...\` : sql\`\`}` embedded-fragment pattern into a plain helper `fetchRefreshCandidates(sql, limit, excludeIds, force)` that picks one of four concrete queries. Cleaner to read, and avoids a subtle Neon fragment-composition footgun where embedded `sql\`\`` invocations show up as extra calls under the test mock.
- 17 new tests: GET auth + dashboard (with-missing + all-current branches), POST auth / no-key / all-current / happy-path / batch_size clamp / per-persona failure isolation / priority-2 top-up / `force=true` / generateText failure fallback / auto-tag `#AIG!itch` / too-short AI output / quote-stripping / remaining-count wiring / refresh-announcement path.
- Suite **1311/1311**, up from 1294.

**Verification gates:**
- `npx tsc --noEmit` — passing
- `npx vitest run` — passing (1311/1311)

**Design choices:**
- Dropped the legacy `generateImage` OpenAI fallback — this repo is xAI-only (same policy as hatch-admin). Helper surfaces failures instead of falling back, and the try/catch around `generateImageToBlob` keeps the batch moving when xAI is unavailable for a given persona.
- Kept legacy `media_source='grok-aurora'` string for client parity even though we now go through `generateImageToBlob` → `grok-imagine-image` under the hood. The old feed UI keys on the source string; changing it would invalidate existing filters.
- `taskType: "image_generation"` — the `AiTaskType` union doesn't have a dedicated `avatar_generation` bucket, and avatar gen shares the xAI cost/budget pool with other image tasks anyway.
- `randomUUID()` from `node:crypto` — matches the rest of the ported admin routes.

**Deferrals vs. legacy:**
- OpenAI/fallback `generateImage` branch — xAI-only repo.
- `console.log` observability — cross-cutting structured-logging pass deferred.

**Next batch options (pick one):**
1. `director-movies` content lib — 1626-line lift. Unlocks `screenplay`, `generate-news`, `generate-channel-video`, `extend-video`, `channels` (partial). Multi-session.
2. `marketing/*` libs — un-defers `spreadPostToSocial` on chibify/persona-avatar/animate-persona/generate-persona/batch-avatars + unlocks `spread`, `media`, `mktg`, `promote-glitchcoin`. Multi-session.
3. Phase 6 cron triage — pick 2–3 pure-DB cron jobs from the 21-job legacy fleet.
4. More small admin routes — `init-persona` (Solana deps — Phase 8 locked, skip), `hatchery` (marketing deps — skip until marketing lib ported), `elon-campaign` (~711 lines), `channels` (~666 lines), `nfts` (Solana deps — Phase 8).

---

### 2026-04-21 (session 70) — Phase 7 admin batch 21 (generate-persona)

**Branch:** `claude/phase-7-admin-batch-21`

**Done:**
- New `src/app/api/admin/generate-persona/route.ts` — SSE-streaming manual post generator, first SSE route in the new repo:
  - POST `{persona_id, count?}` (count clamped 1..20, default 3). Returns `text/event-stream` via `ReadableStream`.
  - Events: `init`, `picked`, `generating`, `post_ready`, `reactions`, `error` (non-fatal, per-post), `done` (terminal with summary).
  - Per-post: `generatePost(persona, recentContext, dailyTopics)` → INSERT `posts` + bump `ai_personas.post_count` → `generateReactions` picks 5 other active AIs, rolls a weighted-random decision per reactor, performs like or comment.
  - Reactions: legacy `generateAIInteraction(reactor, {content, author_username})` returned a `"like"|"comment"|"ignore"` enum from an AI call. The new `generateAIInteraction` returns content, not a decision — so we replaced it with a weighted-random inline roll (30% like / 15% comment / 55% ignore) that preserves the legacy reaction cadence without the extra AI hop. Comments still go through `generateComment`.
- 17 new tests: auth, validation (400 on missing persona_id + bad JSON body), no-API-key error event, XAI-alone-is-enough guard, persona-not-found early stream termination, happy path (1-post event sequence), count clamping (0 → 1, 999 → 20), reactor like / comment / ignore branches (Math.random stubbed deterministic), generatePost failure → error step but loop continues, daily-topics DB failure swallowed (non-fatal), SSE headers, default count = 3, reactor comment-AI failure caught.
- Suite **1294/1294**, up from 1277.

**Verification gates:**
- `npx tsc --noEmit` — passing
- `npx vitest run` — passing (1294/1294)

**Design choices:**
- SSE implementation uses `new ReadableStream({async start(controller) {...}})` with a `send(event, data)` helper that `controller.enqueue`s `event: …\ndata: …\n\n` frames. The `finally` block calls `controller.close()` exactly once — the early-error branches just `return` instead of closing themselves, so we don't double-close.
- Dropped pre-emptive `controller.close()` calls in the error paths — let `finally` own the close. This is cleaner than the legacy pattern and avoids a `TypeError: Invalid state: Controller is already closed`.
- `randomUUID()` from `node:crypto` — matches the rest of the ported admin routes (no `uuid` dep).
- Accepts either `ANTHROPIC_API_KEY` or `XAI_API_KEY` — `generateText` under the hood will route to whichever provider is available, so we shouldn't hard-require one.

**Deferrals vs. legacy (documented on route):**
- `spreadPostToSocial` — marketing lib not ported; posts stay on-platform only.
- `ensureDbReady` / `safeMigrate` — one-shot-per-Lambda migration helper not ported; route assumes schema in place on shared Neon.
- Legacy's `generateAIInteraction` decision call — replaced with inline weighted-random roll (see reactions above). Preserves cadence, removes an AI call per reactor per post.

**Next batch options (pick one):**
1. `director-movies` content lib — 1626-line lift. Unlocks `screenplay`, `generate-news`, `generate-channel-video`, `extend-video`, `channels` (partial). Multi-session.
2. Port `marketing/*` libs (`platforms`, `content-adapter`, `spread-post`, `types`). Unblocks `spread`, `media`, `mktg`, `promote-glitchcoin` (4 routes) + un-defers `spreadPostToSocial` on chibify/persona-avatar/animate-persona/generate-persona. Multi-session.
3. Phase 6 cron triage — pick 2–3 pure-DB cron jobs from the 21-job legacy fleet.
4. More small admin routes — `batch-avatars` (adapt old `media/image-gen` to new helper), `init-persona`, `promote-glitchcoin` (if marketing libs deferred).

---

### 2026-04-21 (session 69) — Phase 7 admin batch 20 (animate-persona)

**Branch:** `claude/phase-7-admin-batch-20`

**Done:**
- New `src/app/api/admin/animate-persona/route.ts` — persona avatar image-to-video animator:
  - POST `{persona_id}` — loads persona, calls `generateText` for a 1-2 sentence animation brief (with local fallback if AI provider fails), submits video job with `sourceImageUrl=persona.avatar_url`, returns `requestId` for client polling.
  - POST `{persona_id, preview:true}` — short-circuits before the AI call and returns the concatenated prompt (for the admin UI's "preview" button).
  - GET `?id=REQUEST_ID&persona_id=X` — thin `pollVideoJob` wrapper. On `done` downloads the video, persists to `feed/{uuid}.mp4`, INSERTs `posts` row (`media_source='grok-animate'`, hashtags `AIGlitch,Animated`), bumps `ai_personas.post_count`. Handles `moderation_failed` / `expired` / `failed` / transient poll errors.
  - Handles the occasional synchronous video URL on submit (xAI sometimes returns it inline) — persists + posts immediately when that happens.
- First real consumer of the video helper's `sourceImageUrl` (image-to-video) branch. The helper's schema passes cleanly through without modification.
- 21 new tests covering: auth, env guard, validation, 404 / no-avatar / preview-mode short-circuit, happy-path submit with avatar, fallback-prompt on AI error, synchronous completion, submit error, GET state machine (pending / moderation / done / failed / expired / poll-error / download-fail).
- Suite **1277/1277**, up from 1256.

**Verification gates:**
- `npx tsc --noEmit` — passing
- `npx vitest run` — passing (1277/1277)

**Deferrals vs. legacy (documented on route):**
- `spreadPostToSocial` — marketing lib not ported; animation stays on-platform only.
- `injectCampaignPlacement` — ad-campaigns lib not ported; prompt goes straight to video helper.
- `console.log` observability on poll — dropped (cross-cutting structured-logging pass deferred).

**Next batch options (pick one):**
1. `director-movies` content lib — 1626-line lift. Unlocks `screenplay`, `generate-news`, `generate-channel-video`, `extend-video`, `channels` (partial). Multi-session, but the biggest remaining single unblock.
2. Port `marketing/*` libs (`platforms`, `content-adapter`, `spread-post`, `types`). Unblocks `spread`, `media`, `mktg`, `promote-glitchcoin` (4 routes) + lets us un-defer `spreadPostToSocial` on the already-ported chibify/persona-avatar/animate-persona routes. Also multi-session.
3. Phase 6 cron triage — pick 2–3 pure-DB cron jobs from the 21-job legacy fleet.
4. More small admin routes — `generate-persona` (needs only `content/ai-engine` + defer `spreadPostToSocial`), `batch-avatars` (adapt old `media/image-gen` to new helper).

---

### 2026-04-21 (session 68) — Phase 7 admin batch 19 (spec-ads)

**Branch:** `claude/phase-7-admin-batch-19`

**Done:**
- New `src/app/api/admin/spec-ads/route.ts` — brand-led 3-channel video teaser pipeline:
  - POST (no action) — picks 3 random channels from a 13-entry `CHANNEL_STYLES` dict (GNN News, Only AI Fans, AiTunes, Paws & Pixels, etc.), submits one `submitVideoJob` per channel (10s, 9:16, 720p), with 1.5s spacing to avoid xAI rate limits. Persists `spec_ads` JSONB row with per-clip `{request_id, status}` entries. Returns `{id, brand_name, product_name, folder, clips, status}`.
  - POST `action=poll` — thin wrapper around `pollVideoJob(requestId)`. On completion downloads + persists the clip to Vercel Blob under `{folder}/clip-{N}.mp4` and patches the `spec_ads.clips` JSONB array. Marks the row `done` when all 3 clips complete. Transient Grok errors → `{status:"pending"}` so the client keeps polling.
  - POST `action=delete` — removes a spec-ad row.
  - GET `action=list` / `action=status&id=X` — inspection endpoints.
- Table is lazily created (`CREATE TABLE IF NOT EXISTS spec_ads`) on every call — legacy safety while standalone migration tooling isn't in place.
- 25 new tests covering: auth (GET + POST 401s), list/status/unknown actions, validation (`brand_name` / `product_name` missing), `XAI_API_KEY` missing, happy path (3 submits + INSERT + UPDATE), single-clip submit failure isolated, delete happy + missing id, poll validation, poll transient error → pending, moderation block → failed, ready → download + blob + DB patch + all-done detection, ready without `spec_id` (no DB touch), failed/expired passthrough, still-pending passthrough.
- Suite **1256/1256**, up from 1231.

**Verification gates:**
- `npx tsc --noEmit` — passing
- `npx vitest run` — passing (1256/1256)

**Design choices:**
- Used `submitVideoJob` / `pollVideoJob` instead of inline xAI fetches — the helper already owns the circuit-breaker + cost-ledger bookkeeping and moderation handling, so the route is pure orchestration.
- `CREATE TABLE IF NOT EXISTS` kept inline: this is the legacy pattern for one-off admin tables that aren't in the main Drizzle schema. Will migrate to proper migration tooling in the Phase 10 cleanup.
- `randomUUID()` from `node:crypto` (no `uuid` dep) — matches the rest of the ported admin routes.

**Deferrals vs. legacy:**
- `ensureDbReady` / `safeMigrate` — not ported; assumed schema present on shared Neon.
- Legacy's `console.log` observability on poll — dropped (cross-cutting structured-logging pass deferred).

**Next batch options (pick one):**
1. `generate-channel-video` + `extend-video` pair — both need the `director-movies` content lib ported first (DIRECTORS, CHANNEL_VISUAL_STYLE, CHANNEL_BRANDING, `generateDirectorScreenplay`, `submitDirectorFilm`). Multi-session — lib port + routes.
2. `director-movies` content lib solo — the biggest remaining unblock, 1626-line lift. Unlocks `screenplay`, `generate-news`, `generate-channel-video`, `extend-video`, `channels` (partial).
3. Phase 6 cron triage — pick 2–3 pure-DB cron jobs from the 21-job legacy fleet.
4. More small admin routes — `promote-glitchcoin`, `generate-persona`, `init-persona`, `batch-avatars` are still candidates (dependency-scout each).

---

### 2026-04-21 (session 67) — Phase 7 admin batch 18 (hatch-admin)

**Branch:** `claude/phase-7-admin-batch-18`

**Done:**
- New `src/app/api/admin/hatch-admin/route.ts` — full-stack persona-hatching pipeline that exercises all three AI-engine legs (text + image + video) in a single route:
  - **Step 1** — `generateText` with a JSON-requesting prompt (Claude/Grok routed via the existing 85/15 weighted provider split) → parsed as `HatchedBeing`. Validates all 8 required fields; returns 500 if any missing.
  - **Step 2** — `generateImageToBlob` (1:1 aspect, `avatars/meatbag-{uuid}.png`). Non-fatal.
  - **Step 3** — `generateVideoToBlob` (9:16, 10-second clip, `hatching/meatbag-{uuid}.mp4`). Polling capped at 24 × 10s = 240s to leave headroom inside the 300s Vercel lambda limit. Non-fatal — if xAI polling runs long the video is skipped and the persona still hatches with text-only media.
  - **Step 4** — INSERT `ai_personas` (abort-on-failure). 409 short-circuit if `owner_wallet_address` already owns a persona.
  - **Step 5** — `awardPersonaCoins(1,000)` starter grant. Non-fatal.
  - **Step 6** — INSERT `posts` first-words announcement. Uses video media when video generation succeeded, text otherwise.
- Per-step `steps[]` array in the response (`in_progress` → `completed` | `skipped`) — matches legacy UI contract.
- GET lists meatbag-owned personas (`owner_wallet_address IS NOT NULL`, newest first).
- 16 new tests covering: auth, validation, 409 duplicate wallet, AI-gen failures (throws + non-JSON + missing fields), full happy path + 4 degraded-happy variants (avatar fail, video fail, coins fail, first-post fail), abort-on-persona-save fail, custom-mode prompt threading, random-mode directive, GET list shape.
- Suite **1231/1231**, up from 1215.

**Verification gates:**
- `npx tsc --noEmit` — passing
- `npx vitest run` — passing (1231/1231)

**First end-to-end stress-test on the video helper:**
- `hatch-admin` is the first consumer of `generateVideoToBlob`. Tightening `maxAttempts` to 24 (from the helper default of 90) was necessary — the helper's default 15-min ceiling exceeds Vercel's 300s lambda timeout. Tuning suggestion validated the helper's `maxAttempts` override design.
- The non-fatal video branch matches the legacy "try/catch → null → skip" behaviour exactly. No callers today need the video to block the response.

**Deferrals vs. legacy (documented on route):**
- `ensureDbReady` / `safeMigrate` — new repo uses standalone migration tooling; route assumes schema is already in place on the shared Neon instance.
- OpenAI / Kie.ai fallbacks for image + video — aiglitch-api is xAI-only. Surfaces failures instead of falling back.

**Next batch options (pick one):**
1. `generate-channel-video` + `extend-video` pair — both exercise `submitVideoJob` (not `generateVideoToBlob`) because the generation timeline exceeds lambda limits. Route-side polling pattern. Larger batch, but the last two video-using admin routes.
2. `director-movies` content lib (1626 lines) — unlocks `screenplay` + `generate-news`.
3. Phase 6 cron triage — pick 2–3 pure-DB jobs from the 21-job legacy fleet.
4. Phase 4 bestie iOS glue — 6 routes unblocked since AI engine shipped.

---

### 2026-04-21 (session 66) — Phase 5 video-gen helper

**Branch:** `claude/phase-5-video-gen-helper`

**Done:**
- New `src/lib/ai/video.ts` — xAI video-generation helper mirroring the image-helper pattern, but built around xAI's async/polling job model:
  - `submitVideoJob({ prompt, taskType, duration?, aspectRatio?, resolution?, sourceImageUrl? })` → `{ requestId, syncVideoUrl?, model, estimatedUsd, durationSec }`. POSTs `/videos/generations`. Handles the occasional synchronous response (video URL on submit) alongside the normal async `request_id` flow.
  - `pollVideoJob(requestId)` → `{ requestId, status, videoUrl?, respectModeration? }`. Single GET `/videos/{id}`. Status enum: `pending` / `done` / `failed` / `expired`.
  - `generateVideo(opts & { pollIntervalMs?, maxAttempts? })` → `{ videoUrl, requestId, model, estimatedUsd, durationSec }`. Submit + poll-to-completion. Defaults: 10s interval × 90 attempts = 15 min ceiling (matches legacy). Throws on `failed` / `expired` / moderation-block / missing URL / max-attempts timeout.
  - `generateVideoToBlob(opts & { blobPath, contentType? })` → `{ blobUrl, requestId, model, estimatedUsd, durationSec, sizeBytes }`. One-shot for routes that don't need to expose a `requestId` to the client.
- Pricing: `$0.05 / second` flat (`VIDEO_COST_PER_SECOND_USD`). Booked at submit time (not completion) — matches legacy. 10s default duration → $0.50 per clip.
- Circuit breaker + cost ledger: shared `"xai"` provider key with text + image. Cost ledger `task_type=video_generation` (new `AiTaskType` variant). Fire-and-forget logging, `inputTokens=0/outputTokens=0`.
- Image-to-video: `sourceImageUrl` maps to xAI's `image_url` request field (used by `extend-video`'s last-frame-to-clip flow and `hatch-admin`'s avatar-to-hatch-video flow).
- Routes that want to return a `requestId` to the client (`generate-channel-video`, `extend-video` when async) call `submitVideoJob` + `pollVideoJob` directly; one-shot flows (`hatch-admin`) use `generateVideoToBlob`.
- 20 new tests (submit × 6, poll × 3, generateVideo × 7, generateVideoToBlob × 3, helper paths × 1). Uses queued fetch mock + stubbed `@vercel/blob`; real circuit-breaker + cost-ledger modules (fail-open with no Redis/DB).
- Suite **1215/1215**, up from 1195.

**Verification gates:**
- `npx tsc --noEmit` — passing
- `npx vitest run` — passing (1215/1215)

**Design decisions (locked):**
- **One breaker for xAI**: text + image + video share the `"xai"` key. A video failure can trip the circuit for text generation. Accepted trade-off; simpler than per-modality breakers.
- **Submit-time cost booking**: xAI bills even if the video later fails / expires (the compute already ran). Charge at submit, not on completion. Matches legacy accounting.
- **No Kie.ai fallback**: legacy routes fall back to Kie.ai on 401/403/429 from xAI. aiglitch-api is xAI-only by policy — if Grok is down, the route surfaces the failure. Documented on the helper + deferred for the consuming routes.
- **Polling is caller-driven, not fire-and-forget**: the helper blocks until done / failed / expired. Routes that can't hold a 15-minute connection (Vercel lambda timeout is 300s max) must use `submitVideoJob` + their own polling UI. Documented in the header.

**Unlock status:**
- 🔓 `generate-channel-video` — now portable. Uses `submitVideoJob` + poll from client UI via a separate GET endpoint (existing pattern).
- 🔓 `extend-video` — now portable. Frame-capture via existing image helper; scene-submission via this helper.
- 🔓 `hatch-admin` — now portable. Full pipeline: Claude (persona JSON) + `generateImageToBlob` (avatar) + `generateVideoToBlob` (hatching video).

**Next batch options (pick one):**
1. Port `hatch-admin` solo — one route, three AI engine legs exercised (Claude text + Grok image + Grok video). Tight scope, real end-to-end check on the video helper.
2. Port `generate-channel-video` + `extend-video` pair — both exercise `submitVideoJob` + polling. Larger batch but related.
3. Port `director-movies` content lib — still the biggest non-video unblock (1626 lines, unlocks `screenplay` + `generate-news`).
4. Phase 6 cron triage — pick 2–3 pure-DB cron jobs from the 21-job legacy fleet.

---

### 2026-04-21 (session 65) — Phase 7 admin batch 17 (grokify-sponsor + generate-og-images)

**Branch:** `claude/phase-7-admin-batch-17`

**Done:**
- New `src/app/api/admin/grokify-sponsor/route.ts` — sponsor-placement image editor. POST builds the source-image set from `grokifyMode` (`all`/`logo_only`/`images_only`; `isOutro=true` forces logo into first-position regardless of mode), caps at 5 images, and either hits xAI `/images/edits` (when sources present) or `/images/generations` (when none, with a distinct subliminal-placement fallback prompt built from `visualPrompt`). On multi-image edit failure, retries once with just the first image — matches legacy behaviour (xAI is stricter about total edit payload size). Persistent path: `sponsors/grokified/{brand}-{channel}-{scene\|outro}-{id}.png`. Response preserves legacy shape: `{ grokifiedUrl, brandName, productName, mode, retried? }` or `{ grokifiedUrl: null, error }`.
- New `src/app/api/admin/generate-og-images/route.ts` — bulk generator for the 21 Open Graph banners used on channel pages. GET returns an iPad-friendly HTML dashboard (buttons per image + "Generate All"; cost quote derived from pro pricing × 21). POST = batch (no body) or single (`{ file }`). Deterministic blob path `og/{file}.png` keeps public `<meta>` URLs stable across regenerations. Pro model + 16:9 to hit the 1200×630 OG spec. Error isolation per image — one failure doesn't stop the batch.
- 21 new tests (13 grokify-sponsor + 8 generate-og-images).
- Suite **1195/1195**, up from 1174.

**Verification gates:**
- `npx tsc --noEmit` — passing
- `npx vitest run` — passing (1195/1195)

**Image-helper coverage milestone:**
- `grokify-sponsor` is the first real route to drive the `/images/edits` branch (via `sourceImageUrls`). With this batch, **all three paths** of `generateImageToBlob` are now exercised by production routes: text-to-image (merch, nft-marketplace, chibify, persona-avatar, og-images) + image-edit (grokify-sponsor) + aspect-ratio passthrough (persona-avatar 1:1, og-images 16:9, grokify-sponsor 9:16).

**Deferrals (intentional, documented on the route):**
- Grokify-sponsor drops the legacy console.log observability — we'll add structured logging as a later cross-cutting pass.
- The legacy "single-image retry on multi-image failure" ships verbatim; legacy also had a second-level "any-fail → return null" that's preserved. No new retry layers added.

**Next admin batch options (pick one):**
1. Start a video-gen helper in `@/lib/ai/video.ts` — mirrors the image-helper pattern. xAI Grok-2 video API + Blob download. Unlocks `generate-channel-video`, `extend-video`, and the video half of `hatch-admin` (3+ routes). No route ships this batch, but the next one becomes trivial.
2. Port `director-movies` content lib — 1626-line lift. Unlocks `screenplay` + `generate-news` (2 routes) + unblocks any future screenplay-related work.
3. Tackle a tight auth/OAuth batch — scan for small admin routes not gated by helpers (wallet-auth / init-persona are trading-locked per §Trading; any non-trading candidates?).
4. Start Phase 6 cron fleet triage — pick 2–3 simple cron jobs (no image/video gen) and ship them as a cohort.

---

### 2026-04-21 (session 64) — Phase 7 admin batch 16 (persona-avatar + chibify)

**Branch:** `claude/phase-7-admin-batch-16`

**Done:**
- New `src/app/api/admin/persona-avatar/route.ts` — admin avatar override. POST → `generateImageToBlob` (Grok Aurora Pro 1:1) → UPDATE `ai_personas.avatar_url` + `avatar_updated_at` → optional in-character announcement via `generateText` + INSERT `posts` + bump `post_count`. Local template fallback when text gen fails (matches legacy behaviour). 400/404 on missing persona_id / persona not found. Returns `{ success, avatar_url, source: "grok-aurora", posted_to_feed, post_id, admin_override: true }`.
- New `src/app/api/admin/chibify/route.ts` — batch chibify. GET `?persona_id=X` previews the chibi prompt. POST `{ persona_ids: string[] }` loops with per-persona error isolation: rejects on no-avatar, persona-not-found, generic errors — each captured in the `results` array without breaking the loop. Happy personas get `chibi/{uuid}.png` Blob + INSERT `posts` (hashtags `AIGlitch,MadeInGrok,Chibi,ChibiArt,Kawaii`, `media_source='grok-aurora'`) + `post_count` bump.
- 21 new tests (9 persona-avatar + 12 chibify).
- Suite **1174/1174**, up from 1153.

**Verification gates:**
- `npx tsc --noEmit` — passing
- `npx vitest run` — passing (1174/1174)

**Deferrals (intentional, documented on the route):**
- Both routes skip `injectCampaignPlacement` — `@/lib/ad-campaigns` not ported yet.
- Chibify skips `spreadPostToSocial` + `logImpressions`. Feed post runs; external platform mirroring deferred until `@/lib/marketing/spread-post` lands.
- Persona-avatar skips the non-xAI image-gen fallback pipeline. aiglitch-api exposes Grok only; if the helper throws, the route returns 500 (legacy fell back to OpenAI DALL-E).

**Validation of the image-gen helper on real routes:**
- Both routes call `generateImageToBlob({ model: "grok-imagine-image-pro", aspectRatio: "1:1" })` — first real usage of the Pro model and the `aspectRatio` passthrough. Helper tests already cover both paths; these route tests confirm the wiring.

**Next admin batch options (pick one):**
1. `grokify-sponsor` — exercises the `/images/edits` branch via `sourceImageUrls` with a text-to-image fallback. Last untested branch of the image-gen helper. Solo-or-pair candidate.
2. `generate-og-images` — bulk OG-image generation for persona pages. Pure text-to-image; pairs well with something else.
3. Port `director-movies` content lib + flip `screenplay` + `generate-news` — big lift but unlocks 2 routes + unblocks further screenplay-related work.
4. Start a video-gen helper in `@/lib/ai/` — mirrors this batch's image-helper pattern. Unlocks `generate-channel-video`, `extend-video`, plus the video half of `hatch-admin`.

---

### 2026-04-21 (session 63) — Phase 5 image-gen helper + flip merch + nft-marketplace

**Branch:** `claude/phase-7-ai-image-gen-helper`

**Done:**
- New `src/lib/ai/image.ts` — shared xAI image-generation helper mirroring the text-completion pattern (`xaiComplete`, `claudeComplete`, `generateText`). Two entry points:
  - `generateImage({ prompt, taskType, model?, aspectRatio?, sourceImageUrls? })` → `{ imageUrl, model, estimatedUsd }`. Low-level primitive. Returns the ephemeral xAI URL (caller decides how to persist).
  - `generateImageToBlob({ ..., blobPath, contentType? })` → `{ blobUrl, model, estimatedUsd }`. Generates + downloads + uploads to Vercel Blob in one shot. Blob path is used verbatim (no random suffix), so UPSERT flows work cleanly.
- Circuit breaker + cost ledger parity with text:
  - Uses the shared `"xai"` breaker key (one provider, one circuit). Image failures trip the same breaker as text — accepted trade-off for operational simplicity.
  - Cost tracking is flat per image: `grok-imagine-image` = $0.02, `grok-imagine-image-pro` = $0.07. Fire-and-forget `logAiCost` with `inputTokens=0`, `outputTokens=0`.
  - New `AiTaskType` variant: `"image_generation"`.
- Endpoint support:
  - `/images/generations` — default text-to-image.
  - `/images/edits` — automatic when `sourceImageUrls` is set (forward-compat for `grokify-sponsor` edit path).
- **Flipped 501 deferrals:**
  - `/api/admin/merch` generate action — now calls `generateImageToBlob`, INSERTs `merch_library` with `source='generate'`. New validations: 400 when `prompt` missing. Blob path: `merch/designs/{uuid}.png`.
  - `/api/admin/nft-marketplace` generate action — now calls `generateImageToBlob`, UPSERTs `nft_product_images` on `product_id`. Prompt template + blob path `marketplace/{product_id}-{slug}.png` copied verbatim from legacy.
- 16 new tests (11 image helper + 5 new generate-action tests across the two routes; 4 old 501-deferral tests replaced with working-flow equivalents).
- Suite **1153/1153**, up from 1137.

**Verification gates:**
- `npx tsc --noEmit` — passing
- `npx vitest run` — passing (1153/1153)

**Test-design notes:**
- Image helper tests use the real circuit-breaker + cost-ledger modules (fail-open when Redis/Neon unset) + a queued fetch mock + stubbed `@vercel/blob` — integration-style coverage of the happy + error paths (non-OK status, missing URL, failed download).
- Route tests mock `@/lib/ai/image` directly; the helper's internals are already covered by `image.test.ts`, so route tests stay focused on SQL shape + blob-path construction + error propagation.

**Unlock status:**
- ✅ `merch` generate (done)
- ✅ `nft-marketplace` generate (done)
- 🔓 **Next to flip** (helper is ready, route ports still pending): `persona-avatar`, `chibify`, `grokify-sponsor`, `generate-og-images`, `hatch-admin`, `generate-channel-video` (the last two need a matching video-gen helper — image alone doesn't unblock them).

**Next admin batch options (pick one):**
1. Port 2–3 of the now-unblocked image-only admin routes: `persona-avatar` + `chibify` (both: prompt → image → Blob → persona column update). Clean batch.
2. Port `grokify-sponsor` — uses the `/images/edits` path (`sourceImageUrls`) with a text-to-image fallback. Good real-world workout for the helper.
3. Port the full `director-movies` content lib (unlocks `screenplay` + `generate-news`).

---

### 2026-04-21 (session 62) — Phase 7 admin batch 15 (solo)

**Branch:** `claude/phase-7-admin-batch-15`

**Done:**
- New `src/app/api/admin/nft-marketplace/route.ts` — per-product image catalogue on `nft_product_images` (lazy `ensureTable()`). **GET is public** (legacy parity: product images are rendered on the marketplace page). POST is admin-gated: `{ action: "delete", product_id }` deletes the row; default action (generate image via xAI + upload to Blob + UPSERT) **returns 501** — same Phase 5 image-gen deferral as `merch`'s generate action. Unblocks when a shared image-gen helper lands in `@/lib/ai/`.
- 9 new tests. Suite **1137/1137**, up from 1128.

**Verification gates:**
- `npx tsc --noEmit` — passing
- `npx vitest run` — passing (1137/1137)

**Why solo this batch:**
- `screenplay` and `generate-news` both need the full 1626-line `@/lib/content/director-movies` (new repo has the 68-line data stub only — needs a dedicated lib port before either route can move).
- `generate-persona` uses SSE streaming + `spreadPostToSocial` (not ported — `@/lib/marketing/platforms` only exports `getAccountForPlatform`). Non-trivial refactor, not a parallel batch port.
- Every other unported admin route either needs image-gen helpers (`persona-avatar`, `generate-og-images`, `chibify`, `grokify-sponsor`, `hatch-admin`) or touches trading/Solana (`wallet-auth`, `nfts`, `init-persona`, `token-metadata`, `promote-glitchcoin`). Pairing `nft-marketplace` with an unhealthy candidate was the wrong trade — honesty in scope over batch rhythm.

**Next admin batch options (pick one):**
1. Port an xAI image-gen helper into `@/lib/ai/` (Aurora + cost-ledger + circuit-breaker integration). Meta-unlock: flips `merch`/`nft-marketplace`'s deferred generate actions from 501 → working, and makes `persona-avatar` + `chibify` + `grokify-sponsor` + `generate-og-images` portable in one swing.
2. Port the full `director-movies` content lib. Unlocks `screenplay` + `generate-news`.
3. Harvest remaining small/pure-DB pieces (if any surface on a re-scan) and ship a miscellaneous batch.

---

### 2026-04-21 (session 61) — Phase 7 admin batch 14

**Branch:** `claude/phase-7-admin-batch-14`

**Done:**
- New `src/app/api/admin/blob-upload/route.ts` — Vercel Blob ingestion + listing. GET default lists video blobs across `VALID_FOLDERS` (news/, premiere/<genre>/, campaigns/); `?action=share_grokified` scans `sponsors/grokified/` and INSERTs new `posts` rows (persona `glitch-000`, `post_type='product_shill'`) with post_count bump; `?action=organize_sponsors` ports the one-shot legacy sponsor-image migration helper verbatim (source URLs still point at the legacy Blob store — no-op on fresh env, kept for parity). POST multipart FormData upload to `{folder}/{cleanName}` (no random suffix — genre detection relies on path). PUT copy-from-URL (single or `copies[]`), download → reupload with source Content-Type.
- New `src/app/api/admin/merch/route.ts` — Merch Studio CRUD on `merch_library` (lazy `ensureTable()`). GET `?action=list` (default, 500 newest) / `?action=videos` (clamped `?limit`, joined with `ai_personas`). POST dispatches `capture` (data-URL frame → Blob `merch/captures/{id}.{ext}` + INSERT), `update` (partial label/category), `delete` (best-effort Blob del + DB delete — legacy parity). **`generate` stubbed to 501** — legacy calls xAI `grok-imagine-image`; image generation is not yet in `@/lib/ai/` (text-only today). The other 4 actions are fully ported; `generate` unblocks when a shared image-gen helper lands (mirrors the `users?action=recover_orphans` deferral pattern).
- New dep `@vercel/blob` — first use in this repo; unblocks every future blob-touching admin route (nft-marketplace, persona-avatar, generate-og-images, etc.).
- New helper in tests: multipart FormData body must be serialised and its Content-Type forwarded explicitly to `NextRequest` (the wrapper otherwise drops undici's auto-set boundary). Pattern captured in `blob-upload/route.test.ts` → reusable for any future multipart admin route.
- 34 new tests (17 blob-upload + 17 merch).
- Suite **1128/1128**, up from 1094.

**Verification gates:**
- `npx tsc --noEmit` — passing
- `npx vitest run` — passing (1128/1128)

**Scoping notes (from this session):**
- Reviewed every unported admin route. **Zero remaining pure-DB admin routes** — they all hit one of three gates: (a) needs `@vercel/blob` (this batch addresses the first two); (b) needs image/video generation helpers not yet in `@/lib/ai/`; (c) touches trading/Solana (§Trading gate). Next admin batch either waits for image-gen helpers or is scoped tightly to non-AI, non-trading blob routes (nft-marketplace GET is next candidate — blob-only product images, guarded DELETE).
- `set-bot-token` — does not exist as a standalone legacy route (checked during scoping). Bot tokens are managed inside `persona_telegram_bots` via other admin UI.
- `hatch-admin` — deferred. Multi-step AI pipeline (xAI Aurora image + Grok video + Claude JSON generation + `awardPersonaCoins`); image/video helpers not yet available.
- `token-metadata` — trading-locked (TREASURY_PRIVATE_KEY + METADATA_AUTHORITY_*). Requires explicit per-endpoint written confirmation per SAFETY-RULES §Trading.

---

### 2026-04-20 (session 47) — Phase 6 Telegram crons

**Branch:** `claude/phase6-telegram-crons`

**Done:**
- New `src/lib/telegram.ts` — `sendMessage(botToken, chatId, text)` (native fetch, no SDK) + `getAdminChannel()` (reads `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHANNEL_ID`). Silent null return when env vars absent — safe in preview deployments.
- New `generateTelegramMessage` in `src/lib/ai/generate.ts` — standalone in-character persona post, `telegram_message` task type (added to `AiTaskType` union).
- New `src/app/api/telegram/credit-check` (GET/POST) — every 30 min. Checks AI daily spend (`ai_cost_log`) and low sponsor balances; sends alert if either trips threshold. No alert when Telegram not configured.
- New `src/app/api/telegram/status` (GET/POST) — every 6 hours. Sends active-persona count, posts-today count, last-5 cron_runs summary, and 24h error count to admin channel.
- New `src/app/api/telegram/persona-message` (GET/POST) — every 3 hours. Queries `persona_telegram_bots JOIN ai_personas`, generates + sends message per active bot. Per-bot error isolation (one failure doesn't abort the run).
- `vercel.json` — 3 new cron schedules added.
- 23 new tests (6 telegram lib + 6 credit-check + 6 status + 5 persona-message).
- Suite **626/626**, up from 608.

**Verification gates:**
- `npx tsc --noEmit` — passing
- `npx vitest run` — passing (626/626)

**Env vars needed in Vercel (optional — routes degrade gracefully without them):**
- `TELEGRAM_BOT_TOKEN` — admin bot token
- `TELEGRAM_CHANNEL_ID` — admin alert channel ID

---

### 2026-04-20 (session 46) — Phase 6 cron infrastructure + sponsor-burn

**Branch:** `claude/review-master-rules-YLOHK`

**Done:**
- New `src/lib/cron-auth.ts` — `requireCronAuth(request)` returns null on success or a 401/500 NextResponse on failure. Uses `timingSafeEqual` to compare `Authorization: Bearer <CRON_SECRET>`. Pattern: `return requireCronAuth(request) ?? ...rest`.
- New `src/lib/cron-handler.ts` — `cronHandler(name, fn)` wrapper that: (1) runs `CREATE TABLE IF NOT EXISTS cron_runs` once per Lambda instance; (2) INSERTs a `status='running'` row; (3) awaits fn; (4) UPDATEs to `status='ok'` with `duration_ms` + `result` JSONB, or `status='error'` with `error` text + re-throws. Returns fn result merged with `_cron_run_id`.
- New `src/app/api/sponsor-burn/route.ts` (POST) — daily cron: SELECT active sponsors with `glitch_balance > 0`, deduct 100 GLITCH each, suspend on zero. Wrapped in `cronHandler`. Auth via `requireCronAuth`.
- 14 new tests across 3 test files (5 cron-auth + 4 cron-handler + 5 sponsor-burn).
- `vercel.json` updated with `"crons": [{ "path": "/api/sponsor-burn", "schedule": "0 0 * * *" }]`.
- Suite **603/603**, up from 589.
- `CRON_SECRET` confirmed added to Vercel env vars by user.

**Verification gates:**
- `npx tsc --noEmit` — passing
- `npx vitest run` — passing (603/603)

**NOTE:** `DAILY_BURN = 100` is a placeholder constant — verify the exact burn rate against the legacy `aiglitch` repo before enabling the cron in production.

---

### 2026-04-20 (session 45) — Phase 4 partner routes

**Branch:** `claude/review-master-rules-YLOHK`

**Done:**
- `getConversationInfo(sessionId, personaId)` added to `src/lib/repositories/conversations.ts` — read-only lookup (no create side-effect), returns `{id, last_message_at, message_count}` or null.
- New `src/lib/repositories/partner.ts` — two helpers:
  - `registerPushToken(sessionId, token, platform)` — UPSERT into `device_push_tokens`. Runs `CREATE TABLE IF NOT EXISTS` once per Lambda instance (module-level flag) since this table is new to this repo. On conflict (same token) refreshes session_id + platform + updated_at.
  - `getBriefingData(sessionId)` — three sequential queries: `human_subscriptions` COUNT, `notifications` unread COUNT, and a conversations+personas JOIN with correlated last-message subqueries. Returns `{followed_count, unread_notifications, conversations[]}`.
- New `src/app/api/partner/push-token/route.ts` (POST) — validates body, calls `registerPushToken`, returns `{success: true}`.
- New `src/app/api/partner/bestie/route.ts` (GET) — looks up persona (404 if missing), calls `getConversationInfo` (null if no conversation yet), returns `{persona, conversation}`.
- New `src/app/api/partner/briefing/route.ts` (GET) — calls `getBriefingData`, returns the aggregated briefing object.
- 19 new tests across 3 test files (7 push-token + 5 bestie + 7 briefing).
- Suite **589/589**, up from 570.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (589/589)
- `npm run build` — passing; all 3 routes registered as dynamic

**Phase 4 progress:** 4 of 7 routes done. Remaining: `/api/bestie-health`, `/api/hatch`, `/api/hatch/telegram`. These need DB schema confirmation before building — `bestie_health` table is not in the documented 88-table schema, and `/api/hatch` logic is too complex to infer safely.

---

### 2026-04-20 (session 44) — /api/messages (bestie chat)

**Branch:** `claude/review-master-rules-YLOHK`

**Done:**
- New `src/lib/repositories/conversations.ts` — `getOrCreateConversation` (idempotent on session_id+persona_id), `getMessages` (windowed by limit, returned chronological asc), `addMessage` (INSERT + bump `last_message_at`), `touchConversation` (mark-as-seen).
- New `getById(personaId)` on `repositories/personas.ts` — full row, cached 60s same as `getByUsername`.
- New `generateBestieReply` on `lib/ai/generate.ts` — bestie-tone system prompt (`AI bestie` framing), feeds last 10 messages of conversation history into the user prompt, taskType `bestie_chat`. Capped to 320 tokens.
- New `src/app/api/messages/route.ts` (GET + POST + PATCH):
  - **GET** `?session_id=X&persona_id=Y` → `{conversation_id, persona, messages}`. Empty messages on a brand-new chat. 404 when persona missing, 400 on missing params.
  - **POST** `{session_id, persona_id, content}` → `{user_message, ai_message}`. Trims content + truncates to 2000 chars. Saves user message **first** so it's never lost; if AI throws or returns empty, returns `{user_message, ai_message: null, ai_error}` at status 200 — the consumer renders the user msg and shows an error toast for the missing reply.
  - **PATCH** `{session_id, persona_id}` → `{success, conversation_id}`. Touches `last_message_at` to NOW().
  - All responses: `Cache-Control: private, no-store`.
- 36 new tests (5 generateBestieReply + 9 conversations repo + 22 route).
- Suite **570/570**, up from 534.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (570/570)
- `npm run build` — passing; `/api/messages` registered as dynamic

**Phase 4 progress:** 1 of 7 routes done. Remaining: `/api/bestie-health`, `/api/partner/bestie`, `/api/partner/briefing`, `/api/partner/push-token`, `/api/hatch`, `/api/hatch/telegram`. All need more spec digging — none documented in detail in the handoff docs.

---

### 2026-04-20 (session 43) — /api/interact AI auto-reply trigger

**Branch:** `claude/review-master-rules-YLOHK`

**Done:**
- New `triggerAIReply(opts)` exported from `src/lib/repositories/interactions.ts`.
  - Guards: skips if `parentCommentId` is set (replies-to-replies never trigger a chain); skips if `Math.random() >= 0.30` (30% probability).
  - On roll success: SELECTs post + persona, calls `generateReplyToHuman`, INSERTs a `posts` row with `post_type='ai_comment'` and `is_reply_to=postId`, INSERTs an `ai_reply` notification for the human session, and awards 5 GLITCH to the persona via `awardPersonaCoins`. All wrapped in a top-level try/catch — errors are swallowed (fire-and-forget contract).
  - `COIN_REWARDS.aiReply = 5` added to the constants block.
- `src/app/api/interact/route.ts`: wired `void triggerAIReply(...)` after `addComment` returns, replacing the `// TODO(Slice 4)` comment. Import added.
- `src/app/api/interact/route.test.ts`: added `vi.mock("@/lib/ai/generate")` guard at module level; 2 new tests (response unaffected by async trigger, trigger skips on reply comments).
- New `src/lib/repositories/interactions.test.ts`: 10 direct unit tests for `triggerAIReply` (probability gate, parent skip, post-not-found exit, empty-reply exit, SQL shapes, error swallowing, bio/persona_type forwarding).
- Suite now **534/534**, up from 522.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (534/534)

**What this unlocks:** `/api/interact` is now fully migrated (all 9 actions + AI auto-reply). Consumer flip candidate — no remaining blockers.

---


### 2026-04-20 (session 42) — Phase 5 AI engine

**Branch:** `claude/review-master-rules-YLOHK`

**Done:**
- New `src/lib/ai/types.ts` — shared types: `AiProvider`, `AiTaskType`, `AiCompletionRequest`, `AiCompletionResult`.
- New `src/lib/ai/xai.ts` — OpenAI-compatible client pointed at `https://api.x.ai/v1`, model `grok-3`. Cost: $3/M input, $15/M output. Lazy singleton with `__resetXaiClient` test helper.
- New `src/lib/ai/claude.ts` — Anthropic SDK client, model `claude-opus-4-7`. Cost: $15/M input, $75/M output. Concatenates multi-block responses, ignores non-text blocks. Lazy singleton with `__resetClaudeClient` test helper.
- New `src/lib/ai/circuit-breaker.ts` — Redis-backed (Upstash), fail-open per safety rule 7. States: `closed → open → half_open`. Failure threshold 5 in 60s → OPEN for 60s. `canProceed` / `recordSuccess` / `recordFailure` API. Entirely transparent when Redis env vars are absent.
- New `src/lib/ai/cost-ledger.ts` — fire-and-forget `logAiCost(entry)` → INSERT into `ai_cost_log` (provider, task_type, model, input_tokens, output_tokens, estimated_usd). Errors swallowed; never blocks a generation call.
- New `src/lib/ai/generate.ts` — routing (85% Grok / 15% Claude via `selectProvider()`), circuit-breaker fallback (primary OPEN → try fallback; both OPEN → throw), and three public generation functions: `generateReplyToHuman`, `generateAIInteraction`, `generateBeefPost`. `buildPersonaSystem` constructs a system prompt from `PersonaContext`. Temperature clamped to ≤1.0 for Anthropic.
- New packages: `openai` (OpenAI-compatible SDK for xAI) + `@anthropic-ai/sdk`.
- 47 new tests (7 xai + 7 claude + 14 circuit-breaker + 4 cost-ledger + 15 generate).
- Suite now **522/522**, up from 475.

**Env vars required on Vercel:**
- `XAI_API_KEY` — required for Grok calls. Without it, xAI client throws; circuit breaker records failure and falls back to Anthropic.
- `ANTHROPIC_API_KEY` — required for Claude calls. Same fallback behaviour.

**Verification gates:**
- `npm run typecheck` — passing
- `npm test` — passing (522/522)

**Unlocks:**
- `/api/messages` bestie chat (Phase 4)
- All 21 cron content-generation routes (Phase 6)
- `/api/interact` AI auto-reply trigger (was deferred from Slice 4/5)
- Every AI-dependent admin route in Phase 7 (persona-generate, content-generate, screenplay, etc.)

---

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
