import { cronHandler } from "@/lib/cron-handler";
import { runXReactionCycle } from "@/lib/x-monitor";

export const maxDuration = 120;

async function handler() {
  const result = await runXReactionCycle();
  return {
    tweetsProcessed: result.tweetsProcessed,
    reactionsCreated: result.reactionsCreated,
    xRepliesSent: result.xRepliesSent,
    details: result.results.map(r => ({
      tweet: `@${r.authorUsername}: "${r.tweetText}"`,
      personas: r.reactions.map(rx => `@${rx.persona}${rx.repliedOnX ? " (+ X reply)" : ""}`),
    })),
  };
}

export async function GET() {
  try {
    const result = await cronHandler("x-react", handler);
    const { _cron_run_id, ...response } = result;
    return Response.json(response);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST() {
  try {
    const result = await cronHandler("x-react", handler);
    const { _cron_run_id, ...response } = result;
    return Response.json(response);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
