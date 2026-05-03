/*
 * SpeechRecognitionStage.swift
 *
 * On-device speech-to-text using Apple SFSpeechRecognizer framework.
 * Runs as an independent actor (NOT a FramePipelineStage) that subscribes
 * to AudioEventBus for PCM audio data, converting buffers to AVAudioPCMBuffer
 * for SFSpeechAudioBufferRecognitionRequest.
 *
 * Supports on-device recognition (iOS 17+) for low-latency transcription
 * without network dependency. Falls back to server-side recognition if
 * on-device model is unavailable.
 *
 * IMPORTANT: Does NOT create its own AVAudioEngine — shares the audio
 * capture from AudioStage via AudioEventBus. This avoids the iOS limitation
 * where only one tap can be installed on bus 0 at a time (which caused
 * conflicts with AudioClassificationStage).
 *
 * Results are relayed as `stt_result` JSON messages through RelayStage.
 * NSSpeechRecognitionUsageDescription must be in Info.plist.
 */

import AVFoundation
import Speech
import Foundation

actor SpeechRecognitionStage {
    // AudioEventBus subscription
    private var eventBus: AudioEventBus?
    private var subscriptionId: UUID?
    private var feedTask: Task<Void, Never>?

    // Speech recognition
    private var recognitionTask: SFSpeechRecognitionTask?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var speechRecognizer: SFSpeechRecognizer?

    // Config
    private var language: String = "en-US"
    private var onDeviceOnly: Bool = true
    private var partialResults: Bool = true
    private var isEnabled = false

    // Per-stage metrics
    private var metricsTracker = StageMetricsTracker(stageId: "speech-stt", nodeType: "mobile-stt")

    // Callback for relaying results
    private var onResult: (@Sendable (TranscriptionResult) async -> Void)?

    func setOnResult(_ handler: @escaping @Sendable (TranscriptionResult) async -> Void) {
        self.onResult = handler
    }

    func collectMetrics() -> StageMetricsSnapshot? {
        metricsTracker.setMemoryMB(isEnabled ? 15.0 : 0)
        return metricsTracker.collect()
    }

    func configure(language: String, onDeviceOnly: Bool, partialResults: Bool) {
        self.language = language
        self.onDeviceOnly = onDeviceOnly
        self.partialResults = partialResults
    }

    func setEventBus(_ bus: AudioEventBus) {
        self.eventBus = bus
    }

    func start() async {
        guard !isEnabled else { return }

        do {
            guard let eventBus else {
                throw SpeechRecognitionError.eventBusNotConfigured
            }

            // Request speech recognition authorization if not yet determined
            var authStatus = SFSpeechRecognizer.authorizationStatus()
            if authStatus == .notDetermined {
                authStatus = await withCheckedContinuation { continuation in
                    SFSpeechRecognizer.requestAuthorization { status in
                        continuation.resume(returning: status)
                    }
                }
            }
            guard authStatus == .authorized else {
                throw SpeechRecognitionError.authorizationDenied(status: authStatus.rawValue)
            }

            // Create speech recognizer for the specified locale
            guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language)) else {
                throw SpeechRecognitionError.recognitionUnavailable(language: language)
            }

            // Check on-device availability if requested
            if onDeviceOnly {
                if #available(iOS 17.0, *) {
                    guard recognizer.supportsOnDeviceRecognition else {
                        throw SpeechRecognitionError.onDeviceUnavailable(language: language)
                    }
                } else {
                    throw SpeechRecognitionError.onDeviceUnavailable(language: language)
                }
            }

            self.speechRecognizer = recognizer

            // Start recognition with AudioEventBus feed
            try await startRecognition(eventBus: eventBus)

            isEnabled = true
            NSLog("[SpeechRecognition] Started: language=\(language) onDevice=\(onDeviceOnly) partial=\(partialResults)")
        } catch {
            NSLog("[SpeechRecognition] Start failed: \(error.localizedDescription)")
            sendErrorResult(error.localizedDescription)
        }
    }

    func stop() async {
        guard isEnabled else { return }
        isEnabled = false

        feedTask?.cancel()
        feedTask = nil

        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest?.endAudio()
        recognitionRequest = nil

        if let eventBus, let subId = subscriptionId {
            await eventBus.unsubscribe(subId)
            subscriptionId = nil
        }

        NSLog("[SpeechRecognition] Stopped")
    }

    // MARK: - Private

    private func startRecognition(eventBus: AudioEventBus) async throws {
        guard let speechRecognizer, speechRecognizer.isAvailable else {
            throw SpeechRecognitionError.recognitionUnavailable(language: language)
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = partialResults

        if onDeviceOnly {
            if #available(iOS 17.0, *) {
                request.requiresOnDeviceRecognition = true
            }
        }

        self.recognitionRequest = request

        // Subscribe to AudioEventBus and feed PCM buffers to recognition request
        let (subId, stream) = await eventBus.subscribe()
        self.subscriptionId = subId

        self.feedTask = Task { [weak self] in
            for await packet in stream {
                guard let self else { return }
                let enabled = await self.isEnabled
                guard enabled else { return }
                await self.feedBuffer(packet: packet)
            }
        }

        // Begin recognition task
        let task = speechRecognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { [weak self] in
                await self?.handleRecognitionResult(result, error: error)
            }
        }
        self.recognitionTask = task
    }

    /// Convert AudioPacket PCM data to AVAudioPCMBuffer and append to recognition request.
    private func feedBuffer(packet: AudioPacket) {
        guard let request = recognitionRequest else { return }

        let frameCount = UInt32(packet.pcmData.count) / 2  // 16-bit = 2 bytes per frame
        guard frameCount > 0 else { return }

        let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: Double(packet.sampleRate), channels: 1, interleaved: true)!
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else { return }

        // Copy PCM data into buffer
        packet.pcmData.withUnsafeBytes { rawBufferPointer in
            if let baseAddress = rawBufferPointer.baseAddress {
                memcpy(buffer.int16ChannelData![0], baseAddress, packet.pcmData.count)
            }
        }
        buffer.frameLength = frameCount

        request.append(buffer)
    }

    private func handleRecognitionResult(_ result: SFSpeechRecognitionResult?, error: Error?) {
        guard isEnabled else { return }

        let cpuStart = metricsTracker.beginFrame()

        if let error {
            NSLog("[SpeechRecognition] Recognition error: \(error)")
            sendErrorResult(error.localizedDescription)
            metricsTracker.endFrame(cpuStart: cpuStart, wallClockMs: 1.0)
            // Restart recognition on error (transient failures are common)
            if isEnabled {
                Task { [weak self] in
                    await self?.restartRecognition()
                }
            }
            return
        }

        guard let result else { return }

        let transcription = result.bestTranscription
        let text = transcription.formattedString
        guard !text.isEmpty else { return }

        // Extract word timestamps
        let wordTimestamps = transcription.segments.map { segment in
            WordTimestamp(
                word: segment.substring,
                startTimeMs: segment.timestamp * 1000,
                endTimeMs: (segment.timestamp + segment.duration) * 1000,
                confidence: Double(segment.confidence)
            )
        }

        // Extract alternatives
        let alternatives = result.transcriptions.dropFirst().prefix(2).map { alt in
            TranscriptionAlternative(
                text: alt.formattedString,
                confidence: 0.0 // Apple doesn't provide per-alternative confidence
            )
        }

        let transcriptionResult = TranscriptionResult(
            isFinal: result.isFinal,
            text: text,
            confidence: wordTimestamps.isEmpty ? 0.0 : wordTimestamps.map(\.confidence).reduce(0, +) / Double(wordTimestamps.count),
            alternatives: alternatives,
            wordTimestamps: wordTimestamps,
            language: language,
            error: nil
        )

        if let onResult {
            metricsTracker.endFrame(cpuStart: cpuStart, wallClockMs: 5.0)
            Task { await onResult(transcriptionResult) }
        }

        // Restart recognition on final result (continuous listening)
        if result.isFinal && isEnabled {
            Task { [weak self] in
                await self?.restartRecognition()
            }
        }
    }

    private func restartRecognition() {
        guard isEnabled else { return }

        // Cancel current task
        recognitionTask?.cancel()
        recognitionTask = nil

        // End current request
        recognitionRequest?.endAudio()
        recognitionRequest = nil

        // Cancel feed task (will resubscribe in startRecognition)
        feedTask?.cancel()
        feedTask = nil

        // Small delay before restarting to avoid rapid cycling
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 200_000_000) // 200ms
            guard let self else { return }
            let enabled = await self.isEnabled
            guard enabled else { return }
            guard let eventBus = await self.eventBus else { return }
            do {
                try await self.startRecognition(eventBus: eventBus)
            } catch {
                NSLog("[SpeechRecognition] Restart failed: \(error.localizedDescription)")
                await self.sendErrorResult(error.localizedDescription)
            }
        }
    }

    private func sendErrorResult(_ errorMessage: String) {
        let errorResult = TranscriptionResult(
            isFinal: true,
            text: "",
            confidence: 0,
            alternatives: [],
            wordTimestamps: [],
            language: language,
            error: errorMessage
        )
        if let onResult {
            Task { await onResult(errorResult) }
        }
    }
}

// MARK: - Error Types

enum SpeechRecognitionError: LocalizedError {
    case authorizationDenied(status: Int)
    case recognitionUnavailable(language: String)
    case onDeviceUnavailable(language: String)
    case eventBusNotConfigured
    case requestCreationFailed
    case recognitionFailed(underlying: Error)

    var errorDescription: String? {
        switch self {
        case .authorizationDenied(let status):
            return "Speech recognition not authorized (status: \(status))"
        case .recognitionUnavailable(let lang):
            return "No speech recognizer available for language: \(lang)"
        case .onDeviceUnavailable(let lang):
            return "On-device recognition unavailable for language: \(lang)"
        case .eventBusNotConfigured:
            return "AudioEventBus not configured — call setEventBus() before start()"
        case .requestCreationFailed:
            return "Failed to create speech recognition request"
        case .recognitionFailed(let error):
            return "Recognition failed: \(error.localizedDescription)"
        }
    }
}
