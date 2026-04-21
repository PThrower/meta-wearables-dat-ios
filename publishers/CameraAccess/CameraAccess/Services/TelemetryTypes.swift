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

struct ThermalMetrics: Sendable {
    /// "nominal", "fair", "serious", "critical"
    let state: String
}

struct NetworkMetrics: Sendable {
    let type: String      // "wifi", "cellular", "wired", "unknown", "disconnected"
    let expensive: Bool
    let constrained: Bool
}

struct MemoryMetrics: Sendable {
    let availableMB: Double
    let pressure: String  // "normal", "warning", "critical"
}

struct RelayMetrics: Sendable {
    let latencyMs: Double?
    let reconnectCount: Int
}

struct DiskMetrics: Sendable {
    let availableGB: Double
    let totalGB: Double
    let percentUsed: Double
}

struct CellularMetrics: Sendable {
    let technology: String?  // "LTE", "5G NR", "EDGE", nil
    let carrier: String?
}

struct DisplayMetrics: Sendable {
    let brightness: Float  // 0.0 to 1.0
}

struct CameraMetrics: Sendable {
    let iso: Float?
    let exposureMs: Double?
    let lensAperture: Float?
}

struct OrientationMetrics: Sendable {
    let orientation: String  // "portrait", "landscapeLeft", "faceUp", etc.
}

struct MotionMetrics: Sendable {
    let accelX: Double
    let accelY: Double
    let accelZ: Double
    let isStationary: Bool
}

struct BluetoothMetrics: Sendable {
    let state: String  // "poweredOn", "poweredOff", "unauthorized", etc.
}

struct CPUMetrics: Sendable {
    let usagePercent: Double
}

// MARK: - Snapshot

struct TelemetrySnapshot: Sendable {
    let frame: FrameMetrics
    let connection: ConnectionMetrics?
    let session: SessionMetrics
    let errors: ErrorMetrics
    let battery: BatteryMetrics
    let thermal: ThermalMetrics
    let network: NetworkMetrics
    let memory: MemoryMetrics
    let relay: RelayMetrics?
    let disk: DiskMetrics
    let cellular: CellularMetrics?
    let display: DisplayMetrics
    let camera: CameraMetrics?
    let orientation: OrientationMetrics
    let motion: MotionMetrics?
    let bluetooth: BluetoothMetrics
    let cpu: CPUMetrics
    let photoCapture: PhotoCaptureEvent?
    let snapshotTimestamp: ContinuousClock.Instant
}
