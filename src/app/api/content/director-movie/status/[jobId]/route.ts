import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { ensureDbReady } from "@/lib/seed";

interface JobStatus {
  jobId: string;
  status: "submitted" | "generating" | "done" | "failed";
  title?: string;
  genre?: string;
  percent?: number;
  clipsCompleted?: number;
  clipCount?: number;
  videoUrl?: string;
  error?: string;
}

export async function GET(
  request: NextRequest,
  { params }: { params: { jobId: string } }
): Promise<NextResponse<JobStatus>> {
  try {
    const { jobId } = params;

    const sql = getDb();
    await ensureDbReady();

    // Get job details
    const jobs = (await sql`
      SELECT
        j.id,
        j.title,
        j.genre,
        j.status,
        j.clip_count,
        (SELECT COUNT(*)::int FROM multi_clip_scenes WHERE job_id = j.id AND status = 'done') as clips_done
      FROM multi_clip_jobs j
      WHERE j.id = ${jobId}
    `) as unknown as Array<{
      id: string;
      title: string;
      genre: string;
      status: string;
      clip_count: number;
      clips_done: number;
    }>;

    if (!jobs || jobs.length === 0) {
      return NextResponse.json(
        {
          jobId,
          status: "failed",
          error: "Job not found",
        },
        { status: 404 }
      );
    }

    const job = jobs[0];
    const percent = job.clip_count > 0 ? Math.round((job.clips_done / job.clip_count) * 100) : 0;

    // If done, try to get video URL
    let videoUrl: string | undefined;
    if (job.status === "done") {
      const posts = (await sql`
        SELECT url FROM posts
        WHERE director_movie_id = (SELECT id FROM director_movies WHERE multi_clip_job_id = ${jobId})
        LIMIT 1
      `) as unknown as Array<{ url: string }>;

      if (posts && posts.length > 0) {
        videoUrl = posts[0].url;
      }
    }

    return NextResponse.json({
      jobId,
      status: job.status as "submitted" | "generating" | "done" | "failed",
      title: job.title,
      genre: job.genre,
      percent,
      clipsCompleted: job.clips_done,
      clipCount: job.clip_count,
      videoUrl,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("[director-movie-status] Error:", err);
    return NextResponse.json(
      {
        jobId: params.jobId,
        status: "failed",
        error: errorMsg,
      },
      { status: 500 }
    );
  }
}
