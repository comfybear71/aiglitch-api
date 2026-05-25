# Migration roadmap

Written 2026-04-20 after session 24. **Rewritten 2026-05-25** after a fresh inventory pass — most of the original "what's left" was already shipped, and several "blocked-on-Phase-5" routes turned out to depend on the deleted director-movies pipeline (so they're dead code, not migration work).

## Where we actually are

**The web migration is functionally complete for unblocked work.** Every remaining unported route falls into one of three buckets:

1. **Locked** — needs external approval or a maintenance window (Phase 8 trading, Phase 9 OAuth)
2. **Dead** — should be DELETED from legacy, not migrated (director-movies dependents, content/* test routes, blob-manager)
3. **Permanent legacy** — must stay on `aiglitch.app` per CLAUDE.md rule #5 (Instagram proxies)

Hard numbers:

- **62 endpoints strangler-flipped** through `aiglitch/next.config.ts` `beforeFiles` and serving real traffic via `aiglitch-api`
- **64 admin routes** active in `aiglitch-api/src/app/api/admin/*` (62 flipped, 2 unflipped Phase 8 trading — `admin/swaps`, `admin/trading`)
- **Full AI engine** ported in `src/lib/ai/` (xai, claude, circuit-breaker, cost-ledger, generate, image, video) + `src/lib/ai-engine-v2.ts` — Phase 5 V2 shipped in v1.9.0, consumed by ~30 admin/cron routes
- **45 routes still unported in legacy** — broken down below, every one of them is locked / dead / permanent

## What's actually left

### 🔒 Phase 8: Trading / Solana writes (~17 routes — locked per decision #6)

Requires explicit written approval per endpoint.

| Sub-card | Routes | Status |
|---|---|---|
| 8a-1 Solana read-only | `/api/solana/balance`, `/api/solana/token-balance` | ✅ Shipped 2026-05-25 (v1.18.0) |
| 8a-2 Wallet create/import | `/api/solana/wallet/create`, `/api/solana/wallet/import` | 🔒 Locked |
| 8a-3 SOL + SPL transfers | `/api/solana/transfer`, `/api/solana/spl-transfer` | 🔒 Locked |
| 8b ai-trading | `/api/ai-trading` (+ legacy `?action=` paths) | 🔒 Locked |
| 8b budju-trading | `/api/budju-trading`, `/api/admin/budju-trading` | 🔒 Locked |
| 8b persona-trade | `/api/persona-trade` | 🔒 Locked |
| 8c OTC + exchange | `/api/otc-swap`, `/api/exchange`, `/api/admin/swaps` | 🔒 Locked |
| 8c bridge | `/api/bridge` | 🔒 Locked |
| 8d wallet | `/api/wallet`, `/api/wallet/verify` | 🔒 Locked |
| 8d marketplace | `/api/marketplace` (trading-adjacent — POST creates products + submits orders) | 🔒 Locked |
| 8d misc admin | `/api/admin/trading`, `/api/admin/wallet-auth`, `/api/admin/nfts`, `/api/admin/token-metadata`, `/api/admin/init-persona`, `/api/admin/personas/generate-missing-wallets`, `/api/admin/personas/refresh-wallet-balances` | 🔒 Locked |

### 🔒 Phase 9: OAuth callbacks (12 routes — final, needs maintenance window)

Locked decision #7. Requires updating 6 OAuth provider dashboards so callback URLs point at `api.aiglitch.app`. Providers: Google, GitHub, X/Twitter, YouTube (active), TikTok (deprecated), Telegram (bot webhooks). Cutover risk: login breaks for all users during the gap between code deploy and dashboard updates.

Routes: `/api/auth/google`, `/api/auth/callback/google`, `/api/auth/github`, `/api/auth/callback/github`, `/api/auth/twitter`, `/api/auth/callback/twitter`, `/api/auth/tiktok`, `/api/auth/callback/tiktok`, `/api/auth/youtube`, `/api/auth/callback/youtube`, `/api/auth/wallet-qr`, `/api/auth/sign-tx`.

Already ported (auth side, not OAuth callbacks): `/api/auth/human`, `/api/auth/admin`, `/api/auth/webauthn/register`, `/api/auth/webauthn/login`.

### ⏸ Phase 4: iOS (deferred per decision #9)

One unported route: `/api/hatch` GET + POST. Waits until web cutover is stable and `Glitch-app` repo is wired up.

### ☠️ Dead code (delete from legacy, do NOT migrate)

These don't need ports — they need deletion in a sister-repo cleanup PR:

| Path | Why dead |
|---|---|
| `src/app/api/admin/blob-manager/route.ts` + `src/app/admin/blob-manager/page.tsx` | One-off migration/rename tool, redundant |
| `src/app/api/admin/elon-campaign/route.ts` | Depends on deleted director-movies pipeline (v1.13.1) |
| `src/app/api/admin/generate-news/route.ts` | Depends on deleted director-movies pipeline |
| `src/app/api/admin/screenplay/route.ts` | Already deleted in aiglitch-api side per v1.13.1 |
| `src/app/api/admin/channels/generate-content/route.ts` | Depends on deleted director-movies pipeline |
| `src/app/api/admin/generate-channel-video/route.ts` | Depends on deleted director-movies pipeline |
| `src/app/api/generate-director-movie/route.ts` | Director pipeline retired |
| `src/app/api/content/*` (5 routes) | Test/dev routes per old roadmap, never made it to prod |
| `src/lib/content/director-movies.ts` + companion test/util files | The whole pipeline |

Estimated removal: ~3,500 LOC of dead code.

### 📦 Permanent legacy

- `/api/image-proxy`, `/api/video-proxy` — Instagram can't fetch Vercel Blob URLs, so these must keep responding on the `aiglitch.app` hostname. Strangler fallback handles this automatically — keep on legacy permanently per CLAUDE.md migration rule #5.

## What "done" looks like for the web migration

Per decision #1 (reverse-proxy strangler), this migration's success condition is: every route either serves from `aiglitch-api` (and the strangler proxies it through `aiglitch.app`), is permanent-legacy, or is gone.

Status today:
- ✅ All Phase 1-3 routes ported + flipped
- ✅ AI engine (Phase 5) ported and consumed
- ✅ Phase 6 cron fleet 19/21 done (remaining 2 will arrive via the dead-code cleanup — those crons are tied to the dead director pipeline)
- ✅ Phase 7 admin cohort 64/77 ported; remaining 13 split into locked (Phase 8 deps) or dead
- ✅ Phase 8a-1 (Solana read-only) shipped
- 🔒 Phase 8a-2 / 8a-3 / 8b / 8c / 8d awaiting per-endpoint approvals
- 🔒 Phase 9 OAuth awaiting maintenance-window scheduling
- 📦 Instagram proxies stay on legacy forever

The only **portable** work left is sister-repo cleanup (deleting dead code) and the Phase 8 / Phase 9 work gated on you.

## Foundation prep (no route ports, but de-risks future Phase 8 sessions)

Adding `@solana/web3.js` + `@solana/spl-token` to `aiglitch-api` opportunistically — done in this same PR. Once those are in:

- `getServerSolanaConnection()` available for Phase 8 reads
- `Keypair` / `PublicKey` parsing available for Phase 8 writes
- 5 admin routes (`nfts`, `init-persona`, `personas/generate-missing-wallets`, `personas/refresh-wallet-balances`, `token-metadata`) ready to port the moment their Phase 8 approval lands

Doesn't unlock anything user-visible on its own, but cuts ~½ session off each future Phase 8 admin port.

## Recommended order from here

1. **Sister-repo dead-code cleanup PR** — biggest win for inventory clarity. ~3,500 LOC delete. Drives the final phantom "unported" count from 45 → ~15 (real locked work only).
2. **First Phase 8 written approval, your call which route.** Recommend `/api/solana/wallet/create` + `/api/solana/wallet/import` (card 8a-2) — they're already the next card and would unblock real on-chain user flows.
3. **Phase 9 OAuth window** — schedule when you can tolerate a few minutes of login disruption.
4. **Phase 10 retire** — once Phase 8/9 land, delete every strangler-flipped legacy handler and shrink `aiglitch` to just the Instagram proxy + the few permanent pages.

## Open decisions

1. **Which Phase 8 endpoint gets the first approval?** Cards 8a-2 (wallet create/import) and 8a-3 (transfers) are the next gates. After that, the trading endpoints (8b/8c/8d) can land in any order — they're independent.
2. **Phase 9 OAuth maintenance window** — when's a low-traffic window of ~10 min you can tolerate? Login breaks during the gap between deploy and dashboard updates.
3. **Sister-repo cleanup PR timing** — happy to spec the dead-code list as a paste-able prompt; user runs the sister-repo Claude session.
