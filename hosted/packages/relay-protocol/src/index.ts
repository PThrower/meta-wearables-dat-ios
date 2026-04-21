/**
 * @ebowwa/relay-protocol
 *
 * Shared wire protocol for caringmind-frame-relay server and viewer.
 */

export { FRLY_MAGIC, FRAU_MAGIC, HEADER_SIZE, AUDIO_HEADER_SIZE, PROTOCOL_VERSION,
         KNOWN_CODEC_TYPES, CRC_OFFSET, HEADER_BEFORE_CRC,
         VIDEO_CODEC_JPEG, VIDEO_CODEC_H264, H264_FLAG_KEYFRAME, H264_FLAG_SPSPPS } from "./constants.js";
export type { CodecType } from "./constants.js";
export { isKnownCodecType } from "./constants.js";
export { isVideoFrame, parseVideoHeader, buildVideoFrame } from "./video.js";
export type { VideoHeader } from "./video.js";
export { isAudioFrame, parseAudioHeader, buildAudioFrame } from "./audio.js";
export type { AudioHeader } from "./audio.js";
export { crc16 } from "./crc16.js";
export { freshTiming, updateTiming, formatTiming } from "./types.js";
export type { FrameTiming } from "./types.js";
export { QUALITY_PRESETS, DEFAULT_QUALITY } from "./quality.js";
export type { QualityPreset } from "./quality.js";
export { isBackpressureMessage, isBackpressureAckMessage } from "./backpressure.js";
export type { BackpressureMessage, BackpressureAckMessage, BackpressureControlMessage } from "./backpressure.js";
