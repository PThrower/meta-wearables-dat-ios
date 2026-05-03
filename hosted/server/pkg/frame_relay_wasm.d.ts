/* tslint:disable */
/* eslint-disable */

/**
 * Audio frame metadata parsed from a FRAU binary header.
 */
export class AudioHeader {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    bits_per_sample: number;
    channels: number;
    codec_type: number;
    sample_rate: number;
    sequence: bigint;
    timestamp_ms: bigint;
}

/**
 * Streaming audio resampler with linear interpolation.
 *
 * Maintains phase continuity across chunks for glitch-free streaming.
 * Input/output are raw PCM bytes (i16 LE interleaved).
 *
 * Common use cases in this system:
 * - 8kHz  -> 16kHz (glasses HFP mic upsample)
 * - 16kHz -> 48kHz (mic to AudioContext)
 * - 48kHz -> 16kHz (browser mic capture downsample)
 */
export class AudioResampler {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Create a new resampler.
     * `channels` is typically 1 (mono) for this system.
     */
    constructor(from_rate: number, to_rate: number, channels: number);
    /**
     * Process a chunk of interleaved PCM i16 LE bytes.
     * Returns resampled PCM i16 LE bytes.
     */
    process(pcm_bytes: Uint8Array): Uint8Array;
    /**
     * Get the input-to-output sample rate ratio.
     */
    ratio(): number;
    /**
     * Reset resampler state (e.g., on stream reconnect).
     */
    reset(): void;
}

/**
 * Video frame metadata parsed from a FRLY binary prefix.
 */
export class FrameHeader {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    height: number;
    quality: number;
    sequence: bigint;
    timestamp_ms: bigint;
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
     * Create a relay from a quality preset name.
     * Returns `null` if the preset is not recognized.
     */
    static from_preset(preset: string): FrameRelay | undefined;
    /**
     * Get the configured max FPS.
     */
    max_fps(): number;
    /**
     * Get the minimum interval in milliseconds between relayed frames.
     */
    min_interval_ms(): bigint;
    /**
     * Create a new relay with a maximum FPS throttle.
     */
    constructor(max_fps: number);
    /**
     * Reset all counters.
     */
    reset(): void;
    /**
     * Update the max FPS at runtime (e.g., when viewer changes quality preset).
     */
    set_max_fps(fps: number): void;
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
 * Classify a binary frame by its magic bytes.
 *
 * Returns:
 * - `0` = unknown / too short
 * - `1` = video (FRLY)
 * - `2` = audio (FRAU)
 */
export function classify_frame(buf: Uint8Array): number;

/**
 * Decode a FRAU header from a binary buffer.
 */
export function decode_audio_header(buf: Uint8Array): AudioHeader | undefined;

/**
 * Decode a FRLY header from a binary buffer.
 */
export function decode_frame_prefix(buf: Uint8Array): FrameHeader | undefined;

/**
 * Encode a complete FRAU frame (29-byte header + PCM payload).
 */
export function encode_audio_frame(codec_type: number, sequence: bigint, sample_rate: number, channels: number, bits_per_sample: number, timestamp_ms: bigint, pcm: Uint8Array): Uint8Array;

/**
 * Encode a 29-byte FRLY header prefix (no JPEG payload).
 */
export function encode_frame_prefix(header: FrameHeader): Uint8Array;

/**
 * Encode a complete FRLY frame (header + JPEG payload).
 */
export function encode_video_frame(sequence: bigint, width: number, height: number, quality: number, timestamp_ms: bigint, jpeg: Uint8Array): Uint8Array;

/**
 * Extract the PCM payload bytes from a FRAU frame (skips 29-byte header).
 */
export function extract_audio_payload(buf: Uint8Array): Uint8Array;

/**
 * Extract the JPEG payload bytes from a FRLY frame (skips 29-byte header).
 */
export function extract_video_payload(buf: Uint8Array): Uint8Array;

/**
 * Check whether a buffer starts with the FRAU magic bytes.
 */
export function is_audio_frame(buf: Uint8Array): boolean;

/**
 * Check whether a buffer starts with the FRLY magic bytes.
 */
export function is_video_frame(buf: Uint8Array): boolean;

/**
 * Validate a binary frame's header integrity.
 *
 * Checks magic bytes and minimum header size.
 * Returns `true` if the frame header is well-formed.
 */
export function validate_frame(buf: Uint8Array): boolean;
