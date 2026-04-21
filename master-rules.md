# Master Rules — All Projects

> **One URL to rule them all.** Paste this into any Claude Code session:
> `https://raw.githubusercontent.com/comfybear71/Master/master/docs/prompts/master-rules.md`
>
> Or just paste the line:
> `Before doing anything, read and follow ALL rules at: https://raw.githubusercontent.com/comfybear71/Master/master/docs/prompts/master-rules.md — acknowledge each section before proceeding.`

---

## RULE 1 — Discuss before coding

Before writing ANY code, making ANY commits, or running ANY destructive commands:

1. **Restate** what you think I'm asking for — in your own words
2. **Propose your plan** — list files, functions, APIs, DB fields, UI changes
3. **Flag risks** — what could break? what assumptions are you making?
4. **Ask clarifying questions** if anything is ambiguous — don't guess
5. **WAIT** for my explicit "go ahead" / "build it" / "yes" before writing code

**Safe without asking:** reading files, ls/grep/git status, GET-only API calls, type-checks, tests that don't modify anything.

**Exceptions:** trivial bug fix in a file you're already editing, or genuine emergency (tell me in one line BEFORE acting).

---

## RULE 2 — Sacred files (NEVER delete)

- `CLAUDE.md`
- `HANDOFF.md`
- `SAFETY-RULES.md`
- `README.md`

If you want to modify these, ask first. If a previous Claude deleted or corrupted them, STOP and tell me — we restore from a previous commit, NOT from memory.

---

## RULE 3 — Branch protection is ACTIVE on master

All 7 repos have branch protection under the "Protect Master" ruleset:

- You **CANNOT** push directly to master. Ever.
- You **CANNOT** force-push anything.
- You **CANNOT** delete master.
- Linear history is enforced — squash-merge only, no merge commits.
- Required PR approvals = 0 (I can self-merge).

**Workflow:**
1. Create a new branch: `claude/<feature-name>` off master
2. Make small, atomic commits
3. Push to the feature branch freely
4. **STOP and tell me when ready.** I open the PR, squash-merge, delete the branch, and tag the release via the GitHub web UI.
5. You do **NOT** open PRs, merge PRs, delete branches, or tag releases yourself. That's always my job.

---

## RULE 4 — Fix-spiral prevention (MANDATORY COUNTING)

When fixing a bug or error, you MUST count every attempt out loud:

1. Type this header BEFORE each fix attempt:
   `## FIX ATTEMPT [N] OF 3: [what I'm trying]`

2. At attempt 3, include a warning:
   `## FIX ATTEMPT 3 OF 3 (FINAL): [what I'm trying]`
   `⚠️ This is my last attempt.`

3. **After attempt 3 fails, STOP.** Output this template:

```
## 🛑 FIX SPIRAL STOPPED — 3 ATTEMPTS EXHAUSTED

**What I was trying to fix:** [description]
**What I tried:**
1. Attempt 1: [what] → [result]
2. Attempt 2: [what] → [result]
3. Attempt 3: [what] → [result]

**What I think the real issue is:** [assessment]
**What I don't know:** [gaps]
**What the next session should check:** [steps]

I am now STOPPED. I will not attempt another fix unless you
explicitly tell me to continue with a specific approach.
```

4. Do **NOT** restart the counter for the same underlying task.
5. "Each fix felt trivial" is **NOT** an excuse to skip counting.

---

## RULE 5 — Complete PR handoff format (MANDATORY)

When work is ready, deliver the handoff in this EXACT format. Every section must be in a copy-paste code block so I can paste directly into GitHub's UI.

**Required sections (in this order):**

### 1. Compare URL
Plain text, clickable:
`https://github.com/comfybear71/<REPO>/compare/master...claude/<BRANCH>`

### 2. PR Title
Inside a code block:
```
<one-line title, max 70 chars>
```

### 3. PR Description
Inside a markdown code block:
```markdown
## Summary
<1-3 sentence overview>

## Changes
- <file>: <what changed>

## Test plan
- [x] Type check passes
- [ ] <manual verification steps>
```

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
| **Create via** | `https://github.com/comfybear71/<REPO>/releases/new` |

Then the tag description inside a code block:
```markdown
## v<semver>

### New
- <what shipped>

### Fixed
- <what was fixed>
```

**Rules about release tags:**
- Every PR gets a tag. No exceptions. Small or large change.
- Check existing tags first (`git tag --list` or GitHub Releases page).
- Tag naming: patch `v1.2.3`, minor `v1.3.0`, major `v2.0.0`, docs `v1.2.3-docs`, recovery `v1.2.3-recovery`.
- Never create the tag yourself — only suggest it. I create via GitHub UI.

---

## RULE 6 — Trading projects (BUDJU) — extra caution

If working on `budju-xyz` or any trading-related code:
- Do **NOT** modify trading logic, order processing, or wallet code without my explicit written confirmation.
- Branch protection and docs changes are fine.
- When in doubt, **ASK**.

---

## RULE 7 — When something breaks

- **STOP** and diagnose before fixing.
- **NEVER** do a blanket revert touching 5+ files.
- **NEVER** batch-delete files to "start fresh."
- If 3+ failed fix attempts, output the FIX SPIRAL STOPPED template (Rule 4).
- Small, atomic commits only — one logical change per commit.

---

## RULE 8 — End of session

Before wrapping up:
- Push all commits to the feature branch.
- Deliver the complete PR handoff (Rule 5) with all 5 sections.
- Include the release tag suggestion.
- Wait for me to merge via GitHub web UI.
- Next session: update HANDOFF.md with session log.

---

## Your acknowledgement

After reading these rules, respond with:

"All 8 rules acknowledged. I'll discuss before coding, count fix attempts out loud, deliver complete PR handoffs with release tags, and never delete sacred files. Waiting for your task."

Then wait for me to give you the specific task for this session.

---

## Reference

These rules are maintained in the MasterHQ repo:
- Full prompts collection: `docs/prompts/` (5 prompts with examples)
- Code Preservation Protocol: `docs/code-preservation-protocol.md`
- Safety Rules: `SAFETY-RULES.md`
- Project context: `CLAUDE.md` + `HANDOFF.md` in each repo

**Owner:** Stuart French (comfybear71) — solo developer, works from iPad/phone, drives merges via GitHub web UI.
