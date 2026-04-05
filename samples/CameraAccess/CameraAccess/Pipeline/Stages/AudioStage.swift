/*
 * AudioStage.swift
 *
 * Pipeline stage that captures microphone audio via AVAudioEngine,
 * encodes as PCM 16-bit 48kHz mono, wraps in the FRAU wire protocol,
 * and sends over the relay WebSocket.
 *
 * Wire protocol per audio chunk:
 *   [4 bytes "FRAU"][1 byte codecType][8 bytes sequence][4 bytes sampleRate]
 *   [2 bytes channels][2 bytes bitsPerSample][8 bytes timestamp_ms][PCM payload]
 *
 * codecType: 0 = mic PCM 16-bit LE
 *
 * CRITICAL: AVAudioInputNode does NOT support format conversion on its output bus.
 * When HFP Bluetooth glasses provide 8kHz/16kHz audio, requesting a 48kHz tap
 * causes the engine's internal converter to silently fail after ~1-2 seconds.
 * FIX: Install tap at the hardware's native format, then manually convert to 48kHz
 * using AVAudioConverter.
 *
 * Runs on its own actor executor -- never blocks the main thread.
 * Audio session must be pre-configured as .playAndRecord by the app delegate;
 * this stage never changes the category (which would crash the BT video stream).
 */

import AVFoundation
import Foundation

actor AudioStage: @preconcurrency FramePipelineStage {
    nonisolated let stageId = "audio"
    var config: FrameStageConfig

    private var engine: AVAudioEngine?
    private var sequenceNumber: UInt64 = 0
    private var relayStage: RelayStage?
    private var isRunning = false
    private var isPaused = false
    private var isRebuilding = false
    private var startupGracePeriod = false
    private var rebuildTask: Task<Void, Never>?
    private var healthTask: Task<Void, Never>?
    private var tapFrameCount: UInt64 = 0

    // Notification observers
    private var interruptionObserver: NSObjectProtocol?
    private var routeChangeObserver: NSObjectProtocol?

    // FRAU header size: magic(4) + codec(1) + seq(8) + sampleRate(4) + channels(2) + bitsPerSample(2) + timestamp(8) = 29
    static let frauHeaderSize = 29

    // Audio parameters (output wire format — always 48kHz 16-bit mono)
    private let targetSampleRate: UInt32 = 48000
    private let targetChannels: UInt16 = 1
    private let targetBitsPerSample: UInt16 = 16

    // Codec type for FRAU wire protocol
    private let codecMic: UInt8 = 0      // Microphone input

    init(config: FrameStageConfig = FrameStageConfig.maxFPS) {
        self.config = config
    }

    func setRelayStage(_ stage: RelayStage) {
        self.relayStage = stage
    }

    // MARK: - FramePipelineStage

    nonisolated func processFrame(_ packet: FramePacket) async {
        // Audio stage does not process video frames
    }

    // THREADING REVIEW [FIXED]:
    // AVAudioSession permission check moved to StreamSessionViewModel.checkMicPermission()
    // which runs on @MainActor — the correct isolation context for iOS 17+.
    // This method no longer calls any @MainActor-isolated APIs.
    func start() async {
        guard !isRunning else { return }

        // Audio session is pre-configured as .playAndRecord by CameraAccessApp.
        // Mic permission is checked by the caller (StreamSessionViewModel) before
        // crossing to this actor — no AVAudioSession calls needed here.

        // Observe audio interruptions (phone calls, Siri, alarms)
        // and route changes (glasses disconnect, BT switching).
        // These run on the main thread via NotificationCenter; we dispatch
        // to this actor for safe state mutation.
        let nc = NotificationCenter.default
        interruptionObserver = nc.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] notification in
            Task { await self?.handleInterruption(notification) }
        }
        routeChangeObserver = nc.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] notification in
            Task { await self?.handleRouteChange(notification) }
        }

        let engine = AVAudioEngine()
        let inputNode = engine.inputNode

        // Use the hardware's ACTUAL output format, not a fabricated 48kHz one.
        // AVAudioInputNode does NOT support format conversion on its output bus.
        // When HFP Bluetooth glasses provide 8kHz/16kHz, requesting 48kHz causes
        // the engine's internal AUConverterNode to silently fail after ~1-2 seconds.
        let hardwareFormat = inputNode.outputFormat(forBus: 0)

        NSLog("[AudioStage] Hardware input format: \(hardwareFormat)")

        // Our desired output format for the wire protocol
        guard let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: Double(targetSampleRate),
            channels: 1,
            interleaved: false
        ) else {
            NSLog("[AudioStage] Failed to create target audio format")
            return
        }

        // Create converter from hardware format to 48kHz target
        let converter = AVAudioConverter(from: hardwareFormat, to: targetFormat)
        let ratio = targetFormat.sampleRate / hardwareFormat.sampleRate

        // Install tap at HARDWARE format with bufferSize=0 (let engine decide).
        // This avoids the internal converter that silently fails.
        inputNode.installTap(onBus: 0, bufferSize: 0, format: hardwareFormat) { [weak self] buffer, _ in
            let frameCount = Int(buffer.frameLength)
            if frameCount == 0 { return }

            // Convert hardware format -> 48kHz mono float32
            let outputFrameCapacity = AVAudioFrameCount(Double(frameCount) * ratio)
            guard let convertedBuffer = AVAudioPCMBuffer(
                pcmFormat: targetFormat,
                frameCapacity: max(outputFrameCapacity, 1)
            ) else { return }

            var newBufferAvailable = true
            let inputBlock: AVAudioConverterInputBlock = { _, outStatus in
                if newBufferAvailable {
                    outStatus.pointee = .haveData
                    newBufferAvailable = false
                    return buffer
                } else {
                    outStatus.pointee = .noDataNow
                    return nil
                }
            }

            var error: NSError?
            let status = converter?.convert(to: convertedBuffer, error: &error, withInputFrom: inputBlock)

            if status == .error {
                NSLog("[AudioStage] Converter error: \(error?.localizedDescription ?? "unknown")")
                return
            }
            if convertedBuffer.frameLength == 0 { return }

            guard let convertedFloat = convertedBuffer.floatChannelData?[0] else { return }
            let pcmData = Self.floatToPCM16(convertedFloat, frameCount: Int(convertedBuffer.frameLength))

            Task { [weak self] in
                await self?.incrementTapCount()
                await self?.sendFRAU(pcmData, codecType: await self?.codecMic ?? 0)
            }
        }

        do {
            try engine.start()
            self.engine = engine
            self.isRunning = true
            // Grace period: suppress route-change rebuilds for 500ms after start.
            self.startupGracePeriod = true
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: 500_000_000)
                await self?.clearStartupGrace()
            }
            // Health monitor: log tap activity every 2s to diagnose silent death
            self.healthTask = Task { [weak self] in
                var lastCount: UInt64 = 0
                while true {
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    guard let self, await self.isRunning else { return }
                    let count = await self.tapFrameCount
                    let engineRunning = await self.engine?.isRunning ?? false
                    NSLog("[AudioStage] Health: tapFrames=\(count) delta=\(count - lastCount) engineRunning=\(engineRunning) rebuilding=\(await self.isRebuilding) grace=\(await self.startupGracePeriod)")
                    lastCount = count
                }
            }
            NSLog("[AudioStage] Started — hardware format: \(hardwareFormat), target: 48kHz, ratio: \(ratio)")
        } catch {
            NSLog("[AudioStage] Engine start failed: \(error)")
            // Clean up taps on failure
            inputNode.removeTap(onBus: 0)
            // Remove observers
            removeObservers()
        }
    }

    func stop() async {
        guard isRunning else { return }

        rebuildTask?.cancel()
        rebuildTask = nil
        healthTask?.cancel()
        healthTask = nil

        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        engine = nil
        isRunning = false
        isPaused = false
        isRebuilding = false
        startupGracePeriod = false

        removeObservers()

        // Note: do NOT deactivate audio session here.
        // The caller (stopSession) handles session lifecycle.

        NSLog("[AudioStage] Stopped")
    }

    // MARK: - Audio Notifications

    private func removeObservers() {
        if let obs = interruptionObserver {
            NotificationCenter.default.removeObserver(obs)
            interruptionObserver = nil
        }
        if let obs = routeChangeObserver {
            NotificationCenter.default.removeObserver(obs)
            routeChangeObserver = nil
        }
    }

    private func clearStartupGrace() {
        startupGracePeriod = false
    }

    private func incrementTapCount() {
        tapFrameCount += 1
    }

    /// Handle phone calls, Siri, alarms — pause/resume the engine.
    private func handleInterruption(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
              let typeValue = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else {
            return
        }

        switch type {
        case .began:
            // Pause the engine — don't tear it down, just stop processing.
            if isRunning && !isPaused {
                engine?.pause()
                isPaused = true
                NSLog("[AudioStage] Interruption began — engine paused")
            }
        case .ended:
            // Resume if we were paused and still supposed to be running.
            if isPaused && isRunning {
                let options = userInfo[AVAudioSessionInterruptionOptionKey] as? UInt
                let shouldResume = AVAudioSession.InterruptionOptions(rawValue: options ?? 0).contains(.shouldResume)
                if shouldResume {
                    do {
                        try engine?.start()
                        isPaused = false
                        NSLog("[AudioStage] Interruption ended — engine resumed")
                    } catch {
                        NSLog("[AudioStage] Failed to resume after interruption: \(error)")
                    }
                } else {
                    NSLog("[AudioStage] Interruption ended but shouldResume=false")
                }
            }
        @unknown default:
            break
        }
    }

    /// Handle audio route changes — e.g., glasses disconnecting/reconnecting,
    /// or setPreferredInput() switching between built-in mic and HFP glasses mic.
    ///
    /// FIX: Tear down the entire engine and create a fresh one. The new engine's
    /// inputNode picks up the current hardware format. Debounced 300ms to coalesce
    /// rapid-fire notifications.
    private func handleRouteChange(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
              let reasonValue = userInfo[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue) else {
            return
        }

        let reasonName: String
        switch reason {
        case .unknown: reasonName = "unknown"
        case .newDeviceAvailable: reasonName = "newDeviceAvailable"
        case .oldDeviceUnavailable: reasonName = "oldDeviceUnavailable"
        case .categoryChange: reasonName = "categoryChange"
        case .override: reasonName = "override"
        case .routeConfigurationChange: reasonName = "routeConfigurationChange"
        default: reasonName = "other(\(reasonValue))"
        }

        NSLog("[AudioStage] Route change: \(reasonName) [running=\(isRunning) rebuilding=\(isRebuilding) grace=\(startupGracePeriod)]")

        // Skip category changes — we never change the category.
        // Skip if not running, already rebuilding, or in startup grace period.
        guard isRunning && !isRebuilding && !startupGracePeriod && reason != .categoryChange else {
            NSLog("[AudioStage] Route change skipped (guard failed)")
            return
        }

        NSLog("[AudioStage] Scheduling engine rebuild (debounce 300ms)")
        rebuildTask?.cancel()
        rebuildTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 300_000_000) // 300ms debounce
            guard !Task.isCancelled else { return }
            await self?.rebuildEngine()
        }
    }

    /// Tear down current engine and create a fresh one with correct inputNode format.
    /// Called after route changes when the hardware input device changed.
    private func rebuildEngine() {
        guard isRunning && !isRebuilding else { return }
        isRebuilding = true
        defer { isRebuilding = false }

        NSLog("[AudioStage] Rebuilding engine for new audio route")

        // Tear down existing engine — remove tap first to stop callbacks,
        // then stop. Do NOT call engine.reset() as it can invalidate buffer
        // memory while the tap callback is still executing on the audio thread.
        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        engine = nil

        // Create fresh engine — new inputNode picks up current hardware format
        let newEngine = AVAudioEngine()
        let inputNode = newEngine.inputNode
        let hardwareFormat = inputNode.outputFormat(forBus: 0)

        NSLog("[AudioStage] Rebuild hardware format: \(hardwareFormat)")

        guard let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: Double(targetSampleRate),
            channels: 1,
            interleaved: false
        ) else {
            NSLog("[AudioStage] Failed to create target format during rebuild")
            return
        }

        let converter = AVAudioConverter(from: hardwareFormat, to: targetFormat)
        let ratio = targetFormat.sampleRate / hardwareFormat.sampleRate

        // Install tap at HARDWARE format — same pattern as start()
        inputNode.installTap(onBus: 0, bufferSize: 0, format: hardwareFormat) { [weak self] buffer, _ in
            let frameCount = Int(buffer.frameLength)
            if frameCount == 0 { return }

            let outputFrameCapacity = AVAudioFrameCount(Double(frameCount) * ratio)
            guard let convertedBuffer = AVAudioPCMBuffer(
                pcmFormat: targetFormat,
                frameCapacity: max(outputFrameCapacity, 1)
            ) else { return }

            var newBufferAvailable = true
            let inputBlock: AVAudioConverterInputBlock = { _, outStatus in
                if newBufferAvailable {
                    outStatus.pointee = .haveData
                    newBufferAvailable = false
                    return buffer
                } else {
                    outStatus.pointee = .noDataNow
                    return nil
                }
            }

            var error: NSError?
            let status = converter?.convert(to: convertedBuffer, error: &error, withInputFrom: inputBlock)

            if status == .error {
                NSLog("[AudioStage] Converter error (rebuild): \(error?.localizedDescription ?? "unknown")")
                return
            }
            if convertedBuffer.frameLength == 0 { return }

            guard let convertedFloat = convertedBuffer.floatChannelData?[0] else { return }
            let pcmData = Self.floatToPCM16(convertedFloat, frameCount: Int(convertedBuffer.frameLength))

            Task { [weak self] in
                await self?.sendFRAU(pcmData, codecType: await self?.codecMic ?? 0)
            }
        }

        do {
            try newEngine.start()
            self.engine = newEngine
            NSLog("[AudioStage] Engine rebuilt and started on new route")
        } catch {
            NSLog("[AudioStage] Rebuild failed: \(error)")
            inputNode.removeTap(onBus: 0)
        }
    }

    // MARK: - PCM Conversion

    /// Convert float32 [-1.0, 1.0] to int16 PCM data
    nonisolated private static func floatToPCM16(_ floatData: UnsafePointer<Float>, frameCount: Int) -> Data {
        var pcmData = Data(count: frameCount * 2) // 2 bytes per sample
        pcmData.withUnsafeMutableBytes { rawDest in
            guard let dest = rawDest.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
            for i in 0..<frameCount {
                let clamped = max(-1.0, min(1.0, floatData[i]))
                dest[i] = Int16(clamped * 32767.0)
            }
        }
        return pcmData
    }

    // MARK: - FRAU Wire Protocol

    private func sendFRAU(_ pcmData: Data, codecType: UInt8) {
        guard let relayStage else { return }
        guard pcmData.count > 0 else { return }

        sequenceNumber += 1

        // Build FRAU header (29 bytes)
        var header = Data(capacity: Self.frauHeaderSize)

        // Magic "FRAU"
        header.append(contentsOf: [0x46, 0x52, 0x41, 0x55])

        // Codec type (1 byte): 0 = mic PCM, 1 = system/output audio PCM
        header.append(codecType)

        // Sequence number (8 bytes LE)
        var seq = sequenceNumber
        header.append(contentsOf: withUnsafeBytes(of: &seq) { Array($0) })

        // Sample rate (4 bytes LE)
        var sr = targetSampleRate
        header.append(contentsOf: withUnsafeBytes(of: &sr) { Array($0) })

        // Channels (2 bytes LE)
        var ch = targetChannels
        header.append(contentsOf: withUnsafeBytes(of: &ch) { Array($0) })

        // Bits per sample (2 bytes LE)
        var bps = targetBitsPerSample
        header.append(contentsOf: withUnsafeBytes(of: &bps) { Array($0) })

        // Timestamp ms (8 bytes LE) — same epoch as FRLY video frames
        var ts = UInt64(Date().timeIntervalSince1970 * 1000)
        header.append(contentsOf: withUnsafeBytes(of: &ts) { Array($0) })

        var message = header
        message.append(pcmData)

        Task {
            await relayStage.sendRawData(message)
        }
    }
}
