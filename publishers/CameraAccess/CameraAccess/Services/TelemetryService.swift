import CoreMedia
import Foundation
import MWDATCamera
import MWDATCore
import os.log

@MainActor
final class TelemetryService: ObservableObject {

    // MARK: - Published

    @Published private(set) var snapshot: TelemetrySnapshot?

    // MARK: - Display Strings (for HUD)

    @Published private(set) var fpsText: String = "--"
    @Published private(set) var jitterText: String = "--"
    @Published private(set) var sessionStateText: String = "stopped"
    @Published private(set) var connectionText: String = "disconnected"
    @Published private(set) var uptimeText: String = "0s"
    @Published private(set) var ttffText: String = "--"
    @Published private(set) var errorCountText: String = "0"
    @Published private(set) var recentErrorsText: String = ""
    @Published private(set) var photoLatencyText: String = "--"
    @Published private(set) var frameCountText: String = "0"
    @Published private(set) var droppedFramesText: String = "0"
    @Published private(set) var deviceInfoText: String = ""

    // MARK: - Frame Tracking

    private var frameCount: UInt64 = 0
    private var lastFrameInstant: ContinuousClock.Instant?
    private var frameInstants: RingBuffer<ContinuousClock.Instant>
    private var droppedFrameGaps: UInt64 = 0
    private let targetFrameInterval: Duration = .milliseconds(41_667_000) / 1000 // ~41.67ms at 24fps

    // FPS rolling window
    private var fpsFrameCount: UInt64 = 0
    private var fpsWindowStart: ContinuousClock.Instant?
    private var effectiveFPS: Double = 0

    // MARK: - Session Tracking

    private var currentSessionState: StreamSessionState = .stopped
    private var sessionStartTime: ContinuousClock.Instant?
    private var streamingStartTime: ContinuousClock.Instant?
    private var firstFrameTime: ContinuousClock.Instant?
    private var stateHistory: [SessionStateEvent] = []

    // MARK: - Error Tracking

    private var errorCounts: [String: UInt64] = [:]
    private var recentErrors: RingBuffer<ErrorEvent>
    private(set) var totalErrors: UInt64 = 0

    // MARK: - Connection Tracking

    private var currentLinkState: LinkState = .disconnected
    private var connectionStartTime: ContinuousClock.Instant?
    private var totalConnectedDuration: Duration = .zero
    private var currentDeviceId: DeviceIdentifier?
    private var currentDeviceName: String?
    private var currentDeviceType: DeviceType?
    private var linkStateTokens: [DeviceIdentifier: AnyListenerToken] = [:]

    // MARK: - Photo Tracking

    private var pendingPhotoRequestTime: ContinuousClock.Instant?
    private var lastPhotoCapture: PhotoCaptureEvent?

    // MARK: - SDK Tokens

    private var streamTokens: [AnyListenerToken] = []

    // MARK: - Init

    init() {
        frameInstants = RingBuffer(capacity: 60)
        recentErrors = RingBuffer(capacity: 20)
    }

    // MARK: - Attach to SDK

    func attachToStreamSession(_ session: StreamSession) {
        NSLog("[Telemetry] attachToStreamSession called, initial state=\(String(describing: session.state))")
        let stateToken = session.statePublisher.listen { [weak self] state in
            Task { @MainActor [weak self] in
                self?.handleSessionState(state)
            }
        }
        streamTokens.append(stateToken)

        let frameToken = session.videoFramePublisher.listen { [weak self] frame in
            Task { @MainActor [weak self] in
                self?.handleVideoFrame(frame)
            }
        }
        streamTokens.append(frameToken)

        let errorToken = session.errorPublisher.listen { [weak self] error in
            Task { @MainActor [weak self] in
                self?.handleError(error)
            }
        }
        streamTokens.append(errorToken)

        let photoToken = session.photoDataPublisher.listen { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.handlePhotoData()
            }
        }
        streamTokens.append(photoToken)

        handleSessionState(session.state)
    }

    func attachToWearables(_ wearables: WearablesInterface) {
        NSLog("[Telemetry] attachToWearables called")
        Task { @MainActor in
            NSLog("[Telemetry] Listening to devicesStream...")
            for await devices in wearables.devicesStream() {
                NSLog("[Telemetry] devicesStream yielded \(devices.count) device(s)")
                self.updateDeviceMonitoring(devices: devices, wearables: wearables)
            }
        }
    }

    func recordPhotoRequest() {
        pendingPhotoRequestTime = ContinuousClock.Instant.now
        TelemetryLogger.photos.info("Photo capture requested")
    }

    // MARK: - Handlers

    private func handleSessionState(_ newState: StreamSessionState) {
        let now = ContinuousClock.Instant.now
        let event = SessionStateEvent(
            timestamp: now,
            previousState: currentSessionState,
            newState: newState
        )
        stateHistory.append(event)

        if newState == .streaming && streamingStartTime == nil {
            streamingStartTime = now
        }
        if newState == .stopped || newState == .paused {
            streamingStartTime = nil
        }

        let prev = String(describing: currentSessionState)
        let next = String(describing: newState)
        TelemetryLogger.session.info("Session: \(prev) -> \(next)")
        NSLog("[Telemetry] Session: \(prev) -> \(next)")
        currentSessionState = newState

        if newState == .stopped || newState == .paused {
            // Reset frame counters on stop/pause
            fpsFrameCount = 0
            fpsWindowStart = nil
            effectiveFPS = 0
        }

        updateDisplayStrings()
    }

    private func handleVideoFrame(_ frame: VideoFrame) {
        let now = ContinuousClock.Instant.now
        frameCount += 1
        fpsFrameCount += 1

        // FPS rolling window (1 second)
        if let windowStart = fpsWindowStart {
            let elapsed = now - windowStart
            let elapsedMs = durationToMs(elapsed)
            if elapsedMs >= 1000.0 {
                effectiveFPS = Double(fpsFrameCount) / (elapsedMs / 1000.0)
                fpsFrameCount = 0
                fpsWindowStart = now
            }
        } else {
            fpsWindowStart = now
        }

        // Time-to-first-frame
        if firstFrameTime == nil {
            firstFrameTime = now
            if let start = streamingStartTime {
                let ttff = now - start
                let ttffMs = self.durationToMs(ttff)
                TelemetryLogger.session.info("Time-to-first-frame: \(ttffMs)ms")
                NSLog("[Telemetry] First frame received, TTFF=\(String(format: "%.0f", ttffMs))ms")
            }
        }

        // Detect dropped frame gaps (> 2x expected interval)
        if let lastTs = lastFrameInstant {
            let gap = now - lastTs
            if durationToMs(gap) > durationToMs(targetFrameInterval) * 2.0 {
                droppedFrameGaps += 1
            }
        }

        frameInstants.append(now)
        lastFrameInstant = now

        updateDisplayStrings()
    }

    private func handleError(_ error: StreamSessionError) {
        let now = ContinuousClock.Instant.now
        let desc = describeError(error)
        let state = currentSessionState

        totalErrors += 1
        errorCounts[desc, default: 0] += 1

        let event = ErrorEvent(
            timestamp: now,
            errorDescription: desc,
            sessionStateAtTime: state
        )
        recentErrors.append(event)

        TelemetryLogger.errors.error("StreamSessionError: \(desc), state=\(String(describing: state))")
        NSLog("[Telemetry] ERROR: \(desc), state=\(String(describing: state))")
        updateDisplayStrings()
    }

    private func handlePhotoData() {
        let now = ContinuousClock.Instant.now
        if let requestTime = pendingPhotoRequestTime {
            let event = PhotoCaptureEvent(requestTimestamp: requestTime, deliveryTimestamp: now)
            lastPhotoCapture = event
            let latencyMs = self.durationToMs(event.latency)
            TelemetryLogger.photos.info("Photo delivered: latency=\(latencyMs)ms")
            pendingPhotoRequestTime = nil
        }
        updateDisplayStrings()
    }

    // MARK: - Device Monitoring

    private func updateDeviceMonitoring(devices: [DeviceIdentifier], wearables: WearablesInterface) {
        NSLog("[Telemetry] updateDeviceMonitoring: \(devices.count) device(s)")
        let deviceSet = Set(devices)
        linkStateTokens = linkStateTokens.filter { deviceId, _ in deviceSet.contains(deviceId) }

        for deviceId in devices {
            guard linkStateTokens[deviceId] == nil else { continue }
            guard let device = wearables.deviceForIdentifier(deviceId) else { continue }

            currentDeviceId = deviceId
            currentDeviceName = device.nameOrId()
            currentDeviceType = device.deviceType()

            let deviceName = device.nameOrId()
            let token = device.addLinkStateListener { [weak self] state in
                Task { @MainActor [weak self] in
                    self?.handleLinkState(state, deviceId: deviceId, deviceName: deviceName)
                }
            }
            linkStateTokens[deviceId] = token

            handleLinkState(device.linkState, deviceId: deviceId, deviceName: device.nameOrId())
        }
        updateDisplayStrings()
    }

    private func handleLinkState(_ newState: LinkState, deviceId: DeviceIdentifier, deviceName: String) {
        let now = ContinuousClock.Instant.now

        switch newState {
        case .connected:
            connectionStartTime = now
        case .disconnected:
            if let connStart = connectionStartTime {
                totalConnectedDuration += now - connStart
                connectionStartTime = nil
            }
        case .connecting:
            break
        @unknown default:
            break
        }

        let prevState = String(describing: currentLinkState)
        let nextState = String(describing: newState)
        TelemetryLogger.connection.info("Link: \(prevState) -> \(nextState) [\(deviceName)]")
        NSLog("[Telemetry] Link: \(prevState) -> \(nextState) [\(deviceName)]")
        currentLinkState = newState
        updateDisplayStrings()
    }

    // MARK: - Display String Updates

    private func updateDisplayStrings() {
        fpsText = String(format: "%.1f", effectiveFPS)

        let jitter = computeJitter()
        jitterText = jitter.map { String(format: "%.1fms", $0) } ?? "--"

        sessionStateText = String(describing: currentSessionState).lowercased()

        // Uptime
        if let start = streamingStartTime {
            let uptime = ContinuousClock.Instant.now - start
            uptimeText = formatDuration(uptime)
        } else {
            uptimeText = "0s"
        }

        // TTFF
        if let streamStart = streamingStartTime, let firstFrame = firstFrameTime {
            ttffText = String(format: "%.0fms", durationToMs(firstFrame - streamStart))
        }

        // Connection
        connectionText = String(describing: currentLinkState).lowercased()

        // Device info
        if let name = currentDeviceName {
            let typeStr = currentDeviceType.map { String(describing: $0) } ?? "unknown"
            deviceInfoText = "\(name) [\(typeStr)]"
        }

        // Errors
        errorCountText = "\(totalErrors)"
        let recent = recentErrors.elements.suffix(5).map { $0.errorDescription }
        recentErrorsText = recent.joined(separator: "\n")

        // Photo
        if let photo = lastPhotoCapture {
            photoLatencyText = String(format: "%.0fms", durationToMs(photo.latency))
        }

        frameCountText = "\(frameCount)"
        droppedFramesText = "\(droppedFrameGaps)"

        // Build snapshot
        let frameMetrics = FrameMetrics(
            effectiveFPS: effectiveFPS,
            jitterMs: jitter,
            totalFramesReceived: frameCount,
            droppedFrameGaps: droppedFrameGaps
        )

        let connectionMetrics = currentDeviceId.map { deviceId in
            ConnectionMetrics(
                deviceId: deviceId,
                currentLinkState: currentLinkState,
                connectedDuration: computeConnectedDuration(),
                totalTransitions: UInt64(stateHistory.count)
            )
        }

        let sessionMetrics = SessionMetrics(
            currentState: currentSessionState,
            uptime: computeUptime(),
            timeToFirstFrame: computeTTFF(),
            stateHistory: stateHistory
        )

        let errorMetrics = ErrorMetrics(
            totalErrors: totalErrors,
            errorsByType: errorCounts,
            recentErrors: recentErrors.elements
        )

        snapshot = TelemetrySnapshot(
            frame: frameMetrics,
            connection: connectionMetrics,
            session: sessionMetrics,
            errors: errorMetrics,
            photoCapture: lastPhotoCapture,
            snapshotTimestamp: ContinuousClock.Instant.now
        )
    }

    // MARK: - Computations

    private func computeJitter() -> Double? {
        let instants = frameInstants.elements
        guard instants.count >= 3 else { return nil }

        let intervals = zip(instants.dropFirst(), instants).map { $0.0 - $0.1 }
        guard !intervals.isEmpty else { return nil }

        let totalMs = intervals.reduce(0.0) { $0 + durationToMs($1) }
        let meanMs = totalMs / Double(intervals.count)

        let deviations = intervals.map { abs(durationToMs($0) - meanMs) }
        let meanDeviation = deviations.reduce(0.0, +) / Double(deviations.count)

        return meanDeviation
    }

    private func computeUptime() -> Duration? {
        guard let start = streamingStartTime else { return nil }
        return ContinuousClock.Instant.now - start
    }

    private func computeTTFF() -> Duration? {
        guard let streamStart = streamingStartTime, let firstFrame = firstFrameTime else { return nil }
        return firstFrame - streamStart
    }

    private func computeConnectedDuration() -> Duration {
        var total = totalConnectedDuration
        if let start = connectionStartTime, currentLinkState == .connected {
            total += ContinuousClock.Instant.now - start
        }
        return total
    }

    // MARK: - Helpers

    private func durationToMs(_ duration: Duration) -> Double {
        let components = duration.components
        return Double(components.seconds) * 1000.0 + Double(components.attoseconds) / 1_000_000_000_000_000.0
    }

    private func formatDuration(_ duration: Duration) -> String {
        let ms = durationToMs(duration)
        if ms < 1000 { return String(format: "%.0fms", ms) }
        let seconds = ms / 1000.0
        if seconds < 60 { return String(format: "%.1fs", seconds) }
        let minutes = Int(seconds) / 60
        let secs = Int(seconds) % 60
        return "\(minutes)m\(secs)s"
    }

    private func describeError(_ error: StreamSessionError) -> String {
        switch error {
        case .internalError: return "internalError"
        case .deviceNotFound: return "deviceNotFound"
        case .deviceNotConnected: return "deviceNotConnected"
        case .timeout: return "timeout"
        case .videoStreamingError: return "videoStreamingError"
        case .permissionDenied: return "permissionDenied"
        case .hingesClosed: return "hingesClosed"
        case .thermalCritical: return "thermalCritical"
        @unknown default: return "unknown(\(error))"
        }
    }
}
