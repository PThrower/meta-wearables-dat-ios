/* tslint:disable */
/* eslint-disable */

/**
 * Frame metadata passed alongside each frame buffer.
 */
export class FrameHeader {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Frame height in pixels.
     */
    height: number;
    /**
     * JPEG quality (0-100).
     */
    quality: number;
    /**
     * Monotonically increasing sequence number.
     */
    sequence: bigint;
    /**
     * Unix timestamp in milliseconds.
     */
    timestamp_ms: bigint;
    /**
     * Frame width in pixels.
     */
    width: number;
}

/**
 * Core relay state: tracks frame routing statistics and throttling.
 */
export class FrameRelay {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Get the effective relay FPS based on relayed frames.
     */
    effective_fps(elapsed_ms: bigint): number;
    /**
     * Create a new relay with a maximum FPS throttle.
     */
    constructor(max_fps: number);
    /**
     * Reset all counters.
     */
    reset(): void;
    /**
     * Decide whether a frame should be relayed or dropped.
     * Returns true if the frame passes the throttle gate.
     */
    should_relay(now_ms: bigint): boolean;
    frames_dropped: bigint;
    frames_received: bigint;
    frames_relayed: bigint;
    last_relayed_sequence: bigint;
}

/**
 * Decode a frame header from a binary buffer prefix.
 * Returns JsValue (null on failure, FrameHeader on success).
 */
export function decode_frame_prefix(buf: Uint8Array): FrameHeader | undefined;

/**
 * Encode a frame header into a binary prefix buffer.
 * Format: [4 bytes "FRLY"][8 bytes sequence][4 bytes width][4 bytes height]
 *         [1 byte quality][8 bytes timestamp_ms]
 * Total: 29 bytes prefix, followed by JPEG payload.
 */
export function encode_frame_prefix(header: FrameHeader): Uint8Array;
