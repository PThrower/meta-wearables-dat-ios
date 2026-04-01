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
 * codecType: 0 = raw PCM 16-bit LE
 * timestamp_ms: same epoch as FRLY video frames — used for A/V sync in viewer
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

    // FRAU header size: magic(4) + codec(1) + seq(8) + sampleRate(4) + channels(2) + bitsPerSample(2) + timestamp(8) = 29
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

    func start() async {
        guard !isRunning else { return }

        // Audio session is already configured as .playAndRecord by CameraAccessApp.
        // Do NOT change category here — reconfiguring mid-stream crashes the DAT SDK
        // Bluetooth video connection.
        let session = AVAudioSession.sharedInstance()

        // Check microphone permission
        if session.recordPermission != .granted {
            NSLog("[AudioStage] Microphone permission not granted — requesting")
            let granted = await withCheckedContinuation { cont in
                session.requestRecordPermission { granted in
                    cont.resume(returning: granted)
                }
            }
            guard granted else {
                NSLog("[AudioStage] Microphone permission denied")
                return
            }
        }

        let engine = AVAudioEngine()
        let inputNode = engine.inputNode

        // Request 48kHz mono float32 — engine handles hardware conversion
        guard let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: Double(targetSampleRate),
            channels: 1,
            interleaved: false
        ) else {
            NSLog("[AudioStage] Failed to create target audio format")
            return
        }

        // Install mic tap at 48kHz mono, 20ms buffer
        inputNode.installTap(onBus: 0, bufferSize: bufferSize, format: targetFormat) { [weak self] buffer, _ in
            guard let floatData = buffer.floatChannelData?[0] else { return }
            let frameCount = Int(buffer.frameLength)
            if frameCount == 0 { return }

            // Convert float32 [-1.0, 1.0] -> int16 [-32768, 32767] and copy to Data
            var pcmData = Data(count: frameCount * 2) // 2 bytes per sample
            pcmData.withUnsafeMutableBytes { rawDest in
                guard let dest = rawDest.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
                for i in 0..<frameCount {
                    let clamped = max(-1.0, min(1.0, floatData[i]))
                    dest[i] = Int16(clamped * 32767.0)
                }
            }

            Task { [weak self] in
                await self?.sendFRAU(pcmData)
            }
        }

        do {
            try engine.start()
            self.engine = engine
            self.isRunning = true
            let inputName = session.currentRoute.inputs.first?.portName ?? "default"
            NSLog("[AudioStage] Started — input: \(inputName)")
        } catch {
            NSLog("[AudioStage] Engine start failed: \(error)")
        }
    }

    func stop() async {
        guard isRunning else { return }

        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        engine = nil
        isRunning = false

        // Note: do NOT deactivate audio session here.
        // The caller (stopSession) handles session lifecycle.

        NSLog("[AudioStage] Stopped")
    }

    // MARK: - FRAU Wire Protocol

    private func sendFRAU(_ pcmData: Data) {
        guard let relayStage else { return }
        guard pcmData.count > 0 else { return }

        sequenceNumber += 1

        // Build FRAU header (29 bytes)
        var header = Data(capacity: Self.frauHeaderSize)

        // Magic "FRAU"
        header.append(contentsOf: [0x46, 0x52, 0x41, 0x55])

        // Codec type (1 byte): 0 = raw PCM 16-bit LE
        header.append(0x00)

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
