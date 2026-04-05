/**
 * SessionExport — converts recorded session segments to downloadable mp4
 *
 * Fetches mjpeg video segments (and optional PCM audio chunks) from R2,
 * writes input to temp files, then pipes ffmpeg output directly to the
 * HTTP response as a streaming mp4.
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
 * Export a recorded session as streaming mp4.
 * Writes input files to temp dir, pipes ffmpeg stdout directly as response.
 * Caller receives { response, cleanup } — cleanup removes temp files after streaming.
 */
export async function exportSessionMp4(opts: ExportOptions): Promise<{
  response: Response;
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

  // Fetch and concatenate video segments
  const videoParts: Buffer[] = [];
  for (const key of segKeys) {
    const buf = await store.get(key);
    if (buf) videoParts.push(buf);
  }
  await writeFile(videoPath, Buffer.concat(videoParts));

  // Fetch and concatenate audio chunks (if any)
  const hasAudio = audioKeys.length > 0;
  const audioParts: Buffer[] = [];
  if (hasAudio) {
    for (const key of audioKeys) {
      const buf = await store.get(key);
      if (buf) audioParts.push(buf);
    }
    await writeFile(audioPath, Buffer.concat(audioParts));
  }

  console.log(
    `[export] Session ${sessionId.slice(0, 8)}: video=${videoParts.reduce((s: number, b: Buffer) => s + b.length, 0)} bytes, ` +
    (hasAudio ? `audio=${audioParts.reduce((s: number, b: Buffer) => s + b.length, 0)} bytes` : "no audio")
  );

  // 4. Build ffmpeg command — output to stdout for streaming
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
    "-f", "mp4",
    "-movflags", "frag_keyframe+empty_moov",
    "pipe:1",           // stream mp4 to stdout
  );

  console.log(`[export] ffmpeg ${args.join(" ")}`);

  // 5. Spawn ffmpeg — pipe stdout directly to HTTP response
  const proc = Bun.spawn([ffmpegPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  // Wrap stdout as a web ReadableStream
  const reader = proc.stdout.getReader();
  const mp4Stream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { controller.close(); return; }
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      proc.kill();
    },
  });

  // Fire-and-forget stderr logging
  proc.exited.then(async (code) => {
    const stderr = await new Response(proc.stderr).text();
    if (code !== 0) {
      console.error(`[export] ffmpeg exited ${code}: ${stderr.slice(0, 500)}`);
    } else {
      console.log(`[export] Session ${sessionId.slice(0, 8)}: mp4 stream complete`);
    }
    // Clean up temp files after ffmpeg exits
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  const response = new Response(mp4Stream, {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Disposition": `inline; filename="session-${sessionId.slice(0, 8)}.mp4"`,
    },
  });

  return {
    response,
    cleanup: () => rm(tmp, { recursive: true, force: true }),
  };
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
