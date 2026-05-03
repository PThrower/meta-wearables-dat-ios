/**
 * Video frame (FRLY) parsing — codec-aware
 *
 * Wire layout (36 byte header):
 *   [0:4]   magic "FRLY"
 *   [4]     version    (u8) — must be 1
 *   [5:9]   payloadLen (u32 LE)
 *   [9:17]  sequence   (u64 LE)
 *   [17:21] width      (u32 LE)
 *   [21:25] height     (u32 LE)
 *   [25]    codecFlags (u8) — top nibble: codec type, bottom nibble: flags
 *   [26:34] timestamp  (u64 LE, ms)
 *   [34:36] headerCrc16 (u16 LE)
 *   [36:]   payload (JPEG or H.264 NAL units)
 *
 * Codec types: 0=JPEG, 1=H.264
 * JPEG flags: quality tier (0-15)
 * H.264 flags: bit0=isKeyframe, bit1=hasSPSPPS
 */
export declare function isVideoFrame(buf: Uint8Array): boolean;
export interface VideoHeader {
    version: number;
    payloadLength: number;
    sequence: number;
    width: number;
    height: number;
    /** Byte[25] raw value — top nibble is codec, bottom nibble is flags */
    codecFlags: number;
    /** Decoded codec type: 0=JPEG, 1=H.264 */
    codecType: number;
    /** For JPEG: quality tier (0-15). For H.264: flags bits */
    flags: number;
    /** H.264: true if this is a keyframe (IDR). JPEG: always true */
    isKeyframe: boolean;
    /** H.264: true if payload includes SPS/PPS parameter sets */
    hasParameterSets: boolean;
    /** Legacy quality field — byte[25] raw (backward compat for old JPEG-only viewers) */
    quality: number;
    timestampMs: number;
}
export declare function parseVideoHeader(buf: Uint8Array): VideoHeader | null;
/**
 * Build a FRLY v1 frame (header + payload).
 * Returns the complete binary message ready for WebSocket send.
 */
export declare function buildVideoFrame(sequence: number, width: number, height: number, quality: number, timestampMs: number, jpegPayload: Uint8Array): Uint8Array;
