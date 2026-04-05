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
 * - Tap callback does ZERO actor hops and creates ZERO Tasks.
 *   It only calls floatToPCM16 + appends to a lock-free ring buffer.
 *   This prevents the audio render thread from ever being blocked by
 *   the Swift cooperative thread pool or actor executor contention.
 *
 * - A drain loop on the actor empties the ring buffer every 100ms
 *   and sends all buffered PCM chunks as FRAU packets. This reduces
 *   actor hops from ~50/sec (one per 20ms callback) to ~10/sec.
 *
 * - The ring buffer uses os_unfair_lock (priority donation, audio-safe).
 */

import AVFoundation
import Foundation

// MARK: - PCM Ring Buffer (os_unfair_lock, audio render thread safe)

private final class PCMRingBuffer: @unchecked Sendable {
    private var chunks: [Data] = []
    private let lock: os_unfair_lock_t

    init() {
        lock = .allocate(capacity: 1)
        lock.initialize(to: os_unfair_lock())
        chunks.reserveCapacity(64)
    }

    deinit { lock.deallocate() }

    func append(_ data: Data) {
        os_unfair_lock_lock(lock)
        chunks.append(data)
        os_unfair_lock_unlock(lock)
    }

    func drainAll() -> [Data] {
        os_unfair_lock_lock(lock)
        let result = chunks
        chunks.removeAll(keepingCapacity: true)
        os_unfair_lock_unlock(lock)
        return result
    }
}

// MARK: - AudioStage

actor AudioStage: @preconcurrency FramePipelineStage {
    nonisolated let stageId = "audio"
    var config: FrameStageConfig

    private var engine: AVAudioEngine?
    private var sequenceNumber: UInt64 = 0
    private var relayStage: RelayStage?
    private var sendQueue: RelaySendQueue?
    private var isRunning = false
    private var isPaused = false

    private let pcmBuffer = PCMRingBuffer()
    private var drainTask: Task<Void, Never>?

    private var interruptionObserver: NSObjectProtocol?
    private var routeChangeObserver: NSObjectProtocol?

    static let frauHeaderSize = 29

    private let targetSampleRate: UInt32 = 48000
    private let targetChannels: UInt16 = 1
    private let targetBitsPerSample: UInt16 = 16
    private let bufferSize: AVAudioFrameCount = 960 // 20ms at 48kHz
    private let codecMic: UInt8 = 0

    init(config: FrameStageConfig = FrameStageConfig.maxFPS) {
        self.config = config
    }

    func setRelayStage(_ stage: RelayStage) {
        self.relayStage = stage
        self.sendQueue = stage.sendQueue
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

        // Capture the ring buffer — NO self, NO Task, NO actor hop in the callback.
        let ringBuffer = self.pcmBuffer

        inputNode.installTap(onBus: 0, bufferSize: bufferSize, format: targetFormat) { buffer, _ in
            guard let floatData = buffer.floatChannelData?[0] else { return }
            let frameCount = Int(buffer.frameLength)
            if frameCount == 0 { return }

            let pcmData = AudioStage.floatToPCM16(floatData, frameCount: frameCount)
            ringBuffer.append(pcmData)
        }

        do {
            try engine.start()
            self.engine = engine
            self.isRunning = true
            startDrainLoop()
            NSLog("[AudioStage] Started — hw: \(inputNode.outputFormat(forBus: 0).sampleRate)Hz")
        } catch {
            NSLog("[AudioStage] Engine start failed: \(error)")
            inputNode.removeTap(onBus: 0)
            removeObservers()
        }
    }

    func stop() async {
        guard isRunning else { return }

        drainTask?.cancel()
        drainTask = nil

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

    // MARK: - Drain Loop

    private func startDrainLoop() {
        drainTask?.cancel()
        drainTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 100_000_000) // 100ms
                guard let self else { return }
                await self.drainAndSend()
            }
        }
    }

    private func drainAndSend() {
        guard isRunning else { return }
        let chunks = pcmBuffer.drainAll()
        for chunk in chunks {
            sendFRAU(chunk, codecType: codecMic)
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
        guard let sendQueue else { return }
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

        // Direct send via nonisolated queue — no actor hop to RelayStage
        sendQueue.send(message)
    }
}
