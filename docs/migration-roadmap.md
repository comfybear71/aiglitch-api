# Migration roadmap

Written 2026-04-20 after session 24. Updates as decisions are made.

## Where we are

**16 endpoints live** on aiglitch-api:

| | Endpoint |
|---|---|
| Health / ops | `/api/health`, `/status`, `/docs` |
| Feed | `/api/feed` (default / cursor / following / breaking / premieres + genre / premiere_counts / following_list) |
| Content reads | `/api/post/[id]`, `/api/trending`, `/api/search`, `/api/profile` |
| User reads | `/api/likes`, `/api/bookmarks`, `/api/notifications` GET |
| Channels | `/api/channels` GET + POST |
| Interact | `/api/interact` POST (9 actions: like, bookmark, share, view, follow, react, comment, comment_like, subscribe) |
| Community | `/api/events` GET + POST |
| Notifications | `/api/notifications` POST (mark_read / mark_all_read) |

**Consumer status:** only `/api/feed` is consumer-flipped — `aiglitch.app` frontend has a `beforeFiles` rewrite. Every other migrated endpoint is reachable via `api.aiglitch.app/...` but `aiglitch.app/...` still serves from the legacy handler. Flipping each needs a separate decision + frontend commit.

## What's left — 5 categories

### 1. Phase 3 extras: small public / session endpoints (~20 routes)

Read-heavy, low-risk, no new infrastructure required. Can be done any time in any order.

**Public reads:**
- `/api/personas` (list all active)
- `/api/personas/:id/wallet-balance` (cached wallet snapshot — touches Solana config, read-only)
- `/api/channels/feed` (channel-specific feed — reuses feed logic)
- `/api/movies` (director movie list)
- `/api/hatchery` (public persona hatchery listing)
- `/api/meatlab` GET (gallery + creator profiles)
- `/api/token/*` (7 small routes — metadata / logo / token-list / verification / dexscreener — mostly static or cached)
- `/api/nft/image/:productId` (SVG render)
- `/api/nft/metadata/:mint` (on-chain metadata read)
- `/api/sponsor/inquiry` POST (public form)
- `/api/suggest-feature` POST (creates GitHub issue via GITHUB_TOKEN)
- `/api/activity` (cron job activity monitor — read)

**Session reads/writes:**
- `/api/coins` GET + POST (GLITCH balance + manual transactions — builds on users.awardCoins we already have)
- `/api/friends` (list + add friend)
- `/api/friend-shares` (share posts with friends)
- `/api/activity-throttle` (pause/resume cron — session-gated for now, admin-gated later)

**Scope per endpoint:** 50–150 LOC including tests. Most ship in one session.

### 2. Phase 4: Bestie + iOS glue (6 routes, some blocked on AI engine)

- `/api/bestie-health` GET + POST (decay/death/resurrection/feeding system — big but mostly DB-side)
- `/api/messages` GET/PATCH/POST (**bestie AI chat — BLOCKED on AI engine port**)
- `/api/partner/bestie` GET (mobile-app bestie data)
- `/api/partner/briefing` GET (daily briefing)
- `/api/partner/push-token` POST (register push notification device)
- `/api/hatch` GET + POST (user-initiated persona hatching — may need AI engine)
- `/api/hatch/telegram` DELETE + POST (Telegram bot hatching)

### 3. Phase 5: AI engine port (the big deferred item)

One unlock, many downstream consumers. Covers:
- xAI client (OpenAI-compatible SDK against Grok)
- Anthropic SDK client
- AI routing (85% Grok / 15% Claude per audit)
- Circuit breaker (Redis-backed, fail-open per audit)
- Cost tracking ledger (writes to `ai_cost_log` table)
- `generateReplyToHuman`, `generateAIInteraction`, `generateBeefPost`, plus prompt templates

**Estimated scope:** 400–800 LOC across 5 files depending on how much we port vs stub.

**Unblocks:**
- `/api/interact` AI auto-reply trigger (deferred from Slice 4)
- `/api/messages` bestie chat
- All cron content generation (Phase 6)

**Why we've deferred it:** needs focused time + no blocker for existing migrated endpoints.

### 4. Phase 6: Cron fleet (21 routes, blocked on AI engine)

Shouldn't ship individually — they share infrastructure (AI engine, Vercel cron scheduler) and the migration must flip the cron schedule as a cohort, else we either double-run (waste $) or stop running (lose content).

**Cron endpoints:**
- Content generation (9): `/api/generate`, `/api/generate-topics`, `/api/generate-persona-content`, `/api/generate-ads`, `/api/generate-avatars`, `/api/generate-director-movie`, `/api/generate-movies`, `/api/generate-videos`, `/api/generate-series`, `/api/generate-breaking-videos`
- Engagement (3): `/api/persona-comments`, `/api/x-react`, `/api/x-dm-poll`
- Marketing (3): `/api/marketing-post`, `/api/marketing-metrics`, `/api/feedback-loop`
- Bestie (1): `/api/bestie-life`
- Admin utility (4): `/api/sponsor-burn`, `/api/telegram/credit-check`, `/api/telegram/status`, `/api/telegram/persona-message`
- Telegram (2): `/api/telegram/webhook`, `/api/telegram/notify`

**Cutover:** remove cron schedule from `aiglitch`, add equivalent to `aiglitch-api`, verify first execution on preview. One coordinated deploy per job, or flip them all in one deploy after each has been smoke-tested.

### 5. Phase 7: Admin panel (~85 routes — biggest category)

Gated by `ADMIN_PASSWORD` or `ADMIN_TOKEN`. Key decision: port admin auth layer first (1 small route: `/api/auth/admin`), then ship admin routes in thematic groups rather than individually.

**Suggested groupings (not rigid):**

| Group | Routes | Notes |
|---|---|---|
| Persona admin | `/api/admin/personas`, `.../generate-missing-wallets`, `.../refresh-wallet-balances`, `.../set-bot-token`, `.../generate-persona`, `.../persona-avatar`, `.../batch-avatars`, `.../animate-persona`, `.../chibify`, `.../init-persona` | Some blocked on AI engine |
| Content admin | `.../posts`, `.../channels`, `.../channels/flush`, `.../channels/generate-content` `.../channels/generate-promo`, `.../channels/generate-title`, `.../generate-channel-video`, `.../director-prompts`, `.../generate-news`, `.../generate-og-images`, `.../screenplay`, `.../extend-video` | AI-heavy |
| Users / settings | `.../users`, `.../settings`, `.../stats`, `.../health`, `.../costs`, `.../cron-control`, `.../coins`, `.../events`, `.../announce`, `.../action`, `.../briefing`, `.../prompts`, `.../snapshot` | Mostly DB-side |
| Media | `.../media`, `.../media/*`, `.../blob-upload`, `.../blob-upload/upload` | Vercel Blob client |
| Meatlab | `.../meatlab` | Moderation queue |
| Marketing / sponsors | `.../merch`, `.../mktg`, `.../spread`, `.../contacts`, `.../emails`, `.../email-outreach`, `.../x-dm`, `.../tiktok-blaster`, `.../sponsors`, `.../sponsors/:id/ads`, `.../ad-campaigns`, `.../spec-ads`, `.../sponsor-clip`, `.../grokify-sponsor`, `.../elon-campaign`, `.../promote-glitchcoin`, `.../token-metadata` | Large group; integrates with social platforms |
| NFT | `.../nfts`, `.../nft-marketplace` | SPL + metadata writes |
| Hatching | `.../hatchery`, `.../hatch-admin` | Persona onboarding |
| Wallet auth | `.../wallet-auth` | QR flow for admin |
| Trading admin | `.../trading`, `.../budju-trading`, `.../swaps` | **Locked decision #6 — written confirmation per endpoint** |
| Telegram admin | `.../telegram/re-register-bots` | Bot management |

**Cutover plan:** after admin auth ships, each group gets its own frontend rewrite (targeting just that path prefix). Zero-downtime flips.

### 6. Phase 8: Trading / wallet / Solana (~15 routes)

Locked decision #6: **explicit written confirmation required per endpoint** before migration.

**User-facing trading:** `/api/trading`, `/api/ai-trading`, `/api/budju-trading`, `/api/persona-trade`, `/api/wallet`, `/api/wallet/verify`, `/api/solana`, `/api/exchange`, `/api/otc-swap`, `/api/bridge`
**Admin trading:** `/api/admin/trading`, `/api/admin/budju-trading`, `/api/admin/swaps`

**Concerns:**
- Real money / real on-chain Solana transactions
- Private keys in env vars (`TREASURY_PRIVATE_KEY`, `BUDJU_WALLET_SECRET`)
- Circuit breaker coordination with trading bots (cron-side)
- Anti-bubble-map randomisation: 65% Jupiter / 35% Raydium split, staggered wallet distribution

Do not touch without per-endpoint user approval.

### 7. Phase 9: OAuth callbacks (12 routes — final phase)

Locked decision #7. Requires updating 6 OAuth provider dashboards so callback URLs point at `api.aiglitch.app` instead of `aiglitch.app`:
- Google, GitHub, X/Twitter, YouTube — active
- TikTok — deprecated per audit
- Telegram — bot webhooks

**Cutover risk:** login breaks for all users during the gap between updating the code and updating the provider dashboards. Plan a maintenance window or dual-register callback URLs if providers support it.

**Routes:** `/api/auth/human`, `/api/auth/admin`, `/api/auth/google`, `/api/auth/callback/google`, `/api/auth/github`, `/api/auth/callback/github`, `/api/auth/twitter`, `/api/auth/callback/twitter`, `/api/auth/tiktok`, `/api/auth/callback/tiktok`, `/api/auth/youtube`, `/api/auth/callback/youtube`, `/api/auth/wallet-qr`, `/api/auth/sign-tx`, `/api/auth/webauthn/register`, `/api/auth/webauthn/login`

### Test/dev routes (migrate any time, no priority)

`/api/test-grok-image`, `/api/test-grok-video`, `/api/test-media`, `/api/test-premiere-post`, `/api/content/*`. Low-traffic, won't block anything.

### Permanent exceptions — Instagram proxies

- `/api/image-proxy`, `/api/video-proxy` — audit rule 5: Instagram cannot fetch Vercel Blob URLs. These must stay reachable at `aiglitch.app`-prefixed URLs because Instagram posts reference them directly. Strangler fallback handles this automatically; consider migrating to `aiglitch-api` but keeping `aiglitch.app` forwarding in place permanently OR porting + maintaining a stable URL regardless of which backend serves them.

## Recommended priority order

1. **Finish Phase 3** — small public / session reads, fast wins, no dependencies. (~20 routes)
2. **Admin auth layer** — 1 route, unblocks the admin backlog without porting every admin route yet.
3. **Phase 5 AI engine** — the big unlock. After this, Phases 4 and 6 become straightforward. Also closes the AI auto-reply TODO on `/api/interact`.
4. **Phase 6 cron fleet** — flip as a cohort once AI engine is stable.
5. **Phase 4 bestie / iOS** — now unblocked by AI engine.
6. **Phase 7 admin routes in thematic groups** — after admin auth layer ships, do groups one at a time.
7. **Phase 8 trading** — per-endpoint approval. Expect this to be its own multi-session workstream.
8. **Phase 9 OAuth** — final. Coordinated provider-dashboard updates.
9. **Phase 10 cleanup** — delete legacy handlers, remove strangler fallback, retire aiglitch project (or keep as permanent Instagram proxy).

## Consumer flip backlog

Currently flipped: `/api/feed`. Flip each migrated endpoint in batches when they've baked for a stability window. Candidates ready for flip any time:

- `/api/post/[id]`
- `/api/channels` (GET only — POST flip implies consumer confidence in write paths)
- `/api/interact` (all 9 actions except AI auto-reply — see Phase 5 note; worth waiting for AI engine port)
- `/api/likes`, `/api/bookmarks`
- `/api/notifications`
- `/api/trending`, `/api/search`, `/api/profile`, `/api/events`

Consumer flip is a frontend commit to add each path to `beforeFiles` in `next.config.ts` of the `aiglitch` repo. Should be done when the new backend has been stable for at least a few days of no errors.

## Open decisions for next session

1. **Admin auth migration timing** — is it urgent enough to interrupt Phase 3, or is it fine to finish Phase 3 small routes first?
2. **Instagram proxy port** — migrate now (with dual-URL strategy) or leave on legacy forever?
3. **AI engine — stub vs full port** — is a minimum-viable port acceptable (skip circuit breaker + cost ledger) to unblock comments, or should we do the full thing?
4. **Trading green-lights** — when you're ready to start Phase 8, which endpoint first? `/api/wallet` GET (read-only) would be the safest entry point.
