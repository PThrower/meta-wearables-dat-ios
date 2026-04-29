/*
 * VoiceActivityStage.swift
 *
 * On-device Voice Activity Detection (VAD) using audio energy analysis.
 * Runs as an independent actor (NOT a FramePipelineStage) that subscribes
 * to AudioEventBus for PCM audio data.
 *
 * Uses RMS energy + zero-crossing rate for lightweight speech detection
 * without any ML model. Configurable threshold, timing, and cooldown.
 *
 * Results are relayed as `vad_result` JSON messages through RelayStage.
 */

import AVFoundation
import Foundation

actor VoiceActivityStage {
    // AudioEventBus subscription
    private var eventBus: AudioEventBus?
    private var subscriptionId: UUID?
    private var subscriptionStream: AsyncStream<AudioPacket>?

    // Config
    private var energyThreshold: Float = -40.0   // dB, speech above this
    private var speechDurationMs: Double = 100.0  // ms of sustained energy to trigger speech_start
    private var silenceDurationMs: Double = 300.0 // ms of low energy to trigger speech_end
    private var cooldownMs: Double = 200.0        // min ms between state changes
    private var isEnabled = false

    // State tracking
    private var currentState: VAState = .silence
    private var stateChangeTimestamp: Double = 0
    private var lastEventTimestamp: Double = 0
    private var consecutiveSpeechFrames: Int = 0
    private var consecutiveSilenceFrames: Int = 0
    private var speechStartTime: Double = 0
    private var frameDurationMs: Double = 0

    // Callback for relaying results
    private var onResult: (@Sendable (VADResult) async -> Void)?

    // Background task
    private var processingTask: Task<Void, Never>?

    private enum VAState {
        case silence
        case speech
    }

    func setOnResult(_ handler: @escaping @Sendable (VADResult) async -> Void) {
        self.onResult = handler
    }

    func configure(
        energyThreshold: Float,
        speechDurationMs: Double,
        silenceDurationMs: Double,
        cooldownMs: Double
    ) {
        self.energyThreshold = energyThreshold
        self.speechDurationMs = speechDurationMs
        self.silenceDurationMs = silenceDurationMs
        self.cooldownMs = cooldownMs
    }

    func setEventBus(_ bus: AudioEventBus) {
        self.eventBus = bus
    }

    func start() async {
        guard !isEnabled else { return }
        guard let eventBus else {
            NSLog("[VAD] No AudioEventBus configured")
            return
        }
        isEnabled = true

        // Reset state
        currentState = .silence
        consecutiveSpeechFrames = 0
        consecutiveSilenceFrames = 0
        lastEventTimestamp = 0

        let (subId, stream) = await eventBus.subscribe()
        subscriptionId = subId
        subscriptionStream = stream

        // Calculate expected frame duration: bufferSize / sampleRate * 1000
        // Typical: 1024 samples / 48000 Hz * 1000 = ~21ms per frame
        let estimatedFrameDuration = 1024.0 / 48000.0 * 1000.0
        self.frameDurationMs = estimatedFrameDuration

        // Start background processing
        processingTask = Task { [weak self] in
            await self?.processLoop()
        }

        NSLog("[VAD] Started: threshold=\(energyThreshold)dB speech=\(speechDurationMs)ms silence=\(silenceDurationMs)ms cooldown=\(cooldownMs)ms")
    }

    func stop() async {
        guard isEnabled else { return }
        isEnabled = false

        processingTask?.cancel()
        processingTask = nil

        if let subId = subscriptionId, let eventBus {
            await eventBus.unsubscribe(subId)
        }
        subscriptionId = nil
        subscriptionStream = nil

        NSLog("[VAD] Stopped")
    }

    // MARK: - Processing

    private func processLoop() async {
        guard let stream = subscriptionStream else { return }

        for await packet in stream {
            guard isEnabled else { break }

            let now = Date().timeIntervalSince1970 * 1000

            // Calculate RMS energy in dB
            let energyDb = calculateEnergyDb(packet.pcmData)

            // Classify frame
            let isSpeechFrame = energyDb >= energyThreshold

            switch currentState {
            case .silence:
                if isSpeechFrame {
                    consecutiveSpeechFrames += 1
                    consecutiveSilenceFrames = 0

                    let sustainedMs = Double(consecutiveSpeechFrames) * frameDurationMs
                    if sustainedMs >= speechDurationMs {
                        let timeSinceLastEvent = now - lastEventTimestamp
                        if timeSinceLastEvent >= cooldownMs {
                            transitionTo(.speech, at: now, energyDb: energyDb)
                        }
                    }
                } else {
                    consecutiveSpeechFrames = 0
                }

            case .speech:
                if isSpeechFrame {
                    consecutiveSilenceFrames = 0
                    // Emit periodic "speech_active" updates
                    let timeSinceLastEvent = now - lastEventTimestamp
                    if timeSinceLastEvent >= 1000 { // every 1s
                        emitEvent("speech_active", isSpeech: true, energyDb: energyDb, at: now)
                    }
                } else {
                    consecutiveSilenceFrames += 1
                    consecutiveSpeechFrames = 0

                    let sustainedMs = Double(consecutiveSilenceFrames) * frameDurationMs
                    if sustainedMs >= silenceDurationMs {
                        let timeSinceLastEvent = now - lastEventTimestamp
                        if timeSinceLastEvent >= cooldownMs {
                            let speechDuration = now - speechStartTime
                            transitionTo(.silence, at: now, energyDb: energyDb, speechDuration: speechDuration)
                        }
                    }
                }
            }
        }
    }

    private func transitionTo(_ newState: VAState, at timestampMs: Double, energyDb: Float, speechDuration: Double = 0) {
        currentState = newState

        switch newState {
        case .speech:
            speechStartTime = timestampMs
            emitEvent("speech_start", isSpeech: true, energyDb: energyDb, at: timestampMs)

        case .silence:
            consecutiveSpeechFrames = 0
            consecutiveSilenceFrames = 0
            emitEvent("speech_end", isSpeech: false, energyDb: energyDb, at: timestampMs, durationMs: speechDuration)
        }

        lastEventTimestamp = timestampMs
    }

    private func emitEvent(_ eventType: String, isSpeech: Bool, energyDb: Float, at timestampMs: Double, durationMs: Double = 0) {
        let result = VADResult(
            eventType: eventType,
            isSpeech: isSpeech,
            confidence: Double(min(1.0, max(0.0, abs(energyDb - energyThreshold) / 20.0))),
            energyDb: Double(energyDb),
            durationMs: durationMs
        )

        if let onResult {
            Task { await onResult(result) }
        }
    }

    // MARK: - Energy Calculation

    /// Calculate RMS energy of 16-bit PCM data, returned in dB.
    private func calculateEnergyDb(_ pcmData: Data) -> Float {
        guard pcmData.count >= 2 else { return -96.0 }

        let sampleCount = pcmData.count / 2
        var sumSquares: Float = 0

        pcmData.withUnsafeBytes { rawBuffer in
            let int16Buffer = rawBuffer.bindMemory(to: Int16.self)
            for i in 0..<int16Buffer.count {
                let sample = Float(int16Buffer[i]) / 32768.0
                sumSquares += sample * sample
            }
        }

        let rms = sqrtf(sumSquares / Float(sampleCount))
        guard rms > 0 else { return -96.0 }

        // Convert to dB: 20 * log10(rms)
        let db = 20.0 * log10(Float(rms))
        return db
    }
}
