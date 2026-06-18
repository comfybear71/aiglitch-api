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
| 1 | **ffmpeg stitcher** — re-encode + concat to support mixed-codec (Grok + HeyGen) clips. Originally wired into breaking-news Mode B; Mode B reverted in v1.51.2 after deploy-pipeline thrash. Library preserved for Ad Creator. | aiglitch-api | ✅ v1.50.0 (parked, breaking-news no longer consumes) | `ffmpeg-static` bundled, `serverExternalPackages` pattern documented in lessons-learned. See "Status at the time of writing" for what to know before reusing this in sessions 2-4. |
| 2 | **Ad Creator backend — part 1**: schema + admin endpoints + asset upload. New tables `ad_briefs` + `ad_brief_assets`. CRUD + Vercel Blob client-upload endpoint for existing-media uploads. No generation yet. | aiglitch-api | ✅ v1.52.0 | Hangs off `/api/admin/ads/*`. Session 4's upload-existing-media path was folded in here since the upload endpoint is part of the same surface. |
| 3 | **Ad Creator backend — part 2**: generation pipeline. Brief → Claude script → HeyGen anchor + Grok b-roll (parallel) → ffmpeg stitch → Blob → For You feed post. Diagnostic surface (generation_log column) mirrors breaking-news `lastForceTrigger`. Cost cap (default $5/run) + serverExternalPackages for ffmpeg-static both shipped. | aiglitch-api | ✅ v1.53.0 | Lessons applied: text-to-video uses 1.0, image-to-video would use 1.5 (future), `serverExternalPackages: ['ffmpeg-static']` set, `allowOverwrite: true` discipline, per-step diagnostic log, pre-flight cost check refuses upfront. |
| ~~4~~ | ~~Ad Creator backend — part 3: upload-existing-media path~~ — folded into session 2 since the upload endpoint shares the same `/api/admin/ads/[id]/*` surface. | — | ✅ rolled into v1.52.0 | — |
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
> step is to create the repo + Vercel project + DNS, see operator
> checklist below).
>
> Most context (sister-repo rules, Rule 5 PR format, etc.) lives in
> the **CLAUDE.md template** at `docs/sister-repo-templates/` in the
> aiglitch-api repo. The prompt below tells the new Claude session to
> copy that template into the new repo as its CLAUDE.md, so we don't
> have to repeat the whole thing in every bootstrap prompt.

```
Stuart French here. This is a brand-new Next.js app that becomes
marketing.aiglitch.app. It's a sister to admin.aiglitch.app
(comfybear71/admin-aiglitch) — same pattern, same backend
(api.aiglitch.app, the aiglitch-api repo). Reasons for splitting:
ease of work scope + security isolation + so I can iterate on the
marketing tooling without redeploying the whole admin.

FIRST THING — set up the project brain:
1. Download the CLAUDE.md and HANDOFF.md templates from aiglitch-api:
     curl -O https://raw.githubusercontent.com/comfybear71/aiglitch-api/master/docs/sister-repo-templates/CLAUDE-frontend-template.md
     mv CLAUDE-frontend-template.md CLAUDE.md
     curl -O https://raw.githubusercontent.com/comfybear71/aiglitch-api/master/docs/sister-repo-templates/HANDOFF-template.md
     mv HANDOFF-template.md HANDOFF.md
2. Edit CLAUDE.md — search for `<<TEMPLATE:` markers and fill in:
     repo name = marketing-aiglitch
     project name = marketing-aiglitch
     subdomain = marketing.aiglitch.app
     "What this repo is" = the marketing-specific paragraph
3. Edit HANDOFF.md similarly — set the date, the subdomain placeholder,
   and list the planned sidebar entries.
4. Commit both files as the first commit on master.

Once CLAUDE.md is in the repo, READ IT IN FULL before doing any
further work — it has the mandatory sister-repo + Rule 5 sections
pre-filled. Confirm you've read it before continuing.

Repo: comfybear71/marketing-aiglitch (you should be in it already)
Vercel project: marketing-aiglitch (already created — Vercel
  auto-deploys on push to master)
Domain: marketing.aiglitch.app (DNS already pointed at Vercel)
Backend: api.aiglitch.app (the aiglitch-api repo). Call /api/admin/*
  routes there.

The backend is fully working as of aiglitch-api v1.53.0 (2026-06-18):
- Auth: POST https://api.aiglitch.app/api/auth/admin with
  {password: "<env ADMIN_PASSWORD>"} — sets the admin cookie.
- Ad Creator backend (the killer feature for THIS marketing app):
    GET    /api/admin/ads                — list briefs
    POST   /api/admin/ads                — create brief
    GET    /api/admin/ads/[id]           — read brief + assets + diagnostic
    PATCH  /api/admin/ads/[id]           — update
    DELETE /api/admin/ads/[id]           — soft delete
    POST   /api/admin/ads/[id]/upload    — Vercel Blob client-upload token
    DELETE /api/admin/ads/[id]/assets/[assetId] — remove asset
    POST   /api/admin/ads/[id]/generate  — generate the MP4 (3-4 min, ~$1.55)
- The diagnostic surface is in GET /api/admin/ads/[id] under
  `brief.last_video_url`, `brief.last_error`, `brief.generation_log`.

After CLAUDE.md is in place, goals for THIS session:
1. Next.js 16 App Router scaffold (matches aiglitch-api version).
2. Login page that POSTs to https://api.aiglitch.app/api/auth/admin
   with {password}. Same admin password as admin.aiglitch.app.
3. Empty layout + sidebar with placeholder navigation entries:
   - Ad Creator (THE big new tab, will land in marketing session 2)
   - Sponsors (proof-of-pattern move from admin in marketing session 3)
   - AI Costs
   - Events
   - Ad Campaigns
   - X Growth
   - Spec Ads
   - Merch Studio
   - Emails
   - Contact
4. NO tab content yet — every placeholder shows "Coming next session".
5. Cookie scoping: scoped to .aiglitch.app domain so admin auth
   cookie carries across admin / marketing / trading subdomains.
   Test by logging in on admin.aiglitch.app and confirming you stay
   authed when you navigate to marketing.aiglitch.app.
6. CI/CD: GitHub Actions on push to master → Vercel auto-deploy.
   Vitest in the workflow.

Constraints:
- Reuse admin-aiglitch's design tokens / Tailwind config — copy them
  into this repo, don't try to share a package yet.
- No backend changes. The backend already exists at api.aiglitch.app.
- Follow Rule 5 — PR handoff format. Read aiglitch-api's CLAUDE.md
  (https://github.com/comfybear71/aiglitch-api/blob/master/CLAUDE.md)
  for the format spec.
- This first session does NOT move any existing admin tabs over yet.
  Just the empty shell + login + nav. Tabs move in later sessions
  one at a time so blast radius stays small.

Deliverable: working empty shell deployed at marketing.aiglitch.app.
Admin login round-trips successfully (POST to api.aiglitch.app/api/auth/admin
returns ok and sets a cookie that lets you navigate the empty tabs).
Sidebar shows 10 placeholder entries. CI green on push. PR + tag
+ release notes per Rule 5.

Tag name for this PR: v0.1.0 (this is the first release of a new repo).
```

## Operator checklist BEFORE you paste the prompt above

You need three prereqs done. None of them are code — pure setup. ~15 min total.

### 1. Create the GitHub repo

1. Go to https://github.com/new
2. Owner: `comfybear71`
3. Repository name: `marketing-aiglitch`
4. Description: "Marketing tooling app for marketing.aiglitch.app — sister to admin-aiglitch"
5. Visibility: private (recommended) or public (your call)
6. **Don't** initialize with README/license/.gitignore — the Claude session will scaffold from scratch
7. Click "Create repository"

### 2. Create the Vercel project

1. Go to https://vercel.com/new
2. Import the `comfybear71/marketing-aiglitch` repo you just created
3. Project name: `marketing-aiglitch`
4. Framework: Next.js (auto-detected once the repo has code)
5. Skip the env-var step for now (the prompt above tells the new Claude session what to add later)
6. Click "Deploy" — it'll fail because the repo is empty, that's fine, the project link is what we needed
7. In Project Settings → Domains, add `marketing.aiglitch.app`

### 3. Point DNS

In your DNS provider (wherever aiglitch.app's records live):
- Add a CNAME record: `marketing` → `cname.vercel-dns.com`
- TTL: default
- Wait 5-15 min for propagation

When Vercel's "Domains" page shows the green "Valid Configuration" checkmark next to marketing.aiglitch.app, prereqs are done.

### 4. Start the new Claude session

1. Open a fresh Claude conversation
2. Make sure it's pointed at the new `comfybear71/marketing-aiglitch` repo
3. Paste the **Marketing repo bootstrap prompt** above
4. Claude takes it from there — scaffolds Next.js, builds login, ships PR

After that PR merges + deploys, you'll have a working marketing.aiglitch.app with an empty nav. Then we come back to the next session and start building the Ad Creator UI (which consumes the v1.53.0 backend we shipped tonight).

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

## Status at the time of writing (2026-06-18, end of HeyGen experiment)

What ships and runs today:

- **Breaking News** — back to the original Grok-only 4-clip 26s stitched format (intro + presenter + field + outro). Mode B HeyGen experiment reverted in v1.51.2.
- Grok video model selection (v1.51.1): text-to-video routes to `grok-imagine-video` (1.0), image-to-video routes to `grok-imagine-video-1.5` (better motion + native audio). xAI's 1.5 is image-only — calling it with just a prompt returns 400.
- Cost ledger fix (v1.48.0): tiered by `(model, resolution)`. Pre-v1.48 ledger numbers underreported every 720p clip by 40-180%.
- Topic `expires_at` fix (v1.47.0): breaking news fires naturally without `force_trigger` — topics rotate daily.
- Chaos drops: 100 scenarios (v1.46.0). 9 visual style families. Marketplace tilt.
- HeyGen catalog admin endpoint (v1.49.1): `GET /api/admin/heygen/catalog` lists avatar + voice IDs. Preserved for Ad Creator use.
- Force-trigger diagnostic (v1.49.2): `lastForceTrigger` in breaking-news GET status. Killer-feature for diagnosing the HeyGen failure chain without Vercel logs.
- 4 known-broken admin pages flagged for fixing during marketing-tab moves.
- 2 sister repos pending creation: marketing-aiglitch, trading-aiglitch.

Preserved parts of the HeyGen / ffmpeg infrastructure (do NOT delete, the Ad Creator will use them):

- `src/lib/ai/heygen.ts` + `.test.ts` — HeyGen V3 Avatar V client (submit / poll / generate / blob, catalog listing).
- `src/lib/media/ffmpeg-stitch.ts` + `.test.ts` — mixed-codec re-encode-and-concat stitcher.
- `next.config.ts` `outputFileTracingIncludes` + (when re-applied) `serverExternalPackages: ['ffmpeg-static']` — bundling fixes for the binary.
- `src/app/api/admin/heygen/catalog/route.ts` — admin endpoint to browse HeyGen avatars + voices.
- `package.json` `ffmpeg-static` + `@vercel/blob` `allowOverwrite` discipline — retry-safe blob writes.

## Lessons learned from the HeyGen Mode B saga (read before Ad Creator)

The Mode B experiment thrashed v1.49.0 → v1.51.2 with five cascading failures. Each was individually small but the chain was expensive in tokens, HeyGen credits, and the user's patience. Lessons to apply in sessions 2-4:

1. **xAI Grok 1.5 is image-to-video ONLY.** Pure text prompts return 400 "Text-to-video is not supported for this model." Code that uses 1.5 must guarantee a `sourceImageUrl`. We added auto-selection in v1.51.1 (text → 1.0, image → 1.5) — use that helper.
2. **Next.js 16 bundles every node_modules dep into the server JS by default.** Native binaries like `ffmpeg-static` need BOTH `serverExternalPackages: ['ffmpeg-static']` (so `__dirname` resolves correctly at runtime) AND `outputFileTracingIncludes` (so the file is in the lambda). One without the other isn't enough.
3. **Vercel Blob refuses to overwrite by default.** Any retryable path needs `allowOverwrite: true` on the `put()` call. Without it, the second attempt at a deterministic-path write fails with "blob already exists" while the first attempt's stale partial sits there forever.
4. **HeyGen mobile app catalog ≠ V3 API catalog.** The iPhone app surfaces Avatar IV (photo-to-life) and Instant Avatar template demos that aren't addressable via `POST /v3/videos` with `engine.type: 'avatar_v'`. Always use the catalog admin endpoint (`/api/admin/heygen/catalog`) or `GET /v2/avatars` directly to pick V-compatible IDs.
5. **Mixed-codec stitching IS possible** — ffmpeg re-encode-then-concat works fine (`src/lib/media/ffmpeg-stitch.ts`). Cost: ~30-60s wall time per 30s of output. Don't try `mp4-concat`'s byte-level stitcher with mixed-provider clips.
6. **Don't make a model-version upgrade the default for ALL paths in one PR.** v1.48 should have made 1.5 opt-in by `sourceImageUrl` from day one — instead the unconditional default silently broke every text-to-video path and the bug only surfaced when the field b-roll call hit production.
7. **Ship a deploy-time dry-run before adding native binary deps.** ffmpeg ENOENT could have been caught locally with a quick `npm run build && node .next/server/.../route.js` smoke test. Worth scripting before sessions 2-4 add more native deps.
8. **The diagnostic surface (v1.49.2) was the single highest-leverage thing we built.** Without `lastForceTrigger` in the GET response, we'd still be guessing at Vercel logs. Build similar surfaces into every new admin-triggered async pipeline.

Capture these in the Ad Creator backend (sessions 2-4) — same provider mix, similar surprises.

Next ship target: ROADMAP session 2 — Ad Creator backend part 1 (schema + admin endpoints), when the user is ready.
