/**
 * @ebowwa/relay-protocol
 *
 * Shared wire protocol for caringmind-frame-relay server and viewer.
 */

export { FRLY_MAGIC, FRAU_MAGIC, HEADER_SIZE, AUDIO_HEADER_SIZE } from "./constants.js";
export { isVideoFrame, parseVideoHeader } from "./video.js";
export type { VideoHeader } from "./video.js";
export { isAudioFrame, parseAudioHeader } from "./audio.js";
export type { AudioHeader } from "./audio.js";
export { freshTiming, updateTiming, formatTiming } from "./types.js";
export type { FrameTiming } from "./types.js";
export { QUALITY_PRESETS, DEFAULT_QUALITY } from "./quality.js";
export type { QualityPreset } from "./quality.js";
