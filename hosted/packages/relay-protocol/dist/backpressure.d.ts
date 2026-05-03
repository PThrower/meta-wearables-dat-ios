/**
 * Backpressure signaling types
 *
 * Viewer -> Server:  { type: "backpressure", targetFps: 8 }
 * Server -> Publisher: { type: "backpressure", targetFps: 8 }
 * Publisher -> Server: { type: "backpressure-ack", targetFps: 8 }
 */
export interface BackpressureMessage {
    type: "backpressure";
    targetFps: number;
}
export interface BackpressureAckMessage {
    type: "backpressure-ack";
    targetFps: number;
}
export type BackpressureControlMessage = BackpressureMessage | BackpressureAckMessage;
export declare function isBackpressureMessage(msg: unknown): msg is BackpressureMessage;
export declare function isBackpressureAckMessage(msg: unknown): msg is BackpressureAckMessage;
