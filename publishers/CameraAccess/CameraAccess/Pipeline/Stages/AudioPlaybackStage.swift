/*
 * AudioPlaybackStage.swift
 *
 * Pipeline stage that plays TTS audio through the glasses or phone speaker
 * AND publishes the PCM data for relay streaming.
 *
 * Architecture:
 *   AVSpeechSynthesizer.speak() -> preferred speaker (local output)
 *   AVSpeechSynthesizer.write() -> Int16 PCM -> AudioEventBus -> relay stream
 *
 * Event-driven: call speakGuidance(_:,preferGlasses:) with guidance text.
 * The stage generates PCM via write(), plays via speak(), and publishes
 * PCM chunks to AudioEventBus (codecType 2) for relay streaming to viewers.
 *
 * Serial playback: utterances are queued and played one at a time so that
 * per-utterance audio routing (glasses vs phone) doesn't conflict. Each
 * utterance waits for the previous one to finish before changing the route.
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

    // Reusable synthesizer — lazily created on @MainActor.
    @MainActor private var synth: AVSpeechSynthesizer?

    // Serial queue: ensures utterances play one at a time with correct routing
    private var queue: [(text: String, preferGlasses: Bool)] = []
    private var isSpeaking = false
    @MainActor private var activeDelegate: SpeechWaitDelegate?

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
        queue.removeAll()
        await Task { @MainActor [weak self] in
            self?.synth?.stopSpeaking(at: .immediate)
            self?.synth = nil
        }.value
        NSLog("[AudioPlayback] Stopped")
    }

    // MARK: - Guidance TTS (queued)

    /// Queue guidance text for serial playback. Each utterance waits for the
    /// previous one to finish before changing the audio route and speaking.
    func speakGuidance(_ text: String, preferGlasses: Bool = true) async {
        guard !text.isEmpty else { return }
        NSLog("[AudioPlayback] Queued: \"\(text.prefix(80))\" preferGlasses=\(preferGlasses)")
        queue.append((text, preferGlasses))
        await drainQueue()
    }

    /// Process queued utterances one at a time.
    private func drainQueue() async {
        guard !isSpeaking else { return }  // already draining
        isSpeaking = true
        defer { isSpeaking = false }

        while let item = queue.first {
            queue.removeFirst()
            await speakNow(item.text, preferGlasses: item.preferGlasses)
        }
    }

    /// Speak a single utterance: route → speak → wait for finish → generate PCM.
    private func speakNow(_ text: String, preferGlasses: Bool) async {
        let rate = self.speechRate
        let language = self.language

        let result: (pcm: Data, sampleRate: UInt32, channels: UInt16)? = await Task { @MainActor in
            // Route to preferred output BEFORE speaking
            if preferGlasses {
                Self.routeToGlasses()
            } else {
                Self.routeToPhone()
            }

            if self.synth == nil {
                self.synth = AVSpeechSynthesizer()
            }
            guard let synth = self.synth else { return nil }

            // Stop anything currently playing before starting new
            if synth.isSpeaking {
                synth.stopSpeaking(at: .immediate)
            }

            // Speak and wait for completion via delegate
            let utterance = AVSpeechUtterance(string: text)
            utterance.rate = rate
            utterance.volume = 1.0
            utterance.voice = AVSpeechSynthesisVoice(language: language)

            let delegate = SpeechWaitDelegate()
            synth.delegate = delegate
            self.activeDelegate = delegate
            synth.speak(utterance)

            // Wait for speech to finish (with timeout)
            let finished = await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
                delegate.completion = { finished in cont.resume(returning: finished) }

                // Timeout after 30s
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 30_000_000_000)
                    delegate.resumeOnce(returning: false)
                }
            }

            NSLog("[AudioPlayback] Speech finished: \(finished), route=\(preferGlasses ? "glasses" : "phone")")

            // Generate PCM for relay publishing
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
                pcmData.append(PCMConvert.floatToPCM16(floatData, frameCount: frames))
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

    // MARK: - Audio Route

    /// Route audio output to Bluetooth HFP glasses.
    nonisolated static func routeToGlasses() {
        let session = AVAudioSession.sharedInstance()

        let route = session.currentRoute
        let outputs = route.outputs.map { "\($0.portName)(\($0.portType.rawValue))" }
        NSLog("[AudioPlayback] Current outputs before route: \(outputs)")

        if route.outputs.contains(where: { $0.portType == .bluetoothHFP }) {
            NSLog("[AudioPlayback] Already on Bluetooth HFP output")
            return
        }

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

    /// Route audio output to phone loudspeaker.
    nonisolated static func routeToPhone() {
        let session = AVAudioSession.sharedInstance()

        do {
            try session.overrideOutputAudioPort(.speaker)
            NSLog("[AudioPlayback] Routed to phone loudspeaker")
        } catch {
            NSLog("[AudioPlayback] Failed to route to phone speaker: \(error)")
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

// MARK: - Speech Wait Delegate

/// Delegate that resolves a continuation when speech finishes.
/// Used to wait for AVSpeechSynthesizer to complete before changing audio route.
@MainActor
private class SpeechWaitDelegate: NSObject, @preconcurrency AVSpeechSynthesizerDelegate {
    var completion: ((Bool) -> Void)?
    private var resumed = false

    func resumeOnce(returning value: Bool) {
        guard !resumed else { return }
        resumed = true
        completion?(value)
        completion = nil
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in
            resumeOnce(returning: true)
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in
            resumeOnce(returning: false)
        }
    }
}
