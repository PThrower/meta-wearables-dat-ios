/**
 * Audio frame (FRAU) parsing — v1
 *
 * Wire layout (36 byte header):
 *   [0:4]   magic "FRAU"
 *   [4]     version      (u8) — must be 1
 *   [5:9]   payloadLen   (u32 LE)
 *   [9]     codecByte    (u8) — top bit = encoding (PCM/Opus), bottom 7 bits = source (0-3)
 *   [10:18] sequence     (u64 LE)
 *   [18:22] sampleRate   (u32 LE)
 *   [22:24] channels     (u16 LE)
 *   [24:26] bitsPerSample (u16 LE)
 *   [26:34] timestamp    (u64 LE, ms)
 *   [34:36] headerCrc16  (u16 LE)
 *   [36:]   payload      (raw PCM i16 LE or Opus-encoded, per encoding bit)
 *
 * byte[9] layout:
 *   bit 7   = encoding: 0 = raw PCM, 1 = Opus
 *   bits 0-6 = source: 0 = phone mic, 1 = glasses HFP, 2 = TTS, 3 = relay inbound
 */
export declare function isAudioFrame(buf: Uint8Array): boolean;
export interface AudioHeader {
    version: number;
    payloadLength: number;
    /** Audio source (0-3). Extracted from bottom 7 bits of byte[9]. */
    codecType: number;
    sequence: number;
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    timestampMs: number;
    /** Raw payload bytes — PCM i16 LE when !isOpus, Opus-encoded when isOpus */
    payload: Uint8Array;
    /** True when the top bit of byte[9] is set (Opus encoding). */
    readonly isOpus: boolean;
}
export declare function parseAudioHeader(buf: Uint8Array): AudioHeader | null;
/**
 * Build a FRAU v1 frame (header + payload).
 * Returns the complete binary message ready for WebSocket send.
 * codecType is the source (0-3). isOpus controls the encoding bit in byte[9].
 */
export declare function buildAudioFrame(codecType: number, sequence: number, sampleRate: number, channels: number, bitsPerSample: number, timestampMs: number, payload: Uint8Array, isOpus?: boolean): Uint8Array;
