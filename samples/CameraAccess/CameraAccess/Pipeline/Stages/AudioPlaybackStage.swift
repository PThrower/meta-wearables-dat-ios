/*
 * AudioPlaybackStage.swift
 *
 * Pipeline stage that plays TTS audio through the glasses speaker during
 * an active stream session.
 *
 * Audio routing:
 *   CameraAccessApp configures the audio session as .playAndRecord with
 *   .allowBluetooth. When glasses are connected via HFP, iOS automatically
 *   routes output (AVSpeechSynthesizer, AVAudioPlayer, etc.) through the
 *   glasses' open-ear speakers.
 *
 *   We do NOT call setPreferredInput() here — that changes BOTH input and
 *   output routes, which tears down the DAT SDK's BT video stream.
 *   The default output route (glasses HFP speaker) is sufficient.
 *
 * Key constraints:
 *   - Audio session is pre-configured as .playAndRecord by CameraAccessApp.
 *     Do NOT change the category or call setPreferredInput().
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
        // Dispatch to MainActor for route probing and TTS.
        loopTask = Task { @MainActor in
            // Log current audio routes for diagnostics.
            Self.logAudioRoutes()

            // Do NOT call tryRouteToGlasses() or setPreferredInput().
            // With .allowBluetooth in the session config, the glasses HFP
            // output is already the default route. Changing it disrupts the
            // DAT SDK's BT video stream.

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

        // Do NOT call setPreferredInput(nil) — route changes disrupt
        // the DAT SDK's BT video stream.

        NSLog("[AudioPlayback] Stopped")
    }

    // MARK: - Audio Route Probing

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
}
