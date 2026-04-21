import Foundation
import MWDATCamera
import MWDATCore

// MARK: - Ring Buffer

struct RingBuffer<Element> {
    private var buffer: [Element?]
    private var writeIndex = 0
    private let capacity: Int

    init(capacity: Int) {
        self.capacity = capacity
        self.buffer = Array(repeating: nil, count: capacity)
    }

    mutating func append(_ element: Element) {
        buffer[writeIndex % capacity] = element
        writeIndex += 1
    }

    var elements: [Element] {
        buffer.compactMap { $0 }
    }
}

// MARK: - Event Records

struct SessionStateEvent: Sendable {
    let timestamp: ContinuousClock.Instant
    let previousState: StreamSessionState?
    let newState: StreamSessionState
}

struct ErrorEvent: Sendable {
    let timestamp: ContinuousClock.Instant
    let errorDescription: String
    let sessionStateAtTime: StreamSessionState
}

struct LinkStateEvent: Sendable {
    let timestamp: ContinuousClock.Instant
    let deviceId: DeviceIdentifier
    let previousState: LinkState?
    let newState: LinkState
}

struct PhotoCaptureEvent: Sendable {
    let requestTimestamp: ContinuousClock.Instant
    let deliveryTimestamp: ContinuousClock.Instant
    var latency: Duration {
        deliveryTimestamp - requestTimestamp
    }
}

// MARK: - Computed Metrics

struct FrameMetrics: Sendable {
    let effectiveFPS: Double
    let jitterMs: Double?
    let totalFramesReceived: UInt64
    let droppedFrameGaps: UInt64
}

struct ConnectionMetrics: Sendable {
    let deviceId: DeviceIdentifier
    let currentLinkState: LinkState
    let connectedDuration: Duration?
    let totalTransitions: UInt64
}

struct SessionMetrics: Sendable {
    let currentState: StreamSessionState
    let uptime: Duration?
    let timeToFirstFrame: Duration?
    let stateHistory: [SessionStateEvent]
}

struct ErrorMetrics: Sendable {
    let totalErrors: UInt64
    let errorsByType: [String: UInt64]
    let recentErrors: [ErrorEvent]
}

struct BatteryMetrics: Sendable {
    /// 0.0 to 1.0, or -1.0 if unavailable
    let level: Float
    /// "unplugged", "charging", "full", "unknown"
    let state: String
    let lowPowerMode: Bool
}

// MARK: - Snapshot

struct TelemetrySnapshot: Sendable {
    let frame: FrameMetrics
    let connection: ConnectionMetrics?
    let session: SessionMetrics
    let errors: ErrorMetrics
    let battery: BatteryMetrics
    let photoCapture: PhotoCaptureEvent?
    let snapshotTimestamp: ContinuousClock.Instant
}
