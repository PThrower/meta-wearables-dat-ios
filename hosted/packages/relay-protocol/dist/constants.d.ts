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
export declare const PROTOCOL_VERSION = 1;
export declare const HEADER_SIZE = 36;
export declare const AUDIO_HEADER_SIZE = 36;
export declare const FRLY_MAGIC: number[];
export declare const FRAU_MAGIC: number[];
export declare const VIDEO_CODEC_JPEG = 0;
export declare const VIDEO_CODEC_H264 = 1;
export declare const H264_FLAG_KEYFRAME = 1;
export declare const H264_FLAG_SPSPPS = 2;
export declare const AUDIO_ENCODING_PCM = 0;
export declare const AUDIO_ENCODING_OPUS = 128;
export declare const KNOWN_CODEC_SOURCES: readonly [0, 1, 2, 3];
export type CodecSource = (typeof KNOWN_CODEC_SOURCES)[number];
/** Check if a value is a valid audio source (0-3). */
export declare function isKnownCodecSource(v: number): v is CodecSource;
/** Encode source + encoding into the wire byte[9] value. */
export declare function encodeCodecByte(source: number, isOpus: boolean): number;
/** Decode wire byte[9] into source and encoding flag. */
export declare function decodeCodecByte(byte: number): {
    source: number;
    isOpus: boolean;
};
export declare const CRC_OFFSET = 34;
export declare const CRC_SIZE = 2;
export declare const HEADER_BEFORE_CRC = 34;
export declare const FRSE_MAGIC: number[];
export declare const SENSOR_HEADER_SIZE = 36;
export declare const SENSOR_CRC_OFFSET = 34;
export declare const SENSOR_HEADER_BEFORE_CRC = 34;
export declare const SENSOR_FLAG_MOTION = 1;
export declare const SENSOR_FLAG_GYRO = 2;
export declare const SENSOR_FLAG_MAGNETOMETER = 4;
export declare const SENSOR_FLAG_BAROMETER = 8;
export declare const SENSOR_FLAG_LOCATION = 16;
export declare const SENSOR_FLAG_PROXIMITY = 32;
export declare const SENSOR_FLAG_BATTERY = 64;
export declare const SENSOR_FLAG_NETWORK = 128;
export declare const SENSOR_FLAG_THERMAL = 256;
export declare const SENSOR_FLAG_ORIENTATION = 512;
export declare const SENSOR_FLAG_MEMORY = 1024;
export declare const SENSOR_FLAG_CPU = 2048;
export declare const SENSOR_FLAG_DISK = 4096;
export declare const SENSOR_FLAG_STREAM_METRICS = 8192;
