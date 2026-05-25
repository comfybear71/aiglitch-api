# BACKLOG.md — pending route ports

> Auto-generated from `src/lib/migration/backlog.ts`. Do not edit by hand — update the source-of-truth catalogue and regen this file.

**35 routes left** • estimated **~33 sessions** at current pace.

Pick a blocker category, then attack one route at a time. Each route lists its prereqs (libs / other routes) so you know what to port first.

## Dead code — depends on retired pipeline, delete from legacy

**5 routes** • ~0 sessions

| Route | Methods | Sessions | Complexity | Notes |
|---|---|---|---|---|
| `/api/admin/channels/generate-content` | POST | 0 | small | Director-movies-dependent. Delete from legacy. <br>**Prereqs:** `@/lib/content/director-movies (retired)` |
| `/api/admin/generate-channel-video` | POST | 0 | small | Director-movies-dependent. Delete from legacy. <br>**Prereqs:** `@/lib/content/director-movies (retired)` |
| `/api/admin/generate-news` | POST | 0 | small | Director-movies-dependent. Delete from legacy. <br>**Prereqs:** `@/lib/content/director-movies (retired)` |
| `/api/admin/screenplay` | GET, POST | 0 | small | Director-movies-dependent. Delete from legacy. <br>**Prereqs:** `@/lib/content/director-movies (retired)` |
| `/api/generate-director-movie` | GET, POST | 0 | small | Cron — director-led movie production pipeline. Delete from legacy (cron entry already removed in v1.13.1). <br>**Prereqs:** `@/lib/content/director-movies (retired)` |

## Phase 8 — Trading / Wallet / Solana (needs greenlight)

**18 routes** • ~23 sessions

| Route | Methods | Sessions | Complexity | Notes |
|---|---|---|---|---|
| `/api/admin/budju-trading` | GET, POST | 2 | large | Admin BUDJU trading controls. Audit 2026-05-25: 990 LOC, 28 sign calls, real treasury-key SPL transfers. This is the genuine high-risk one — per-endpoint decision-#6 approval needed. <br>**Prereqs:** `/api/budju-trading` |
| `/api/admin/init-persona` | POST | 1 | medium | Initialise persona + Solana wallet + GLITCH balance. Also depends on AI image-gen — partially blocked beyond Phase 8. |
| `/api/admin/personas/generate-missing-wallets` | POST | 1 | small | Generate Solana wallets for personas missing them. System-custodial of *persona* keypairs (same model as treasury/ElonBot — not user-custodial). Needs decision-#6 approval. |
| `/api/admin/token-metadata` | POST | 2 | medium | Metaplex on-chain metadata writes for §GLITCH token. 439 LOC, real mint-authority signing — genuine high-risk decision-#6 approval needed. |
| `/api/ai-trading` | GET, POST | 2 | large | AI personas trading SOL/BUDJU. Touches Solana RPC + budju-trading lib. Audit 2026-05-25: zero on-chain signing — pure DB simulation, could ship with standard approval ceremony. |
| `/api/auth/sign-tx` | GET, POST | 1 | medium | Cross-device tx signing bridge (iPad QR → phone signs). |
| `/api/auth/wallet-qr` | GET, POST | 1 | small | Public wallet QR auth (Ed25519 signature verify). |
| `/api/bridge` | POST | 1 | medium | Cross-chain bridge. Audit 2026-05-25: pure DB ledger, no real signing. |
| `/api/budju-trading` | GET, POST | 1 | small | BUDJU token trading user-facing endpoint. Audit 2026-05-25: 59 LOC stub — pure DB ledger, no real signing. |
| `/api/exchange` | GET, POST | 1 | medium | GLITCH/SOL/USDC exchange. Audit 2026-05-25: pure DB ledger, no real signing. |
| `/api/hatch` | POST | 1 | large | Hatch persona + mint NFT (Solana). Phase 4 deferred per decision #9 (iOS). |
| `/api/marketplace` | GET, POST | 1 | large | NFT marketplace purchase + Phantom signing. |
| `/api/otc-swap` | GET, POST | 2 | large | OTC swap matching engine. Audit 2026-05-25: 689 LOC, 4 sign calls, 9 chain reads — REAL treasury-side SPL transfers. Genuine high-risk per-endpoint decision-#6 approval needed. |
| `/api/persona-trade` | GET, POST | 1 | medium | Buy/sell shares in AI personas. Audit 2026-05-25: pure DB simulation, no real signing. |
| `/api/solana` | GET, POST | 1 | medium | Legacy ?action=-based Solana proxy. /balance + /token-balance already split out in v1.18.0. Remaining actions: link_phantom, validate_transfer, claim_airdrop, mode, elonbot_status — mostly DB simulation. |
| `/api/trading` | GET, POST | 1 | medium | Generic trading endpoint. |
| `/api/wallet` | GET, POST | 2 | large | Wallet state + balance + tx history. Simulated wallet table — generates fake base58 addresses, NOT real keypairs (per legacy design). |
| `/api/wallet/verify` | POST | 1 | small | Verify wallet signature for ownership proof. |

## Phase 9 — OAuth callbacks (last per migration plan)

**10 routes** • ~10 sessions

| Route | Methods | Sessions | Complexity | Notes |
|---|---|---|---|---|
| `/api/auth/callback/github` | GET | 1 | medium | GitHub OAuth callback. |
| `/api/auth/callback/google` | GET | 1 | medium | Google OAuth callback. |
| `/api/auth/callback/tiktok` | GET | 1 | medium | TikTok OAuth callback. |
| `/api/auth/callback/twitter` | GET | 1 | medium | X/Twitter OAuth callback. |
| `/api/auth/callback/youtube` | GET | 1 | medium | YouTube OAuth callback. |
| `/api/auth/github` | GET | 1 | small | GitHub OAuth start. |
| `/api/auth/google` | GET | 1 | small | Google OAuth start. |
| `/api/auth/tiktok` | GET | 1 | small | TikTok OAuth start (deprecated by TikTok but kept). |
| `/api/auth/twitter` | GET | 1 | small | X/Twitter OAuth start. |
| `/api/auth/youtube` | GET | 1 | small | YouTube/Google OAuth start. |

## Permanent legacy — stays on aiglitch.app by design

**2 routes** • ~0 sessions

| Route | Methods | Sessions | Complexity | Notes |
|---|---|---|---|---|
| `/api/image-proxy` | GET | 0 | small | Instagram can't fetch Vercel Blob URLs — this proxy must stay reachable on aiglitch.app domain. Per CLAUDE.md, treat as permanent legacy. Sharp dep + image resize. |
| `/api/video-proxy` | GET | 0 | small | Same as image-proxy — IG can't fetch Blob videos. |

---

_Regenerate: `npx tsx scripts/gen-backlog.ts`_
