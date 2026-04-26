/**
 * FRAU binary frame builder for viewer mic capture
 *
 * Delegates to @ebowwa/relay-protocol buildAudioFrame which produces
 * the v1 wire layout (36 byte header + PCM payload):
 *   [0:4]   magic "FRAU"
 *   [4]     version      (u8) — 1
 *   [5:9]   payloadLen   (u32 LE)
 *   [9]     codecType    (u8) — 0..3
 *   [10:18] sequence     (u64 LE)
 *   [18:22] sampleRate   (u32 LE)
 *   [22:24] channels     (u16 LE)
 *   [24:26] bitsPerSample (u16 LE)
 *   [26:34] timestamp    (u64 LE, ms)
 *   [34:36] headerCrc16  (u16 LE)
 *   [36:]   PCM payload
 */

import { buildAudioFrame } from "@ebowwa/relay-protocol";

export function buildFrauFrame(
  codecType: number,
  seqNum: number,
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
  pcmInt16: Int16Array
): ArrayBuffer {
  const pcmBytes = new Uint8Array(pcmInt16.buffer as ArrayBuffer, pcmInt16.byteOffset, pcmInt16.byteLength);
  const frame = buildAudioFrame(codecType, seqNum, sampleRate, channels, bitsPerSample, Date.now(), pcmBytes);
  return frame.buffer as ArrayBuffer;
}
