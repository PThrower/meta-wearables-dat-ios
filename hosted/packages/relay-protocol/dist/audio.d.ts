/**
 * Audio frame (FRAU) parsing — v1
 *
 * Wire layout (36 byte header):
 *   [0:4]   magic "FRAU"
 *   [4]     version      (u8) — must be 1
 *   [5:9]   payloadLen   (u32 LE)
 *   [9]     codecType    (u8) — 0..3 = raw PCM, 4 = Opus
 *   [10:18] sequence     (u64 LE)
 *   [18:22] sampleRate   (u32 LE)
 *   [22:24] channels     (u16 LE)
 *   [24:26] bitsPerSample (u16 LE)
 *   [26:34] timestamp    (u64 LE, ms)
 *   [34:36] headerCrc16  (u16 LE)
 *   [36:]   payload      (raw PCM when codecType 0-3, Opus when codecType 4)
 */
export declare function isAudioFrame(buf: Uint8Array): boolean;
export interface AudioHeader {
    version: number;
    payloadLength: number;
    codecType: number;
    sequence: number;
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    timestampMs: number;
    /** Raw payload bytes — PCM i16 LE when codecType 0-3, Opus-encoded when codecType 4 */
    payload: Uint8Array;
    /** Convenience: true when this frame contains Opus-encoded audio (codecType 4) */
    readonly isOpus: boolean;
}
export declare function parseAudioHeader(buf: Uint8Array): AudioHeader | null;
/**
 * Build a FRAU v1 frame (header + payload).
 * Returns the complete binary message ready for WebSocket send.
 * Payload is opaque: raw PCM when codecType 0-3, Opus-encoded when codecType 4.
 */
export declare function buildAudioFrame(codecType: number, sequence: number, sampleRate: number, channels: number, bitsPerSample: number, timestampMs: number, payload: Uint8Array): Uint8Array;
