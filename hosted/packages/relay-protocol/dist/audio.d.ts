/**
 * Audio frame (FRAU) parsing — v1
 *
 * Wire layout (36 byte header):
 *   [0:4]   magic "FRAU"
 *   [4]     version      (u8) — must be 1
 *   [5:9]   payloadLen   (u32 LE)
 *   [9]     codecType    (u8) — must be 0, 1, 2, or 3
 *   [10:18] sequence     (u64 LE)
 *   [18:22] sampleRate   (u32 LE)
 *   [22:24] channels     (u16 LE)
 *   [24:26] bitsPerSample (u16 LE)
 *   [26:34] timestamp    (u64 LE, ms)
 *   [34:36] headerCrc16  (u16 LE)
 *   [36:]   PCM payload
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
    pcm: Uint8Array;
}
export declare function parseAudioHeader(buf: Uint8Array): AudioHeader | null;
/**
 * Build a FRAU v1 frame (header + PCM payload).
 * Returns the complete binary message ready for WebSocket send.
 */
export declare function buildAudioFrame(codecType: number, sequence: number, sampleRate: number, channels: number, bitsPerSample: number, timestampMs: number, pcmPayload: Uint8Array): Uint8Array;
