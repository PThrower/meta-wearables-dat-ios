/**
 * SessionExport — converts recorded session segments to downloadable mp4
 *
 * Fetches mjpeg video segments (and optional PCM audio chunks) from R2,
 * writes input to temp files, runs ffmpeg to produce mp4, caches to R2.
 *
 * Routes:
 *   GET /session/{id}/video.mp4        — video only (cached to R2 after first build)
 *   GET /session/{id}/video.mp4?audio  — video + audio mixed in
 *   GET /session/{id}/thumbnail        — mid-frame JPEG (cached to R2 as thumb.jpg)
 *   GET /session/{id}/export           — JSON metadata (segment counts, etc.)
 *   GET /gallery/api                   — all sessions with metadata for gallery
 */

import { join } from "node:path";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ObjectStore } from "@ebowwa/object-store";
import { canSeeInGallery } from "./permissions.js";
import { resamplePcm, TARGET_SAMPLE_RATE } from "./pcm-resample.js";
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
 * Serial export queue — only one ffmpeg export runs at a time.
 * Prevents OOM on the VPS from parallel encodes (each ~300MB RSS).
 */
let exportLock: Promise<Response> | null = null;

async function withExportLock(fn: () => Promise<Response>): Promise<Response> {
  // Wait for any in-flight export to finish, then run ours
  while (exportLock !== null) {
    try { await exportLock; } catch { /* previous export failed, that's fine */ }
  }
  const promise = fn();
  exportLock = promise;
  try {
    return await promise;
  } finally {
    if (exportLock === promise) exportLock = null;
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

// Thumbnail extraction moved to dedicated module
export { getSessionThumbnail } from "./thumbnail.js";

/**
 * Check if a cached MP4 export exists in R2.
 * Returns a signed URL if found, null otherwise.
 */
export async function getCachedMp4Url(sessionId: string, store: ObjectStore, includeAudio: boolean): Promise<string | null> {
  const key = includeAudio
    ? `sessions/${sessionId}/export-audio.mp4`
    : `sessions/${sessionId}/export.mp4`;
  if (!await store.exists(key)) return null;

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
  return withExportLock(() => exportAndCacheMp4Inner(opts));
}

async function exportAndCacheMp4Inner(opts: ExportOptions): Promise<Response> {
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
  const videoPath = join(tmp, "video.raw");
  const audioPath = join(tmp, "audio.pcm");
  const mp4Path = join(tmp, "output.mp4");

  // Read all segments and detect codec: JPEG (0xFFD8) or H.264 NAL (0x00000001/0x000001)
  const jpegParts: Buffer[] = [];
  const h264Parts: Buffer[] = [];
  for (const key of segKeys) {
    const buf = await store.get(key);
    if (!buf || buf.length < 4) continue;
    if (buf[0] === 0xFF && buf[1] === 0xD8) {
      jpegParts.push(buf);
    } else if (buf[0] === 0x00 && buf[1] === 0x00 && (buf[2] === 0x00 || buf[2] === 0x01)) {
      h264Parts.push(buf);
    } else {
      console.warn(`[export] Unknown segment format ${key}: starts with 0x${buf[0].toString(16)}${buf[1].toString(16)}`);
    }
  }

  const totalFrames = jpegParts.length + h264Parts.length;
  if (totalFrames === 0) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw new ExportError("No valid video segments found", 404);
  }

  // Prefer JPEG segments; fall back to H.264 if no JPEGs available
  const isH264 = jpegParts.length === 0 && h264Parts.length > 0;
  const videoData = isH264 ? Buffer.concat(h264Parts) : Buffer.concat(jpegParts);
  await writeFile(videoPath, videoData);

  // Read manifest for actual framerate and audio sample rate BEFORE writing audio
  let actualFps = 15;
  let audioSampleRate = 48000;
  try {
    const manifestBuf = await store.get(`sessions/${sessionId}/manifest.json`);
    if (manifestBuf) {
      const manifest = JSON.parse(new TextDecoder().decode(manifestBuf));
      if (manifest.actualFps && manifest.actualFps > 0) actualFps = manifest.actualFps;
      if (manifest.audioSampleRate && manifest.audioSampleRate > 0) audioSampleRate = manifest.audioSampleRate;
    }
  } catch (err) { console.warn(`[export] Manifest parse error for ${sessionId}:`, err); }

  const hasAudio = audioKeys.length > 0;
  if (hasAudio) {
    const audioParts: Buffer[] = [];
    for (const key of audioKeys) {
      const buf = await store.get(key);
      if (buf) audioParts.push(buf);
    }
    let rawAudio = Buffer.concat(audioParts);

    // Resample legacy recordings that weren't normalized to 48kHz
    if (audioSampleRate !== TARGET_SAMPLE_RATE) {
      console.log(`[export] Resampling audio from ${audioSampleRate}Hz to ${TARGET_SAMPLE_RATE}Hz (${rawAudio.length} bytes)`);
      rawAudio = Buffer.from(resamplePcm(new Uint8Array(rawAudio), audioSampleRate, TARGET_SAMPLE_RATE));
      audioSampleRate = TARGET_SAMPLE_RATE; // ffmpeg gets 48kHz after resampling
    }

    await writeFile(audioPath, rawAudio);
  }

  // Build ffmpeg args — different input format for H.264 vs MJPEG
  const args: string[] = ["-y"];
  if (isH264) {
    args.push(
      "-probesize", "100M",
      "-analyzeduration", "100M",
      "-f", "h264",
      "-i", videoPath,
    );
  } else {
    args.push(
      "-probesize", "100M",
      "-analyzeduration", "100M",
      "-framerate", String(actualFps),
      "-f", "image2pipe", "-vcodec", "mjpeg",
      "-i", videoPath,
    );
  }
  if (hasAudio) {
    args.push("-f", "s16le", "-ar", String(audioSampleRate), "-ac", "1", "-i", audioPath);
  }
  args.push(
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "fast", "-crf", "23",
  );
  if (hasAudio) {
    args.push("-c:a", "aac", "-b:a", "128k");
    args.push("-shortest"); // prevent frozen frames when one stream outlasts the other
  }
  // Write to file (not pipe) so we can upload the complete MP4 afterward
  args.push("-f", "mp4", "-movflags", "frag_keyframe+empty_moov", mp4Path);

  console.log(`[export] ffmpeg ${args.join(" ")}`);
  console.log(`[export] video=${videoPath} (${videoData.length} bytes from ${segKeys.length} segs) audio=${hasAudio ? `${audioKeys.length} chunks` : "none"} fps=${actualFps} rate=${audioSampleRate}`);
  const proc = Bun.spawn([ffmpegPath, ...args], { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  const stderr = await new Response(proc.stderr).text();

  if (code !== 0) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    const detail = stderr.slice(0, 300).replace(/\n/g, " | ");
    console.error(`[export] ffmpeg exited ${code}: ${detail}`);
    throw new ExportError(`FFmpeg encoding failed (exit ${code}): ${detail}`, 500);
  }

  const mp4File = Bun.file(mp4Path);
  const mp4Size = mp4File.size;

  // Persist to R2 in background (read file separately to avoid consuming the stream)
  const cacheKey = includeAudio
    ? `sessions/${sessionId}/export-audio.mp4`
    : `sessions/${sessionId}/export.mp4`;
  readFile(mp4Path).then(mp4Data => {
    store.put(cacheKey, mp4Data).then(() => {
      console.log(`[export] MP4 cached for ${sessionId.slice(0, 8)}: ${(mp4Data.length / 1048576).toFixed(2)} MB`);
    }).catch(err => {
      console.error(`[export] MP4 cache write failed:`, err.message);
    });
  }).catch(err => {
    console.error(`[export] MP4 read for cache failed:`, err.message);
  });

  // Stream the file to the response (avoids holding entire MP4 in memory)
  // Cleanup happens after the stream is consumed via a transform
  const fileStream = mp4File.stream();
  const cleanupTransform = new TransformStream({
    flush() {
      rm(tmp, { recursive: true, force: true }).catch(() => {});
    },
  });
  const body = fileStream.pipeTo(cleanupTransform.writable).catch(() => {});
  // Actually, we need to return a readable stream. Let's use a different approach.
  // Read the file as a stream and pipe through cleanup.

  // Use Bun.file directly as response body — it streams from disk
  const response = new Response(mp4File, {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(mp4Size),
      "Content-Disposition": `inline; filename="session-${sessionId.slice(0, 8)}.mp4"`,
    },
  });

  // Schedule cleanup after a delay to allow the stream to be consumed
  setTimeout(() => {
    rm(tmp, { recursive: true, force: true }).catch(() => {});
  }, 60_000);

  return response;
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
  videoDurationMs?: number;
  audioDurationMs?: number;
  driftMs?: number;
  framesRelayed?: number;
  framesRecorded?: number;
  device: {
    deviceName: string | null;
    deviceModel: string | null;
    wearableType: string | null;
  };
  wearable: {
    wearableId: string | null;
    wearableType: string | null;
  } | null;
  segments: number;
  audioChunks: number;
  exportCached: boolean;
  hasThumbnail: boolean;
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
  userEmail?: string,
  showAll?: boolean,
): Promise<GallerySession[]> {
  const keys = await store.list("sessions/") as string[];
  const metaKeys = keys.filter(k => k.endsWith("/meta.json"));
  const exportKeys = new Set(keys.filter(k => k.endsWith("/export.mp4") || k.endsWith("/export-audio.mp4")));
  const thumbKeys = new Set(keys.filter(k => k.endsWith("/thumb.jpg")));
  const videoKeys = keys.filter(k => k.includes("/video/") && k.endsWith(".mjpeg"));
  const sessionsWithVideo = new Set<string>();
  for (const vk of videoKeys) {
    const match = vk.match(/^sessions\/([^/]+)\/video\//);
    if (match) sessionsWithVideo.add(match[1]);
  }

  const sessions: GallerySession[] = [];

  for (const mk of metaKeys) {
    const sessionId = mk.slice("sessions/".length, mk.length - "/meta.json".length);
    const buf = await store.get(mk);
    if (!buf) continue;

    try {
      const meta = JSON.parse(new TextDecoder().decode(buf));

      // Lazy migration: missing accessLevel = "link" (owner-only, matches new session default)
      const accessLevel: AccessLevel = meta.accessLevel || "link";
      const acl: AclEntry[] = meta.acl || [];
      const ownerId: string | undefined = meta.ownerId;
      const ownerEmail: string | undefined = meta.ownerEmail;

      // Gallery visibility check (bypassed in NO_AUTH mode)
      if (!showAll && !canSeeInGallery({ accessLevel, acl, ownerId, ownerEmail }, userId, userEmail)) continue;

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
        videoDurationMs: meta.recording?.videoDurationMs,
        audioDurationMs: meta.recording?.audioDurationMs,
        driftMs: meta.recording?.driftMs,
        framesRelayed: meta.recording?.framesRelayed,
        framesRecorded: meta.recording?.totalFrames,
        device: {
          deviceName: meta.device?.deviceName || null,
          deviceModel: meta.device?.deviceModel || null,
          wearableType: meta.device?.wearableType || null,
        },
        wearable: meta.wearable ? {
          wearableId: meta.wearable.wearableId || null,
          wearableType: meta.wearable.wearableType || null,
        } : null,
        segments: meta.recording?.segmentsWritten || 0,
        audioChunks: meta.recording?.audioChunks || 0,
        exportCached: exportKeys.has(`sessions/${sessionId}/export.mp4`) || exportKeys.has(`sessions/${sessionId}/export-audio.mp4`),
        hasThumbnail: thumbKeys.has(`sessions/${sessionId}/thumb.jpg`) || sessionsWithVideo.has(sessionId),
        thumbnailUrl: `/session/${sessionId}/thumbnail`,
        videoUrl: `/session/${sessionId}/video.mp4?audio`,
        ownerId,
        ownerEmail,
        accessLevel,
        acl,
        viewerRole,
      });
    } catch (err) { console.warn(`[gallery] Meta parse error for ${sessionId}:`, err); }
  }

  // Most recent first
  sessions.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  return sessions;
}
