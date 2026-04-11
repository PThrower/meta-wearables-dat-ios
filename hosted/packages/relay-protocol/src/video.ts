/**
 * Video frame (FRLY) parsing
 *
 * Wire layout:
 *   [0:4]   magic "FRLY"
 *   [4:12]  sequence   (u64 LE)
 *   [12:16] width      (u32 LE)
 *   [16:20] height     (u32 LE)
 *   [20]    quality    (u8)
 *   [21:29] timestamp  (u64 LE, ms)
 *   [29:]   JPEG payload
 */

import { FRLY_MAGIC, HEADER_SIZE } from "./constants.js";

export function isVideoFrame(buf: Uint8Array): boolean {
  return buf.length >= 4 && buf[0] === FRLY_MAGIC[0] && buf[1] === FRLY_MAGIC[1] && buf[2] === FRLY_MAGIC[2] && buf[3] === FRLY_MAGIC[3];
}

export interface VideoHeader {
  sequence: number;
  width: number;
  height: number;
  quality: number;
  timestampMs: number;
}

export function parseVideoHeader(buf: Uint8Array): VideoHeader | null {
  if (buf.length < HEADER_SIZE) return null;
  if (buf[0] !== FRLY_MAGIC[0] || buf[1] !== FRLY_MAGIC[1] || buf[2] !== FRLY_MAGIC[2] || buf[3] !== FRLY_MAGIC[3]) return null;
  const view = new DataView(buf.buffer, buf.byteOffset);
  return {
    sequence: Number(view.getBigUint64(4, true)),
    width: view.getUint32(12, true),
    height: view.getUint32(16, true),
    quality: buf[20],
    timestampMs: Number(view.getBigUint64(21, true)),
  };
}
