/**
 * SessionExport — converts recorded session segments to downloadable mp4
 *
 * Fetches mjpeg video segments (and optional PCM audio chunks) from R2,
 * writes input to temp files, runs ffmpeg to produce mp4, caches to R2.
 *
 * Routes:
 *   GET /session/{id}/video.mp4        — video only (cached to R2 after first build)
 *   GET /session/{id}/video.mp4?audio  — video + audio mixed in
 *   GET /session/{id}/thumbnail        — first JPEG frame (cached to R2 as thumb.jpg)
 *   GET /session/{id}/export           — JSON metadata (segment counts, etc.)
 *   GET /gallery/api                   — all sessions with metadata for gallery
 */

import { join } from "node:path";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ObjectStore } from "@ebowwa/object-store";
import { canSeeInGallery } from "./permissions.js";
import type { AccessLevel, AclEntry } from "./types.js";

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

/**
 * Extract the first JPEG frame from a session's first video segment.
 * Caches the result to R2 as `sessions/<id>/thumb.jpg`.
 * Returns the JPEG Buffer or null if no video data exists.
 */
export async function getSessionThumbnail(sessionId: string, store: ObjectStore): Promise<Buffer | null> {
  const cacheKey = `sessions/${sessionId}/thumb.jpg`;
  const cached = await store.get(cacheKey);
  if (cached) return cached;

  const segKeys = (await store.list(`sessions/${sessionId}/video/`))
    .filter(k => k.endsWith(".mjpeg"))
    .sort();

  if (segKeys.length === 0) return null;

  const firstSeg = await store.get(segKeys[0]);
  if (!firstSeg || firstSeg.length < 4) return null;

  // MJPEG = concatenated JPEGs. Each starts with FF D8, ends with FF D9.
  // Extract from byte 0 to end of first FF D9 marker.
  const jpeg = extractFirstJpeg(firstSeg);
  if (!jpeg) return null;

  store.put(cacheKey, jpeg).catch(err =>
    console.error(`[export] thumbnail cache write failed:`, err.message)
  );

  console.log(`[export] Thumbnail cached for ${sessionId.slice(0, 8)}: ${jpeg.length} bytes`);
  return jpeg;
}

function extractFirstJpeg(mjpeg: Buffer): Buffer | null {
  // Find SOI marker (FF D8)
  if (mjpeg[0] !== 0xFF || mjpeg[1] !== 0xD8) return null;

  // Scan for EOI marker (FF D9)
  for (let i = 2; i < mjpeg.length - 1; i++) {
    if (mjpeg[i] === 0xFF && mjpeg[i + 1] === 0xD9) {
      return Buffer.from(mjpeg.subarray(0, i + 2));
    }
  }
  // No EOI found — return entire buffer as best-effort
  return Buffer.from(mjpeg);
}

/**
 * Check if a cached MP4 export exists in R2.
 * Returns a signed URL if found, null otherwise.
 */
export async function getCachedMp4Url(sessionId: string, store: ObjectStore): Promise<string | null> {
  const key = `sessions/${sessionId}/export.mp4`;
  const keys = await store.list(`sessions/${sessionId}/`);
  if (!keys.includes(key)) return null;

  try {
    return await store.signedUrl(key, 3600);
  } catch {
    return null;
  }
}

/**
 * Export session MP4, then persist the result to R2 for future cache hits.
 * Uses a temp file approach: ffmpeg writes to a file, we stream it to the
 * response AND upload to R2 after ffmpeg completes.
 */
export async function exportAndCacheMp4(opts: ExportOptions): Promise<Response> {
  const { sessionId, store, includeAudio, ffmpegPath = "ffmpeg" } = opts;

  const segKeys = (await store.list(`sessions/${sessionId}/video/`))
    .filter(k => k.endsWith(".mjpeg"))
    .sort();

  if (segKeys.length === 0) {
    throw new ExportError("No video segments found", 404);
  }

  let audioKeys: string[] = [];
  if (includeAudio) {
    audioKeys = (await store.list(`sessions/${sessionId}/audio/`))
      .filter(k => k.endsWith(".pcm"))
      .sort();
  }

  const tmp = await mkdtemp(join(tmpdir(), `export-${sessionId.slice(0, 8)}-`));
  const videoPath = join(tmp, "video.mjpeg");
  const audioPath = join(tmp, "audio.pcm");
  const mp4Path = join(tmp, "output.mp4");

  const videoParts: Buffer[] = [];
  for (const key of segKeys) {
    const buf = await store.get(key);
    if (buf) videoParts.push(buf);
  }
  await writeFile(videoPath, Buffer.concat(videoParts));

  const hasAudio = audioKeys.length > 0;
  if (hasAudio) {
    const audioParts: Buffer[] = [];
    for (const key of audioKeys) {
      const buf = await store.get(key);
      if (buf) audioParts.push(buf);
    }
    await writeFile(audioPath, Buffer.concat(audioParts));
  }

  // Read manifest for actual framerate and audio sample rate
  let actualFps = 15;
  let audioSampleRate = 48000;
  try {
    const manifestBuf = await store.get(`sessions/${sessionId}/manifest.json`);
    if (manifestBuf) {
      const manifest = JSON.parse(new TextDecoder().decode(manifestBuf));
      if (manifest.actualFps && manifest.actualFps > 0) actualFps = manifest.actualFps;
      if (manifest.audioSampleRate && manifest.audioSampleRate > 0) audioSampleRate = manifest.audioSampleRate;
    }
  } catch {}

  const args: string[] = [
    // Force ffmpeg to probe the full file — without this, image2pipe
    // may stop after the first JPEG frame in a concatenated MJPEG stream.
    "-probesize", "100M",
    "-analyzeduration", "100M",
    "-framerate", String(actualFps),
    "-f", "image2pipe", "-vcodec", "mjpeg",
    "-i", videoPath,
  ];
  if (hasAudio) {
    args.push("-f", "s16le", "-ar", String(audioSampleRate), "-ac", "1", "-i", audioPath);
  }
  args.push(
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "fast", "-crf", "23",
  );
  if (hasAudio) {
    args.push("-c:a", "aac", "-b:a", "128k");
  }
  // Write to file (not pipe) so we can upload the complete MP4 afterward
  args.push("-f", "mp4", "-movflags", "frag_keyframe+empty_moov", mp4Path);

  console.log(`[export] ffmpeg (cached) ${args.join(" ")}`);
  const proc = Bun.spawn([ffmpegPath, ...args], { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  const stderr = await new Response(proc.stderr).text();

  if (code !== 0) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    console.error(`[export] ffmpeg exited ${code}: ${stderr.slice(0, 500)}`);
    throw new ExportError("FFmpeg encoding failed", 500);
  }

  const mp4Data = await readFile(mp4Path);

  // Persist to R2 in background
  const cacheKey = `sessions/${sessionId}/export.mp4`;
  store.put(cacheKey, mp4Data).then(() => {
    console.log(`[export] MP4 cached for ${sessionId.slice(0, 8)}: ${(mp4Data.length / 1048576).toFixed(2)} MB`);
  }).catch(err => {
    console.error(`[export] MP4 cache write failed:`, err.message);
  });

  await rm(tmp, { recursive: true, force: true }).catch(() => {});

  return new Response(mp4Data, {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(mp4Data.length),
      "Content-Disposition": `inline; filename="session-${sessionId.slice(0, 8)}.mp4"`,
    },
  });
}

/**
 * Gallery API: list all recorded sessions from R2 with enriched metadata.
 */
export interface GallerySession {
  sessionId: string;
  live: boolean;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  device: {
    deviceName: string | null;
    deviceModel: string | null;
    wearableType: string | null;
  };
  segments: number;
  audioChunks: number;
  exportCached: boolean;
  thumbnailUrl: string;
  videoUrl: string;
  ownerId?: string;
  ownerEmail?: string;
  accessLevel: AccessLevel;
  acl: AclEntry[];
  viewerRole?: "owner" | "editor" | "viewer" | "public" | "none";
}

export async function getGalleryData(
  store: ObjectStore,
  liveSessionIds: Set<string>,
  userId?: string,
): Promise<GallerySession[]> {
  const keys = await store.list("sessions/") as string[];
  const metaKeys = keys.filter(k => k.endsWith("/meta.json"));
  const exportKeys = new Set(keys.filter(k => k.endsWith("/export.mp4")));

  const sessions: GallerySession[] = [];

  for (const mk of metaKeys) {
    const sessionId = mk.slice("sessions/".length, mk.length - "/meta.json".length);
    const buf = await store.get(mk);
    if (!buf) continue;

    try {
      const meta = JSON.parse(new TextDecoder().decode(buf));

      // Lazy migration: missing accessLevel = "public" (backward compat)
      const accessLevel: AccessLevel = meta.accessLevel || "public";
      const acl: AclEntry[] = meta.acl || [];
      const ownerId: string | undefined = meta.ownerId;
      const ownerEmail: string | undefined = meta.ownerEmail;

      // Gallery visibility check
      if (!canSeeInGallery({ accessLevel, acl, ownerId }, userId)) continue;

      // Determine viewer role
      let viewerRole: "owner" | "editor" | "viewer" | "public" | "none" = "none";
      if (userId && ownerId === userId) viewerRole = "owner";
      else if (userId && acl.find((e: AclEntry) => e.userId === userId)?.role === "editor") viewerRole = "editor";
      else if (userId && acl.find((e: AclEntry) => e.userId === userId)) viewerRole = "viewer";
      else if (accessLevel === "public") viewerRole = "public";

      sessions.push({
        sessionId,
        live: liveSessionIds.has(sessionId),
        startedAt: meta.startedAt || new Date(0).toISOString(),
        finishedAt: meta.finishedAt,
        durationMs: meta.durationMs,
        device: {
          deviceName: meta.device?.deviceName || null,
          deviceModel: meta.device?.deviceModel || null,
          wearableType: meta.device?.wearableType || null,
        },
        segments: meta.recording?.segmentsWritten || 0,
        audioChunks: meta.recording?.audioChunks || 0,
        exportCached: exportKeys.has(`sessions/${sessionId}/export.mp4`),
        thumbnailUrl: `/session/${sessionId}/thumbnail`,
        videoUrl: `/session/${sessionId}/video.mp4?audio`,
        ownerId,
        ownerEmail,
        accessLevel,
        acl,
        viewerRole,
      });
    } catch {}
  }

  // Most recent first
  sessions.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  return sessions;
}
