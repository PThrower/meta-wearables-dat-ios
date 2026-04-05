/*
 * AudioPlaybackStage.swift
 *
 * Pipeline stage that plays audio during an active stream session.
 *
 * Current: uses AVSpeechSynthesizer to say "hello world" on loop.
 *          Attempts to route output to connected glasses via HFP.
 *
 * Audio routing to glasses:
 *   The glasses expose two BT audio profiles (per Meta docs):
 *     - A2DP: high-quality output-only media
 *     - HFP:  8kHz mono two-way voice
 *
 *   When the audio session includes .allowBluetoothHFP and we set
 *   preferredInput to the glasses' HFP port, iOS routes
 *   AVSpeechSynthesizer output through the glasses' open-ear speakers.
 *
 *   Ref: https://wearables.developer.meta.com/docs/microphones-and-speakers/
 *
 * Key constraints:
 *   - Audio session is pre-configured as .playAndRecord by CameraAccessApp.
 *     Do NOT change the category here — it crashes the DAT SDK BT video stream.
 *   - Runs on its own actor executor — never blocks the main thread.
 */

import AVFoundation
import Foundation

actor AudioPlaybackStage: @preconcurrency FramePipelineStage {
    nonisolated let stageId = "audio-playback"
    var config: FrameStageConfig

    private var isPlaying = false
    private var loopTask: Task<Void, Never>?

    // MARK: - Tuneable constants

    private let phrase: String = "hello world"
    private let loopDelaySeconds: UInt64 = 1
    private let speechRate: Float = 0.5
    private let language: String = "en-US"

    init(config: FrameStageConfig = FrameStageConfig.maxFPS) {
        self.config = config
    }

    // MARK: - FramePipelineStage

    nonisolated func processFrame(_ packet: FramePacket) async {}

    func start() async {
        guard !isPlaying else { return }
        isPlaying = true

        // AVAudioSession APIs are @MainActor-isolated in iOS 17+.
        // Dispatch to MainActor for route probing, TTS, and audio routing.
        loopTask = Task { @MainActor in
            // Log every available audio port so we can see what's connected.
            Self.logAudioRoutes()

            // Try to route output to glasses via HFP.
            Self.tryRouteToGlasses()

            let synthesizer = AVSpeechSynthesizer()
            let voice = AVSpeechSynthesisVoice(language: await self.language)

            while await self.isPlaying && !Task.isCancelled {
                let utterance = AVSpeechUtterance(string: await self.phrase)
                utterance.rate = await self.speechRate
                utterance.voice = voice

                if synthesizer.isSpeaking {
                    synthesizer.stopSpeaking(at: .immediate)
                }
                synthesizer.speak(utterance)

                let delay = await self.loopDelaySeconds * 1_000_000_000
                try? await Task.sleep(nanoseconds: delay)
            }

            NSLog("[AudioPlayback] Loop task ended")
        }

        NSLog("[AudioPlayback] Started — speaking \"\(phrase)\" on loop every \(loopDelaySeconds)s")
    }

    func stop() async {
        guard isPlaying else { return }
        isPlaying = false
        loopTask?.cancel()
        loopTask = nil

        // Reset audio route back to default (phone speaker).
        // AVAudioSession is @MainActor-isolated in iOS 17+.
        await Task { @MainActor in
            let session = AVAudioSession.sharedInstance()
            try? session.setPreferredInput(nil)
        }.value

        NSLog("[AudioPlayback] Stopped, route reset to default")
    }

    // MARK: - Audio Route Probing

    // THREADING REVIEW:
    // This method is `nonisolated static` — does NOT run on @MainActor.
    // It calls AVAudioSession.sharedInstance() and reads route properties.
    // SAFE ONLY because callers dispatch to @MainActor before calling:
    //   - start() calls it inside `Task { @MainActor in }` block.
    // DANGER: If called from any other context (e.g. directly from actor), it will crash.
    // Consider adding `@MainActor` annotation to this method itself for compile-time safety.
    nonisolated static func logAudioRoutes() {
        let session = AVAudioSession.sharedInstance()
        let route = session.currentRoute

        NSLog("[AudioPlayback] === AUDIO ROUTE PROBE ===")
        NSLog("[AudioPlayback] Current outputs: \(route.outputs.map { "\($0.portName)(\($0.portType.rawValue))" })")
        NSLog("[AudioPlayback] Current inputs:  \(route.inputs.map { "\($0.portName)(\($0.portType.rawValue))" })")

        for input in session.availableInputs ?? [] {
            NSLog("[AudioPlayback] Available input: \(input.portName) | type=\(input.portType.rawValue) | uid=\(input.uid)")
        }

        NSLog("[AudioPlayback] Category options: \(session.categoryOptions)")
    }

    // THREADING REVIEW: Same as logAudioRoutes() — nonisolated static calling @MainActor APIs.
    // SAFE only because start() dispatches to @MainActor before calling.
    // Would crash if called from actor executor directly.
    /// Find the glasses' HFP port and set it as preferred input.
    /// Per Meta Wearables docs, HFP gives us two-way audio through the glasses.
    /// When setPreferredInput points to a BT HFP device, iOS routes output
    /// (AVSpeechSynthesizer, AVAudioPlayer, etc.) through its speakers.
    nonisolated static func tryRouteToGlasses() {
        let session = AVAudioSession.sharedInstance()

        // HFP is the two-way voice profile the glasses expose.
        // A2DP is output-only — also valid for playback.
        let allInputs = session.availableInputs ?? []
        let btInputs = allInputs.filter { input in
            input.portType == .bluetoothHFP || input.portType == .bluetoothA2DP
                || input.portType == .bluetoothLE
        }

        if let btInput = btInputs.first {
            NSLog("[AudioPlayback] Found BT audio device: \(btInput.portName) (\(btInput.portType.rawValue))")
            do {
                try session.setPreferredInput(btInput)
                let newRoute = session.currentRoute
                NSLog("[AudioPlayback] Routed to glasses — outputs: \(newRoute.outputs.map { "\($0.portName)(\($0.portType.rawValue))" })")
            } catch {
                NSLog("[AudioPlayback] Failed to set preferredInput: \(error)")
            }
        } else {
            NSLog("[AudioPlayback] No BT audio device found in availableInputs")
            for input in allInputs {
                NSLog("[AudioPlayback]   available: \(input.portName) (\(input.portType.rawValue))")
            }
        }
    }
}
