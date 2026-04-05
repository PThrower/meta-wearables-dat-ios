/**
 * SessionExport — converts recorded session segments to downloadable mp4
 *
 * Fetches mjpeg video segments (and optional PCM audio chunks) from R2,
 * writes to temp files, runs ffmpeg to produce H.264 mp4, streams result.
 *
 * Routes:
 *   GET /session/{id}/video.mp4        — video only
 *   GET /session/{id}/video.mp4?audio  — video + audio mixed in
 *   GET /session/{id}/export           — JSON metadata (segment counts, etc.)
 */

import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ObjectStore } from "@ebowwa/object-store";

export interface ExportOptions {
  sessionId: string;
  store: ObjectStore;
  includeAudio: boolean;
  ffmpegPath?: string;
}

export class ExportError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * Export a recorded session as mp4 via temp files + ffmpeg.
 * Returns { stream, cleanup } — caller MUST call cleanup() when done.
 */
export async function exportSessionMp4(opts: ExportOptions): Promise<{
  stream: ReadableStream<Uint8Array>;
  cleanup: () => Promise<void>;
}> {
  const { sessionId, store, includeAudio, ffmpegPath = "ffmpeg" } = opts;

  // 1. Discover video segments
  const segKeys = (await store.list(`sessions/${sessionId}/video/`))
    .filter(k => k.endsWith(".mjpeg"))
    .sort();

  if (segKeys.length === 0) {
    throw new ExportError("No video segments found", 404);
  }

  // 2. Discover audio chunks
  let audioKeys: string[] = [];
  if (includeAudio) {
    audioKeys = (await store.list(`sessions/${sessionId}/audio/`))
      .filter(k => k.endsWith(".pcm"))
      .sort();
  }

  console.log(
    `[export] Session ${sessionId.slice(0, 8)}: ` +
    `${segKeys.length} video segs` +
    (audioKeys.length > 0 ? `, ${audioKeys.length} audio chunks` : "")
  );

  // 3. Create temp dir and write concatenated input files
  const tmp = await mkdtemp(join(tmpdir(), `export-${sessionId.slice(0, 8)}-`));
  const videoPath = join(tmp, "video.mjpeg");
  const audioPath = join(tmp, "audio.pcm");
  const outPath = join(tmp, "output.mp4");

  try {
    // Fetch and concatenate video segments
    const videoParts: Buffer[] = [];
    for (const key of segKeys) {
      const buf = await store.get(key);
      if (buf) videoParts.push(buf);
    }
    await writeFile(videoPath, Buffer.concat(videoParts));

    // Fetch and concatenate audio chunks (if any)
    const hasAudio = audioKeys.length > 0;
    if (hasAudio) {
      const audioParts: Buffer[] = [];
      for (const key of audioKeys) {
        const buf = await store.get(key);
        if (buf) audioParts.push(buf);
      }
      await writeFile(audioPath, Buffer.concat(audioParts));
    }

    console.log(
      `[export] Session ${sessionId.slice(0, 8)}: video=${videoParts.reduce((s, b) => s + b.length, 0)} bytes, ` +
      (hasAudio ? `audio=${audioParts.reduce((s, b) => s + b.length, 0)} bytes` : "no audio")
    );

    // 4. Build ffmpeg command
    // image2pipe reads concatenated JPEG frames from a file (mjpeg_pipe only works on pipes)
    const args: string[] = [
      "-framerate", "15",
      "-f", "image2pipe",
      "-vcodec", "mjpeg",
      "-i", videoPath,
    ];

    if (hasAudio) {
      args.push(
        "-f", "s16le",
        "-ar", "48000",
        "-ac", "1",
        "-i", audioPath,
      );
    }

    args.push(
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-preset", "fast",
      "-crf", "23",
    );

    if (hasAudio) {
      args.push("-c:a", "aac", "-b:a", "128k");
    }

    args.push(
      "-y",
      "-f", "mp4",
      "-movflags", "frag_keyframe+empty_moov",
      outPath,
    );

    console.log(`[export] ffmpeg ${args.join(" ")}`);

    // 5. Run ffmpeg
    const proc = Bun.spawn([ffmpegPath, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    if (exitCode !== 0) {
      console.error(`[export] ffmpeg exited ${exitCode}: ${stderr.slice(0, 1000)}`);
      throw new ExportError(`ffmpeg failed (code ${exitCode})`, 500);
    }

    console.log(`[export] Session ${sessionId.slice(0, 8)}: mp4 export complete`);

    // 6. Stream the output file
    const file = Bun.file(outPath);
    if (!(await file.exists())) {
      throw new ExportError("ffmpeg produced no output", 500);
    }

    return {
      stream: file.stream(),
      cleanup: () => rm(tmp, { recursive: true, force: true }),
    };
  } catch (err) {
    // Clean up temp files on error
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Get metadata about what's available for export.
 */
export async function getSessionExportMeta(sessionId: string, store: ObjectStore) {
  const videoKeys = (await store.list(`sessions/${sessionId}/video/`))
    .filter(k => k.endsWith(".mjpeg"));
  const audioKeys = (await store.list(`sessions/${sessionId}/audio/`))
    .filter(k => k.endsWith(".pcm"));
  const meta = await store.get(`sessions/${sessionId}/meta.json`);

  return {
    sessionId,
    videoSegments: videoKeys.length,
    audioChunks: audioKeys.length,
    hasAudio: audioKeys.length > 0,
    meta: meta ? JSON.parse(new TextDecoder().decode(meta)) : null,
  };
}
