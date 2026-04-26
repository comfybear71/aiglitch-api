# BACKLOG.md — pending route ports

> Auto-generated from `src/lib/migration/backlog.ts`. Do not edit by hand — update the source-of-truth catalogue and regen this file.

**45 routes left** • estimated **~47 sessions** at current pace.

Pick a blocker category, then attack one route at a time. Each route lists its prereqs (libs / other routes) so you know what to port first.

## Phase 8 — Trading / Wallet / Solana (needs greenlight)

**21 routes** • ~24 sessions

| Route | Methods | Sessions | Complexity | Notes |
|---|---|---|---|---|
| `/api/admin/budju-trading` | GET, POST | 1 | medium | Admin BUDJU trading controls. <br>**Prereqs:** `/api/budju-trading` |
| `/api/admin/init-persona` | POST | 1 | medium | Initialise persona + Solana wallet + GLITCH balance. |
| `/api/admin/nfts` | GET, POST | 1 | medium | Admin NFT reconciliation, Solana RPC for tx lookup. |
| `/api/admin/personas/generate-missing-wallets` | POST | 1 | small | Generate Solana wallets for personas missing them. |
| `/api/admin/personas/refresh-wallet-balances` | POST | 1 | small | Refresh on-chain balances for persona wallets. |
| `/api/admin/token-metadata` | POST | 1 | medium | Metaplex on-chain metadata for §GLITCH token. |
| `/api/admin/wallet-auth` | GET, POST | 1 | medium | Admin wallet QR auth flow. |
| `/api/ai-trading` | GET, POST | 2 | large | AI personas trading SOL/BUDJU. Touches Solana RPC + budju-trading lib. |
| `/api/auth/sign-tx` | GET, POST | 1 | medium | Cross-device tx signing bridge (iPad QR → phone signs). |
| `/api/auth/wallet-qr` | GET, POST | 1 | small | Public wallet QR auth (Ed25519 signature verify). |
| `/api/bridge` | POST | 1 | medium | Cross-chain bridge. |
| `/api/budju-trading` | GET, POST | 2 | large | BUDJU token trading. Solana RPC + market simulator. |
| `/api/exchange` | GET, POST | 1 | medium | GLITCH/SOL/USDC exchange. |
| `/api/hatch` | POST | 1 | large | Hatch persona + mint NFT (Solana). Marketing dep too. |
| `/api/marketplace` | GET, POST | 1 | large | NFT marketplace purchase + Phantom signing. |
| `/api/otc-swap` | GET, POST | 1 | medium | OTC swap matching engine. |
| `/api/persona-trade` | GET, POST | 1 | medium | Buy/sell shares in AI personas. |
| `/api/solana` | GET, POST | 1 | medium | Generic Solana RPC proxy. |
| `/api/trading` | GET, POST | 1 | medium | Generic trading endpoint. |
| `/api/wallet` | GET, POST | 2 | large | Wallet state + balance + tx history. |
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

## Marketing library port required (3036 lines)

**1 routes** • ~1 sessions

| Route | Methods | Sessions | Complexity | Notes |
|---|---|---|---|---|
| `/api/generate-ads` | GET, POST | 1 | large | Sponsored ad generation cron. <br>**Prereqs:** `@/lib/marketing/*` |

## Director-movies library port required (1626 lines)

**10 routes** • ~10 sessions

| Route | Methods | Sessions | Complexity | Notes |
|---|---|---|---|---|
| `/api/admin/channels/generate-content` | POST | 1 | large | Full multi-scene channel video generation. <br>**Prereqs:** `@/lib/content/director-movies` |
| `/api/admin/extend-video` | POST | 1 | medium | Extend an existing video clip. <br>**Prereqs:** `@/lib/content/director-movies` |
| `/api/admin/generate-channel-video` | POST | 1 | large | Multi-clip channel video. <br>**Prereqs:** `@/lib/content/director-movies`, `@/lib/media/multi-clip` |
| `/api/admin/generate-news` | POST | 1 | medium | Breaking-news video generator. <br>**Prereqs:** `@/lib/content/director-movies` |
| `/api/admin/screenplay` | GET, POST | 1 | medium | Standalone screenplay generation tool. <br>**Prereqs:** `@/lib/content/director-movies` |
| `/api/generate-breaking-videos` | GET, POST | 1 | medium | Breaking news video cron — needs generateBreakingNewsVideos lib. <br>**Prereqs:** `@/lib/content/ai-engine#generateBreakingNewsVideos` |
| `/api/generate-director-movie` | GET, POST | 1 | large | Cron — director-led movie production pipeline. <br>**Prereqs:** `@/lib/content/director-movies` |
| `/api/generate-movies` | GET, POST | 1 | medium | Generic movie generation cron. <br>**Prereqs:** `@/lib/content/director-movies` |
| `/api/generate-persona-content` | GET, POST | 1 | large | Persona content generation — multi-clip + director-movie polling. <br>**Prereqs:** `@/lib/content/director-movies`, `@/lib/media/multi-clip` |
| `/api/generate-series` | GET, POST | 1 | medium | Multi-clip series generator. <br>**Prereqs:** `@/lib/media/multi-clip` |

## Chunky single-session port (1-2 sessions)

**1 routes** • ~2 sessions

| Route | Methods | Sessions | Complexity | Notes |
|---|---|---|---|---|
| `/api/admin/elon-campaign` | GET, POST | 2 | huge | Daily Elon-bait campaign (711 lines). Needs ELON_CAMPAIGN constant, mp4-concat lib, multi-clip lib, marketing/spread-post. Chunky even with deferrals. <br>**Prereqs:** `@/lib/bible/constants#ELON_CAMPAIGN`, `@/lib/media/mp4-concat`, `@/lib/media/multi-clip` |

## Permanent legacy — stays on aiglitch.app by design

**2 routes** • ~0 sessions

| Route | Methods | Sessions | Complexity | Notes |
|---|---|---|---|---|
| `/api/image-proxy` | GET | 0 | small | Instagram can't fetch Vercel Blob URLs — this proxy must stay reachable on aiglitch.app domain. Per CLAUDE.md, treat as permanent legacy. Sharp dep + image resize. |
| `/api/video-proxy` | GET | 0 | small | Same as image-proxy — IG can't fetch Blob videos. |

---

_Regenerate: `npx tsx scripts/gen-backlog.ts`_
