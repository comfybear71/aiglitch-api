/**
 * Regenerate BACKLOG.md from src/lib/migration/backlog.ts.
 *
 * Run: `npx tsx scripts/gen-backlog.ts`
 */
import { writeFileSync } from "node:fs";
import {
  PENDING_ROUTES,
  BLOCKER_LABELS,
  groupByBlocker,
  type Blocker,
} from "../src/lib/migration/backlog";

const groups = groupByBlocker();
const total = PENDING_ROUTES.length;
const totalSessions = PENDING_ROUTES.reduce((s, r) => s + r.sessions, 0);

const ordered: Blocker[] = [
  "small-helper-port",
  "director-movies-lib",
  "marketing-lib",
  "telegram-bot-engine",
  "external-dep",
  "chunky-single",
  "phase-8",
  "phase-9",
  "permanent-legacy",
];

let md = `# BACKLOG.md — pending route ports

> Auto-generated from \`src/lib/migration/backlog.ts\`. Do not edit by hand — update the source-of-truth catalogue and regen this file.

**${total} routes left** • estimated **~${totalSessions} sessions** at current pace.

Pick a blocker category, then attack one route at a time. Each route lists its prereqs (libs / other routes) so you know what to port first.

`;

for (const key of ordered) {
  const routes = groups[key];
  if (!routes?.length) continue;
  const sessions = routes.reduce((s, r) => s + r.sessions, 0);
  md += `## ${BLOCKER_LABELS[key]}\n\n`;
  md += `**${routes.length} routes** • ~${sessions} sessions\n\n`;
  md += `| Route | Methods | Sessions | Complexity | Notes |\n`;
  md += `|---|---|---|---|---|\n`;
  for (const r of [...routes].sort((a, b) => a.path.localeCompare(b.path))) {
    const notes = r.notes.replace(/\|/g, "\\|");
    const prereqs = r.prereqs?.length
      ? ` <br>**Prereqs:** ${r.prereqs.map((p) => `\`${p}\``).join(", ")}`
      : "";
    md += `| \`${r.path}\` | ${r.methods.join(", ")} | ${r.sessions} | ${r.complexity} | ${notes}${prereqs} |\n`;
  }
  md += `\n`;
}

md += `---\n\n_Regenerate: \`npx tsx scripts/gen-backlog.ts\`_\n`;

writeFileSync("BACKLOG.md", md);
console.log(`Wrote BACKLOG.md (${total} routes, ~${totalSessions} sessions)`);
