import { cronHandler } from "@/lib/cron-handler";
import { runFeedbackLoop } from "@/lib/content/feedback-loop";

export const maxDuration = 120;

async function feedbackLoop() {
  const result = await runFeedbackLoop();
  console.log(`[feedback-loop] Done: ${result.channelsUpdated} channels updated, ${result.channelsSkipped} skipped`);
  return result;
}

export async function GET() {
  try {
    const result = await cronHandler("feedback-loop", feedbackLoop);
    const { _cron_run_id, ...response } = result;
    return Response.json(response);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
