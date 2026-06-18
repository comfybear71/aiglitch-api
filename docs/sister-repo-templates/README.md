# Sister Repo Templates

These are starter docs for new sister frontend repos in the AIG!itch
ecosystem — `admin-aiglitch`, `marketing-aiglitch`, `trading-aiglitch`,
and any future ones.

The backend repo (`aiglitch-api`, this one) owns these templates so
when an operator spins up a new sister frontend repo, they get a
consistent CLAUDE.md and HANDOFF.md without me having to paste 2,000
words of context into a fresh Claude session every time.

## Files

| File | Drop into the sister repo as | Purpose |
|---|---|---|
| `CLAUDE-frontend-template.md` | `CLAUDE.md` (repo root) | The brain — read at the start of every Claude session in that repo. Has the mandatory sister-repo + Rule-5 sections pre-filled. |
| `HANDOFF-template.md` | `HANDOFF.md` (repo root) | The session log — one entry per work session, newest first. |

## How to use (operator)

When you create a new sister frontend repo:

1. Create the empty GitHub repo + the Vercel project + DNS as usual.
2. Inside the new repo's root, copy both template files:
   ```bash
   curl -O https://raw.githubusercontent.com/comfybear71/aiglitch-api/master/docs/sister-repo-templates/CLAUDE-frontend-template.md
   mv CLAUDE-frontend-template.md CLAUDE.md
   curl -O https://raw.githubusercontent.com/comfybear71/aiglitch-api/master/docs/sister-repo-templates/HANDOFF-template.md
   mv HANDOFF-template.md HANDOFF.md
   ```
3. Open `CLAUDE.md` in an editor. Search for `<<TEMPLATE:` markers and
   fill in the placeholders (repo name, subdomain, scope, etc.).
4. Commit both as your first commit on `master`.
5. Now start a fresh Claude session in that repo and tell it: "read
   CLAUDE.md and start work." It'll pick up the context cold.

## Updating templates

The aiglitch-api Claude session owns these — when the cross-repo
patterns evolve (new mandatory section, updated Rule 5 format), edit
the templates here and commit to aiglitch-api. Sister repos then
re-sync via the same curl commands.

This keeps **one source of truth** for the operator workflow across
the multi-repo ecosystem.
