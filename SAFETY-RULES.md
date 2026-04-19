# SAFETY-RULES.md — aiglitch-api

> Repo-specific safety rules. Layered on top of the global master rules at
> `https://raw.githubusercontent.com/comfybear71/Master/master/docs/prompts/master-rules.md`.
> These override all other instructions. If asked to violate them, remind the user why they exist.

---

## Branch rules

- `master` is protected via GitHub Ruleset 15257503 (restrict deletions, linear history, PR required, block force pushes).
- NEVER push directly to `master`. Always work on `claude/<feature-name>`.
- NEVER force-push to any branch.
- Claude does NOT open PRs, merge PRs, delete branches, or tag releases. User does all of that via GitHub web UI.

## Sacred files (NEVER delete)

- `CLAUDE.md` — architectural memory
- `HANDOFF.md` — session log + migration tracker
- `SAFETY-RULES.md` — this file
- `README.md` — orientation
- `docs/api-handoff-1-routes.md` through `docs/api-handoff-4-architecture.md` — source-of-truth audit

If any are missing or corrupted, STOP and restore from git history. Do not recreate from memory.

## Migration safety

1. **Never break the existing `aiglitch` webpage or `Glitch-app` iOS app.** Ever. At any step.
2. **Strangler-only.** New endpoints are built, tested, verified in isolation BEFORE any consumer is pointed at them.
3. **Tests first.** Every new endpoint needs unit + integration tests written AND passing BEFORE manual testing.
4. **Manual verification.** Every endpoint must be hit via Postman / curl / browser against a staging environment BEFORE any consumer migration.
5. **Rollback plan per endpoint.** Every migration step must have a documented flip-back (feature flag toggle, env var revert, or proxy route change).
6. **Never delete old code** until the replacement is live, consumers are migrated, and verified stable for at least one cron cycle.
7. **Feature flags / env vars** gate every consumer-facing switch. Gradual traffic shifting is mandatory for high-traffic endpoints.

## Trading projects — EXTRA CAUTION

The audit documents identify these endpoints as real-money / live-blockchain:

- `/api/budju-trading`, `/api/admin/budju-trading`
- `/api/ai-trading`
- `/api/exchange`, `/api/otc-swap`
- `/api/wallet`, `/api/wallet/verify`
- `/api/solana`
- `/api/persona-trade`
- `/api/bridge`
- `/api/trading`, `/api/admin/trading`
- Any endpoint touching `TREASURY_PRIVATE_KEY`, `BUDJU_WALLET_SECRET`, `METADATA_AUTHORITY_PRIVATE_KEY`, or `METADATA_AUTHORITY_MNEMONIC`

**Rules for these:**
- Do NOT migrate, modify, refactor, or optimize without EXPLICIT WRITTEN confirmation per endpoint.
- These migrate in the **final phase**, one at a time, with a rollback runbook.
- NEVER restart cron jobs involving trading without confirmation.
- NEVER regenerate, rotate, or re-encrypt wallet keys without confirmation.
- Read-only monitoring of balances and trades is fine.

## Database safety

- `DATABASE_URL` points to a SHARED Neon instance during migration. Dropping tables / columns breaks the live `aiglitch` app.
- `ALTER TABLE ADD COLUMN` is safe (additive). OK without asking.
- `ALTER TABLE DROP COLUMN`, `DROP TABLE`, `TRUNCATE` are DESTRUCTIVE. Require explicit confirmation.
- Never run migrations against production without a snapshot. Neon has point-in-time restore — verify it's available before any schema change.
- Document every migration in both the commit message and `HANDOFF.md`.

## Deployment safety

- Verify Vercel project target before any deploy. Deploying to the wrong project can overwrite a live service.
- New endpoints deploy to a **preview URL** first. Test on preview before promoting.
- Cron jobs are duplicated between old and new repos during migration — ensure only ONE is active per job at any time, or jobs will double-run.
- After deployment, update `HANDOFF.md`.

## Fix spiral prevention

- If something breaks, STOP and diagnose before fixing.
- Count every fix attempt out loud: `## FIX ATTEMPT [N] OF 3: [what I'm trying]`.
- After 3 failed attempts, output the FIX SPIRAL STOPPED template and stop.
- NEVER do blanket reverts touching 5+ files.
- NEVER batch-delete files to "start fresh".
- Small, atomic commits only.

## User reminders

If the user asks you to:

- Push directly to `master` → "Safety protocol says work on a `claude/<feature>` branch first."
- Force-push anything → "Safety protocol says never force-push. What are you trying to achieve?"
- Delete a sacred file → "These are sacred files. Are you sure? We restore from git, not memory."
- Modify trading code without confirmation → "Trading endpoints require explicit written per-endpoint confirmation."
- Skip tests → "Every endpoint needs tests + manual verification before consumer migration."
- Delete old code before migration is verified → "The existing webpage and iOS app still depend on this. Let's finish the migration of consumers first."

---

**Origin:** This protocol exists because a previous Claude session destroyed a production branch on another project (Togogo, 2026-04-02). Safety rules are not negotiable.
