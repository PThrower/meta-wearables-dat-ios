/**
 * Wire protocol constants for caringmind-frame-relay (v1)
 *
 * FRLY v1: video frames
 *   [4B "FRLY"][1B version][4B payloadLen][8B sequence][4B width][4B height]
 *   [1B codec+flags][8B timestamp_ms][2B crc16][payload]
 *   Total header: 36 bytes
 *
 *   Byte [25] layout (codec+flags):
 *     Top 4 bits: codec type (0=JPEG, 1=H.264)
 *     Bottom 4 bits: codec-specific flags
 *       JPEG: quality tier (0-15)
 *       H.264: bit0=isKeyframe, bit1=hasSPSPPS
 *
 * FRAU v1: audio frames
 *   [4B "FRAU"][1B version][4B payloadLen][1B codecType][8B sequence][4B sampleRate]
 *   [2B channels][2B bitsPerSample][8B timestamp_ms][2B crc16][PCM payload]
 *   Total header: 36 bytes
 */
// --- Protocol version ---
export const PROTOCOL_VERSION = 1;
// --- Header sizes (v1) ---
export const HEADER_SIZE = 36; // FRLY v1: 4 + 1 + 4 + 8 + 4 + 4 + 1 + 8 + 2
export const AUDIO_HEADER_SIZE = 36; // FRAU v1: 4 + 1 + 4 + 1 + 8 + 4 + 2 + 2 + 8 + 2
// --- Magic bytes ---
export const FRLY_MAGIC = [0x46, 0x52, 0x4c, 0x59]; // "FRLY"
export const FRAU_MAGIC = [0x46, 0x52, 0x41, 0x55]; // "FRAU"
// --- Video codec types (byte[25] top nibble) ---
export const VIDEO_CODEC_JPEG = 0;
export const VIDEO_CODEC_H264 = 1;
// --- Video codec flags (byte[25] bottom nibble) ---
export const H264_FLAG_KEYFRAME = 0x01;
export const H264_FLAG_SPSPPS = 0x02;
// --- Known audio codec types ---
export const KNOWN_CODEC_TYPES = [0, 1, 2, 3];
export function isKnownCodecType(v) {
    return KNOWN_CODEC_TYPES.includes(v);
}
// --- CRC offset (same for both headers) ---
export const CRC_OFFSET = 34;
export const CRC_SIZE = 2;
export const HEADER_BEFORE_CRC = CRC_OFFSET; // bytes 0..33 are covered by CRC
