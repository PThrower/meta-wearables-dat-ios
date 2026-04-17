/**
 * Wire protocol constants for caringmind-frame-relay (v1)
 *
 * FRLY v1: video frames
 *   [4B "FRLY"][1B version][4B payloadLen][8B sequence][4B width][4B height]
 *   [1B quality][8B timestamp_ms][2B crc16][JPEG payload]
 *   Total header: 36 bytes
 *
 * FRAU v1: audio frames
 *   [4B "FRAU"][1B version][4B payloadLen][1B codecType][8B sequence][4B sampleRate]
 *   [2B channels][2B bitsPerSample][8B timestamp_ms][2B crc16][PCM payload]
 *   Total header: 36 bytes
 */

// --- Protocol version ---

export const PROTOCOL_VERSION = 1;

// --- Header sizes (v1) ---

export const HEADER_SIZE = 36;       // FRLY v1: 4 + 1 + 4 + 8 + 4 + 4 + 1 + 8 + 2
export const AUDIO_HEADER_SIZE = 36; // FRAU v1: 4 + 1 + 4 + 1 + 8 + 4 + 2 + 2 + 8 + 2

// --- Magic bytes ---

export const FRLY_MAGIC = [0x46, 0x52, 0x4c, 0x59]; // "FRLY"
export const FRAU_MAGIC = [0x46, 0x52, 0x41, 0x55]; // "FRAU"

// --- Known codec types ---

export const KNOWN_CODEC_TYPES = [0, 1, 2, 3] as const;
export type CodecType = (typeof KNOWN_CODEC_TYPES)[number];

export function isKnownCodecType(v: number): v is CodecType {
  return (KNOWN_CODEC_TYPES as readonly number[]).includes(v);
}

// --- CRC offset (same for both headers) ---

export const CRC_OFFSET = 34;
export const CRC_SIZE = 2;
export const HEADER_BEFORE_CRC = CRC_OFFSET; // bytes 0..33 are covered by CRC
