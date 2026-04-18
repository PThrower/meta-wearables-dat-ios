/*
 * AudioRelayStage.swift
 *
 * Subscribes to AudioEventBus, applies audio processing (noise gate,
 * noise suppression, gain), encodes as FRAU wire protocol, and sends
 * over the relay WebSocket via RelayStage.sendRawData().
 *
 * Processing pipeline per audio packet:
 *   raw PCM -> noise gate (RMS threshold) -> noise suppression (EMA) -> gain (dB)
 *   -> skip if all-zero -> FRAU encode -> WebSocket send
 *
 * Audio processing delegated to PCMAudioProcessing.
 * Wire protocol encoding delegated to WireProtocol.
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

    // Audio processing configuration -- mutated by viewer control messages
    private var processingConfig = AudioProcessingConfig()

    // Noise suppression state per codecType -- EMA noise floor estimate
    private var noiseFloorEstimate: [UInt8: Float] = [0: 0.0, 1: 0.0]
    private let noiseFloorAlpha: Float = 0.95  // EMA decay (slow adaptation)

    // Stats for telemetry
    private(set) var framesSuppressed: UInt64 = 0
    private var framesSent: UInt64 = 0
    private var lastLogTime: Date = .distantPast

    // Expose FRAU header size for tests (delegated to WireProtocol)
    static let frauHeaderSize = WireProtocol.frauHeaderSize

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
        guard let relayStage else {
            NSLog("[AudioRelayStage] WARNING: sendAudio called but relayStage is nil")
            return
        }

        // Only process codecType 0 (phone mic) and 1 (glasses HFP mic)
        // codecType 2 (TTS) and 3 (relay inbound) pass through unmodified
        var processedData = packet.pcmData
        let ct = packet.codecType

        if ct == 0 || ct == 1 {
            // 1. Noise gate -- compute RMS, skip frame if below threshold
            let threshold = processingConfig.noiseGateThreshold[ct] ?? 0.0
            if threshold > 0.0 {
                let rms = PCMAudioProcessing.computeRMS(processedData)
                if rms < threshold {
                    framesSuppressed += 1
                    return  // Skip this frame entirely -- saves bandwidth
                }
            }

            // 2. Noise suppression -- EMA noise floor subtraction
            if processingConfig.noiseSuppressionEnabled[ct] == true {
                var floor = noiseFloorEstimate[ct] ?? 0.0
                processedData = PCMAudioProcessing.applyNoiseSuppression(
                    processedData,
                    currentFloor: floor,
                    alpha: noiseFloorAlpha,
                    updatedFloor: &floor
                )
                noiseFloorEstimate[ct] = floor
            }

            // 3. Gain -- apply dB multiplier
            let gainDb = processingConfig.gainDb[ct] ?? 0.0
            if gainDb != 0.0 {
                processedData = PCMAudioProcessing.applyGain(processedData, gainDb: gainDb)
            }
        }

        // Build FRAU with processed (or original) PCM data via WireProtocol
        let message = WireProtocol.buildFRAU(
            pcmData: processedData,
            codecType: packet.codecType,
            sampleRate: packet.sampleRate,
            channels: packet.channels,
            bitsPerSample: packet.bitsPerSample,
            sequenceNumber: packet.sequenceNumber,
            timestampMs: packet.timestampMs
        )
        await relayStage.sendRawData(message)
        framesSent += 1

        // Diagnostic: log every 2 seconds
        let now = Date()
        if now.timeIntervalSince(lastLogTime) >= 2.0 {
            lastLogTime = now
            NSLog("[AudioRelayStage] sent=\(framesSent) suppressed=\(framesSuppressed) ct=\(ct) pcmSize=\(processedData.count) msgSize=\(message.count)")
        }
    }

    // MARK: - FramePipelineStage

    nonisolated func processFrame(_ packet: FramePacket) async {
        // Audio relay stage ignores video frames
    }
}
