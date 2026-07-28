import { type NextRequest, NextResponse } from "next/server";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { cronHandler } from "@/lib/cron-handler";
import { runMarketingCycle } from "@/lib/marketing";

export const maxDuration = 300;

/** Admin manual trigger — bypasses activity throttle (does not use cronHandler). */
export async function POST(request: NextRequest) {
  if (!(await isAdminAuthenticated(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const cycle = await runMarketingCycle();
    return NextResponse.json({
      ok: true,
      manual: true,
      posted: cycle.posted,
      failed: cycle.failed,
      skipped: cycle.skipped,
      details: cycle.details,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

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
