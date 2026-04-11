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
  isVideoFrame,
  isAudioFrame,
  parseVideoHeader,
  parseAudioHeader,
  freshTiming,
  updateTiming,
  formatTiming,
} from "@ebowwa/relay-protocol";

// Backward compat: server code uses parseHeader
import { parseVideoHeader } from "@ebowwa/relay-protocol";
export const parseHeader = parseVideoHeader;
