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
 * Runs on its own actor executor -- never blocks the main thread.
 * Audio session must be pre-configured as .playAndRecord by the app delegate;
 * this stage never changes the category (which would crash the BT video stream).
 *
 * NOTE: Previous version tapped outputNode to capture system audio (TTS), but
 * this prevented the TTS from actually playing through speakers/glasses.
 * System audio capture must be done differently — e.g. via AudioPlaybackStage
 * sending its own FRAU chunks when it speaks, not by tapping the output bus.
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

    // Notification observers
    private var interruptionObserver: NSObjectProtocol?
    private var routeChangeObserver: NSObjectProtocol?

    // FRAU header size: magic(4) + codec(1) + seq(8) + sampleRate(4) + channels(2) + bitsPerSample(2) + timestamp(8) = 29
    static let frauHeaderSize = 29

    // Audio parameters
    private let targetSampleRate: UInt32 = 48000
    private let targetChannels: UInt16 = 1
    private let targetBitsPerSample: UInt16 = 16
    private let bufferSize: AVAudioFrameCount = 960 // 20ms at 48kHz

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

        // Request 48kHz mono float32 — engine handles hardware conversion
        // even if the actual hardware (e.g. HFP at 8kHz) provides a different rate.
        guard let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: Double(targetSampleRate),
            channels: 1,
            interleaved: false
        ) else {
            NSLog("[AudioStage] Failed to create target audio format")
            return
        }

        // Install mic tap at 48kHz mono, 20ms buffer.
        // The engine will upsample/downsample from the hardware format as needed.
        inputNode.installTap(onBus: 0, bufferSize: bufferSize, format: targetFormat) { [weak self] buffer, _ in
            guard let floatData = buffer.floatChannelData?[0] else { return }
            let frameCount = Int(buffer.frameLength)
            if frameCount == 0 { return }

            let pcmData = Self.floatToPCM16(floatData, frameCount: frameCount)

            Task { [weak self] in
                await self?.sendFRAU(pcmData, codecType: await self?.codecMic ?? 0)
            }
        }

        do {
            try engine.start()
            self.engine = engine
            self.isRunning = true
            NSLog("[AudioStage] Started")
        } catch {
            NSLog("[AudioStage] Engine start failed: \(error)")
            inputNode.removeTap(onBus: 0)
            removeObservers()
        }
    }

    func stop() async {
        guard isRunning else { return }

        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        engine = nil
        isRunning = false
        isPaused = false

        removeObservers()

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

    private func handleInterruption(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
              let typeValue = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else {
            return
        }

        switch type {
        case .began:
            if isRunning && !isPaused {
                engine?.pause()
                isPaused = true
                NSLog("[AudioStage] Interruption began — engine paused")
            }
        case .ended:
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

        NSLog("[AudioStage] Route change: \(reasonName)")

        if reason == .oldDeviceUnavailable {
            if isRunning && !(engine?.isRunning ?? false) {
                NSLog("[AudioStage] Device disconnected — engine stopped by OS")
            }
        }
    }

    // MARK: - PCM Conversion

    nonisolated private static func floatToPCM16(_ floatData: UnsafePointer<Float>, frameCount: Int) -> Data {
        var pcmData = Data(count: frameCount * 2)
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

        var header = Data(capacity: Self.frauHeaderSize)

        header.append(contentsOf: [0x46, 0x52, 0x41, 0x55])
        header.append(codecType)

        var seq = sequenceNumber
        header.append(contentsOf: withUnsafeBytes(of: &seq) { Array($0) })

        var sr = targetSampleRate
        header.append(contentsOf: withUnsafeBytes(of: &sr) { Array($0) })

        var ch = targetChannels
        header.append(contentsOf: withUnsafeBytes(of: &ch) { Array($0) })

        var bps = targetBitsPerSample
        header.append(contentsOf: withUnsafeBytes(of: &bps) { Array($0) })

        var ts = UInt64(Date().timeIntervalSince1970 * 1000)
        header.append(contentsOf: withUnsafeBytes(of: &ts) { Array($0) })

        var message = header
        message.append(pcmData)

        Task {
            await relayStage.sendRawData(message)
        }
    }
}
