# Migration roadmap

Written 2026-04-20 after session 24. **Refreshed 2026-05-25** after the Solana 8a-1 + Studios by-genre + `/api/auth/admin` strangler-flip sweep — Phase 3 is now done and the dependency map for the remaining work has been recomputed against the live codebase.

## Where we are

**62 endpoints flipped through the strangler** on `aiglitch.app` (i.e. real user traffic served by `aiglitch-api`). All consumer paths in `aiglitch/next.config.ts` `beforeFiles` are backed by a real handler in this repo — no phantom 404s.

**64 admin routes ported and active** in `aiglitch-api/src/app/api/admin/*`, 62 of them flipped (the two unflipped — `admin/swaps`, `admin/trading` — are Phase 8 trading-locked per decision #6).

**Consumer status:** consumer flips have stopped being a separate ceremony — every recent port (Solana read-only, Studios by-genre, `/api/auth/admin`) has been paired with the corresponding sister-repo `beforeFiles` PR in the same hand-off, so the "consumer flip backlog" section that used to live at the bottom of this doc is no longer meaningful.

## What's left

### 1. ~~Phase 3 extras~~ — ✅ COMPLETE (2026-05-25)

Every Phase 3 card from the original list has shipped + flipped + verified end-to-end:

- All public reads (`personas`, `personas/:id/wallet-balance`, `channels/feed`, `movies`, `hatchery`, `meatlab`, `token/*`, `nft/image/:productId`, `nft/metadata/:mint`, `sponsor/inquiry`, `suggest-feature`, `activity`, `channels/aiglitch-studios/by-genre`)
- All session reads/writes (`coins`, `friends`, `friend-shares`, `activity-throttle`)

Nothing left in Phase 3. Tag history: `v1.9.0` → `v1.10.0` → `v1.18.1`.

### 2. Phase 4: Bestie + iOS glue — DEFERRED per locked decision #9

iOS is deferred until web cutover is stable. Phase 4 routes either depend on Phase 5 (AI engine) or serve the iOS app:

- `/api/bestie-health` GET + POST — DB-side, but only the iOS app consumes the partner endpoints below
- `/api/messages` GET/PATCH/POST — **🔒 blocked on Phase 5** (bestie AI chat)
- `/api/partner/bestie`, `/api/partner/briefing`, `/api/partner/push-token` — iOS-only
- `/api/hatch`, `/api/hatch/telegram` — depends on Phase 5 for hatch-time content generation

Honest assessment: nothing in Phase 4 ships until Phase 5 lands, except possibly `/api/bestie-health` (which is mostly a DB scheduler) — but with no iOS consumer hitting it, there's no urgency.

### 3. Phase 5: AI engine port — THE remaining big lift

Unchanged from the prior plan. **Now the highest-leverage unblocker.** Covers:

- xAI client (OpenAI-compatible SDK against Grok)
- Anthropic SDK client
- AI routing (85% Grok / 15% Claude per audit)
- Circuit breaker (Redis-backed, fail-open per audit)
- Cost tracking ledger (writes to `ai_cost_log` table)
- `generateReplyToHuman`, `generateAIInteraction`, `generateBeefPost`, plus prompt templates

**Estimated scope:** 400–800 LOC across 5 files. **Estimated sessions:** 2–3, sliceable as `(session 1: xAI client + cost ledger)`, `(session 2: Anthropic client + router)`, `(session 3: circuit breaker + integration tests)`.

**Unblocks once landed:**
- `/api/interact` AI auto-reply trigger
- `/api/messages` bestie chat
- 2 remaining Phase 6 crons (`bestie-life`, `messages-process` or equivalent)
- 3 admin routes (`admin/channels/generate-content`, `admin/generate-channel-video`, `admin/init-persona`)

### 4. Phase 6: Cron fleet — 19/21 active crons ported

Per v1.10.0 ("90% cron coverage achieved") and follow-ups. Remaining 2 are blocked on Phase 5. Don't flip them individually — flip after Phase 5 along with the AI-dependent admin routes, in one coordinated deploy. (The cohort-flip risk is double-running vs stop-running content gen.)

### 5. Phase 7: Admin panel — 64/77 ported, 13 truly remaining

The Phase 7 cohort is **further along than the original roadmap suggested**. Verified by cross-checking `aiglitch-api/src/app/api/admin/*` against `aiglitch/src/app/api/admin/*`. Of the 13 unported admin routes, most are blocked or dead:

| Route | LOC | Status |
|---|---|---|
| `admin/blob-manager` | 972 | **Flag for DELETION, not migration.** Was a one-off migration/rename tool, now redundant. Sister-repo PR should drop the handler + the `/admin/blob-manager` page. |
| `admin/budju-trading` | 990 | 🔒 Phase 8 locked |
| `admin/channels/generate-content` | — | 🔒 Blocked on Phase 5 |
| `admin/elon-campaign` | — | ☠️ Deprecated (director-movies pipeline deleted in v1.13.1) |
| `admin/generate-channel-video` | 289 | 🔒 Blocked on Phase 5 |
| `admin/generate-news` | 148 | ☠️ Depends on deleted `director-movies` lib |
| `admin/init-persona` | 280 | 🔒 Blocked on Phase 5 (xai) + Phase 8 (Solana Keypair) |
| `admin/nfts` | 247 | 🔒 Phase 8 (`getServerSolanaConnection`) |
| `admin/personas/generate-missing-wallets` | 234 | 🔒 Phase 8 (Solana writes) |
| `admin/personas/refresh-wallet-balances` | 278 | 🔒 Phase 8 (Solana reads) |
| `admin/screenplay` | — | ☠️ Already deleted in v1.13.1 |
| `admin/token-metadata` | 439 | 🔒 Phase 8 (token mint writes) |
| `admin/wallet-auth` | 213 | 🔒 Phase 8 (Solana wallet sigs) |

**Translation:** there are no unblocked admin routes left to port that aren't gated by Phase 5 (AI engine) or Phase 8 (Solana deps + per-endpoint approval) — Phase 7 is effectively done from this repo's side until one of those unlocks.

### 6. Phase 8: Trading / wallet / Solana

**Card 8a-1 — Solana read-only routes** ✅ Shipped 2026-05-25 (v1.18.0). Two routes: `/api/solana/balance` (full parity with legacy `?action=balance`), `/api/solana/token-balance` (pure on-chain SPL slice). Helius-only, no `@solana/web3.js` deps added.

**Card 8a-2 — Wallet create/import** 🔒 Locked. Requires written approval per locked decision #6 before either side touches it. Keypair generation + encrypted seed storage involved.

**Card 8a-3 — SOL + SPL transfers** 🔒 Locked. On-chain writes — highest-risk slice. Written approval required.

**Phase 8b/8c (ai-trading, budju-trading, persona-trade, exchange, OTC, bridge, wallet/verify, marketplace)** — all 🔒 Locked per decision #6.

**Foundation work that could land without trading approval:** add `@solana/web3.js` + `@solana/spl-token` to `package.json` and port `getServerSolanaConnection()` + `Keypair` helpers into `solana-config.ts`. Doesn't unlock anything user-visible on its own, but removes the dep-blocker for 5 admin routes (`nfts`, `init-persona`, `personas/generate-missing-wallets`, `personas/refresh-wallet-balances`, `token-metadata`) — though those still need Phase 8 trading approval per-endpoint after the deps are in.

### 7. Phase 9: OAuth callbacks (12 routes — final phase)

Unchanged from prior plan. Requires updating 6 OAuth provider dashboards so callback URLs point at `api.aiglitch.app`. Providers: Google, GitHub, X/Twitter, YouTube (active), TikTok (deprecated), Telegram (bot webhooks). Cutover risk: login breaks during the dashboard-update gap. Plan a maintenance window or dual-register where supported.

Routes: `/api/auth/google`, `/api/auth/callback/google`, `/api/auth/github`, `/api/auth/callback/github`, `/api/auth/twitter`, `/api/auth/callback/twitter`, `/api/auth/tiktok`, `/api/auth/callback/tiktok`, `/api/auth/youtube`, `/api/auth/callback/youtube`, `/api/auth/wallet-qr`, `/api/auth/sign-tx`.

Already ported (auth side, not OAuth callbacks): `/api/auth/human`, `/api/auth/admin`, `/api/auth/webauthn/register`, `/api/auth/webauthn/login`.

### Permanent exceptions — Instagram proxies

`/api/image-proxy`, `/api/video-proxy` — Instagram can't fetch Vercel Blob URLs. These must stay reachable at `aiglitch.app`-prefixed URLs because IG posts reference them directly. Strangler fallback handles this — keep on legacy permanently per CLAUDE.md migration rule #5.

## Recommended priority order (refreshed)

1. **Phase 5 AI engine** — the single highest-leverage unblock. Unfreezes `/interact` AI auto-reply, bestie chat, the last 2 crons, and 3 admin routes. 2-3 sessions.
2. **Cohort flip for Phase 6 last 2 crons + 3 AI admin routes** — after Phase 5 lands. One coordinated deploy.
3. **Phase 9 OAuth** — only when ready for the provider-dashboard maintenance window.
4. **Phase 8 cards 8a-2 / 8a-3** — only with explicit written per-endpoint approval per decision #6.
5. **Sister-repo cleanup of `blob-manager`** — delete the legacy handler + `/admin/blob-manager` page once nothing depends on it.
6. **Phase 10 cleanup** — delete legacy handlers for everything that's been strangler-flipped, retire the strangler entries, decide whether to keep `aiglitch` alive purely as the Instagram-proxy host.

## Open decisions for next session

1. **Phase 5 slicing:** start with `(session 1 = xAI client + cost ledger)` or with `(session 1 = circuit breaker + Redis primitives)`? The first lets us see real costs flowing into the ledger early; the second lets us de-risk the fail-open behavior before any real AI traffic. Recommend xAI-first — costs ledger is the bigger downstream dependency.
2. **AI engine — stub vs full port:** minimum-viable port (skip circuit breaker + cost ledger) could unblock `/api/interact` AI auto-reply in 1 session instead of 3. Is the partial unblock worth the tech debt?
3. **Phase 8 foundation deps:** add `@solana/web3.js` + `@solana/spl-token` opportunistically (no-route-port commit) so they're ready when written approval lands on 8a-2/8a-3? Or wait until then?
4. **`blob-manager` retirement:** does anything in `aiglitch.app` still reference it, or is it truly safe to delete handler + page?
