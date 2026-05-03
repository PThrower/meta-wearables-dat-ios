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

export const HEADER_SIZE = 36;       // FRLY v1: 4 + 1 + 4 + 8 + 4 + 4 + 1 + 8 + 2
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

// --- Audio codec byte layout (byte[9]) ---
// Top bit (0x80) = encoding: 0 = raw PCM, 0x80 = Opus
// Bottom 7 bits (0x7F) = source: 0 = phone mic, 1 = glasses HFP, 2 = TTS, 3 = relay inbound
//
// Examples: 0x00 = phone mic PCM, 0x81 = glasses HFP Opus, 0x80 = phone mic Opus

export const AUDIO_ENCODING_PCM  = 0x00;
export const AUDIO_ENCODING_OPUS = 0x80;

export const KNOWN_CODEC_SOURCES = [0, 1, 2, 3] as const;
export type CodecSource = (typeof KNOWN_CODEC_SOURCES)[number];

/** Check if a value is a valid audio source (0-3). */
export function isKnownCodecSource(v: number): v is CodecSource {
  return (KNOWN_CODEC_SOURCES as readonly number[]).includes(v);
}

/** Encode source + encoding into the wire byte[9] value. */
export function encodeCodecByte(source: number, isOpus: boolean): number {
  return (source & 0x7F) | (isOpus ? AUDIO_ENCODING_OPUS : AUDIO_ENCODING_PCM);
}

/** Decode wire byte[9] into source and encoding flag. */
export function decodeCodecByte(byte: number): { source: number; isOpus: boolean } {
  return {
    source: byte & 0x7F,
    isOpus: (byte & AUDIO_ENCODING_OPUS) !== 0,
  };
}

// --- CRC offset (same for FRLY and FRAU headers) ---

export const CRC_OFFSET = 34;
export const CRC_SIZE = 2;
export const HEADER_BEFORE_CRC = CRC_OFFSET; // bytes 0..33 are covered by CRC

// --- FRSE (Sensor) ---

export const FRSE_MAGIC = [0x46, 0x52, 0x53, 0x45]; // "FRSE"
export const SENSOR_HEADER_SIZE = 36;  // FRSE v1: 4 + 1 + 4 + 8 + 4 + 1 + 4 + 8 + 2
// CRC is at byte 34 for FRSE (same offset as FRLY/FRAU — header bytes 0..33 covered)
export const SENSOR_CRC_OFFSET = 34;
export const SENSOR_HEADER_BEFORE_CRC = SENSOR_CRC_OFFSET;

// --- Sensor flags bitmask ---

export const SENSOR_FLAG_MOTION        = 0x0001;
export const SENSOR_FLAG_GYRO          = 0x0002;
export const SENSOR_FLAG_MAGNETOMETER  = 0x0004;
export const SENSOR_FLAG_BAROMETER     = 0x0008;
export const SENSOR_FLAG_LOCATION      = 0x0010;
export const SENSOR_FLAG_PROXIMITY     = 0x0020;
export const SENSOR_FLAG_BATTERY       = 0x0040;
export const SENSOR_FLAG_NETWORK       = 0x0080;
export const SENSOR_FLAG_THERMAL       = 0x0100;
export const SENSOR_FLAG_ORIENTATION   = 0x0200;
export const SENSOR_FLAG_MEMORY        = 0x0400;
export const SENSOR_FLAG_CPU           = 0x0800;
export const SENSOR_FLAG_DISK          = 0x1000;
export const SENSOR_FLAG_STREAM_METRICS = 0x2000;
