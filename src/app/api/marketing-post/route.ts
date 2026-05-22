import { cronHandler } from "@/lib/cron-handler";
import { runMarketingCycle } from "@/lib/marketing";

export const maxDuration = 300;

export async function GET() {
  try {
    const result = await cronHandler("marketing-post", async () => {
      const cycle = await runMarketingCycle();
      return {
        posted: cycle.posted,
        failed: cycle.failed,
        skipped: cycle.skipped,
        details: cycle.details,
      };
    });
    const { _cron_run_id, ...response } = result;
    return Response.json(response);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
