import AVFoundation
import CoreBluetooth
import CoreLocation
import CoreMedia
import CoreMotion
import CoreTelephony
import Foundation
import MWDATCamera
import MWDATCore
import Network
import os.log
import UIKit

private final class BTDelegateWrapper: NSObject, CBCentralManagerDelegate, Sendable {
    let onUpdate: @Sendable (String) -> Void
    init(onUpdate: @Sendable @escaping (String) -> Void) {
        self.onUpdate = onUpdate
    }
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        let state: String
        switch central.state {
        case .poweredOn: state = "poweredOn"
        case .poweredOff: state = "poweredOff"
        case .unauthorized: state = "unauthorized"
        case .unsupported: state = "unsupported"
        case .resetting: state = "resetting"
        default: state = "unknown"
        }
        onUpdate(state)
    }
}

private final class LocationDelegate: NSObject, CLLocationManagerDelegate, Sendable {
    let onUpdate: @Sendable (CLLocation?) -> Void
    init(onUpdate: @Sendable @escaping (CLLocation?) -> Void) {
        self.onUpdate = onUpdate
    }
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        onUpdate(locations.last)
    }
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // Ignore — may not have permission or GPS unavailable
    }
}

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
    @Published private(set) var batteryText: String = "--"
    @Published private(set) var thermalText: String = "--"
    @Published private(set) var networkText: String = "--"
    @Published private(set) var memoryText: String = "--"
    @Published private(set) var relayLatencyText: String = "--"
    @Published private(set) var diskText: String = "--"
    @Published private(set) var cellularText: String = "--"
    @Published private(set) var brightnessText: String = "--"
    @Published private(set) var cameraInfoText: String = "--"
    @Published private(set) var orientationText: String = "--"
    @Published private(set) var motionText: String = "--"
    @Published private(set) var bluetoothText: String = "--"
    @Published private(set) var cpuText: String = "--"
    @Published private(set) var locationText: String = "--"
    @Published private(set) var gyroText: String = "--"
    @Published private(set) var magnetometerText: String = "--"
    @Published private(set) var barometerText: String = "--"
    @Published private(set) var audioLevelText: String = "--"
    @Published private(set) var memoryFootprintText: String = "--"
    @Published private(set) var proximityText: String = "--"
    @Published private(set) var backgroundText: String = "--"
    @Published private(set) var throughputText: String = "--"
    @Published private(set) var activityText: String = "--"
    @Published private(set) var currentActivity: ActivityType = .unknown

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

    // Frame-gated effective uptime
    private var effectiveUptimeAccumulated: Duration = .zero
    private var currentSegmentStart: ContinuousClock.Instant?
    private var isUptimePaused: Bool = false
    private var backgroundEnterTime: ContinuousClock.Instant?
    private var totalBackgroundDuration: Duration = .zero
    static let staleThresholdMs: Double = 5000.0
    var lastFrameTime: ContinuousClock.Instant? { lastFrameInstant }

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

    // MARK: - Network Monitoring

    private let pathMonitor = NWPathMonitor()
    private let monitorQueue = DispatchQueue(label: "telemetry.network")
    private var currentNetworkType: String = "unknown"
    private var currentNetworkExpensive: Bool = false
    private var currentNetworkConstrained: Bool = false
    private var lastRelayLatencyMs: Double?
    private let networkInfo = CTTelephonyNetworkInfo()
    var phoneCameraDeviceProvider: (@MainActor () -> AVCaptureDevice?)?
    private let motionManager = CMMotionManager()
    private var lastAccelX: Double = 0
    private var lastAccelY: Double = 0
    private var lastAccelZ: Double = 0
    private var btManager: CBCentralManager?
    private var btDelegateWrapper: BTDelegateWrapper?
    private var currentBTState: String = "unknown"

    // Location
    private var locationManager: CLLocationManager?
    private var locationDelegate: LocationDelegate?
    private var currentLocation: CLLocation?

    // Gyroscope
    private var lastGyroX: Double = 0
    private var lastGyroY: Double = 0
    private var lastGyroZ: Double = 0

    // Magnetometer
    private var lastMagX: Double = 0
    private var lastMagY: Double = 0
    private var lastMagZ: Double = 0

    // Barometer
    private let altimeter = CMAltimeter()
    private var currentPressureKPa: Double?

    // Activity detection
    private let activityManager = CMMotionActivityManager()
    private var lastActivityType: ActivityType = .unknown
    private var lastActivityConfidence: String = "low"

    // Audio level provider (set by ViewModel)
    var audioLevelProvider: (@MainActor () -> (peakDb: Float, averageDb: Float)?)?

    // Throughput tracking
    private var lastThroughputBytes: UInt64 = 0
    private var lastThroughputTime: ContinuousClock.Instant?
    private var currentBytesPerSec: Double = 0
    var lastTotalBytesSent: UInt64 = 0

    // App-level fg/bg tracking
    private let serviceStartTime: ContinuousClock.Instant = .now
    private var totalAppBackgroundDuration: Duration = .zero
    private var appBackgroundEnterTime: ContinuousClock.Instant?

    // MARK: - Init

    init() {
        NSLog("[TelemetryService] init start")
        frameInstants = RingBuffer(capacity: 60)
        recentErrors = RingBuffer(capacity: 20)
        UIDevice.current.isBatteryMonitoringEnabled = true
        UIDevice.current.beginGeneratingDeviceOrientationNotifications()
        NSLog("[TelemetryService] battery+orientation OK")

        pathMonitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor [weak self] in
                guard let self else { return }
                let type: String
                if path.status == .satisfied {
                    if path.usesInterfaceType(.wifi) { type = "wifi" }
                    else if path.usesInterfaceType(.cellular) { type = "cellular" }
                    else if path.usesInterfaceType(.wiredEthernet) { type = "wired" }
                    else { type = "unknown" }
                } else {
                    type = "disconnected"
                }
                self.currentNetworkType = type
                self.currentNetworkExpensive = path.isExpensive
                self.currentNetworkConstrained = path.isConstrained
                self.updateDisplayStrings()
            }
        }
        pathMonitor.start(queue: monitorQueue)
        NSLog("[TelemetryService] network monitor started")

        // Accelerometer at 1Hz for telemetry
        if motionManager.isAccelerometerAvailable {
            motionManager.accelerometerUpdateInterval = 1.0
            motionManager.startAccelerometerUpdates(to: .main) { [weak self] data, _ in
                guard let self, let data else { return }
                self.lastAccelX = data.acceleration.x
                self.lastAccelY = data.acceleration.y
                self.lastAccelZ = data.acceleration.z
            }
        }

        // Bluetooth state monitoring
        NSLog("[TelemetryService] starting BT setup")
        let wrapper = BTDelegateWrapper { [weak self] state in
            Task { @MainActor [weak self] in
                self?.currentBTState = state
                self?.updateDisplayStrings()
            }
        }
        btDelegateWrapper = wrapper
        btManager = CBCentralManager(delegate: wrapper, queue: nil)
        NSLog("[TelemetryService] BT OK")

        // Location monitoring
        NSLog("[TelemetryService] starting location setup")
        let locDelegate = LocationDelegate { [weak self] location in
            Task { @MainActor [weak self] in
                self?.currentLocation = location
            }
        }
        locationDelegate = locDelegate
        let locManager = CLLocationManager()
        locManager.delegate = locDelegate
        locManager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        locManager.distanceFilter = 10
        locManager.requestWhenInUseAuthorization()
        locManager.startUpdatingLocation()
        locationManager = locManager
        NSLog("[TelemetryService] location OK")

        // Gyroscope at 1Hz
        if motionManager.isGyroAvailable {
            motionManager.gyroUpdateInterval = 1.0
            motionManager.startGyroUpdates(to: .main) { [weak self] data, _ in
                guard let self, let data else { return }
                self.lastGyroX = data.rotationRate.x
                self.lastGyroY = data.rotationRate.y
                self.lastGyroZ = data.rotationRate.z
            }
        }

        // Magnetometer at 1Hz
        if motionManager.isMagnetometerAvailable {
            motionManager.magnetometerUpdateInterval = 1.0
            motionManager.startMagnetometerUpdates(to: .main) { [weak self] data, _ in
                guard let self, let data else { return }
                self.lastMagX = data.magneticField.x
                self.lastMagY = data.magneticField.y
                self.lastMagZ = data.magneticField.z
            }
        }

        // Barometer
        if CMAltimeter.isRelativeAltitudeAvailable() {
            altimeter.startRelativeAltitudeUpdates(to: .main) { [weak self] data, _ in
                guard let self, let data else { return }
                self.currentPressureKPa = data.pressure.doubleValue
            }
        }
        NSLog("[TelemetryService] barometer OK")

        // Activity detection
        if CMMotionActivityManager.isActivityAvailable() {
            activityManager.startActivityUpdates(to: .main) { [weak self] activity in
                guard let self, let activity else { return }
                let type: ActivityType
                if activity.walking { type = .walking }
                else if activity.running { type = .running }
                else if activity.automotive { type = .automotive }
                else if activity.cycling { type = .cycling }
                else if activity.stationary { type = .stationary }
                else { type = .unknown }

                let confidence: String
                switch activity.confidence {
                case .low: confidence = "low"
                case .medium: confidence = "medium"
                case .high: confidence = "high"
                @unknown default: confidence = "low"
                }

                self.lastActivityType = type
                self.lastActivityConfidence = confidence
                self.currentActivity = type
            }
            NSLog("[TelemetryService] activity detection OK")
        }

        // Proximity monitoring
        UIDevice.current.isProximityMonitoringEnabled = true
        NSLog("[TelemetryService] init complete")
    }

    // MARK: - Attach to SDK

    func attachToStreamSession(_ session: StreamSession) {
        NSLog("[Telemetry] attachToStreamSession called, initial state=\(String(describing: session.state)), capabilityState=\(String(describing: session.capabilityState))")
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

    func updateRelayLatency(_ latencyMs: Double?) {
        lastRelayLatencyMs = latencyMs
        if let ms = latencyMs, ms > 0 {
            relayLatencyText = String(format: "%.1fms", ms)
        } else {
            relayLatencyText = "--"
        }
    }

    // MARK: - Uptime Pause/Resume (background transitions)

    func pauseUptimeAccumulation() {
        guard !isUptimePaused else { return }
        isUptimePaused = true
        backgroundEnterTime = ContinuousClock.Instant.now
        appBackgroundEnterTime = ContinuousClock.Instant.now

        // Close current segment into accumulated
        if let segStart = currentSegmentStart {
            effectiveUptimeAccumulated += ContinuousClock.Instant.now - segStart
            currentSegmentStart = nil
        }
    }

    func resumeUptimeAccumulation() {
        guard isUptimePaused else { return }
        isUptimePaused = false

        // Track background duration
        if let bgEnter = backgroundEnterTime {
            totalBackgroundDuration += ContinuousClock.Instant.now - bgEnter
            backgroundEnterTime = nil
        }
        if let appBgEnter = appBackgroundEnterTime {
            totalAppBackgroundDuration += ContinuousClock.Instant.now - appBgEnter
            appBackgroundEnterTime = nil
        }

        // Start new segment if streaming
        if currentSessionState == .streaming {
            currentSegmentStart = ContinuousClock.Instant.now
        }
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
            // Close current uptime segment
            if let segStart = currentSegmentStart {
                effectiveUptimeAccumulated += now - segStart
                currentSegmentStart = nil
            }
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
            effectiveUptimeAccumulated = .zero
            totalBackgroundDuration = .zero
            streamTokens.removeAll()
        }

        if newState == .streaming && !isUptimePaused && currentSegmentStart == nil {
            currentSegmentStart = now
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

        // Detect dropped frame gaps (> 2x expected interval) and stale gaps
        if let lastTs = lastFrameInstant {
            let gap = now - lastTs
            let gapMs = durationToMs(gap)
            if gapMs > durationToMs(targetFrameInterval) * 2.0 {
                droppedFrameGaps += 1
            }
            // Stale gap: close previous segment at lastTs, start new segment now
            if gapMs > Self.staleThresholdMs {
                if let segStart = currentSegmentStart {
                    effectiveUptimeAccumulated += lastTs - segStart
                }
                currentSegmentStart = now
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

        // Uptime (frame-gated effective uptime)
        if let uptime = computeUptime() {
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

        // Battery
        let batteryLevel = UIDevice.current.batteryLevel
        let batteryState: UIDevice.BatteryState = UIDevice.current.batteryState
        let lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
        let stateStr: String
        switch batteryState {
        case .unplugged: stateStr = "unplugged"
        case .charging: stateStr = "charging"
        case .full: stateStr = "full"
        case .unknown: stateStr = "unknown"
        @unknown default: stateStr = "unknown"
        }
        let batteryMetrics = BatteryMetrics(
            level: batteryLevel,
            state: stateStr,
            lowPowerMode: lowPower
        )
        if batteryLevel >= 0 {
            batteryText = "\(Int(batteryLevel * 100))%\(lowPower ? " LPM" : "")\(batteryState == .charging ? " +" : "")"
        } else {
            batteryText = "--"
        }

        // Thermal state
        let thermalState: ProcessInfo.ThermalState = ProcessInfo.processInfo.thermalState
        let thermalStr: String
        switch thermalState {
        case .nominal: thermalStr = "nominal"
        case .fair: thermalStr = "fair"
        case .serious: thermalStr = "serious"
        case .critical: thermalStr = "critical"
        @unknown default: thermalStr = "unknown"
        }
        let thermalMetrics = ThermalMetrics(state: thermalStr)
        thermalText = thermalStr

        // Network
        let networkMetrics = NetworkMetrics(
            type: currentNetworkType,
            expensive: currentNetworkExpensive,
            constrained: currentNetworkConstrained
        )
        networkText = currentNetworkType

        // Memory
        let availableBytes = os_proc_available_memory()
        let totalPhysical = ProcessInfo.processInfo.physicalMemory
        let availableMB: Double
        let usedRatio: Double
        if availableBytes > 0 {
            availableMB = Double(availableBytes) / 1_048_576.0
            usedRatio = 1.0 - (Double(availableBytes) / Double(totalPhysical))
        } else {
            availableMB = 0
            usedRatio = 1.0
        }
        let pressureStr: String
        if usedRatio < 0.7 { pressureStr = "normal" }
        else if usedRatio < 0.85 { pressureStr = "warning" }
        else { pressureStr = "critical" }
        let memoryMetrics = MemoryMetrics(availableMB: availableMB, pressure: pressureStr)
        memoryText = String(format: "%.0fMB", availableMB)

        // Disk space
        let diskMetrics: DiskMetrics
        if let docURL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
           let values = try? docURL.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey, .volumeTotalCapacityKey]) {
            let available = Double(values.volumeAvailableCapacityForImportantUsage ?? 0) / 1_073_741_824.0
            let total = Double(values.volumeTotalCapacity ?? 0) / 1_073_741_824.0
            let percentUsed = total > 0 ? ((total - available) / total) * 100.0 : 0
            diskMetrics = DiskMetrics(availableGB: available, totalGB: total, percentUsed: percentUsed)
            diskText = String(format: "%.1f/%.0fGB", available, total)
        } else {
            diskMetrics = DiskMetrics(availableGB: 0, totalGB: 0, percentUsed: 0)
            diskText = "--"
        }

        // Cellular
        let radioTech = networkInfo.serviceCurrentRadioAccessTechnology?.values.first
        let carrierName = networkInfo.serviceSubscriberCellularProviders?.values.first?.carrierName
        let cellularMetrics: CellularMetrics?
        if let tech = radioTech {
            let shortTech = tech
                .replacingOccurrences(of: "CTRadioAccessTechnology", with: "")
            cellularMetrics = CellularMetrics(technology: shortTech, carrier: carrierName)
            cellularText = shortTech + (carrierName.map { " (\($0))" } ?? "")
        } else {
            cellularMetrics = nil
            cellularText = currentNetworkType == "cellular" ? "unknown" : "--"
        }

        // Display brightness
        let brightness = UIScreen.main.brightness
        let displayMetrics = DisplayMetrics(brightness: Float(brightness))
        brightnessText = String(format: "%.0f%%", brightness * 100)

        // Camera ISO/Exposure (phone camera mode only)
        let cameraMetrics: CameraMetrics?
        if let device = phoneCameraDeviceProvider?() {
            let iso = device.iso
            let exposureDuration = device.exposureDuration
            let exposureMs = CMTimeGetSeconds(exposureDuration) * 1000.0
            let aperture = device.lensAperture
            cameraMetrics = CameraMetrics(iso: iso, exposureMs: exposureMs, lensAperture: aperture)
            cameraInfoText = String(format: "ISO%.0f %.1fms", iso, exposureMs)
        } else {
            cameraMetrics = nil
            cameraInfoText = "--"
        }

        // Device orientation
        let deviceOrientation = UIDevice.current.orientation
        let orientationStr: String
        switch deviceOrientation {
        case .portrait: orientationStr = "portrait"
        case .portraitUpsideDown: orientationStr = "portraitUpsideDown"
        case .landscapeLeft: orientationStr = "landscapeLeft"
        case .landscapeRight: orientationStr = "landscapeRight"
        case .faceUp: orientationStr = "faceUp"
        case .faceDown: orientationStr = "faceDown"
        default: orientationStr = "unknown"
        }
        let orientationMetrics = OrientationMetrics(orientation: orientationStr)
        orientationText = orientationStr

        // Motion (accelerometer)
        let motionMetrics: MotionMetrics?
        if motionManager.isAccelerometerAvailable {
            let magnitude = sqrt(lastAccelX * lastAccelX + lastAccelY * lastAccelY + lastAccelZ * lastAccelZ)
            let stationary = magnitude < 0.3
            motionMetrics = MotionMetrics(
                accelX: lastAccelX, accelY: lastAccelY, accelZ: lastAccelZ,
                isStationary: stationary
            )
            motionText = String(format: "x%.2f y%.2f z%.2f", lastAccelX, lastAccelY, lastAccelZ)
        } else {
            motionMetrics = nil
            motionText = "--"
        }

        // Bluetooth state
        let btMetrics = BluetoothMetrics(state: currentBTState)
        bluetoothText = currentBTState

        // Activity detection
        let activityMetrics: ActivityMetrics?
        if CMMotionActivityManager.isActivityAvailable() {
            activityMetrics = ActivityMetrics(type: lastActivityType, confidence: lastActivityConfidence)
            activityText = "\(lastActivityType.rawValue) (\(lastActivityConfidence))"
        } else {
            activityMetrics = nil
            activityText = "--"
        }

        // CPU usage (app process)
        let cpuUsage = computeCPUUsage()
        let cpuMetrics = CPUMetrics(usagePercent: cpuUsage)
        cpuText = String(format: "%.1f%%", cpuUsage)

        // Location
        let locationMetrics: LocationMetrics?
        if let loc = currentLocation {
            locationMetrics = LocationMetrics(
                speed: loc.speed >= 0 ? loc.speed : nil,
                altitude: loc.verticalAccuracy >= 0 ? loc.altitude : nil,
                accuracy: loc.horizontalAccuracy >= 0 ? loc.horizontalAccuracy : nil
            )
            let speedStr = loc.speed >= 0 ? String(format: "%.1fm/s", loc.speed) : ""
            let altStr = loc.verticalAccuracy >= 0 ? String(format: " %.0fm", loc.altitude) : ""
            locationText = speedStr + altStr
        } else {
            locationMetrics = nil
            locationText = "--"
        }

        // Gyroscope
        let gyroMetrics: GyroMetrics?
        if motionManager.isGyroAvailable {
            gyroMetrics = GyroMetrics(rotationX: lastGyroX, rotationY: lastGyroY, rotationZ: lastGyroZ)
            gyroText = String(format: "x%.1f y%.1f z%.1f r/s", lastGyroX, lastGyroY, lastGyroZ)
        } else {
            gyroMetrics = nil
            gyroText = "--"
        }

        // Magnetometer
        let magMetrics: MagnetometerMetrics?
        if motionManager.isMagnetometerAvailable {
            magMetrics = MagnetometerMetrics(magX: lastMagX, magY: lastMagY, magZ: lastMagZ)
            magnetometerText = String(format: "x%.0f y%.0f z%.0f uT", lastMagX, lastMagY, lastMagZ)
        } else {
            magMetrics = nil
            magnetometerText = "--"
        }

        // Barometer
        let baroMetrics: BarometerMetrics?
        if let pressure = currentPressureKPa {
            baroMetrics = BarometerMetrics(pressureKPa: pressure)
            barometerText = String(format: "%.2fkPa", pressure)
        } else {
            baroMetrics = nil
            barometerText = "--"
        }

        // Audio level (from provider set by ViewModel)
        let audioMetrics: AudioLevelMetrics?
        if let level = audioLevelProvider?() {
            audioMetrics = AudioLevelMetrics(peakDb: level.peakDb, averageDb: level.averageDb)
            audioLevelText = String(format: "peak:%.0fdB avg:%.0fdB", level.peakDb, level.averageDb)
        } else {
            audioMetrics = nil
            audioLevelText = "--"
        }

        // Memory footprint (app's actual RSS)
        let physFootprint = computeMemoryFootprint()
        let footprintMetrics = MemoryFootprintMetrics(footprintMB: physFootprint)
        memoryFootprintText = String(format: "%.0fMB", physFootprint)

        // Proximity sensor
        let proxNear = UIDevice.current.proximityState
        let proxMetrics = ProximityMetrics(near: proxNear)
        proximityText = proxNear ? "near" : "far"

        // Foreground / background ratio
        let totalAppDuration = ContinuousClock.Instant.now - serviceStartTime
        let totalAppMs = durationToMs(totalAppDuration)
        var bgMs = durationToMs(totalAppBackgroundDuration)
        if let appBgEnter = appBackgroundEnterTime {
            bgMs += durationToMs(ContinuousClock.Instant.now - appBgEnter)
        }
        let fgMs = totalAppMs - bgMs
        let bgMetrics = BackgroundMetrics(foregroundSec: fgMs / 1000.0, backgroundSec: bgMs / 1000.0)
        backgroundText = totalAppMs > 0 ? String(format: "%.0f%%fg", (fgMs / totalAppMs) * 100) : "--"

        // Throughput (outbound bytes/sec from relay)
        let throughputMetrics: ThroughputMetrics?
        if lastTotalBytesSent > 0 {
            let now = ContinuousClock.Instant.now
            if let lastTime = lastThroughputTime {
                let elapsed = now - lastTime
                let elapsedSec = Double(elapsed.components.seconds) + Double(elapsed.components.attoseconds) / 1e18
                if elapsedSec > 0 {
                    let bytesDelta = Double(lastTotalBytesSent - lastThroughputBytes)
                    currentBytesPerSec = bytesDelta / elapsedSec
                }
            }
            lastThroughputBytes = lastTotalBytesSent
            lastThroughputTime = now
            let totalMB = Double(lastTotalBytesSent) / 1_048_576.0
            throughputMetrics = ThroughputMetrics(bytesPerSec: currentBytesPerSec, totalMB: totalMB)
            let kbps = currentBytesPerSec / 1024.0
            throughputText = kbps > 1024 ? String(format: "%.1fMB/s %.0fMB", kbps / 1024.0, totalMB)
                : String(format: "%.0fKB/s %.1fMB", kbps, totalMB)
        } else {
            throughputMetrics = nil
            throughputText = "--"
        }

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
            battery: batteryMetrics,
            thermal: thermalMetrics,
            network: networkMetrics,
            memory: memoryMetrics,
            relay: RelayMetrics(latencyMs: lastRelayLatencyMs, reconnectCount: 0),
            disk: diskMetrics,
            cellular: cellularMetrics,
            display: displayMetrics,
            camera: cameraMetrics,
            orientation: orientationMetrics,
            motion: motionMetrics,
            activity: activityMetrics,
            bluetooth: btMetrics,
            cpu: cpuMetrics,
            location: locationMetrics,
            gyro: gyroMetrics,
            magnetometer: magMetrics,
            barometer: baroMetrics,
            audioLevel: audioMetrics,
            memoryFootprint: footprintMetrics,
            proximity: proxMetrics,
            background: bgMetrics,
            throughput: throughputMetrics,
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
        guard streamingStartTime != nil else { return nil }
        var total = effectiveUptimeAccumulated
        if let segStart = currentSegmentStart {
            total += ContinuousClock.Instant.now - segStart
        }
        return total
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

    private func computeCPUUsage() -> Double {
        var taskInfo = task_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<task_basic_info>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &taskInfo) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_BASIC_INFO), $0, &count)
            }
        }
        guard result == KERN_SUCCESS else { return 0 }
        let userTime = Double(taskInfo.user_time.seconds) + Double(taskInfo.user_time.microseconds) / 1_000_000.0
        let sysTime = Double(taskInfo.system_time.seconds) + Double(taskInfo.system_time.microseconds) / 1_000_000.0
        return min((userTime + sysTime) * 10.0, 100.0)  // rough scale
    }

    private func computeMemoryFootprint() -> Double {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        guard result == KERN_SUCCESS else { return 0 }
        return Double(info.phys_footprint) / 1_048_576.0
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
