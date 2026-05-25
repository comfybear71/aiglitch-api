# seed-aiglitch-meta-issues.ps1
#
# PowerShell equivalent of seed-aiglitch-meta-issues.sh
# Creates all 30 migration catalogue issues in comfybear71/aiglitch-meta via gh CLI.
#
# Prereqs:
#   - gh CLI installed and authenticated (run `gh auth status` to verify)
#
# Usage (from PowerShell, after downloading this file):
#   .\seed-aiglitch-meta-issues.ps1
#
# Or one-shot inline:
#   iex (iwr https://raw.githubusercontent.com/comfybear71/aiglitch-api/claude/confident-maxwell-ozxrF/scripts/seed-aiglitch-meta-issues.ps1).Content
#
# Re-running creates duplicates — only run once.

$ErrorActionPreference = "Stop"
$Repo = "comfybear71/aiglitch-meta"

function New-Issue {
    param([string]$Title, [string]$Body)
    Write-Host "Creating: $Title"
    gh issue create --repo $Repo --title $Title --body $Body
}

# ─── Phase 8 — Trading / Solana ──────────────────────────────────────────────

New-Issue -Title "Port Solana read-only routes (wallet + token balance)" -Body @'
## Context

Phase 8a kickoff — already approved. Two small read-only Solana endpoints from legacy `aiglitch` to `aiglitch-api`. No writes, no auth changes, safe canary for the broader Phase 8 lockstep.

## Scope

- `GET /api/solana/balance`
- `GET /api/solana/token-balance`

## Acceptance

- [ ] Routes return identical responses to legacy
- [ ] `beforeFiles` entries flipped in `aiglitch/next.config.ts`
- [ ] Curl verification against `aiglitch.app/api/solana/*` returns new shape
- [ ] No reads inside Neon replication-lag window
- [ ] Release tag created per Rule 5

## Risk

🟢 Low — read-only, no writes, no auth changes.

---
**Suggested project fields:** Phase: `8a-Solana-readonly` | Repo: `aiglitch-api` | Risk: `🟢 Low` | Sessions: `1` | Owner: `Opus`
'@

New-Issue -Title "Port Solana wallet create + import routes" -Body @'
## Context

Phase 8a expansion. Wallet creation involves keypair generation and seed storage — handle with care.

## Scope

- `POST /api/solana/wallet/create`
- `POST /api/solana/wallet/import`

## Acceptance

- [ ] Approval received from user (per locked decision #6)
- [ ] Keypair generation matches legacy entropy source
- [ ] Encrypted seed storage preserves existing format
- [ ] Session merge direction preserved on auth-bound flows
- [ ] Verification matrix: balance lookup works against newly-created wallet

## Risk

🔒 Locked — touches wallet creation. Requires written approval before start.

---
**Suggested project fields:** Phase: `8a-Solana-readonly` | Repo: `aiglitch-api` | Risk: `🔒 Locked` | Sessions: `1-2` | Owner: `Opus`
'@

New-Issue -Title "Port Solana SOL + SPL token transfer routes" -Body @'
## Context

Phase 8a final block. Writes to chain — highest risk in the Solana subset.

## Scope

- `POST /api/solana/transfer` (SOL)
- `POST /api/solana/spl-transfer` (SPL tokens)

## Acceptance

- [ ] Approval received from user
- [ ] Idempotency keys preserved from legacy
- [ ] Fail-open circuit breaker behavior documented
- [ ] Curl smoke test against devnet passes
- [ ] Rollback plan documented (revert beforeFiles entry)

## Risk

🔒 Locked — on-chain writes, irreversible.

---
**Suggested project fields:** Phase: `8a-Solana-readonly` | Repo: `aiglitch-api` | Risk: `🔒 Locked` | Sessions: `2` | Owner: `Opus`
'@

New-Issue -Title "Port ai-trading endpoints (Grok-driven trades)" -Body @'
## Context

Grok-driven autonomous trading routes. Uses xAI client + circuit breaker (already ported in Phase 5). Honor Grok 4096-char prompt budget per safety rule #6.

## Scope

- `POST /api/ai-trading/analyze`
- `POST /api/ai-trading/execute`
- `GET /api/ai-trading/positions`

## Acceptance

- [ ] Approval received from user
- [ ] xAI client uses Phase 5 circuit breaker
- [ ] Cost ledger logs every trade
- [ ] Position reconciliation verified against legacy
- [ ] Prompts kept under 4096 chars

## Risk

🔒 Locked — autonomous trades with real funds.

---
**Suggested project fields:** Phase: `8c-Trading` | Repo: `aiglitch-api` | Risk: `🔒 Locked` | Sessions: `2-3` | Owner: `Opus`
'@

New-Issue -Title "Port budju-trading endpoints" -Body @'
## Context

Budju persona trading flows. Tightly coupled to persona-trade routes.

## Scope

- `GET /api/budju-trading/portfolio`
- `POST /api/budju-trading/trade`
- `GET /api/budju-trading/history`

## Acceptance

- [ ] Approval received
- [ ] Portfolio totals match legacy to 8 decimal places
- [ ] Trade execution logs match legacy structure
- [ ] Cost ledger updated

## Risk

🔒 Locked — real funds.

---
**Suggested project fields:** Phase: `8c-Trading` | Repo: `aiglitch-api` | Risk: `🔒 Locked` | Sessions: `2` | Owner: `Opus`
'@

New-Issue -Title "Port persona-trade endpoints" -Body @'
## Context

Per-persona trading state. Sister to budju-trading.

## Scope

- `GET /api/persona-trade/state`
- `POST /api/persona-trade/decision`

## Acceptance

- [ ] Approval received
- [ ] State machine transitions match legacy
- [ ] No double-execution on retry

## Risk

🔒 Locked.

---
**Suggested project fields:** Phase: `8c-Trading` | Repo: `aiglitch-api` | Risk: `🔒 Locked` | Sessions: `1-2` | Owner: `Opus`
'@

New-Issue -Title "Port OTC swap endpoint" -Body @'
## Context

Over-the-counter swap routing. Lower volume than DEX flows.

## Scope

- `POST /api/otc-swap/quote`
- `POST /api/otc-swap/execute`

## Acceptance

- [ ] Approval received
- [ ] Quote slippage matches legacy
- [ ] Settlement confirmed on-chain

## Risk

🔒 Locked.

---
**Suggested project fields:** Phase: `8c-Trading` | Repo: `aiglitch-api` | Risk: `🔒 Locked` | Sessions: `1-2` | Owner: `Opus`
'@

New-Issue -Title "Port exchange endpoints" -Body @'
## Context

DEX integration routes. Highest call volume of the trading subset.

## Scope

- `GET /api/exchange/pairs`
- `POST /api/exchange/order`
- `GET /api/exchange/orderbook`

## Acceptance

- [ ] Approval received
- [ ] Orderbook latency within 50ms of legacy
- [ ] Order placement idempotent

## Risk

🔒 Locked.

---
**Suggested project fields:** Phase: `8c-Trading` | Repo: `aiglitch-api` | Risk: `🔒 Locked` | Sessions: `2` | Owner: `Opus`
'@

New-Issue -Title "Port cross-chain bridge endpoints" -Body @'
## Context

Cross-chain bridging. Complex due to multi-chain confirmation logic.

## Scope

- `POST /api/bridge/initiate`
- `GET /api/bridge/status/:id`
- `POST /api/bridge/claim`

## Acceptance

- [ ] Approval received
- [ ] Bridge tx polling logic preserved
- [ ] Claim idempotent across retries
- [ ] Status webhook (if any) preserved

## Risk

🔒 Locked — bridge funds can be stuck mid-transit.

---
**Suggested project fields:** Phase: `8c-Trading` | Repo: `aiglitch-api` | Risk: `🔒 Locked` | Sessions: `2-3` | Owner: `Opus`
'@

New-Issue -Title "Port wallet read-only endpoints (history, balance aggregator)" -Body @'
## Context

Multi-chain wallet read endpoints. Read-only, but aggregates sensitive data.

## Scope

- `GET /api/wallet/history`
- `GET /api/wallet/balance-aggregator`

## Acceptance

- [ ] Approval received
- [ ] Aggregator totals match legacy
- [ ] No PII leakage in error responses

## Risk

🟡 Medium — reads only, but exposes balances.

---
**Suggested project fields:** Phase: `8b-Solana-writes` | Repo: `aiglitch-api` | Risk: `🟡 Medium` | Sessions: `1` | Owner: `Opus`
'@

# ─── Phase 9 — OAuth Callbacks ───────────────────────────────────────────────

New-Issue -Title "Port Google OAuth callback" -Body @'
## Context

Google OAuth is the highest-volume provider. Callback URL change must be coordinated with the Google Cloud Console update.

## Scope

- `GET /api/auth/google/callback`
- Update Google Cloud Console authorized redirect URI

## Acceptance

- [ ] Callback handler ported to `aiglitch-api`
- [ ] Google Cloud Console redirect URI updated by user
- [ ] Session merge from old session_id to new preserved
- [ ] Login flow tested end-to-end on aiglitch.app

## Risk

🔴 High — auth flow, breaks login if mis-staged.

---
**Suggested project fields:** Phase: `9-OAuth` | Repo: `aiglitch-api` | Risk: `🔴 High` | Sessions: `1` | Owner: `Both Claudes`
'@

New-Issue -Title "Port GitHub OAuth callback" -Body @'
## Context

GitHub OAuth. Coordinate with GitHub App settings update.

## Scope

- `GET /api/auth/github/callback`
- Update GitHub OAuth App callback URL

## Acceptance

- [ ] Callback handler ported
- [ ] GitHub OAuth App config updated by user
- [ ] Login tested

## Risk

🔴 High.

---
**Suggested project fields:** Phase: `9-OAuth` | Repo: `aiglitch-api` | Risk: `🔴 High` | Sessions: `1` | Owner: `Both Claudes`
'@

New-Issue -Title "Port X OAuth callback" -Body @'
## Context

X/Twitter OAuth. Coordinate with X Developer Portal settings.

## Scope

- `GET /api/auth/x/callback`
- Update X Developer Portal callback URL

## Acceptance

- [ ] Callback handler ported
- [ ] X Developer Portal config updated
- [ ] Login tested

## Risk

🔴 High.

---
**Suggested project fields:** Phase: `9-OAuth` | Repo: `aiglitch-api` | Risk: `🔴 High` | Sessions: `1` | Owner: `Both Claudes`
'@

New-Issue -Title "Port YouTube OAuth callback" -Body @'
## Context

YouTube uses Google OAuth under the hood, but has its own callback path for channel-scoped permissions.

## Scope

- `GET /api/auth/youtube/callback`
- Update Google Cloud Console scopes if needed

## Acceptance

- [ ] Callback handler ported
- [ ] Scope verification preserved
- [ ] Login + channel auth tested

## Risk

🔴 High.

---
**Suggested project fields:** Phase: `9-OAuth` | Repo: `aiglitch-api` | Risk: `🔴 High` | Sessions: `1` | Owner: `Both Claudes`
'@

New-Issue -Title "Port Telegram login widget callback" -Body @'
## Context

Telegram login widget. Hash verification on callback.

## Scope

- `GET /api/auth/telegram/callback`
- Update Telegram BotFather domain whitelist

## Acceptance

- [ ] Hash verification preserved (HMAC-SHA256 with bot token)
- [ ] BotFather domain updated
- [ ] Login tested

## Risk

🟡 Medium — narrower user base than Google.

---
**Suggested project fields:** Phase: `9-OAuth` | Repo: `aiglitch-api` | Risk: `🟡 Medium` | Sessions: `1` | Owner: `Both Claudes`
'@

New-Issue -Title "Document TikTok OAuth deprecation (no migration)" -Body @'
## Context

Per safety rule #8 — TikTok API is dead. Manual posting only. No callback to port. This card exists to **document the decision** and remove dead code.

## Scope

- Delete `aiglitch/src/app/api/auth/tiktok/*` from legacy repo
- Note deprecation in `aiglitch-api/docs/api-handoff-4-architecture.md`

## Acceptance

- [ ] Dead TikTok routes deleted from `aiglitch`
- [ ] Architecture doc updated
- [ ] No new TikTok automation introduced

## Risk

🟢 Low — deletion only.

---
**Suggested project fields:** Phase: `9-OAuth` | Repo: `aiglitch` | Risk: `🟢 Low` | Sessions: `0` | Owner: `User`
'@

# ─── Admin Repo Extraction ───────────────────────────────────────────────────

New-Issue -Title "Bootstrap admin-aiglitch Next.js scaffold + base layout" -Body @'
## Context

`admin-aiglitch` currently has minimal scaffolding. Establish the base Next.js App Router structure mirroring legacy admin section.

## Scope

- Next.js App Router init (if not present)
- Base layout matching legacy admin chrome
- Tailwind config matching aiglitch
- `next.config.ts` with API base URL pointing at `api.aiglitch.app`

## Acceptance

- [ ] `npm run dev` starts cleanly
- [ ] Base layout renders
- [ ] API base URL configurable via env

## Risk

🟡 Medium — new repo, easy to drift from legacy patterns.

---
**Suggested project fields:** Phase: `Admin-Extract` | Repo: `admin-aiglitch` | Risk: `🟡 Medium` | Sessions: `1` | Owner: `Opus`
'@

New-Issue -Title "Wire admin auth using /api/auth/admin on api.aiglitch.app + shared cookie" -Body @'
## Context

Admin auth currently uses `ADMIN_PASSWORD` env var via `/api/auth/admin`. Cookie must work across `aiglitch.app` and `admin.aiglitch.app` — either set cookie domain to `.aiglitch.app` OR move auth fully to `api.aiglitch.app` with CORS allowing the admin subdomain.

## Scope

- Login page in admin-aiglitch posting to `api.aiglitch.app/api/auth/admin`
- Cookie domain strategy decided + documented in ADR
- CORS config on aiglitch-api to allow admin subdomain
- Logout flow

## Acceptance

- [ ] Login works from `admin.aiglitch.app`
- [ ] Cookie persists across page loads
- [ ] Logout clears cookie
- [ ] No CORS errors in browser console

## Risk

🔴 High — auth split across two domains.

---
**Suggested project fields:** Phase: `Admin-Extract` | Repo: `admin-aiglitch` | Risk: `🔴 High` | Sessions: `1-2` | Owner: `Both Claudes`
'@

New-Issue -Title "Move first batch of admin pages from aiglitch to admin-aiglitch" -Body @'
## Context

Port admin UI pages in batches. Start with the lowest-coupled pages.

## Scope

- Identify first 5-10 admin pages by dependency depth
- Copy `aiglitch/src/app/admin/<page>` → `admin-aiglitch/src/app/<page>`
- Update internal links (drop `/admin` prefix)
- Update API call URLs to absolute `api.aiglitch.app/api/admin/*`

## Acceptance

- [ ] Pages render on `admin.aiglitch.app`
- [ ] API calls succeed
- [ ] Internal navigation works
- [ ] Original `aiglitch/src/app/admin/<page>` left in place for now (deletion in later card)

## Risk

🟡 Medium.

---
**Suggested project fields:** Phase: `Admin-Extract` | Repo: `admin-aiglitch` | Risk: `🟡 Medium` | Sessions: `1-2` | Owner: `Opus`
'@

New-Issue -Title "Move remaining admin pages to admin-aiglitch" -Body @'
## Context

Finish the page migration started in the first batch.

## Scope

- All remaining `aiglitch/src/app/admin/*` pages
- Update navigation references
- Update any cron-status / system-status dashboards

## Acceptance

- [ ] All admin pages render on `admin.aiglitch.app`
- [ ] No 404s on internal nav
- [ ] Feature parity vs legacy `aiglitch.app/admin`

## Risk

🟡 Medium.

---
**Suggested project fields:** Phase: `Admin-Extract` | Repo: `admin-aiglitch` | Risk: `🟡 Medium` | Sessions: `1-2` | Owner: `Opus`
'@

New-Issue -Title "Delete /admin pages from aiglitch repo" -Body @'
## Context

After admin pages are verified on `admin.aiglitch.app`, remove `aiglitch/src/app/admin/*` entirely. Frontend simplifies, build time drops.

## Scope

- Delete `aiglitch/src/app/admin/*`
- Remove `/admin/*` paths from `aiglitch/next.config.ts` strangler if present
- Update any in-app links pointing at `aiglitch.app/admin/*` to redirect to `admin.aiglitch.app`

## Acceptance

- [ ] `aiglitch/src/app/admin/` directory gone
- [ ] Build still passes
- [ ] No broken internal links

## Risk

🟢 Low — deletion after parity verified.

---
**Suggested project fields:** Phase: `Admin-Extract` | Repo: `aiglitch` | Risk: `🟢 Low` | Sessions: `1` | Owner: `Opus`
'@

# ─── Phase 10 — Cleanup ──────────────────────────────────────────────────────

New-Issue -Title "Delete legacy handlers for all migrated routes" -Body @'
## Context

Every flipped route has a duplicate handler still living in `aiglitch/src/app/api/`. After full migration is verified, delete them all.

## Scope

- Audit `aiglitch/next.config.ts` `beforeFiles` — every entry there means the legacy handler is dead code
- Delete corresponding `aiglitch/src/app/api/<route>/` directories
- Keep Instagram proxies (`image-proxy`, `video-proxy`) per safety rule #5

## Acceptance

- [ ] Every flipped route's legacy handler removed
- [ ] Instagram proxies retained
- [ ] aiglitch builds + deploys cleanly
- [ ] No 500s in Vercel logs post-deploy

## Risk

🟡 Medium — bulk deletion. Verify each before deleting.

---
**Suggested project fields:** Phase: `10-Cleanup` | Repo: `aiglitch` | Risk: `🟡 Medium` | Sessions: `2-3` | Owner: `Opus`
'@

New-Issue -Title "Retire strangler rewrites from aiglitch/next.config.ts" -Body @'
## Context

After legacy handlers are gone, the `beforeFiles` rewrites are the only thing keeping `aiglitch.app/api/*` working. Replace with a single catch-all proxy to `api.aiglitch.app`.

## Scope

- Replace per-route `beforeFiles` entries with one catch-all
- OR remove `beforeFiles` entirely if frontends call `api.aiglitch.app` directly
- Decision documented in ADR

## Acceptance

- [ ] `next.config.ts` simplified
- [ ] All consumer apps still functional
- [ ] DNS / Vercel routing verified

## Risk

🟡 Medium — config change affecting all API traffic.

---
**Suggested project fields:** Phase: `10-Cleanup` | Repo: `aiglitch` | Risk: `🟡 Medium` | Sessions: `1` | Owner: `Opus`
'@

New-Issue -Title "Reduce aiglitch repo to pure-UI shell" -Body @'
## Context

After all backend work is in `aiglitch-api` and admin is in `admin-aiglitch`, `aiglitch` should be only: feed, channel pages, post components, service worker, public/static assets, IG proxies.

## Scope

- Remove unused API utilities (db clients, AI clients, blob writers)
- Remove cron-related code (crons run from aiglitch-api now)
- Move schema canonical to aiglitch-api (decision #4 cutover)
- Trim `package.json` deps

## Acceptance

- [ ] Bundle size reduced
- [ ] Build time reduced
- [ ] Service worker still ships
- [ ] IG proxies still reachable

## Risk

🟢 Low — deletion of dead code.

---
**Suggested project fields:** Phase: `10-Cleanup` | Repo: `aiglitch` | Risk: `🟢 Low` | Sessions: `1-2` | Owner: `Opus`
'@

New-Issue -Title "Verify Instagram proxies remain reachable post-cleanup" -Body @'
## Context

Per safety rule #5 — IG cannot fetch Vercel Blob URLs. The `/api/image-proxy` and `/api/video-proxy` routes are permanent legacy on `aiglitch.app`. Cleanup must NOT remove them.

## Scope

- Smoke test from Instagram's user-agent
- Confirm proxies return 200 + correct Content-Type
- Document this as PERMANENT in the cleanup ADR

## Acceptance

- [ ] Proxies confirmed working
- [ ] Documented as permanent legacy

## Risk

🔴 High — breaks IG posting if removed.

---
**Suggested project fields:** Phase: `10-Cleanup` | Repo: `aiglitch` | Risk: `🔴 High` | Sessions: `1` | Owner: `User`
'@

# ─── Meta / Coordination ─────────────────────────────────────────────────────

New-Issue -Title "Reference MIGRATION-PLAYBOOK.md from aiglitch-api/CLAUDE.md" -Body @'
## Context

Now that the meta repo holds the canonical playbook, both consumer repos should reference it from CLAUDE.md.

## Scope

- Add section to `aiglitch-api/CLAUDE.md` linking to https://github.com/comfybear71/aiglitch-meta/blob/main/MIGRATION-PLAYBOOK.md
- Add section linking to the project board

## Acceptance

- [ ] CLAUDE.md updated
- [ ] Links resolve

## Risk

🟢 Low.

---
**Suggested project fields:** Phase: `Meta-Setup` | Repo: `aiglitch-api` | Risk: `🟢 Low` | Sessions: `0.5` | Owner: `Opus`
'@

New-Issue -Title "Reference MIGRATION-PLAYBOOK.md from aiglitch/CLAUDE.md" -Body @'
## Context

Sister repo also needs the playbook link.

## Scope

- Same content as the aiglitch-api card, but in `aiglitch/CLAUDE.md`

## Acceptance

- [ ] CLAUDE.md updated
- [ ] Links resolve

## Risk

🟢 Low.

---
**Suggested project fields:** Phase: `Meta-Setup` | Repo: `aiglitch` | Risk: `🟢 Low` | Sessions: `0.5` | Owner: `Haiku`
'@

New-Issue -Title "Set up project board auto-status transitions on PR merge" -Body @'
## Context

GitHub Projects workflows can auto-move cards to Done when their linked PR merges. Set this up so the board stays current without manual updates.

## Scope

- Configure workflow in project settings
- Test with a sample PR
- Document in meta repo README

## Acceptance

- [ ] Workflow active
- [ ] Sample PR moves card automatically
- [ ] Documented

## Risk

🟢 Low.

---
**Suggested project fields:** Phase: `Meta-Setup` | Repo: `aiglitch-meta` | Risk: `🟢 Low` | Sessions: `1` | Owner: `Opus`
'@

New-Issue -Title "Write cross-repo verification script (detect migration drift)" -Body @'
## Context

A script that checks: every route in `aiglitch/next.config.ts` `beforeFiles` has a corresponding handler in `aiglitch-api`. Catches drift early.

## Scope

- Bash or Node script in `aiglitch-meta/scripts/verify.sh`
- Reads `aiglitch/next.config.ts` (or fetches via GitHub raw)
- Checks `aiglitch-api/src/app/api/` for matching directories
- Outputs diff

## Acceptance

- [ ] Script runs locally and in CI
- [ ] Outputs human-readable diff
- [ ] Exits non-zero on mismatch

## Risk

🟢 Low.

---
**Suggested project fields:** Phase: `Meta-Setup` | Repo: `aiglitch-meta` | Risk: `🟢 Low` | Sessions: `1` | Owner: `Opus`
'@

New-Issue -Title "Create per-endpoint approval log for Phase 8 trading routes" -Body @'
## Context

Per locked decision #6, every Phase 8 endpoint needs written approval. Maintain a log so approvals don't get lost across sessions.

## Scope

- `aiglitch-meta/docs/phase-8-approvals.md`
- Table: endpoint | approved-date | session-tag | status
- Pre-populated rows for all Phase 8 cards

## Acceptance

- [ ] File created
- [ ] Rows for all Phase 8 cards
- [ ] Card 1 (Solana read-only) marked approved (already done)

## Risk

🟢 Low.

---
**Suggested project fields:** Phase: `Meta-Setup` | Repo: `aiglitch-meta` | Risk: `🟢 Low` | Sessions: `0.5` | Owner: `User`
'@

Write-Host ""
Write-Host "All 30 issues created in $Repo" -ForegroundColor Green
Write-Host "Next: open the project board and bulk-add the new issues."
