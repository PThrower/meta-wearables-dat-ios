/**
 * Audio frame (FRAU) parsing
 *
 * Wire layout:
 *   [0:4]   magic "FRAU"
 *   [4]     codecType  (u8) — 0=built-in mic, 1=glasses HFP, 2=TTS, 3=relay inbound (viewer mic / server audio)
 *   [5:13]  sequence   (u64 LE)
 *   [13:17] sampleRate (u32 LE)
 *   [17:19] channels   (u16 LE)
 *   [19:21] bitsPerSample (u16 LE)
 *   [21:29] timestamp  (u64 LE, ms)
 *   [29:]   PCM payload
 */

import { FRAU_MAGIC, AUDIO_HEADER_SIZE } from "./constants.js";

export function isAudioFrame(buf: Uint8Array): boolean {
  return buf.length >= 4 && buf[0] === FRAU_MAGIC[0] && buf[1] === FRAU_MAGIC[1] && buf[2] === FRAU_MAGIC[2] && buf[3] === FRAU_MAGIC[3];
}

export interface AudioHeader {
  codecType: number;
  sequence: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  timestampMs: number;
  pcm: Uint8Array;
}

export function parseAudioHeader(buf: Uint8Array): AudioHeader | null {
  if (buf.length < AUDIO_HEADER_SIZE) return null;
  if (buf[0] !== FRAU_MAGIC[0] || buf[1] !== FRAU_MAGIC[1] || buf[2] !== FRAU_MAGIC[2] || buf[3] !== FRAU_MAGIC[3]) return null;
  const view = new DataView(buf.buffer, buf.byteOffset);
  return {
    codecType: buf[4],
    sequence: Number(view.getBigUint64(5, true)),
    sampleRate: view.getUint32(13, true),
    channels: view.getUint16(17, true),
    bitsPerSample: view.getUint16(19, true),
    timestampMs: Number(view.getBigUint64(21, true)),
    pcm: buf.subarray(AUDIO_HEADER_SIZE),
  };
}
