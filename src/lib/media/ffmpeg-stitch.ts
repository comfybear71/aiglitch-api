/**
 * MP4 stitcher with re-encode normalization — designed for mixed-codec
 * input (Grok + HeyGen + future providers).
 *
 * The legacy stitcher (`mp4-concat.ts`) does byte-level concatenation
 * which only works when all clips share identical codec parameters.
 * That breaks the moment we mix Grok output (one H.264 profile) with
 * HeyGen output (different H.264 profile + always has audio) with
 * future ffmpeg-rendered title cards.
 *
 * Two-pass algorithm:
 *
 *   PASS 1 — per clip, re-encode to common profile:
 *     - video: H.264 baseline @ 720x1280 9:16 portrait, yuv420p
 *     - audio: AAC stereo 44.1kHz; silent track injected when source is mute
 *     - faststart muxer flag so the moov atom is at the front
 *
 *   PASS 2 — concat demuxer with `-c copy` (no re-encode since all
 *   inputs are now the same profile). Fast — just stream copy.
 *
 * Audio handling: ffmpeg detects mute clips via `-i` stderr probe, then
 * either re-encodes original audio (preserving HeyGen TTS voice) OR
 * injects an anullsrc silent track of matching duration. Without this,
 * a Grok-1.0-silent intro stitched with a HeyGen-spoken anchor would
 * either error or produce broken audio sync.
 *
 * Performance: ~30-60s of re-encode wall time per 30s of output on a
 * Vercel `nodejs` runtime. Vercel function `maxDuration` should be
 * ≥120s for breaking-news (3 clips = 30s output). Cold start adds ~5s
 * to load the ffmpeg binary from `node_modules`.
 *
 * Storage: temp files in `/tmp` (writable on Vercel serverless). All
 * intermediates are cleaned up in a finally block, even on error.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import ffmpegPathOrNull from "ffmpeg-static";

/** Resolves the bundled ffmpeg binary path; throws if the dep is missing. */
function ffmpegPath(): string {
  if (!ffmpegPathOrNull) {
    throw new Error("ffmpeg-static binary not available — check node_modules");
  }
  return ffmpegPathOrNull;
}

export interface StitchOptions {
  /** Output video width. Default 720 (matches Grok / HeyGen 9:16 output). */
  width?: number;
  /** Output video height. Default 1280. */
  height?: number;
  /** Audio sample rate. Default 44100. */
  audioSampleRate?: number;
  /** Output audio bitrate. Default `128k`. */
  audioBitrate?: string;
  /** Optional override for the workdir; default is os.tmpdir(). */
  workDir?: string;
}

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn a process and capture stdout/stderr. Resolves on exit with
 * code + buffers — does NOT throw on non-zero exit so callers can
 * inspect ffmpeg stderr to diagnose codec / mapping errors.
 */
async function spawnCapture(
  cmd: string,
  args: string[],
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      }),
    );
  });
}

/**
 * Probe for an audio stream by running ffmpeg with `-f null` and
 * parsing stderr. Avoids adding an `ffprobe-static` dep — ffmpeg itself
 * prints the stream summary to stderr regardless of output.
 */
async function hasAudioStream(inputPath: string): Promise<boolean> {
  const res = await spawnCapture(ffmpegPath(), [
    "-hide_banner",
    "-i",
    inputPath,
    "-f",
    "null",
    "-",
  ]);
  // ffmpeg formats stream lines like "Stream #0:1[0x2](eng): Audio: aac (LC)..."
  // The `-f null` muxer will exit code 0 if it successfully processed every
  // stream — we don't actually care about the code, only the stderr text.
  return /Stream #\d+:\d+[^A-Za-z]*Audio:/i.test(res.stderr);
}

/**
 * Pass 1 — re-encode one input to the common output profile. Adds
 * silent audio when the input is mute so the concat demuxer in pass 2
 * doesn't trip over stream-mismatch.
 */
async function normalizeClip(
  inputPath: string,
  outputPath: string,
  opts: Required<Omit<StitchOptions, "workDir">>,
): Promise<void> {
  const hasAudio = await hasAudioStream(inputPath);
  const vf = `scale=${opts.width}:${opts.height}:force_original_aspect_ratio=decrease,pad=${opts.width}:${opts.height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`;

  // Building args — sharing the video encode block across both branches.
  const videoCommon = [
    "-vf",
    vf,
    "-c:v",
    "libx264",
    "-profile:v",
    "baseline",
    "-level",
    "3.1",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "veryfast",
  ];
  const audioCommon = [
    "-c:a",
    "aac",
    "-b:a",
    opts.audioBitrate,
    "-ar",
    String(opts.audioSampleRate),
    "-ac",
    "2",
  ];

  let args: string[];
  if (hasAudio) {
    args = [
      "-y",
      "-hide_banner",
      "-i",
      inputPath,
      ...videoCommon,
      ...audioCommon,
      "-movflags",
      "+faststart",
      outputPath,
    ];
  } else {
    // Inject silent audio with `anullsrc` and bound it to the video
    // duration via `-shortest`. Without `-shortest`, anullsrc would
    // emit forever and ffmpeg would write a never-ending file.
    args = [
      "-y",
      "-hide_banner",
      "-i",
      inputPath,
      "-f",
      "lavfi",
      "-i",
      `anullsrc=channel_layout=stereo:sample_rate=${opts.audioSampleRate}`,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      ...videoCommon,
      ...audioCommon,
      "-shortest",
      "-movflags",
      "+faststart",
      outputPath,
    ];
  }

  const res = await spawnCapture(ffmpegPath(), args);
  if (res.exitCode !== 0) {
    throw new Error(
      `ffmpeg normalize failed (exit ${res.exitCode}): ${res.stderr.slice(-400)}`,
    );
  }
}

/**
 * Pass 2 — concat the already-normalized clips with stream copy.
 * Uses the concat demuxer which expects a list file of `file '<path>'`
 * lines.
 */
async function concatNormalized(
  normalizedPaths: string[],
  listFilePath: string,
  outputPath: string,
): Promise<void> {
  const listBody = normalizedPaths
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join("\n");
  await fs.writeFile(listFilePath, listBody, "utf8");

  const res = await spawnCapture(ffmpegPath(), [
    "-y",
    "-hide_banner",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFilePath,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    outputPath,
  ]);

  if (res.exitCode !== 0) {
    throw new Error(
      `ffmpeg concat failed (exit ${res.exitCode}): ${res.stderr.slice(-400)}`,
    );
  }
}

/**
 * Public entry point — re-encode + concat a list of MP4 buffers into a
 * single stitched MP4 buffer. Safe for mixed-codec inputs. Returns the
 * final MP4 bytes ready to upload to Vercel Blob.
 */
export async function stitchClipsWithReencode(
  clips: Buffer[],
  opts: StitchOptions = {},
): Promise<Buffer> {
  if (clips.length === 0) {
    throw new Error("stitchClipsWithReencode: at least one clip required");
  }
  if (clips.length === 1) {
    // No stitching needed — single clip still benefits from normalization
    // for downstream consistency, but skip the concat pass.
    const single = await normalizeOne(clips[0]!, opts);
    return single;
  }

  const fullOpts: Required<Omit<StitchOptions, "workDir">> = {
    width: opts.width ?? 720,
    height: opts.height ?? 1280,
    audioSampleRate: opts.audioSampleRate ?? 44100,
    audioBitrate: opts.audioBitrate ?? "128k",
  };

  const root = join(opts.workDir ?? tmpdir(), `aig-stitch-${randomUUID()}`);
  await fs.mkdir(root, { recursive: true });

  const inputPaths: string[] = [];
  const normalizedPaths: string[] = [];
  const listFilePath = join(root, "concat.txt");
  const outputPath = join(root, "output.mp4");

  try {
    // Write each clip to disk first — ffmpeg needs file inputs for the
    // -f null probe trick and for predictable seeking.
    for (let i = 0; i < clips.length; i++) {
      const ip = join(root, `input_${i}.mp4`);
      await fs.writeFile(ip, clips[i]!);
      inputPaths.push(ip);
    }

    // Pass 1 — normalize sequentially. Parallelism would race for CPU
    // and we're on a single Vercel function CPU anyway.
    for (let i = 0; i < inputPaths.length; i++) {
      const np = join(root, `normalized_${i}.mp4`);
      await normalizeClip(inputPaths[i]!, np, fullOpts);
      normalizedPaths.push(np);
    }

    // Pass 2 — concat with stream copy.
    await concatNormalized(normalizedPaths, listFilePath, outputPath);

    return await fs.readFile(outputPath);
  } finally {
    // Always sweep — even on a warm Vercel container, leaving 100s of MB
    // of temp files behind eats into the 512MB /tmp ceiling.
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Single-clip normalize. Pulled out so the 1-clip fast-path can skip
 * concat without duplicating logic.
 */
async function normalizeOne(
  buf: Buffer,
  opts: StitchOptions,
): Promise<Buffer> {
  const fullOpts: Required<Omit<StitchOptions, "workDir">> = {
    width: opts.width ?? 720,
    height: opts.height ?? 1280,
    audioSampleRate: opts.audioSampleRate ?? 44100,
    audioBitrate: opts.audioBitrate ?? "128k",
  };
  const root = join(opts.workDir ?? tmpdir(), `aig-stitch-${randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  const inputPath = join(root, "input.mp4");
  const outputPath = join(root, "output.mp4");
  try {
    await fs.writeFile(inputPath, buf);
    await normalizeClip(inputPath, outputPath, fullOpts);
    return await fs.readFile(outputPath);
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

/** Re-export for ad-hoc consumers that want their own probe. */
export const __test = { hasAudioStream, spawnCapture };
