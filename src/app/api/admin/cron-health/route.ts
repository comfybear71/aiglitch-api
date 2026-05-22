import { NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";

export const maxDuration = 60;

const CRON_SCHEDULE = [
  { path: "/api/generate", schedule: "*/30 * * * *", name: "Post generation" },
  { path: "/api/generate-topics", schedule: "0 */2 * * *", name: "Topic generation" },
  { path: "/api/generate-persona-content", schedule: "*/40 * * * *", name: "Persona content" },
  { path: "/api/generate-ads", schedule: "0 */4 * * *", name: "Ad generation" },
  { path: "/api/generate-chaos-drop", schedule: "0 */2 * * *", name: "Chaos drops" },
  { path: "/api/ai-trading", schedule: "*/30 * * * *", name: "AI trading" },
  { path: "/api/budju-trading", schedule: "*/30 * * * *", name: "BUDJU trading" },
  { path: "/api/generate-avatars", schedule: "0 */2 * * *", name: "Avatar generation" },
  { path: "/api/generate-director-movie", schedule: "0 */2 * * *", name: "Director movies" },
  { path: "/api/persona-comments", schedule: "0 */2 * * *", name: "Persona comments" },
  { path: "/api/marketing-post", schedule: "0 */4 * * *", name: "Marketing posts" },
  { path: "/api/marketing-metrics", schedule: "0 * * * *", name: "Marketing metrics" },
  { path: "/api/feedback-loop", schedule: "0 */6 * * *", name: "Feedback loop" },
  { path: "/api/telegram/credit-check", schedule: "*/30 * * * *", name: "Telegram credits" },
  { path: "/api/telegram/status", schedule: "0 */6 * * *", name: "Telegram status" },
  { path: "/api/telegram/persona-message", schedule: "0 */3 * * *", name: "Telegram messages" },
  { path: "/api/x-react", schedule: "*/30 * * * *", name: "X reactions" },
  { path: "/api/bestie-life", schedule: "0 8,20 * * *", name: "Bestie life events" },
  { path: "/api/admin/elon-campaign", schedule: "0 12 * * *", name: "Elon campaign" },
  { path: "/api/admin/budju-trading", schedule: "*/10 * * * *", name: "BUDJU admin" },
  { path: "/api/sponsor-burn", schedule: "0 0 * * *", name: "Sponsor burn" },
  { path: "/api/x-dm-poll", schedule: "0 * * * *", name: "X DM polling" },
];

export async function GET(req: NextRequest) {
  try {
    const isAdmin = await isAdminAuthenticated(req);
    if (!isAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    return NextResponse.json({
      timestamp: new Date().toISOString(),
      status: "cron-infrastructure-registered",
      note: "All 22 crons are currently scheduled in aiglitch (legacy). Execution monitoring will be available after migration to aiglitch-api.",
      totalCrons: CRON_SCHEDULE.length,
      crons: CRON_SCHEDULE.map((cron) => ({
        path: cron.path,
        name: cron.name,
        schedule: cron.schedule,
        currentLocation: "aiglitch.app/api/*",
        targetLocation: "api.aiglitch.app/api/* (pending migration)",
      })),
      nextSteps: [
        "Crons remain active in aiglitch until handlers are migrated",
        "Once business logic libs are ported, handlers will move to aiglitch-api",
        "Execution history will be tracked in cron_runs table after migration",
      ],
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: errorMsg }, { status: 500 });
  }
}
