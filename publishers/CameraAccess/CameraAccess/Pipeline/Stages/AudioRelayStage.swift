/*
 * AudioRelayStage.swift
 *
 * Subscribes to AudioEventBus, applies audio processing (noise gate,
 * noise suppression, gain), encodes as FRAU wire protocol, and sends
 * over the relay WebSocket via RelayStage.sendRawData().
 *
 * Processing pipeline per audio packet:
 *   raw PCM → noise gate (RMS threshold) → noise suppression (EMA) → gain (dB)
 *   → skip if all-zero → FRAU encode → WebSocket send
 *
 * Runs on its own actor executor -- never blocks the main thread.
 */

import Foundation

actor AudioRelayStage: @preconcurrency FramePipelineStage, @preconcurrency AudioTransport {
    nonisolated let stageId = "audio-relay"
    var config: FrameStageConfig

    private var relayStage: RelayStage?
    private var subscriptionId: UUID?
    private var listenTask: Task<Void, Never>?
    private var isListening = false

    // Audio processing configuration — mutated by viewer control messages
    private var processingConfig = AudioProcessingConfig()

    // Noise suppression state per codecType — EMA noise floor estimate
    private var noiseFloorEstimate: [UInt8: Float] = [0: 0.0, 1: 0.0]
    private let noiseFloorAlpha: Float = 0.95  // EMA decay (slow adaptation)

    // Stats for telemetry
    private(set) var framesSuppressed: UInt64 = 0

    // FRAU v1 header: magic(4) + version(1) + payloadLength(4) + codec(1) + seq(8) + sampleRate(4) + channels(2) + bitsPerSample(2) + timestamp(8) + crc16(2) = 36
    static let frauHeaderSize = 36

    init(config: FrameStageConfig = FrameStageConfig.maxFPS) {
        self.config = config
    }

    func setRelayStage(_ stage: RelayStage) {
        self.relayStage = stage
    }

    // MARK: - Configuration Updates (called from ViewModel)

    func setGain(codecType: UInt8, gainDb: Float) {
        let clamped = max(-20.0, min(20.0, gainDb))
        processingConfig.gainDb[codecType] = clamped
        NSLog("[AudioRelayStage] Gain set: codecType=\(codecType) gainDb=\(clamped)")
    }

    func setNoiseGate(codecType: UInt8, threshold: Float) {
        let clamped = max(0.0, min(1.0, threshold))
        processingConfig.noiseGateThreshold[codecType] = clamped
        NSLog("[AudioRelayStage] Noise gate set: codecType=\(codecType) threshold=\(clamped)")
    }

    func setNoiseSuppression(codecType: UInt8, enabled: Bool) {
        processingConfig.noiseSuppressionEnabled[codecType] = enabled
        if !enabled { noiseFloorEstimate[codecType] = 0.0 }
        NSLog("[AudioRelayStage] Noise suppression: codecType=\(codecType) enabled=\(enabled)")
    }

    func setMixEnabled(_ enabled: Bool, weightPhone: Float, weightGlasses: Float) {
        processingConfig.mixEnabled = enabled
        processingConfig.mixWeights[0] = max(0.0, min(1.0, weightPhone))
        processingConfig.mixWeights[1] = max(0.0, min(1.0, weightGlasses))
        NSLog("[AudioRelayStage] Mix: enabled=\(enabled) weights=[\(processingConfig.mixWeights[0] ?? 0.5), \(processingConfig.mixWeights[1] ?? 0.5)]")
    }

    func getCurrentConfig() -> AudioProcessingConfig {
        return processingConfig
    }

    // MARK: - EventBus Subscription

    /// Subscribe to AudioEventBus and relay audio packets to the WebSocket.
    func attachToEventBus(_ bus: AudioEventBus) async {
        let (id, stream) = await bus.subscribe()
        subscriptionId = id
        isListening = true

        listenTask = Task { [weak self] in
            for await packet in stream {
                guard let self else { break }
                await self.sendAudio(packet)
            }
            await self?.setListening(false)
        }
        NSLog("[AudioRelayStage] Attached to event bus")
    }

    /// Detach from AudioEventBus.
    func detachFromEventBus(_ bus: AudioEventBus) async {
        if let id = subscriptionId {
            await bus.unsubscribe(id)
            subscriptionId = nil
        }
        listenTask?.cancel()
        listenTask = nil
        isListening = false
        NSLog("[AudioRelayStage] Detached from event bus")
    }

    private func setListening(_ value: Bool) {
        isListening = value
    }

    // MARK: - AudioTransport

    func sendAudio(_ packet: AudioPacket) async {
        guard let relayStage else { return }

        // Only process codecType 0 (phone mic) and 1 (glasses HFP mic)
        // codecType 2 (TTS) and 3 (relay inbound) pass through unmodified
        var processedData = packet.pcmData
        let ct = packet.codecType

        if ct == 0 || ct == 1 {
            // 1. Noise gate — compute RMS, skip frame if below threshold
            let threshold = processingConfig.noiseGateThreshold[ct] ?? 0.0
            if threshold > 0.0 {
                let rms = Self.computeRMS(processedData)
                if rms < threshold {
                    framesSuppressed += 1
                    return  // Skip this frame entirely — saves bandwidth
                }
            }

            // 2. Noise suppression — EMA noise floor subtraction
            if processingConfig.noiseSuppressionEnabled[ct] == true {
                var floor = noiseFloorEstimate[ct] ?? 0.0
                processedData = Self.applyNoiseSuppression(
                    processedData,
                    currentFloor: floor,
                    alpha: noiseFloorAlpha,
                    updatedFloor: &floor
                )
                noiseFloorEstimate[ct] = floor
            }

            // 3. Gain — apply dB multiplier
            let gainDb = processingConfig.gainDb[ct] ?? 0.0
            if gainDb != 0.0 {
                processedData = Self.applyGain(processedData, gainDb: gainDb)
            }
        }

        // Build FRAU with processed (or original) PCM data
        var packet = packet
        let message = Self.buildFRAU(processedData, codecType: packet.codecType,
                                      sampleRate: packet.sampleRate, channels: packet.channels,
                                      bitsPerSample: packet.bitsPerSample,
                                      sequenceNumber: packet.sequenceNumber,
                                      timestampMs: packet.timestampMs)
        await relayStage.sendRawData(message)
    }

    // MARK: - Audio Processing (pure static functions)

    /// Compute RMS amplitude of Int16 PCM data, normalized to 0.0..1.0.
    nonisolated private static func computeRMS(_ pcmData: Data) -> Float {
        guard pcmData.count >= 2 else { return 0.0 }
        let sampleCount = pcmData.count / 2
        var sumSquares: Float = 0.0
        pcmData.withUnsafeBytes { rawBuf in
            guard let samples = rawBuf.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
            for i in 0..<sampleCount {
                let normalized = Float(samples[i]) / 32768.0
                sumSquares += normalized * normalized
            }
        }
        return sqrt(sumSquares / Float(sampleCount))
    }

    /// Apply gain in dB to Int16 PCM data. Returns new Data.
    nonisolated private static func applyGain(_ pcmData: Data, gainDb: Float) -> Data {
        let gainFactor = pow(10.0, gainDb / 20.0)
        var result = Data(count: pcmData.count)
        pcmData.withUnsafeBytes { rawSrc in
            guard let src = rawSrc.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
            result.withUnsafeMutableBytes { rawDst in
                guard let dst = rawDst.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
                let sampleCount = pcmData.count / 2
                for i in 0..<sampleCount {
                    let scaled = Float(src[i]) * gainFactor
                    dst[i] = Int16(clamp(scaled, -32768.0, 32767.0))
                }
            }
        }
        return result
    }

    /// Simple noise suppression via EMA noise floor estimation and subtraction.
    /// Returns processed data and updates noise floor via inout.
    nonisolated private static func applyNoiseSuppression(_ pcmData: Data,
                                                           currentFloor: Float,
                                                           alpha: Float,
                                                           updatedFloor: inout Float) -> Data {
        // Update noise floor estimate using minimum-statistics approach
        let rms = computeRMS(pcmData)
        if rms < currentFloor {
            updatedFloor = rms  // Floor tracks minimum
        } else {
            updatedFloor = alpha * currentFloor + (1.0 - alpha) * rms
        }

        let floor = updatedFloor
        guard floor > 0.001 else { return pcmData }  // No suppression needed

        let floorAmp = floor * 32768.0  // Convert normalized threshold to Int16 scale
        var result = Data(count: pcmData.count)
        pcmData.withUnsafeBytes { rawSrc in
            guard let src = rawSrc.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
            result.withUnsafeMutableBytes { rawDst in
                guard let dst = rawDst.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
                let sampleCount = pcmData.count / 2
                for i in 0..<sampleCount {
                    let sample = Float(src[i])
                    // Spectral subtraction: reduce amplitude by noise floor
                    let sign: Float = sample >= 0 ? 1.0 : -1.0
                    let magnitude = abs(sample)
                    let cleaned = max(0.0, magnitude - floorAmp)
                    dst[i] = Int16(clamp(sign * cleaned, -32768.0, 32767.0))
                }
            }
        }
        return result
    }

    nonisolated private static func clamp(_ value: Float, _ min: Float, _ max: Float) -> Float {
        if value < min { return min }
        if value > max { return max }
        return value
    }

    // MARK: - FRAU Wire Protocol

    /// Build FRAU v1 wire protocol message from processed PCM data.
    nonisolated private static func buildFRAU(_ pcmData: Data, codecType: UInt8,
                                              sampleRate: UInt32, channels: UInt16,
                                              bitsPerSample: UInt16, sequenceNumber: UInt64,
                                              timestampMs: UInt64) -> Data {
        var header = Data(capacity: frauHeaderSize)

        // [0:4] Magic "FRAU"
        header.append(contentsOf: [0x46, 0x52, 0x41, 0x55])

        // [4] Version = 1
        header.append(UInt8(1))

        // [5:9] Payload length (u32 LE) — PCM data size
        var payloadLen = UInt32(pcmData.count)
        header.append(contentsOf: withUnsafeBytes(of: &payloadLen) { Array($0) })

        // [9] Codec type (u8)
        header.append(codecType)

        // [10:18] Sequence number (u64 LE)
        var seq = sequenceNumber
        header.append(contentsOf: withUnsafeBytes(of: &seq) { Array($0) })

        // [18:22] Sample rate (u32 LE)
        var sr = sampleRate
        header.append(contentsOf: withUnsafeBytes(of: &sr) { Array($0) })

        // [22:24] Channels (u16 LE)
        var ch = channels
        header.append(contentsOf: withUnsafeBytes(of: &ch) { Array($0) })

        // [24:26] Bits per sample (u16 LE)
        var bps = bitsPerSample
        header.append(contentsOf: withUnsafeBytes(of: &bps) { Array($0) })

        // [26:34] Timestamp ms (u64 LE)
        var ts = timestampMs
        header.append(contentsOf: withUnsafeBytes(of: &ts) { Array($0) })

        // [34:36] CRC-16/CCITT-FALSE over header bytes [0..33]
        let crc = crc16ccitt(header, offset: 0, length: 34)
        header.append(contentsOf: withUnsafeBytes(of: crc) { Array($0) })

        var message = header
        message.append(pcmData)
        return message
    }

    // MARK: - FramePipelineStage

    nonisolated func processFrame(_ packet: FramePacket) async {
        // Audio relay stage ignores video frames
    }
}
