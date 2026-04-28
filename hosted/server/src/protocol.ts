/**
 * Wire protocol — re-exports from @ebowwa/relay-protocol
 *
 * Server code imports parseHeader (alias for parseVideoHeader) for backward compat.
 */

export {
  FRLY_MAGIC,
  FRAU_MAGIC,
  FRSE_MAGIC,
  HEADER_SIZE,
  AUDIO_HEADER_SIZE,
  SENSOR_HEADER_SIZE,
  PROTOCOL_VERSION,
  CRC_OFFSET,
  HEADER_BEFORE_CRC,
  SENSOR_CRC_OFFSET,
  SENSOR_HEADER_BEFORE_CRC,
  isVideoFrame,
  isAudioFrame,
  isSensorFrame,
  isKnownCodecType,
  CODEC_OPUS,
  parseVideoHeader,
  parseAudioHeader,
  parseSensorHeader,
  buildVideoFrame,
  buildAudioFrame,
  crc16,
  freshTiming,
  updateTiming,
  formatTiming,
  isBackpressureMessage,
  isBackpressureAckMessage,
  SENSOR_FLAG_MOTION,
  SENSOR_FLAG_GYRO,
  SENSOR_FLAG_MAGNETOMETER,
  SENSOR_FLAG_BAROMETER,
  SENSOR_FLAG_LOCATION,
  SENSOR_FLAG_PROXIMITY,
  SENSOR_FLAG_BATTERY,
  SENSOR_FLAG_NETWORK,
  SENSOR_FLAG_THERMAL,
  SENSOR_FLAG_ORIENTATION,
  SENSOR_FLAG_MEMORY,
  SENSOR_FLAG_CPU,
  SENSOR_FLAG_DISK,
  SENSOR_FLAG_STREAM_METRICS,
} from "@ebowwa/relay-protocol";

export type {
  BackpressureMessage,
  BackpressureAckMessage,
  SensorHeader,
} from "@ebowwa/relay-protocol";

// Backward compat: server code uses parseHeader
import { parseVideoHeader } from "@ebowwa/relay-protocol";
export const parseHeader = parseVideoHeader;
