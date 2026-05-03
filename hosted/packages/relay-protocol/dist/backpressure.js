/**
 * Backpressure signaling types
 *
 * Viewer -> Server:  { type: "backpressure", targetFps: 8 }
 * Server -> Publisher: { type: "backpressure", targetFps: 8 }
 * Publisher -> Server: { type: "backpressure-ack", targetFps: 8 }
 */
export function isBackpressureMessage(msg) {
    return (typeof msg === "object" &&
        msg !== null &&
        msg.type === "backpressure" &&
        typeof msg.targetFps === "number");
}
export function isBackpressureAckMessage(msg) {
    return (typeof msg === "object" &&
        msg !== null &&
        msg.type === "backpressure-ack" &&
        typeof msg.targetFps === "number");
}
