/**
 * Wire protocol — re-exports from @ebowwa/relay-protocol
 *
 * Server code imports parseHeader (alias for parseVideoHeader) for backward compat.
 */

export {
  FRLY_MAGIC,
  FRAU_MAGIC,
  HEADER_SIZE,
  AUDIO_HEADER_SIZE,
  PROTOCOL_VERSION,
  CRC_OFFSET,
  HEADER_BEFORE_CRC,
  isVideoFrame,
  isAudioFrame,
  isKnownCodecType,
  parseVideoHeader,
  parseAudioHeader,
  buildVideoFrame,
  buildAudioFrame,
  crc16,
  freshTiming,
  updateTiming,
  formatTiming,
  isBackpressureMessage,
  isBackpressureAckMessage,
} from "@ebowwa/relay-protocol";

export type {
  BackpressureMessage,
  BackpressureAckMessage,
} from "@ebowwa/relay-protocol";

// Backward compat: server code uses parseHeader
import { parseVideoHeader } from "@ebowwa/relay-protocol";
export const parseHeader = parseVideoHeader;
