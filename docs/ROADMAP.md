# ROADMAP — multi-session plan, locked 2026-06-18

> Operator's reference for what we're building next, in what order, and
> across which repos. Future Claude sessions (this repo or sister repos)
> read this cold before picking up work.
>
> Update this file whenever a session ships or scope changes. Tick the
> checkbox in the "status" column when a session closes.

---

## North-star vision

AIG!itch is splitting into a multi-repo platform:

```
aiglitch.app             (consumer)        — existing consumer frontend
admin.aiglitch.app       (ops)             — existing admin frontend  (admin-aiglitch repo)
api.aiglitch.app         (backend)         — existing API repo (THIS REPO)
marketing.aiglitch.app   (marketing tools) — NEW repo, to be created
trading.aiglitch.app     (trading + NFT)   — NEW repo, to be created, later
```

Each frontend repo is a thin Next.js app calling the shared backend at
`api.aiglitch.app`. Backend changes happen in this repo. UI changes
happen in the respective frontend repo via a sister Claude session.

---

## Session sequence

| # | Session | Repo | Status | Notes |
|---|---|---|---|---|
| 0 | Roadmap + spec lock | aiglitch-api | ✅ this PR | The doc you're reading. |
| 1 | **ffmpeg stitcher** — re-encode + concat to support mixed-codec (Grok + HeyGen) clips. Brings intro/outro back to breaking-news Mode B. Foundation for the Ad Creator. | aiglitch-api | ✅ v1.50.0 | Bundled `ffmpeg-static`. Wired into breaking-news Mode B — intro + HeyGen anchor + outro stitched into 16s output. Foundation for Ad Creator (session 2-4). |
| 2 | **Ad Creator backend — part 1**: schema + admin endpoints. New DB table for "ad briefs" (title, project name, concept, target socials). CRUD endpoints. No generation yet. | aiglitch-api | ⬜ | Hangs off `/api/admin/ads/*`. |
| 3 | **Ad Creator backend — part 2**: generation pipeline. Brief → HeyGen presenter + Grok b-roll + HeyGen intro/outro → ffmpeg stitch → MP4 in Blob → INSERT post to For You feed. | aiglitch-api | ⬜ | Posts to AIG!itch For You feed only (user said other-project socials are manual for now). |
| 4 | **Ad Creator backend — part 3**: upload-existing-media path. Operator uploads their own video clips to mix with AI-generated content (per user: "experiment until we hit sweet spot for each project/business"). | aiglitch-api | ⬜ | Reuses Vercel Blob client-upload pattern from meatlab. |
| 5 | **marketing-aiglitch bootstrap** — new GitHub repo, new Vercel project, CI/CD, login shell, layout, route to api.aiglitch.app. No tabs yet. | NEW marketing-aiglitch | ⬜ | Sister Claude session. Use the kickoff prompt in §"Marketing repo bootstrap prompt" below. |
| 6 | Move **Sponsors** tab (first proof) | marketing-aiglitch | ⬜ | Lowest blast radius DB-backed CRUD. If clean, every other tab is mechanical. |
| 7 | Move **AI Costs** tab — and fix the existing `/costs` page that returns "Couldn't load" on admin.aiglitch.app | marketing-aiglitch + aiglitch-api | ⬜ | Investigate route /api/admin/costs first. |
| 8 | Move **Events** tab — and fix the broken `/events` page | marketing-aiglitch + aiglitch-api | ⬜ | Investigate route /api/admin/events first. |
| 9 | Move **Contact** tab — and fix the broken `/contacts` page | marketing-aiglitch + aiglitch-api | ⬜ | Investigate route /api/admin/contacts first. |
| 10 | Move **Emails** tab | marketing-aiglitch | ⬜ | |
| 11 | Move **X Growth** tab | marketing-aiglitch | ⬜ | |
| 12 | Move **Spec Ads** tab | marketing-aiglitch | ⬜ | |
| 13 | Move **Merch Studio** tab | marketing-aiglitch | ⬜ | |
| 14 | Move **Ad Campaigns** tab + wire up the new **Ad Creator UI** (consumes sessions 2-4 backend) | marketing-aiglitch | ⬜ | The big one — Ad Creator UI is the marketing tool the user explicitly wants for promoting their other projects. |
| 15 | Fix the broken `/prompts` page (still on admin or move to marketing — TBD) | aiglitch-api + admin-aiglitch (or marketing-aiglitch) | ⬜ | Investigate route /api/admin/prompts first. |
| 16 | **Telegram consolidation** — kill the dual-fire to channel + group, audit `marketing_platform_accounts` rows, pin one canonical target. | aiglitch-api | ⬜ | Per user: after marketing, before trading. |
| 17 | **trading-aiglitch bootstrap** — new repo, new Vercel project, CI/CD, login shell. | NEW trading-aiglitch | ⬜ | After marketing is stable. |
| 18 | **Multi-wallet adapter** — Phantom + Solflare + Jupiter Wallet + Backpack via `@solana/wallet-adapter-react`. Readonly mode (public-key + balance) + write mode (signTransaction). | trading-aiglitch | ⬜ | Big scope per user. Per CLAUDE.md decision #6 — explicit written confirmation required before each on-chain endpoint ships. |
| 19 | Move **Budju trading** tab | trading-aiglitch | ⬜ | Single tab move + wire into wallet adapter. |
| 20 | Move **NFT** tab | trading-aiglitch | ⬜ | User noted NFT belongs in trading repo, not marketing. |

Stop after each session, deliver Rule 5 handoff, tag, push, deploy.
Don't bundle sessions — each one ships independently so the user can
review + merge at their own pace.

---

## Open known-broken pages on admin.aiglitch.app (as of 2026-06-18)

Investigated during session 0; need to be checked when their tabs move
in sessions 7, 8, 9, 15 above. Most likely cause: backend route exists
on legacy `aiglitch` repo but never ported to `aiglitch-api`, OR the
proxy rewrite on admin-aiglitch isn't pointed at api.aiglitch.app.

- `https://admin.aiglitch.app/prompts` → "Couldn't load"
- `https://admin.aiglitch.app/costs` → "Couldn't load"
- `https://admin.aiglitch.app/contacts` → "Couldn't load"
- `https://admin.aiglitch.app/events` → "Couldn't load"

When each tab is moved, the corresponding backend route gets fixed/
ported as part of the same session. Don't try to fix these
piecemeal on the current admin repo — that's wasted effort, since
the page is moving anyway.

---

## Locked decisions from this discussion

| Decision | Value | Why |
|---|---|---|
| Ad Creator output destination | AIG!itch For You feed only (sessions 2-4) | User said other-project social posting is manual for now via a separate platform they'll build later. |
| Ad Creator input shape | Hybrid — operator can upload existing video/images AND mix with AI-generated clips. | User: "experiment until we hit sweet spot for each project/business". |
| ffmpeg approach | `ffmpeg-static` binary in serverless function | Free, ships once, reuse across breaking-news + ad creator + future stitching. ~50MB inside the 250MB Vercel function limit. Cold start adds 5-10s. |
| First marketing tab to move | Sponsors | Real DB-backed CRUD with low blast radius — proves the auth + API contract from a new domain. |
| Trading auth model | Multi-wallet adapter (Phantom + Solflare + Jupiter + Backpack), readonly + write modes | Per user. Big scope, deferred until session 18. |
| Telegram channel keep | TBD (user keeps both until session 16 resolves it) | User has both a Bot channel (`AIG!itch`) and a Group (`AIG!itch Group`). Will decide once consolidation work starts. |
| Marketing tabs to move (9 total) | AI Costs, Events, Ad Campaigns, Sponsors, X Growth, Spec Ads, Merch Studio, Emails, Contact | Per user. Existing admin pages, some of them currently broken (see §"Open known-broken pages"). |

---

## Marketing repo bootstrap prompt

> Paste this into a fresh Claude session inside the new
> `comfybear71/marketing-aiglitch` repo (which doesn't exist yet — first
> step is to create the repo + Vercel project).

```
Stuart French here. This is a brand-new Next.js app that becomes
marketing.aiglitch.app. It's a sister to admin.aiglitch.app
(comfybear71/admin-aiglitch) — same pattern, same backend
(api.aiglitch.app, the aiglitch-api repo). Reasons for splitting:
ease of work scope + security isolation + so I can iterate on the
marketing tooling without redeploying the whole admin.

Repo to create: comfybear71/marketing-aiglitch
Vercel project to create: marketing-aiglitch
Domain: marketing.aiglitch.app
Backend: api.aiglitch.app (call /api/admin/* routes there — same
proxy pattern as admin-aiglitch uses for everything except the
admin auth POST).

Goals for THIS session (bootstrap only):
1. Next.js 14 App Router scaffold matching admin-aiglitch's structure.
2. Login page that POSTs to api.aiglitch.app/api/auth/admin (same
   admin password as the existing admin).
3. Empty layout + sidebar with placeholder navigation entries for
   the 9 tabs that will move here in later sessions:
   AI Costs, Events, Ad Campaigns, Sponsors, X Growth, Spec Ads,
   Merch Studio, Emails, Contact, plus an Ad Creator entry that
   will be built fresh (consumes aiglitch-api sessions 2-4).
4. NO tab content yet — just placeholders that say "Coming in
   session N — see docs/ROADMAP.md in aiglitch-api".
5. Cookie scoping: scoped to .aiglitch.app domain so admin auth
   cookie carries across all 3 admin subdomains (admin / marketing
   / trading). Confirm with the user before shipping if uncertain.
6. CI/CD: GitHub Actions on push to main → Vercel auto-deploy.
   Vitest in the workflow.

Constraints:
- Reuse admin-aiglitch's design tokens / Tailwind config if possible
  — copy them into this repo, don't try to share a package yet.
- No backend changes. The backend already exists.
- Follow Rule 5 — PR handoff format (read aiglitch-api's CLAUDE.md
  if you don't know it).

Deliverable: working empty shell deployed at marketing.aiglitch.app,
admin login round-trips successfully, sidebar shows 10 placeholder
tabs. PR + tag + release notes per Rule 5.
```

---

## How a future session opens

1. Read this file. Identify the lowest-numbered ⬜ session.
2. Confirm with the user it's still the right next step (priorities shift).
3. Branch `claude/<session-N>-<short-name>` off master.
4. Build + test + push.
5. Deliver Rule 5 handoff. User reviews + merges + tags.
6. Tick the ⬜ → ✅ checkbox in this file in the same commit.

If the session uncovers new work, add it to the table with the next
sequential number rather than splitting commits across multiple
sessions.

---

## Status at the time of writing (2026-06-18)

- Grok video upgraded to 1.5 (v1.48.0) — synced audio, better motion, 2x speed.
- HeyGen Avatar V wired up for breaking-news anchor (v1.49.0). Currently running anchor-only (no intro/outro) until session 1 (ffmpeg stitcher) brings them back.
- HeyGen catalog endpoint (v1.49.1) — admin can list avatars + voices.
- Force-trigger diagnostic surface (v1.49.2) — `lastForceTrigger` in GET status payload lets us diagnose silent failures from Safari without scraping Vercel logs.
- Chaos drops library expanded to 100 scenarios (v1.46.0).
- Topic expiry bug fixed (v1.47.0) — breaking news now fires naturally without `force_trigger`.
- 4 known-broken admin pages flagged for fixing during tab moves.
- 2 sister repos pending creation: marketing-aiglitch, trading-aiglitch.

Next ship target: ffmpeg stitcher (session 1).
