/*
 * AudioClassificationStage.swift
 *
 * On-device sound classification using Apple SoundAnalysis framework.
 * Runs as an independent actor (NOT a FramePipelineStage) — has its own
 * AVAudioEngine input tap and SNClassifySoundRequest analyzer.
 *
 * Results are relayed as `sensor_result` JSON messages through RelayStage.
 * NSMicrophoneUsageDescription must be in Info.plist (already present).
 */

import AVFoundation
import SoundAnalysis
import Foundation

actor AudioClassificationStage {
    // Audio engine for mic input
    private var audioEngine: AVAudioEngine?
    private var analyzer: SNAudioStreamAnalyzer?

    // Config
    private var windowDuration: Double = 1.5
    private var overlapFactor: Double = 0.5
    private var confidenceThreshold: Double = 0.3
    private var maxLabels: Int = 5
    private var isEnabled = false

    // Callback for relaying results
    private var onResult: (@Sendable (SoundClassification) async -> Void)?

    func setOnResult(_ handler: @escaping @Sendable (SoundClassification) async -> Void) {
        self.onResult = handler
    }

    func configure(windowDuration: Double, overlapFactor: Double, confidence: Double, maxLabels: Int) {
        self.windowDuration = windowDuration
        self.overlapFactor = overlapFactor
        self.confidenceThreshold = confidence
        self.maxLabels = maxLabels
    }

    func start() async {
        guard !isEnabled else { return }
        isEnabled = true

        let audioSession = AVAudioSession.sharedInstance()
        do {
            try audioSession.setCategory(.record, mode: .measurement)
            try audioSession.setActive(true)
        } catch {
            NSLog("[AudioClassification] Failed to set up audio session: \(error)")
            return
        }

        let engine = AVAudioEngine()
        let inputNode = engine.inputNode
        let format = inputNode.outputFormat(forBus: 0)

        // Create stream analyzer
        let sampleRate = format.sampleRate
        let bufferSize = AVAudioFrameCount(sampleRate * windowDuration)
        let analyzer = SNAudioStreamAnalyzer(format: format)

        // Create sound classification request using Apple's built-in classifier
        let request = try? SNClassifySoundRequest(classifierIdentifier: .version1)
        guard let request else {
            NSLog("[AudioClassification] Failed to create SNClassifySoundRequest")
            return
        }
        request.windowDuration = CMTime(seconds: windowDuration, preferredTimescale: 44100)
        request.overlapFactor = overlapFactor

        do {
            try analyzer.add(request, withObserver: SoundAnalysisObserver { [weak self] results in
                Task { [weak self] in
                    await self?.handleResults(results)
                }
            })
        } catch {
            NSLog("[AudioClassification] Failed to add request to analyzer: \(error)")
            return
        }

        self.analyzer = analyzer

        // Install tap on input node
        inputNode.installTap(onBus: 0, bufferSize: bufferSize, format: format) { [weak self] buffer, time in
            Task { [weak self] in
                await self?.processBuffer(buffer, at: time)
            }
        }

        do {
            try engine.start()
            self.audioEngine = engine
            NSLog("[AudioClassification] Started: window=\(windowDuration)s overlap=\(overlapFactor) confidence=\(confidenceThreshold) maxLabels=\(maxLabels)")
        } catch {
            NSLog("[AudioClassification] Failed to start audio engine: \(error)")
        }
    }

    func stop() async {
        guard isEnabled else { return }
        isEnabled = false

        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine?.stop()
        audioEngine = nil
        analyzer = nil

        let audioSession = AVAudioSession.sharedInstance()
        try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)

        NSLog("[AudioClassification] Stopped")
    }

    // MARK: - Private

    private func processBuffer(_ buffer: AVAudioPCMBuffer, at time: AVAudioTime) {
        guard let analyzer else { return }
        analyzer.analyze(buffer, atAudioFramePosition: time.sampleTime)
    }

    private func handleResults(_ results: [SNClassificationResult]) {
        guard isEnabled, let topResult = results.first else { return }

        let filtered = topResult.classifications
            .filter { $0.confidence >= confidenceThreshold }
            .prefix(maxLabels)
            .map { SoundLabel(label: $0.identifier, confidence: Double($0.confidence)) }

        guard !filtered.isEmpty else { return }

        let classification = SoundClassification(labels: Array(filtered))
        if let onResult {
            Task { await onResult(classification) }
        }
    }
}

// MARK: - SoundAnalysis Observer

private class SoundAnalysisObserver: NSObject, SNResultsObserving {
    private let handler: ([SNClassificationResult]) -> Void

    init(handler: @escaping ([SNClassificationResult]) -> Void) {
        self.handler = handler
        super.init()
    }

    func request(_ request: SNRequest, didProduce result: SNResult) {
        guard let classificationResult = result as? SNClassificationResult else { return }
        handler([classificationResult])
    }

    func request(_ request: SNRequest, didFailWithError error: Error) {
        NSLog("[AudioClassification] Request error: \(error)")
    }
}
