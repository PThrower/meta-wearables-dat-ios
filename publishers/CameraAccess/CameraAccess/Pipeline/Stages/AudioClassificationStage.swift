/*
 * AudioClassificationStage.swift
 *
 * On-device sound classification using Apple SoundAnalysis framework.
 * Runs as an independent actor (NOT a FramePipelineStage) — has its own
 * AVAudioEngine input tap and SNClassifySoundRequest analyzer.
 *
 * Results are relayed as `sensor_result` JSON messages through RelayStage.
 * NSMicrophoneUsageDescription must be in Info.plist (already present).
 *
 * Audio source routing:
 *   - .builtInMic (default): uses phone's built-in microphone
 *   - .bluetoothHFP: routes through glasses HFP mic via setPreferredInput
 *
 * IMPORTANT: Never calls setCategory — joins the app delegate's existing
 * .playAndRecord + .allowBluetooth session to avoid breaking HFP/TTS.
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
    private var targetLabels: Set<String>? = nil  // nil = all labels, non-nil = filter to these only
    private var source: AudioSource?
    private var isEnabled = false

    // Confidence smoothing (EMA per sound label)
    private var confidenceSmoother = ConfidenceSmoother(alpha: 0.3)
    private var smoothingAlpha: Double = 0.3

    // Per-stage metrics
    private var metricsTracker = StageMetricsTracker(stageId: "sensor-sound", nodeType: "sensor-sound")

    // Callback for relaying results
    private var onResult: (@Sendable (SoundClassification) async -> Void)?

    func setOnResult(_ handler: @escaping @Sendable (SoundClassification) async -> Void) {
        self.onResult = handler
    }

    func collectMetrics() -> StageMetricsSnapshot? {
        metricsTracker.setMemoryMB(isEnabled ? 10.0 : 0)
        return metricsTracker.collect()
    }

    func configure(windowDuration: Double, overlapFactor: Double, confidence: Double, maxLabels: Int, targetLabels: [String]?, smoothingAlpha: Double = 0.3, source: AudioSource? = nil) {
        self.windowDuration = windowDuration
        self.overlapFactor = overlapFactor
        self.confidenceThreshold = confidence
        self.maxLabels = maxLabels
        self.targetLabels = (targetLabels != nil && !targetLabels!.isEmpty) ? Set(targetLabels!) : nil
        self.smoothingAlpha = smoothingAlpha
        self.source = source
        confidenceSmoother.reset()
    }

    func start() async {
        guard !isEnabled else { return }
        isEnabled = true

        let audioSession = AVAudioSession.sharedInstance()
        do {
            // Do NOT call setCategory — the app delegate already configures
            // .playAndRecord + .allowBluetooth. Overriding it breaks HFP and TTS.
            try audioSession.setActive(true)
        } catch {
            NSLog("[AudioClassification] Failed to activate audio session: \(error)")
            return
        }

        // Route to requested input source
        if let source = source, source == .bluetoothHFP {
            let preferredPort = audioSession.availableInputs?.first { $0.portType == .bluetoothHFP }
            if let port = preferredPort {
                do {
                    try audioSession.setPreferredInput(port)
                    NSLog("[AudioClassification] Set preferred input to HFP: \(port.portName)")
                    // Allow time for Bluetooth HFP handshake
                    try? await Task.sleep(nanoseconds: 2 * NSEC_PER_SEC)
                } catch {
                    NSLog("[AudioClassification] Failed to set HFP preferred input: \(error), falling back to built-in")
                }
            } else {
                NSLog("[AudioClassification] No Bluetooth HFP port available, using built-in mic")
            }
        } else {
            // Explicitly prefer built-in mic
            let preferredPort = audioSession.availableInputs?.first { $0.portType == .builtInMic }
            if let port = preferredPort {
                do {
                    try audioSession.setPreferredInput(port)
                } catch {
                    NSLog("[AudioClassification] Failed to set built-in mic as preferred: \(error)")
                }
            }
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
            let sourceName = source?.displayName ?? "Phone Mic"
            NSLog("[AudioClassification] Started: source=\(sourceName) window=\(windowDuration)s overlap=\(overlapFactor) confidence=\(confidenceThreshold) maxLabels=\(maxLabels) targetLabels=\(targetLabels?.sorted().joined(separator: ", ") ?? "all")")
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
        confidenceSmoother.reset()

        // Don't deactivate the shared audio session — other stages may still need it
        NSLog("[AudioClassification] Stopped")
    }

    // MARK: - Private

    private func processBuffer(_ buffer: AVAudioPCMBuffer, at time: AVAudioTime) {
        guard let analyzer else { return }
        let cpuStart = metricsTracker.beginFrame()
        analyzer.analyze(buffer, atAudioFramePosition: time.sampleTime)
        metricsTracker.endFrame(cpuStart: cpuStart, wallClockMs: 1.0)
    }

    private func handleResults(_ results: [SNClassificationResult]) {
        guard isEnabled, let topResult = results.first else { return }

        var classifications = topResult.classifications
            .filter { $0.confidence >= confidenceThreshold }

        // Optional target label filtering — only keep labels the user cares about
        if let targets = targetLabels {
            classifications = classifications.filter { targets.contains($0.identifier) }
        }

        let filtered = classifications
            .prefix(maxLabels)
            .map { raw -> SoundLabel in
                let key = "sound-\(raw.identifier)"
                let smoothed: Double
                if smoothingAlpha < 1.0 {
                    smoothed = confidenceSmoother.smooth(key: key, raw: Double(raw.confidence))
                } else {
                    smoothed = Double(raw.confidence)
                }
                return SoundLabel(label: raw.identifier, confidence: smoothed)
            }

        // Prune stale labels from smoother
        if smoothingAlpha < 1.0 {
            confidenceSmoother.prune(maxAge: .milliseconds(2000))
        }

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
