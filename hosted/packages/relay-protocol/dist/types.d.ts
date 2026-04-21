/**
 * Shared types and timing functions for frame relay
 */
export interface FrameTiming {
    lastSequence: number;
    lastTimestampMs: number;
    lastReceivedAt: number;
    jitterMs: number;
    fps: number;
    minIntervalMs: number;
    maxIntervalMs: number;
    droppedFrames: number;
}
export declare function freshTiming(): FrameTiming;
export declare function updateTiming(t: FrameTiming, sequence: number, timestampMs: number): FrameTiming;
export declare function formatTiming(t: FrameTiming): {
    fps: number;
    jitterMs: number;
    minIntervalMs: number;
    maxIntervalMs: number;
    droppedFrames: number;
};
