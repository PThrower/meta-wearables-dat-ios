/*
 * AudioStage.swift
 *
 * Pipeline stage that captures microphone audio via AVAudioEngine,
 * encodes as PCM 16-bit mono, wraps in the FRAU wire protocol,
 * and sends over the relay WebSocket.
 *
 * Wire protocol per audio chunk:
 *   [4 bytes "FRAU"][1 byte codecType][8 bytes sequence][4 bytes sampleRate]
 *   [2 bytes channels][2 bytes bitsPerSample][8 bytes timestamp_ms][PCM payload]
 *
 * codecType: 0 = mic PCM 16-bit LE
 *
 * DESIGN:
 * - final class (NOT actor) — actor executor hopping from the real-time audio
 *   thread was killing tap callbacks after ~1 second. Verified via SO and Apple
 *   Developer Forums: actor/MainActor isolation breaks AVAudioEngine taps.
 * - Tap installed at hardware's native format, no AVAudioConverter.
 * - Watchdog auto-rebuilds engine if tap stops firing for 2 seconds.
 *   This catches silent engine resets (HFP negotiation, route changes) without
 *   the crash risk of observing AVAudioEngineConfigurationChange (which fires
 *   during engine teardown while the audio thread still holds buffer pointers).
 * - Thread-safe counters via NSLock, called ONLY from the cooperative thread pool
 *   (inside Task closures) and the main thread — NEVER from the audio render thread.
 *   NSLock on the render thread causes priority inversion → audio watchdog kill.
 * - Tap callback does PCM extraction only. All other work (locks, FRAU header alloc,
 *   actor hops) dispatched via Task to the cooperative pool.
 */

import AVFoundation
import Foundation

final class AudioStage: FramePipelineStage, @unchecked Sendable {
    nonisolated let stageId = "audio"
    var config: FrameStageConfig

    // Engine state — only modified on main thread
    private var engine: AVAudioEngine?
    private(set) var isRunning = false
    private var isPaused = false
    private var isRebuilding = false

    // Relay reference — set once before start, read from audio thread
    private var relayStage: RelayStage?

    // Thread-safe counters (audio thread writes, main thread reads)
    private let counterLock = NSLock()
    private var _sequenceNumber: UInt64 = 0
    private var _tapFrameCount: UInt64 = 0

    // Background tasks
    private var rebuildWorkItem: DispatchWorkItem?
    private var healthTask: Task<Void, Never>?

    // Notification observers (session-level only — NOT engine config)
    private var interruptionObserver: NSObjectProtocol?
    private var routeChangeObserver: NSObjectProtocol?

    // FRAU header: magic(4) + codec(1) + seq(8) + sampleRate(4) + channels(2) + bitsPerSample(2) + timestamp(8) = 29
    static let frauHeaderSize = 29

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

    func start() async {
        guard !isRunning else { return }

        installObservers()
        startEngine()
    }

    func stop() async {
        guard isRunning else { return }

        healthTask?.cancel()
        healthTask = nil
        rebuildWorkItem?.cancel()
        rebuildWorkItem = nil

        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        engine = nil
        isRunning = false
        isPaused = false
        isRebuilding = false

        removeObservers()
        NSLog("[AudioStage] Stopped")
    }

    // MARK: - Engine Lifecycle

    private func startEngine() {
        let engine = AVAudioEngine()
        let inputNode = engine.inputNode
        let hardwareFormat = inputNode.outputFormat(forBus: 0)
        let hwSampleRate = hardwareFormat.sampleRate

        NSLog("[AudioStage] Hardware input format: \(hardwareFormat)")

        // Install tap at HARDWARE format. No format conversion.
        // CRITICAL: The tap callback runs on the real-time audio render thread.
        // Only PCM extraction is permitted here — buffer pointers are invalid after return.
        // NSLock, malloc (Data alloc for FRAU), and actor hops MUST NOT run on this thread.
        // Priority inversion on the render thread triggers the iOS audio watchdog → crash.
        inputNode.installTap(onBus: 0, bufferSize: 0, format: hardwareFormat) { [weak self] buffer, _ in
            let frameCount = Int(buffer.frameLength)
            if frameCount == 0 { return }

            let pcmData: Data
            if let floatPtr = buffer.floatChannelData?[0] {
                pcmData = Self.floatToPCM16(floatPtr, frameCount: frameCount)
            } else if let int16Ptr = buffer.int16ChannelData?[0] {
                pcmData = Self.int16Copy(int16Ptr, frameCount: frameCount)
            } else if let int32Ptr = buffer.int32ChannelData?[0] {
                pcmData = Self.int32ToPCM16(int32Ptr, frameCount: frameCount)
            } else {
                return
            }

            let rate = UInt32(hwSampleRate)
            Task { [weak self] in
                guard let self else { return }
                self.incrementTapCount()
                let seq = self.nextSequence()
                let message = Self.buildFRAU(pcmData, codecType: 0, sequence: seq, sampleRate: rate)
                guard let relay = self.relayStage else { return }
                await relay.sendRawData(message)
            }
        }

        do {
            try engine.start()
            self.engine = engine
            self.isRunning = true
            startWatchdog()
            NSLog("[AudioStage] Started — hw: \(hwSampleRate)Hz")
        } catch {
            NSLog("[AudioStage] Engine start failed: \(error)")
            inputNode.removeTap(onBus: 0)
            removeObservers()
        }
    }

    // MARK: - Observers

    private func installObservers() {
        let nc = NotificationCenter.default

        interruptionObserver = nc.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [weak self] notification in
            self?.handleInterruption(notification)
        }

        routeChangeObserver = nc.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
        ) { [weak self] notification in
            self?.handleRouteChange(notification)
        }
    }

    private func removeObservers() {
        for obs in [interruptionObserver, routeChangeObserver].compactMap({ $0 }) {
            NotificationCenter.default.removeObserver(obs)
        }
        interruptionObserver = nil
        routeChangeObserver = nil
    }

    // MARK: - Audio Notifications

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
                NSLog("[AudioStage] Interruption began — paused")
            }
        case .ended:
            if isPaused && isRunning {
                let options = userInfo[AVAudioSessionInterruptionOptionKey] as? UInt
                let shouldResume = AVAudioSession.InterruptionOptions(rawValue: options ?? 0).contains(.shouldResume)
                if shouldResume {
                    do {
                        try engine?.start()
                        isPaused = false
                        NSLog("[AudioStage] Interruption ended — resumed")
                    } catch {
                        NSLog("[AudioStage] Resume failed: \(error)")
                    }
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

        NSLog("[AudioStage] Route change: \(reason.rawValue) [running=\(isRunning) rebuild=\(isRebuilding)]")

        guard isRunning && !isRebuilding && reason != .categoryChange else { return }

        scheduleRebuild(reason: "route change (\(reason.rawValue))")
    }

    // MARK: - Rebuild

    private func scheduleRebuild(reason: String) {
        guard isRunning && !isRebuilding else { return }

        NSLog("[AudioStage] Scheduling rebuild: \(reason)")

        rebuildWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            self?.rebuildEngine()
        }
        rebuildWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: workItem)
    }

    private func rebuildEngine() {
        guard isRunning && !isRebuilding else { return }
        isRebuilding = true
        defer { isRebuilding = false }

        NSLog("[AudioStage] Rebuilding engine")

        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        engine = nil

        // Reset tap counter to detect if new engine produces data
        resetTapCount()

        let newEngine = AVAudioEngine()
        let inputNode = newEngine.inputNode
        let hardwareFormat = inputNode.outputFormat(forBus: 0)
        let hwSampleRate = hardwareFormat.sampleRate

        NSLog("[AudioStage] Rebuild hw format: \(hardwareFormat)")

        inputNode.installTap(onBus: 0, bufferSize: 0, format: hardwareFormat) { [weak self] buffer, _ in
            let frameCount = Int(buffer.frameLength)
            if frameCount == 0 { return }

            let pcmData: Data
            if let floatPtr = buffer.floatChannelData?[0] {
                pcmData = Self.floatToPCM16(floatPtr, frameCount: frameCount)
            } else if let int16Ptr = buffer.int16ChannelData?[0] {
                pcmData = Self.int16Copy(int16Ptr, frameCount: frameCount)
            } else if let int32Ptr = buffer.int32ChannelData?[0] {
                pcmData = Self.int32ToPCM16(int32Ptr, frameCount: frameCount)
            } else {
                return
            }

            let rate = UInt32(hwSampleRate)
            Task { [weak self] in
                guard let self else { return }
                self.incrementTapCount()
                let seq = self.nextSequence()
                let message = Self.buildFRAU(pcmData, codecType: 0, sequence: seq, sampleRate: rate)
                guard let relay = self.relayStage else { return }
                await relay.sendRawData(message)
            }
        }

        do {
            try newEngine.start()
            self.engine = newEngine
            NSLog("[AudioStage] Rebuilt — hw: \(hwSampleRate)Hz")
        } catch {
            NSLog("[AudioStage] Rebuild failed: \(error)")
            inputNode.removeTap(onBus: 0)
        }
    }

    // MARK: - Watchdog

    /// Monitors tap health every second. If tap count stalls for 2 consecutive
    /// checks (2 seconds), forces an engine rebuild. This catches silent engine
    /// deaths from HFP renegotiation, route changes, and configuration changes
    /// that don't trigger AVAudioSession notifications.
    private func startWatchdog() {
        healthTask?.cancel()
        healthTask = Task { [weak self] in
            var lastCount: UInt64 = 0
            var stallCount = 0

            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000) // 1 second
                guard let self, self.isRunning else { return }

                let count = self.tapFrameCount
                let engineRunning = self.engine?.isRunning ?? false
                NSLog("[AudioStage] Watchdog: taps=\(count) delta=\(count - lastCount) engine=\(engineRunning) rebuild=\(self.isRebuilding)")

                if count == lastCount && !self.isRebuilding {
                    stallCount += 1
                    if stallCount >= 2 {
                        NSLog("[AudioStage] Watchdog: tap stalled for \(stallCount)s — forcing rebuild")
                        DispatchQueue.main.async { self.scheduleRebuild(reason: "watchdog stall") }
                        stallCount = 0
                    }
                } else {
                    stallCount = 0
                }

                lastCount = count
            }
        }
    }

    // MARK: - Thread-safe Counters

    private func incrementTapCount() {
        counterLock.lock()
        _tapFrameCount += 1
        counterLock.unlock()
    }

    private func resetTapCount() {
        counterLock.lock()
        _tapFrameCount = 0
        counterLock.unlock()
    }

    private var tapFrameCount: UInt64 {
        counterLock.lock()
        defer { counterLock.unlock() }
        return _tapFrameCount
    }

    private func nextSequence() -> UInt64 {
        counterLock.lock()
        _sequenceNumber += 1
        let val = _sequenceNumber
        counterLock.unlock()
        return val
    }

    // MARK: - PCM Conversion

    /// Float32 [-1.0, 1.0] -> int16 LE
    private static func floatToPCM16(_ floatData: UnsafePointer<Float>, frameCount: Int) -> Data {
        var pcmData = Data(count: frameCount * 2)
        pcmData.withUnsafeMutableBytes { rawDest in
            guard let dest = rawDest.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
            for i in 0..<frameCount {
                dest[i] = Int16(max(-1.0, min(1.0, floatData[i])) * 32767.0)
            }
        }
        return pcmData
    }

    /// Int16 native (HFP) -> just copy bytes
    private static func int16Copy(_ int16Data: UnsafePointer<Int16>, frameCount: Int) -> Data {
        return Data(bytes: int16Data, count: frameCount * 2)
    }

    /// Int32 -> int16 LE (shift down)
    private static func int32ToPCM16(_ int32Data: UnsafePointer<Int32>, frameCount: Int) -> Data {
        var pcmData = Data(count: frameCount * 2)
        pcmData.withUnsafeMutableBytes { rawDest in
            guard let dest = rawDest.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
            for i in 0..<frameCount {
                dest[i] = Int16(clamping: int32Data[i] >> 16)
            }
        }
        return pcmData
    }

    // MARK: - FRAU Wire Protocol

    /// Build a complete FRAU packet (header + PCM payload).
    /// Called from the audio thread — must be fast and allocation-light.
    private static func buildFRAU(_ pcmData: Data, codecType: UInt8, sequence: UInt64, sampleRate: UInt32) -> Data {
        guard pcmData.count > 0 else { return Data() }

        var header = Data(capacity: frauHeaderSize)

        // Magic "FRAU"
        header.append(contentsOf: [0x46, 0x52, 0x41, 0x55])

        // Codec type (1 byte)
        header.append(codecType)

        // Sequence number (8 bytes LE)
        var seq = sequence
        header.append(contentsOf: withUnsafeBytes(of: &seq) { Array($0) })

        // Sample rate (4 bytes LE) — actual hardware rate
        var sr = sampleRate
        header.append(contentsOf: withUnsafeBytes(of: &sr) { Array($0) })

        // Channels (2 bytes LE)
        var ch: UInt16 = 1
        header.append(contentsOf: withUnsafeBytes(of: &ch) { Array($0) })

        // Bits per sample (2 bytes LE)
        var bps: UInt16 = 16
        header.append(contentsOf: withUnsafeBytes(of: &bps) { Array($0) })

        // Timestamp ms (8 bytes LE)
        var ts = UInt64(Date().timeIntervalSince1970 * 1000)
        header.append(contentsOf: withUnsafeBytes(of: &ts) { Array($0) })

        var message = header
        message.append(pcmData)
        return message
    }
}
