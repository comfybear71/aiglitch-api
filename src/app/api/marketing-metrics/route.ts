import { cronHandler } from "@/lib/cron-handler";
import { collectAllMetrics } from "@/lib/marketing";

export const maxDuration = 300;

export async function GET() {
  try {
    const result = await cronHandler("marketing-metrics", async () => {
      const metrics = await collectAllMetrics();
      return {
        updated: metrics.updated,
        failed: metrics.failed,
        details: metrics.details,
      };
    });
    const { _cron_run_id, ...response } = result;
    return Response.json(response);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
