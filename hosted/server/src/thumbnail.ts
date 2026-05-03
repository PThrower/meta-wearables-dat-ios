/**
 * thumbnail.ts — session thumbnail extraction
 *
 * Extracts a representative JPEG frame from MJPEG video segments.
 * Uses the mid-duration frame (not the first frame) for a more
 * representative preview. Caches to R2 at sessions/{id}/thumb.jpg.
 */

import type { ObjectStore } from "@ebowwa/object-store";

/**
 * Extract a JPEG thumbnail from the middle of the recording.
 * For multi-segment sessions, picks the middle segment.
 * For that segment, picks the middle JPEG frame.
 * Caches result to R2.
 */
export async function getSessionThumbnail(sessionId: string, store: ObjectStore): Promise<Buffer | null> {
  const cacheKey = `sessions/${sessionId}/thumb.jpg`;
  const cached = await store.get(cacheKey);
  if (cached) return cached;

  const segKeys = (await store.list(`sessions/${sessionId}/video/`))
    .filter(k => k.endsWith(".mjpeg"))
    .sort();

  if (segKeys.length === 0) return null;

  // Pick the middle segment for better visual representation
  const midIdx = Math.floor(segKeys.length / 2);
  const seg = await store.get(segKeys[midIdx]);
  if (!seg || seg.length < 4) return null;

  const jpeg = extractMidJpeg(seg);
  if (!jpeg) return null;

  // Fire-and-forget cache write
  store.put(cacheKey, jpeg).catch(err =>
    console.error(`[thumbnail] cache write failed:`, err.message)
  );

  console.log(`[thumbnail] Cached mid-frame for ${sessionId.slice(0, 8)}: ${jpeg.length} bytes (seg ${midIdx + 1}/${segKeys.length})`);
  return jpeg;
}

/**
 * Parse MJPEG buffer to find all JPEG frame boundaries,
 * then return the frame closest to the middle.
 */
function extractMidJpeg(mjpeg: Buffer): Buffer | null {
  const frames: Array<{ start: number; end: number }> = [];
  let i = 0;

  while (i < mjpeg.length - 1) {
    // Find SOI marker (FF D8)
    if (mjpeg[i] !== 0xFF || mjpeg[i + 1] !== 0xD8) {
      i++;
      continue;
    }
    const frameStart = i;

    // Find matching EOI marker (FF D9)
    let j = i + 2;
    while (j < mjpeg.length - 1) {
      if (mjpeg[j] === 0xFF && mjpeg[j + 1] === 0xD9) {
        frames.push({ start: frameStart, end: j + 2 });
        i = j + 2;
        break;
      }
      j++;
    }
    if (j >= mjpeg.length - 1) break;
  }

  if (frames.length === 0) return null;

  // Pick the middle frame for a representative thumbnail
  const mid = frames[Math.floor(frames.length / 2)];
  return Buffer.from(mjpeg.subarray(mid.start, mid.end));
}
