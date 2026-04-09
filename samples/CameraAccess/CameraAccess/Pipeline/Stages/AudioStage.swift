/*
 * AudioStage.swift
 *
 * Pipeline stage that captures microphone audio via AVAudioEngine,
 * converts to PCM 16-bit mono, wraps in AudioPacket,
 * and publishes to AudioEventBus for any subscriber to consume.
 *
 * Decoupled from transport concerns (FRAU wire protocol, WebSocket relay).
 * Subscribers (AudioRelayStage, future recording stages) handle encoding
 * and transport independently.
 *
 * AudioPacket carries raw PCM + metadata (sample rate, codec type, sequence).
 * FRAU wire protocol encoding lives in AudioRelayStage.
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
    private var eventBus: AudioEventBus?
    private var isRunning = false
    private var isPaused = false

    // Notification observers
    private var interruptionObserver: NSObjectProtocol?
    private var routeChangeObserver: NSObjectProtocol?

    // Audio parameters
    private let targetChannels: UInt16 = 1
    private let targetBitsPerSample: UInt16 = 16

    // Codec type: 0 = mic PCM 16-bit LE
    private let codecMic: UInt8 = 0

    init(config: FrameStageConfig = FrameStageConfig.maxFPS) {
        self.config = config
    }

    func setEventBus(_ bus: AudioEventBus) {
        self.eventBus = bus
    }

    // MARK: - FramePipelineStage

    nonisolated func processFrame(_ packet: FramePacket) async {
        // Audio stage does not process video frames
    }

    func start() async {
        guard !isRunning else { return }

        // Audio session is pre-configured as .playAndRecord by CameraAccessApp.
        // Mic permission is checked by the caller (StreamSessionViewModel) before
        // crossing to this actor — no AVAudioSession calls needed here.

        // Observe audio interruptions (phone calls, Siri, alarms)
        // and route changes (glasses disconnect, BT switching).
        let nc = NotificationCenter.default
        interruptionObserver = nc.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] notification in
            Task { await self?.handleInterruption(notification) }
        }
        routeChangeObserver = nc.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] notification in
            Task { await self?.handleRouteChange(notification) }
        }

        let engine = AVAudioEngine()
        let inputNode = engine.inputNode

        // Use the input node's native hardware format for the tap.
        // Requesting a different format (e.g. 48kHz when hardware is 8kHz HFP)
        // causes AVAudioIONodeImpl::SetOutputFormat to throw an ObjC NSException
        // on iOS 18, which crashes as SIGABRT. We convert to our target format
        // in the tap callback instead.
        let hwFormat = inputNode.outputFormat(forBus: 0)
        let isFloat = hwFormat.commonFormat == .pcmFormatFloat32 || hwFormat.commonFormat == .pcmFormatFloat64

        NSLog("[AudioStage] Hardware format: \(hwFormat.sampleRate)Hz, \(hwFormat.channelCount)ch, \(hwFormat.commonFormat)")

        // Install mic tap using hardware format — no format conversion at tap level.
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: hwFormat) { [weak self] buffer, _ in
            let frameCount = Int(buffer.frameLength)
            if frameCount == 0 { return }

            let pcmData: Data
            if isFloat, let floatData = buffer.floatChannelData?[0] {
                pcmData = Self.floatToPCM16(floatData, frameCount: frameCount)
            } else if let int16Data = buffer.int16ChannelData?[0] {
                pcmData = Data(bytes: int16Data, count: frameCount * 2)
            } else {
                return
            }

            guard pcmData.count > 0 else { return }

            let sampleRate = UInt32(hwFormat.sampleRate)
            Task { [weak self] in
                await self?.publishPCMAudio(pcmData, sampleRate: sampleRate)
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

    // MARK: - AudioPacket Publishing

    /// Convert raw PCM data to AudioPacket and publish to AudioEventBus.
    /// Runs on the actor executor — safe to mutate sequenceNumber.
    private func publishPCMAudio(_ pcmData: Data, sampleRate: UInt32) {
        guard let eventBus else { return }
        guard pcmData.count > 0 else { return }

        sequenceNumber += 1

        let packet = AudioPacket(
            pcmData: pcmData,
            codecType: codecMic,
            sampleRate: sampleRate,
            channels: targetChannels,
            bitsPerSample: targetBitsPerSample,
            sequenceNumber: sequenceNumber,
            timestampMs: UInt64(Date().timeIntervalSince1970 * 1000)
        )

        Task { await eventBus.publish(packet) }
    }
}
