/*
 * AudioPlaybackStage.swift
 *
 * Pipeline stage that plays TTS audio through the glasses speaker during
 * an active stream session AND captures the PCM data for relay streaming.
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
 * Stream capture:
 *   Uses AVSpeechSynthesizer.write() to generate PCM buffers without
 *   affecting playback state, converts Float32 → Int16 PCM, then publishes
 *   AudioPacket (codecType=2) to AudioEventBus for relay streaming.
 *   Also calls speak() for local playback through the glasses speaker.
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
    private var eventBus: AudioEventBus?
    private var sequenceNumber: UInt64 = 0

    // MARK: - Tuneable constants

    private let phrase: String = "hello world"
    private let loopDelaySeconds: UInt64 = 1
    private let speechRate: Float = 0.5
    private let language: String = "en-US"

    init(config: FrameStageConfig = FrameStageConfig.maxFPS) {
        self.config = config
    }

    func setEventBus(_ bus: AudioEventBus) {
        self.eventBus = bus
    }

    // MARK: - FramePipelineStage

    nonisolated func processFrame(_ packet: FramePacket) async {}

    func start() async {
        guard !isPlaying else { return }
        isPlaying = true

        // AVAudioSession APIs are @MainActor-isolated in iOS 17+.
        // Dispatch to MainActor for route probing and TTS.
        loopTask = Task { @MainActor [weak self] in
            // Log current audio routes for diagnostics.
            Self.logAudioRoutes()

            let synthesizer = AVSpeechSynthesizer()
            let voice = AVSpeechSynthesisVoice(language: await self?.language ?? "en-US")

            while await self?.isPlaying == true && !Task.isCancelled {
                let phrase = await self?.phrase ?? "hello world"
                let rate = await self?.speechRate ?? 0.5

                // Use write() to capture PCM buffers for relay streaming.
                // write() does NOT affect the synthesizer's speaking state.
                let writeUtterance = AVSpeechUtterance(string: phrase)
                writeUtterance.rate = rate
                writeUtterance.voice = voice

                let bus = await self?.eventBus
                if let bus {
                    synthesizer.write(writeUtterance) { [weak self] buffer in
                        guard let self, let pcmBuffer = buffer as? AVAudioPCMBuffer else { return }
                        guard pcmBuffer.frameLength > 0 else { return }
                        Task { await self.publishBuffer(pcmBuffer, to: bus) }
                    }
                }

                // Play through glasses speaker (separate from write()).
                let speakUtterance = AVSpeechUtterance(string: phrase)
                speakUtterance.rate = rate
                speakUtterance.voice = voice

                if synthesizer.isSpeaking {
                    synthesizer.stopSpeaking(at: .immediate)
                }
                synthesizer.speak(speakUtterance)

                let delay = (await self?.loopDelaySeconds ?? 1) * 1_000_000_000
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

        NSLog("[AudioPlayback] Stopped")
    }

    // MARK: - PCM Capture & Publish

    /// Convert AVSpeechSynthesizer Float32 buffer to Int16 PCM and publish to AudioEventBus.
    private func publishBuffer(_ buffer: AVAudioPCMBuffer, to bus: AudioEventBus) async {
        guard let floatData = buffer.floatChannelData?[0] else { return }
        let frameCount = Int(buffer.frameLength)
        guard frameCount > 0 else { return }

        let pcmData = Self.floatToPCM16(floatData, frameCount: frameCount)
        guard pcmData.count > 0 else { return }

        sequenceNumber += 1

        let packet = AudioPacket(
            pcmData: pcmData,
            codecType: 2,  // playback
            sampleRate: UInt32(buffer.format.sampleRate),
            channels: UInt16(buffer.format.channelCount),
            bitsPerSample: 16,
            sequenceNumber: sequenceNumber,
            timestampMs: UInt64(Date().timeIntervalSince1970 * 1000)
        )

        await bus.publish(packet)
    }

    /// Convert Float32 samples to signed 16-bit PCM (little-endian).
    nonisolated private static func floatToPCM16(_ floatData: UnsafePointer<Float>, frameCount: Int) -> Data {
        var pcmData = Data(count: frameCount * 2)
        pcmData.withUnsafeMutableBytes { rawDest in
            guard let dest = rawDest.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
            for i in 0..<frameCount {
                let clamped = max(-1.0, min(1.0, floatData[i]))
                dest[i] = Int16(clamped * 32767.0)
            }
        }
        return pcmData
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
