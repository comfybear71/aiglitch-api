# CLAUDE.md — <<TEMPLATE: repo name, e.g. marketing-aiglitch>>

> This file is the project's brain. Every Claude session in this repo reads it
> automatically.
> Never delete. To update, edit and commit on a feature branch.

---

## ⚠️ MANDATORY — Backend repo (`comfybear71/aiglitch-api`)

**This is not optional. Read this section before doing anything else.**

This is a frontend sister repo. It calls the AIG!itch backend at
`api.aiglitch.app`, owned by `comfybear71/aiglitch-api`. That repo
holds:

- All `/api/admin/*` routes you'll call from here
- The DB schema (Drizzle + raw SQL)
- The Vercel Blob storage layout
- Cron jobs
- Content generation pipelines (chaos drops, breaking news, ad creator, etc.)

**You MUST have the backend repo cloned and pulled fresh before
answering any question that could touch the API surface.**

### Run this at the start of every session

```bash
if [ -d /home/user/aiglitch-api ]; then
  git -C /home/user/aiglitch-api pull --ff-only
else
  git clone https://github.com/comfybear71/aiglitch-api /home/user/aiglitch-api
fi
```

Public repo. Read-only. Never edit, never push from there.

### Files to consult in aiglitch-api

| What you want to know | Read this file |
|---|---|
| All available API routes | `aiglitch-api/docs/api-handoff-1-routes.md` |
| DB tables + columns | `aiglitch-api/docs/api-handoff-2-database.md` |
| Env vars + external services | `aiglitch-api/docs/api-handoff-3-env-services.md` |
| Backend file layout + patterns | `aiglitch-api/docs/api-handoff-4-architecture.md` |
| Multi-session multi-repo plan | `aiglitch-api/docs/ROADMAP.md` |
| Where each content pipeline's prompts live | `aiglitch-api/docs/PROMPT-MAP.md` |

If you find yourself making up an API route, STOP and grep the
backend's `aiglitch-api/src/app/api/` directory instead.

---

## What this repo is

<<TEMPLATE: 2-3 sentences. Example for marketing-aiglitch:>>

`marketing-aiglitch` is the frontend for `marketing.aiglitch.app` —
the marketing tooling app. Sister to `admin-aiglitch` (which serves
`admin.aiglitch.app`) and `trading-aiglitch` (future, will serve
`trading.aiglitch.app`). All three call the shared backend at
`api.aiglitch.app`.

## What this repo is NOT

- It does NOT have its own backend. Every data action goes through
  `https://api.aiglitch.app/api/admin/*`.
- It does NOT have its own database. The backend's Postgres is the
  source of truth.
- It does NOT have its own cron jobs.
- It does NOT do auth itself. The login form POSTs to
  `https://api.aiglitch.app/api/auth/admin` and the cookie that comes
  back is scoped to `.aiglitch.app` so it works across all sister
  frontends.

## Locked architectural decisions

<<TEMPLATE: list per-repo decisions. Example placeholders below — replace.>>

| # | Decision | Value |
|---|---|---|
| 1 | Framework | Next.js 16 App Router (matches the rest of the ecosystem) |
| 2 | Hosting | Vercel — project `<<TEMPLATE: project name>>` |
| 3 | Domain | `<<TEMPLATE: subdomain.aiglitch.app>>` |
| 4 | Backend | `https://api.aiglitch.app` (do not call legacy `aiglitch.app/api/*`) |
| 5 | Auth cookie scope | `.aiglitch.app` (cross-subdomain SSO with admin / marketing / trading) |
| 6 | Styling | Tailwind + design tokens copied from `admin-aiglitch`. Do not extract a shared package yet. |
| 7 | Tests | Vitest. Run on every push via GitHub Actions. |

## How we work here

1. Every task starts with a discussion — no code until explicit "go ahead".
2. Branch per feature: `claude/<feature-name>` off `master`.
3. Small atomic commits. No PRs, merges, or tags from Claude — the user
   drives those via GitHub UI.
4. Fix spiral protocol: count attempts aloud, stop after 3, output the
   stopped-template.
5. End of session: push commits, deliver PR handoff (Rule 5 format,
   pinned below), update `HANDOFF.md`.

## Rule 5 — PR handoff format (MANDATORY, pinned)

> Pinned verbatim so sessions can't drift. When a branch is ready to ship,
> deliver the handoff in this EXACT format. Every section must be copy-paste
> ready for GitHub's UI.

**Required sections, in this order:**

### 1. Compare URL
Plain text, clickable:
`https://github.com/comfybear71/<<TEMPLATE: repo>>/compare/master...claude/<BRANCH>`

### 2. PR Title
Inside a code block:
````
```
<one-line title, max 70 chars>
```
````

### 3. PR Description
Inside a markdown code block:
````
```markdown
## Summary
<1-3 sentence overview>

## Changes
- <file>: <what changed>

## Test plan
- [x] Type check passes
- [ ] <manual verification steps>
```
````

### 4. Merge instructions
1. Open the Compare URL above
2. Click "Create pull request"
3. Scroll to bottom → ▼ dropdown → "Squash and merge"
4. Click "Confirm squash and merge"
5. Click "Delete branch"

### 5. Release tag (MANDATORY)
As a table:

| Field | Value |
|---|---|
| **Tag name** | `v<semver>-<YYYY-MM-DD>` |
| **Target** | `master` |
| **Title** | `v<semver> — <short title>` |
| **Create via** | `https://github.com/comfybear71/<<TEMPLATE: repo>>/releases/new` |

Then the tag description inside a code block:
````
```markdown
## v<semver>

### New
- <what shipped>

### Fixed
- <what was fixed>
```
````

**Rules about release tags:**
- Every PR gets a tag. No exceptions. Small or large change.
- Check existing tags first (`git tag --list` or GitHub Releases page).
- Tag naming: patch `v1.2.3`, minor `v1.3.0`, major `v2.0.0`, docs `v1.2.3-docs`, recovery `v1.2.3-recovery`.
- First release of a brand new repo: start at `v0.1.0`.
- Never create the tag yourself — only suggest it. The user creates via GitHub UI.

**Enforcement:** before writing a handoff, re-read this section. Do not reconstruct the template from memory — use what's pinned here.

## Sacred files (never delete)

`CLAUDE.md`, `HANDOFF.md`, `README.md`. If corrupted or deleted, restore
from git history, not memory.

## Owner

Stuart French (comfybear71) — solo developer. Works from PC, iPad, and
phone. Drives all merges and release tags via GitHub web UI.
