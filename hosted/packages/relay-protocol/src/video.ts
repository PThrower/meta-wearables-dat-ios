/**
 * Video frame (FRLY) parsing — v1
 *
 * Wire layout (36 byte header):
 *   [0:4]   magic "FRLY"
 *   [4]     version    (u8) — must be 1
 *   [5:9]   payloadLen (u32 LE)
 *   [9:17]  sequence   (u64 LE)
 *   [17:21] width      (u32 LE)
 *   [21:25] height     (u32 LE)
 *   [25]    quality    (u8)
 *   [26:34] timestamp  (u64 LE, ms)
 *   [34:36] headerCrc16 (u16 LE)
 *   [36:]   JPEG payload
 */

import { FRLY_MAGIC, HEADER_SIZE, PROTOCOL_VERSION, CRC_OFFSET, HEADER_BEFORE_CRC } from "./constants.js";
import { crc16 } from "./crc16.js";

export function isVideoFrame(buf: Uint8Array): boolean {
  return buf.length >= 4 && buf[0] === FRLY_MAGIC[0] && buf[1] === FRLY_MAGIC[1] && buf[2] === FRLY_MAGIC[2] && buf[3] === FRLY_MAGIC[3];
}

export interface VideoHeader {
  version: number;
  payloadLength: number;
  sequence: number;
  width: number;
  height: number;
  quality: number;
  timestampMs: number;
}

export function parseVideoHeader(buf: Uint8Array): VideoHeader | null {
  if (buf.length < HEADER_SIZE) return null;
  if (buf[0] !== FRLY_MAGIC[0] || buf[1] !== FRLY_MAGIC[1] || buf[2] !== FRLY_MAGIC[2] || buf[3] !== FRLY_MAGIC[3]) return null;

  const version = buf[4];
  if (version !== PROTOCOL_VERSION) return null;

  const view = new DataView(buf.buffer, buf.byteOffset);

  // Validate CRC16 over header bytes [0..33]
  const expectedCrc = view.getUint16(CRC_OFFSET, true);
  const computedCrc = crc16(buf, 0, HEADER_BEFORE_CRC);
  if (expectedCrc !== computedCrc) return null;

  const payloadLength = view.getUint32(5, true);

  return {
    version,
    payloadLength,
    sequence: Number(view.getBigUint64(9, true)),
    width: view.getUint32(17, true),
    height: view.getUint32(21, true),
    quality: buf[25],
    timestampMs: Number(view.getBigUint64(26, true)),
  };
}

/**
 * Build a FRLY v1 frame (header + JPEG payload).
 * Returns the complete binary message ready for WebSocket send.
 */
export function buildVideoFrame(
  sequence: number,
  width: number,
  height: number,
  quality: number,
  timestampMs: number,
  jpegPayload: Uint8Array,
): Uint8Array {
  const total = HEADER_SIZE + jpegPayload.length;
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);

  // Magic
  buf[0] = FRLY_MAGIC[0]; buf[1] = FRLY_MAGIC[1];
  buf[2] = FRLY_MAGIC[2]; buf[3] = FRLY_MAGIC[3];

  // Version
  buf[4] = PROTOCOL_VERSION;

  // Payload length
  view.setUint32(5, jpegPayload.length, true);

  // Sequence
  view.setBigUint64(9, BigInt(sequence), true);

  // Width
  view.setUint32(17, width, true);

  // Height
  view.setUint32(21, height, true);

  // Quality
  buf[25] = quality;

  // Timestamp
  view.setBigUint64(26, BigInt(timestampMs), true);

  // CRC16 over bytes [0..33]
  const crcVal = crc16(buf, 0, HEADER_BEFORE_CRC);
  view.setUint16(CRC_OFFSET, crcVal, true);

  // Payload
  buf.set(jpegPayload, HEADER_SIZE);

  return buf;
}
