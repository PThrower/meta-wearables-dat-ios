/*
 * AudioPlaybackStage.swift
 *
 * Pipeline stage that plays audio during an active stream session.
 *
 * Current: uses AVSpeechSynthesizer to say "hello world" on loop.
 * Iterate from here to play TTS prompts, audio files, or route to glasses.
 *
 * Key constraints:
 *   - Audio session is pre-configured as .playAndRecord by CameraAccessApp.
 *     Do NOT change the category here — it crashes the DAT SDK BT video stream.
 *   - .mixWithOthers is set, so background audio from other apps keeps playing.
 *   - Runs on its own actor executor — never blocks the main thread.
 *
 * Iteration notes (where to go next):
 *   1. Change `phrase` to any TTS string, or make it dynamic per session event
 *   2. Swap AVSpeechSynthesizer for AVAudioPlayer + a .wav/.mp3 file:
 *        let player = try AVAudioPlayer(contentsOf: url)
 *        player.numberOfLoops = -1  // infinite loop
 *        player.play()
 *   3. Route output to Bluetooth (glasses) by picking a specific
 *      AVAudioSessionPortDescription from availableInputs
 *   4. Replace fixed delay with AVSpeechSynthesizerDelegate.didFinish
 *      to trigger next utterance only after the current one completes
 */

import AVFoundation
import Foundation

actor AudioPlaybackStage: @preconcurrency FramePipelineStage {
    nonisolated let stageId = "audio-playback"
    var config: FrameStageConfig

    private var isPlaying = false
    private var loopTask: Task<Void, Never>?

    // MARK: - Tuneable constants
    // Swap these to change behavior without touching the logic below.

    /// The phrase spoken on each loop iteration.
    /// TODO: Make this configurable from the UI or per-session.
    private let phrase: String = "hello world"

    /// Seconds to wait between utterances.
    /// The speech itself takes ~1-2s; this adds a gap on top of that.
    private let loopDelaySeconds: UInt64 = 1

    /// Speech rate: 0.0 (slowest) to 1.0 (fastest). 0.5 is normal.
    private let speechRate: Float = 0.5

    /// Voice language. "en-US" for American English.
    /// TODO: Let user pick, or detect from device locale.
    private let language: String = "en-US"

    init(config: FrameStageConfig = FrameStageConfig.maxFPS) {
        self.config = config
    }

    // MARK: - FramePipelineStage

    nonisolated func processFrame(_ packet: FramePacket) async {
        // Playback stage does not process video frames.
        // Future: use packet.timestamp for A/V sync if needed.
    }

    func start() async {
        guard !isPlaying else { return }
        isPlaying = true

        loopTask = Task { [weak self] in
            // Create synthesizer inside the loop task so it's owned by this actor.
            let synthesizer = AVSpeechSynthesizer()

            // Pick a voice for the configured language.
            // TODO: Let user select from AVSpeechSynthesisVoice.speechVoices()
            let voice = AVSpeechSynthesisVoice(language: self?.language ?? "en-US")

            while !(self?.isPlaying == false) && !Task.isCancelled {
                guard let self, self.isPlaying else { break }

                let utterance = AVSpeechUtterance(string: self.phrase)
                utterance.rate = self.speechRate
                utterance.voice = voice

                // Stop any in-progress speech before starting a new utterance.
                // This prevents overlap if the loop is faster than speech.
                if synthesizer.isSpeaking {
                    synthesizer.stopSpeaking(at: .immediate)
                }
                synthesizer.speak(utterance)

                // Wait before looping again.
                // The utterance itself takes ~1-2s to speak; this delay adds
                // a gap on top of that so it doesn't feel machine-gun.
                // TODO: Replace fixed delay with listening to
                //   AVSpeechSynthesizerDelegate.didFinish to trigger
                //   the next utterance only after the current one completes.
                let delay = (self?.loopDelaySeconds ?? 1) * 1_000_000_000
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

        // Note: do NOT deactivate the audio session here.
        // AudioStage and the DAT SDK still need it active.

        NSLog("[AudioPlayback] Stopped")
    }
}
