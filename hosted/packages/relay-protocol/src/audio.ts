/**
 * Audio frame (FRAU) parsing — v1
 *
 * Wire layout (36 byte header):
 *   [0:4]   magic "FRAU"
 *   [4]     version      (u8) — must be 1
 *   [5:9]   payloadLen   (u32 LE)
 *   [9]     codecByte    (u8) — top bit = encoding (PCM/Opus), bottom 7 bits = source (0-3)
 *   [10:18] sequence     (u64 LE)
 *   [18:22] sampleRate   (u32 LE)
 *   [22:24] channels     (u16 LE)
 *   [24:26] bitsPerSample (u16 LE)
 *   [26:34] timestamp    (u64 LE, ms)
 *   [34:36] headerCrc16  (u16 LE)
 *   [36:]   payload      (raw PCM i16 LE or Opus-encoded, per encoding bit)
 *
 * byte[9] layout:
 *   bit 7   = encoding: 0 = raw PCM, 1 = Opus
 *   bits 0-6 = source: 0 = phone mic, 1 = glasses HFP, 2 = TTS, 3 = relay inbound
 */

import { FRAU_MAGIC, AUDIO_HEADER_SIZE, PROTOCOL_VERSION, isKnownCodecSource, CRC_OFFSET, HEADER_BEFORE_CRC, decodeCodecByte, AUDIO_ENCODING_OPUS } from "./constants.js";
import { crc16 } from "./crc16.js";

export function isAudioFrame(buf: Uint8Array): boolean {
  return buf.length >= 4 && buf[0] === FRAU_MAGIC[0] && buf[1] === FRAU_MAGIC[1] && buf[2] === FRAU_MAGIC[2] && buf[3] === FRAU_MAGIC[3];
}

export interface AudioHeader {
  version: number;
  payloadLength: number;
  /** Audio source (0-3). Extracted from bottom 7 bits of byte[9]. */
  codecType: number;
  sequence: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  timestampMs: number;
  /** Raw payload bytes — PCM i16 LE when !isOpus, Opus-encoded when isOpus */
  payload: Uint8Array;
  /** True when the top bit of byte[9] is set (Opus encoding). */
  readonly isOpus: boolean;
}

export function parseAudioHeader(buf: Uint8Array): AudioHeader | null {
  if (buf.length < AUDIO_HEADER_SIZE) return null;
  if (buf[0] !== FRAU_MAGIC[0] || buf[1] !== FRAU_MAGIC[1] || buf[2] !== FRAU_MAGIC[2] || buf[3] !== FRAU_MAGIC[3]) return null;

  const version = buf[4];
  if (version !== PROTOCOL_VERSION) return null;

  const view = new DataView(buf.buffer, buf.byteOffset);

  // Validate CRC16 over header bytes [0..33]
  const expectedCrc = view.getUint16(CRC_OFFSET, true);
  const computedCrc = crc16(buf, 0, HEADER_BEFORE_CRC);
  if (expectedCrc !== computedCrc) return null;

  // Decode byte[9]: top bit = encoding, bottom 7 bits = source
  const { source, isOpus } = decodeCodecByte(buf[9]);
  if (!isKnownCodecSource(source)) return null;

  const payloadLength = view.getUint32(5, true);

  return {
    version,
    payloadLength,
    codecType: source,
    sequence: Number(view.getBigUint64(10, true)),
    sampleRate: view.getUint32(18, true),
    channels: view.getUint16(22, true),
    bitsPerSample: view.getUint16(24, true),
    timestampMs: Number(view.getBigUint64(26, true)),
    payload: buf.subarray(AUDIO_HEADER_SIZE),
    get isOpus() { return isOpus; },
  };
}

/**
 * Build a FRAU v1 frame (header + payload).
 * Returns the complete binary message ready for WebSocket send.
 * codecType is the source (0-3). isOpus controls the encoding bit in byte[9].
 */
export function buildAudioFrame(
  codecType: number,
  sequence: number,
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
  timestampMs: number,
  payload: Uint8Array,
  isOpus: boolean = false,
): Uint8Array {
  const total = AUDIO_HEADER_SIZE + payload.length;
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);

  // Magic
  buf[0] = FRAU_MAGIC[0]; buf[1] = FRAU_MAGIC[1];
  buf[2] = FRAU_MAGIC[2]; buf[3] = FRAU_MAGIC[3];

  // Version
  buf[4] = PROTOCOL_VERSION;

  // Payload length
  view.setUint32(5, payload.length, true);

  // Codec byte: source (0-3) | encoding bit
  buf[9] = isOpus ? (codecType | AUDIO_ENCODING_OPUS) : codecType;

  // Sequence
  view.setBigUint64(10, BigInt(sequence), true);

  // Sample rate
  view.setUint32(18, sampleRate, true);

  // Channels
  view.setUint16(22, channels, true);

  // Bits per sample
  view.setUint16(24, bitsPerSample, true);

  // Timestamp
  view.setBigUint64(26, BigInt(timestampMs), true);

  // CRC16 over bytes [0..33]
  const crcVal = crc16(buf, 0, HEADER_BEFORE_CRC);
  view.setUint16(CRC_OFFSET, crcVal, true);

  // Payload
  buf.set(payload, AUDIO_HEADER_SIZE);

  return buf;
}
