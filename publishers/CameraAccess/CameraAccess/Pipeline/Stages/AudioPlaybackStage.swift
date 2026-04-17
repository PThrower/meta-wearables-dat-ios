/*
 * AudioPlaybackStage.swift
 *
 * Pipeline stage that plays TTS audio through the glasses speaker
 * AND publishes the PCM data for relay streaming.
 *
 * Architecture:
 *   AVSpeechSynthesizer.speak() -> glasses HFP speaker (local output)
 *   AVSpeechSynthesizer.write() -> Int16 PCM -> AudioEventBus -> relay stream
 *
 * Event-driven: call speakGuidance(_:) with guidance text from the server.
 * The stage generates PCM via write(), plays via speak(), and publishes
 * PCM chunks to AudioEventBus (codecType 2) for relay streaming to viewers.
 *
 * Key constraints:
 *   - Audio session is pre-configured as .playAndRecord by CameraAccessApp.
 *     Do NOT change the category or call setPreferredInput().
 *   - Runs on its own actor executor -- never blocks the main thread.
 */

import AVFoundation
import Foundation

actor AudioPlaybackStage: @preconcurrency FramePipelineStage {
    nonisolated let stageId = "audio-playback"
    var config: FrameStageConfig

    private var isPlaying = false
    private var eventBus: AudioEventBus?
    private var sequenceNumber: UInt64 = 0

    // TTS settings
    private let speechRate: Float = 0.5
    private let language: String = "en-US"

    // Reusable synthesizer — creating a new one each call resets audio routing.
    // Lazily created on @MainActor where it's used.
    @MainActor private var synth: AVSpeechSynthesizer?

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
        Self.logAudioRoutes()
        NSLog("[AudioPlayback] Started — waiting for guidance text")
    }

    func stop() async {
        guard isPlaying else { return }
        isPlaying = false
        await Task { @MainActor [weak self] in
            self?.synth?.stopSpeaking(at: .immediate)
            self?.synth = nil
        }.value
        NSLog("[AudioPlayback] Stopped")
    }

    // MARK: - Guidance TTS

    /// Speak guidance text through glasses speaker and publish PCM to relay.
    /// Called when the server sends a `guidance_text` JSON message.
    func speakGuidance(_ text: String) async {
        guard !text.isEmpty else { return }

        NSLog("[AudioPlayback] speakGuidance: \"\(text.prefix(80))\"")

        let rate = self.speechRate
        let language = self.language

        let result: (pcm: Data, sampleRate: UInt32, channels: UInt16)? = await Task { @MainActor in
            // Route to glasses HFP BEFORE speaking — must be on @MainActor
            // for iOS 17+ AVAudioSession strict concurrency.
            Self.routeToGlasses()

            // Reuse synthesizer to avoid route reset from new instances
            if self.synth == nil {
                self.synth = AVSpeechSynthesizer()
            }
            let synth = self.synth!

            // Stop any current speech before starting new
            if synth.isSpeaking {
                synth.stopSpeaking(at: .immediate)
            }

            // Play through glasses speaker (local output)
            let speakUtterance = AVSpeechUtterance(string: text)
            speakUtterance.rate = rate
            speakUtterance.volume = 1.0
            speakUtterance.voice = AVSpeechSynthesisVoice(language: language)
            synth.speak(speakUtterance)

            // Generate PCM for relay publishing (separate utterance)
            let writeUtterance = AVSpeechUtterance(string: text)
            writeUtterance.rate = rate
            writeUtterance.voice = AVSpeechSynthesisVoice(language: language)

            var collectedBuffers: [(buffer: AVAudioPCMBuffer, format: AVAudioFormat)] = []

            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                synth.write(writeUtterance) { buffer in
                    if let pcmBuffer = buffer as? AVAudioPCMBuffer, pcmBuffer.frameLength > 0 {
                        let format = pcmBuffer.format
                        guard let copy = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: pcmBuffer.frameLength) else { return }
                        copy.frameLength = pcmBuffer.frameLength
                        if let src = pcmBuffer.floatChannelData?[0], let dst = copy.floatChannelData?[0] {
                            dst.initialize(from: src, count: Int(pcmBuffer.frameLength) * Int(format.channelCount))
                        }
                        collectedBuffers.append((copy, format))
                    } else {
                        continuation.resume()
                    }
                }
            }

            guard let first = collectedBuffers.first else { return nil }

            let sampleRate = UInt32(first.format.sampleRate)
            let channels = UInt16(first.format.channelCount)
            var pcmData = Data()
            for (buffer, _) in collectedBuffers {
                guard let floatData = buffer.floatChannelData?[0] else { continue }
                let frames = Int(buffer.frameLength)
                pcmData.append(Self.floatToPCM16(floatData, frameCount: frames))
            }
            guard pcmData.count > 0 else { return nil }

            NSLog("[AudioPlayback] Generated \(collectedBuffers.count) buffers, \(pcmData.count) bytes, \(sampleRate)Hz")
            return (pcmData, sampleRate, channels)
        }.value

        if let result {
            await publishPCM(result.pcm, sampleRate: result.sampleRate, channels: result.channels)
            NSLog("[AudioPlayback] Published guidance PCM: \(result.pcm.count) bytes")
        } else {
            NSLog("[AudioPlayback] TTS produced no PCM for: \"\(text.prefix(50))\"")
        }
    }

    // MARK: - PCM Publish

    /// Publish Int16 PCM to AudioEventBus in chunks for relay streaming.
    private func publishPCM(_ pcm: Data, sampleRate: UInt32, channels: UInt16) async {
        guard let bus = eventBus else { return }

        let chunkSize = 2048
        let totalChunks = (pcm.count + chunkSize - 1) / chunkSize
        let baseTimestamp = UInt64(Date().timeIntervalSince1970 * 1000)
        let chunkDurationMs = UInt64(Double(chunkSize / 2) / Double(sampleRate) * 1000)

        for i in 0..<totalChunks {
            let start = i * chunkSize
            let end = min(start + chunkSize, pcm.count)
            let chunk = pcm[start..<end]

            sequenceNumber += 1

            let packet = AudioPacket(
                pcmData: Data(chunk),
                codecType: 2,
                sampleRate: sampleRate,
                channels: channels,
                bitsPerSample: 16,
                sequenceNumber: sequenceNumber,
                timestampMs: baseTimestamp + UInt64(i) * chunkDurationMs
            )

            await bus.publish(packet)
        }
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

    /// Try to route audio output to Bluetooth HFP glasses.
    /// AVSpeechSynthesizer doesn't automatically use the HFP output,
    /// so we explicitly set the preferred input to the Bluetooth port
    /// which forces output through the glasses speaker.
    nonisolated static func routeToGlasses() {
        let session = AVAudioSession.sharedInstance()

        // Log current route
        let route = session.currentRoute
        let outputs = route.outputs.map { "\($0.portName)(\($0.portType.rawValue))" }
        NSLog("[AudioPlayback] Current outputs before route: \(outputs)")

        // If already on Bluetooth HFP, nothing to do
        if route.outputs.contains(where: { $0.portType == .bluetoothHFP }) {
            NSLog("[AudioPlayback] Already on Bluetooth HFP output")
            return
        }

        // Find a Bluetooth HFP input and set it as preferred — this forces
        // the output to route through the same Bluetooth device's HFP speaker
        let btInput = session.availableInputs?.first(where: { $0.portType == .bluetoothHFP })
        if let bt = btInput {
            do {
                try session.setPreferredInput(bt)
                NSLog("[AudioPlayback] Routed to Bluetooth HFP: \(bt.portName)")
            } catch {
                NSLog("[AudioPlayback] Failed to set preferred input: \(error)")
            }
        } else {
            NSLog("[AudioPlayback] No Bluetooth HFP input found — TTS will use phone speaker")
        }
    }

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
