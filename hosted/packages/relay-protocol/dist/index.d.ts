/**
 * @ebowwa/relay-protocol
 *
 * Shared wire protocol for caringmind-frame-relay server and viewer.
 */
export { FRLY_MAGIC, FRAU_MAGIC, FRSE_MAGIC, HEADER_SIZE, AUDIO_HEADER_SIZE, SENSOR_HEADER_SIZE, PROTOCOL_VERSION, KNOWN_CODEC_SOURCES, CRC_OFFSET, HEADER_BEFORE_CRC, SENSOR_CRC_OFFSET, SENSOR_HEADER_BEFORE_CRC, AUDIO_ENCODING_PCM, AUDIO_ENCODING_OPUS, VIDEO_CODEC_JPEG, VIDEO_CODEC_H264, H264_FLAG_KEYFRAME, H264_FLAG_SPSPPS, SENSOR_FLAG_MOTION, SENSOR_FLAG_GYRO, SENSOR_FLAG_MAGNETOMETER, SENSOR_FLAG_BAROMETER, SENSOR_FLAG_LOCATION, SENSOR_FLAG_PROXIMITY, SENSOR_FLAG_BATTERY, SENSOR_FLAG_NETWORK, SENSOR_FLAG_THERMAL, SENSOR_FLAG_ORIENTATION, SENSOR_FLAG_MEMORY, SENSOR_FLAG_CPU, SENSOR_FLAG_DISK, SENSOR_FLAG_STREAM_METRICS } from "./constants.js";
export type { CodecSource } from "./constants.js";
export { isKnownCodecSource, encodeCodecByte, decodeCodecByte } from "./constants.js";
export { isVideoFrame, parseVideoHeader, buildVideoFrame } from "./video.js";
export type { VideoHeader } from "./video.js";
export { isAudioFrame, parseAudioHeader, buildAudioFrame } from "./audio.js";
export type { AudioHeader } from "./audio.js";
export { isSensorFrame, parseSensorHeader } from "./sensor.js";
export type { SensorHeader } from "./sensor.js";
export { crc16 } from "./crc16.js";
export { freshTiming, updateTiming, formatTiming } from "./types.js";
export type { FrameTiming } from "./types.js";
export { QUALITY_PRESETS, DEFAULT_QUALITY } from "./quality.js";
export type { QualityPreset } from "./quality.js";
export { isBackpressureMessage, isBackpressureAckMessage } from "./backpressure.js";
export type { BackpressureMessage, BackpressureAckMessage, BackpressureControlMessage } from "./backpressure.js";
