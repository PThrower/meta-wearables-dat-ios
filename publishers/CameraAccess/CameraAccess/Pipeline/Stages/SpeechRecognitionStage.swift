/*
 * SpeechRecognitionStage.swift
 *
 * On-device speech-to-text using Apple SFSpeechRecognizer framework.
 * Runs as an independent actor (NOT a FramePipelineStage) with its own
 * AVAudioEngine input tap, feeding SFSpeechAudioBufferRecognitionRequest.
 *
 * Supports on-device recognition (iOS 17+) for low-latency transcription
 * without network dependency. Falls back to server-side recognition if
 * on-device model is unavailable.
 *
 * Results are relayed as `stt_result` JSON messages through RelayStage.
 * NSSpeechRecognitionUsageDescription must be in Info.plist.
 */

import AVFoundation
import Speech
import Foundation

actor SpeechRecognitionStage {
    // Audio engine for mic input
    private var audioEngine: AVAudioEngine?

    // Speech recognition
    private var recognitionTask: SFSpeechRecognitionTask?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var speechRecognizer: SFSpeechRecognizer?

    // Config
    private var language: String = "en-US"
    private var onDeviceOnly: Bool = true
    private var partialResults: Bool = true
    private var isEnabled = false

    // Callback for relaying results
    private var onResult: (@Sendable (TranscriptionResult) async -> Void)?

    func setOnResult(_ handler: @escaping @Sendable (TranscriptionResult) async -> Void) {
        self.onResult = handler
    }

    func configure(language: String, onDeviceOnly: Bool, partialResults: Bool) {
        self.language = language
        self.onDeviceOnly = onDeviceOnly
        self.partialResults = partialResults
    }

    func start() async {
        guard !isEnabled else { return }

        do {
            // Request speech recognition authorization
            let authStatus = SFSpeechRecognizer.authorizationStatus()
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

            // Set up audio session (category already .playAndRecord from app)
            let audioSession = AVAudioSession.sharedInstance()
            try audioSession.setActive(true)

            // Start recognition
            try await startRecognition()

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

        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest?.endAudio()
        recognitionRequest = nil

        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine?.stop()
        audioEngine = nil

        NSLog("[SpeechRecognition] Stopped")
    }

    // MARK: - Private

    private func startRecognition() async throws {
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

        let engine = AVAudioEngine()
        let inputNode = engine.inputNode
        let format = inputNode.outputFormat(forBus: 0)

        // Install tap to feed audio buffers to recognition request
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            Task { [weak self] in
                await self?.recognitionRequest?.append(buffer)
            }
        }

        do {
            try engine.start()
            self.audioEngine = engine
        } catch {
            throw SpeechRecognitionError.audioEngineStartFailed(underlying: error)
        }

        // Begin recognition task
        let task = speechRecognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { [weak self] in
                await self?.handleRecognitionResult(result, error: error)
            }
        }
        self.recognitionTask = task
    }

    private func handleRecognitionResult(_ result: SFSpeechRecognitionResult?, error: Error?) {
        guard isEnabled else { return }

        if let error {
            NSLog("[SpeechRecognition] Recognition error: \(error)")
            sendErrorResult(error.localizedDescription)
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

        // Small delay before restarting to avoid rapid cycling
        Task {
            try? await Task.sleep(nanoseconds: 200_000_000) // 200ms
            guard self.isEnabled else { return }
            do {
                try await self.startRecognition()
            } catch {
                NSLog("[SpeechRecognition] Restart failed: \(error.localizedDescription)")
                sendErrorResult(error.localizedDescription)
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
    case audioEngineStartFailed(underlying: Error)
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
        case .audioEngineStartFailed(let error):
            return "Audio engine start failed: \(error.localizedDescription)"
        case .requestCreationFailed:
            return "Failed to create speech recognition request"
        case .recognitionFailed(let error):
            return "Recognition failed: \(error.localizedDescription)"
        }
    }
}
