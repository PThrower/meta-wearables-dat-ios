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
 * DESIGN:
 * - Kept as `actor` — previous `final class` conversion caused thread safety crashes.
 * - Tap callback builds FRAU packet inline via static function (no actor hop).
 *   Only one Task per callback for the RelayStage.sendRawData() actor hop.
 *   Previous pattern created two actor hops per 20ms callback, overflowing the
 *   AudioStage mailbox and killing the tap after ~10 seconds.
 * - Thread-safe counters via os_unfair_lock (priority donation, no inversion).
 *   NOT NSLock (which caused priority inversion crash on the audio render thread).
 * - Watchdog detects tap stall after 4 seconds and rebuilds engine.
 * - Route change handler triggers engine rebuild on device connect/disconnect.
 * - NO AVAudioEngineConfigurationChange observer (fired during teardown, crashed).
 */

import AVFoundation
import Foundation
import os

// MARK: - AtomicCounter (os_unfair_lock, safe for audio render thread)

final class AtomicCounter: @unchecked Sendable {
    private var _value: UInt64 = 0
    private let lock: os_unfair_lock_t

    init() {
        lock = .allocate(capacity: 1)
        lock.initialize(to: os_unfair_lock())
    }

    deinit { lock.deallocate() }

    @discardableResult func increment() -> UInt64 {
        os_unfair_lock_lock(lock)
        _value += 1
        let v = _value
        os_unfair_lock_unlock(lock)
        return v
    }

    var value: UInt64 {
        os_unfair_lock_lock(lock)
        defer { os_unfair_lock_unlock(lock) }
        return _value
    }

    func reset() {
        os_unfair_lock_lock(lock)
        _value = 0
        os_unfair_lock_unlock(lock)
    }
}

// MARK: - AudioStage

actor AudioStage: @preconcurrency FramePipelineStage {
    nonisolated let stageId = "audio"
    var config: FrameStageConfig

    private var engine: AVAudioEngine?
    private var relayStage: RelayStage?
    private var isRunning = false
    private var isPaused = false
    private var isRebuilding = false

    // Thread-safe counters: nonisolated so the tap callback and watchdog
    // can access them without an actor hop.
    nonisolated let _seq = AtomicCounter()
    nonisolated let _tapCount = AtomicCounter()

    private var rebuildTask: Task<Void, Never>?
    private var watchdogTask: Task<Void, Never>?

    // Notification observers
    private var interruptionObserver: NSObjectProtocol?
    private var routeChangeObserver: NSObjectProtocol?

    // FRAU header: magic(4) + codec(1) + seq(8) + sampleRate(4) + channels(2) + bitsPerSample(2) + timestamp(8) = 29
    static let frauHeaderSize = 29

    // Audio parameters
    private let targetSampleRate: UInt32 = 48000
    private let targetChannels: UInt16 = 1
    private let targetBitsPerSample: UInt16 = 16
    private let bufferSize: AVAudioFrameCount = 960 // 20ms at 48kHz

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

    // MARK: - Start / Stop

    func start() async {
        guard !isRunning else { return }

        let nc = NotificationCenter.default
        interruptionObserver = nc.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] notification in
            Task { await self?.handleInterruption(notification) }
        }
        routeChangeObserver = nc.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] notification in
            Task { await self?.handleRouteChange(notification) }
        }

        let engine = AVAudioEngine()
        let inputNode = engine.inputNode

        guard let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: Double(targetSampleRate),
            channels: 1,
            interleaved: false
        ) else {
            NSLog("[AudioStage] Failed to create target audio format")
            return
        }

        guard let relay = self.relayStage else {
            NSLog("[AudioStage] No relay stage set — cannot start")
            removeObservers()
            return
        }

        // Capture counters and relay directly — no `self` in the hot path
        let seq = self._seq
        let tapCount = self._tapCount

        inputNode.installTap(onBus: 0, bufferSize: bufferSize, format: targetFormat) { buffer, _ in
            guard let floatData = buffer.floatChannelData?[0] else { return }
            let frameCount = Int(buffer.frameLength)
            if frameCount == 0 { return }

            let pcmData = AudioStage.floatToPCM16(floatData, frameCount: frameCount)
            tapCount.increment()
            let s = seq.increment()
            let packet = AudioStage.buildFRAU(pcmData, codecType: 0, sequence: s, sampleRate: 48000)

            Task { await relay.sendRawData(packet) }
        }

        do {
            try engine.start()
            self.engine = engine
            self.isRunning = true
            startWatchdog()
            NSLog("[AudioStage] Started")
        } catch {
            NSLog("[AudioStage] Engine start failed: \(error)")
            inputNode.removeTap(onBus: 0)
            removeObservers()
        }
    }

    func stop() async {
        guard isRunning else { return }

        watchdogTask?.cancel()
        watchdogTask = nil
        rebuildTask?.cancel()
        rebuildTask = nil

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

    // MARK: - Watchdog

    private func startWatchdog() {
        watchdogTask?.cancel()
        watchdogTask = Task { [weak self] in
            var lastCount: UInt64 = 0
            var stallChecks = 0
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                guard let self else { return }
                let result = await self.watchdogTick(lastCount: lastCount, stallChecks: stallChecks)
                guard result.running else { return }
                lastCount = result.count
                stallChecks = result.stallChecks
            }
        }
    }

    private func watchdogTick(lastCount: UInt64, stallChecks: Int) -> (running: Bool, count: UInt64, stallChecks: Int) {
        guard isRunning else { return (false, 0, 0) }
        let count = _tapCount.value
        let engineRunning = engine?.isRunning ?? false
        NSLog("[AudioStage] Watchdog: taps=\(count) delta=\(count - lastCount) engine=\(engineRunning) rebuild=\(isRebuilding)")

        var s = stallChecks
        if count == lastCount && !isRebuilding {
            s += 1
            if s >= 2 {
                NSLog("[AudioStage] Watchdog: tap stalled 4s — rebuilding")
                rebuildEngine()
                s = 0
            }
        } else {
            s = 0
        }
        return (true, count, s)
    }

    // MARK: - Rebuild

    private func scheduleRebuild(reason: String) {
        guard isRunning && !isRebuilding else { return }
        NSLog("[AudioStage] Scheduling rebuild: \(reason)")
        rebuildTask?.cancel()
        rebuildTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled else { return }
            await self?.rebuildEngine()
        }
    }

    private func rebuildEngine() {
        guard isRunning && !isRebuilding else { return }
        isRebuilding = true

        NSLog("[AudioStage] Rebuilding engine")

        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        engine = nil
        _tapCount.reset()

        let newEngine = AVAudioEngine()
        let inputNode = newEngine.inputNode

        guard let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: Double(targetSampleRate),
            channels: 1,
            interleaved: false
        ) else {
            NSLog("[AudioStage] Rebuild: failed to create format")
            isRebuilding = false
            return
        }

        guard let relay = self.relayStage else {
            NSLog("[AudioStage] Rebuild: no relay stage")
            isRebuilding = false
            return
        }

        let seq = self._seq
        let tapCount = self._tapCount

        inputNode.installTap(onBus: 0, bufferSize: bufferSize, format: targetFormat) { buffer, _ in
            guard let floatData = buffer.floatChannelData?[0] else { return }
            let frameCount = Int(buffer.frameLength)
            if frameCount == 0 { return }

            let pcmData = AudioStage.floatToPCM16(floatData, frameCount: frameCount)
            tapCount.increment()
            let s = seq.increment()
            let packet = AudioStage.buildFRAU(pcmData, codecType: 0, sequence: s, sampleRate: 48000)

            Task { await relay.sendRawData(packet) }
        }

        do {
            try newEngine.start()
            self.engine = newEngine
            isRebuilding = false
            NSLog("[AudioStage] Rebuild complete — hw: \(inputNode.outputFormat(forBus: 0).sampleRate)Hz")
        } catch {
            NSLog("[AudioStage] Rebuild failed: \(error)")
            inputNode.removeTap(onBus: 0)
            isRebuilding = false
        }
    }

    // MARK: - Notification Observers

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

        switch reason {
        case .oldDeviceUnavailable, .newDeviceAvailable, .routeConfigurationChange:
            scheduleRebuild(reason: reasonName)
        default:
            break
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

    nonisolated private static func buildFRAU(_ pcmData: Data, codecType: UInt8, sequence: UInt64, sampleRate: UInt32) -> Data {
        guard pcmData.count > 0 else { return Data() }

        var header = Data(capacity: frauHeaderSize)

        // Magic "FRAU"
        header.append(contentsOf: [0x46, 0x52, 0x41, 0x55])

        // Codec type
        header.append(codecType)

        // Sequence number (8 bytes LE)
        var seq = sequence
        header.append(contentsOf: withUnsafeBytes(of: &seq) { Array($0) })

        // Sample rate (4 bytes LE)
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
