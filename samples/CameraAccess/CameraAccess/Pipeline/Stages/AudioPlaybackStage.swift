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
 * speak() and write() share a single TTS engine, so we pre-generate PCM via
 * write() at startup, then use only speak() in the loop. The pre-generated
 * PCM is published to AudioEventBus for relay streaming.
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
    private var loopTask: Task<Void, Never>?
    private var eventBus: AudioEventBus?
    private var sequenceNumber: UInt64 = 0

    // Pre-generated Int16 PCM from TTS write() for relay streaming
    private var pregeneratedPCM: Data?
    private var pregeneratedSampleRate: UInt32 = 0
    private var pregeneratedChannels: UInt16 = 1

    // MARK: - Tuneable constants

    private let phrase: String = "hello world"
    private let loopDelaySeconds: UInt64 = 3
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

        // Pre-generate PCM via write() for relay streaming.
        await pregenerateTTS()

        // Fallback: if write() produced nothing, generate a test 440Hz tone.
        if pregeneratedPCM == nil {
            NSLog("[AudioPlayback] write() produced no PCM — generating 440Hz test tone")
            let sampleRate: UInt32 = 22050
            let duration: Double = 1.0
            let frameCount = Int(Double(sampleRate) * duration)
            var toneData = Data(capacity: frameCount * 2)
            for i in 0..<frameCount {
                let t = Double(i) / Double(sampleRate)
                let sample = sin(2.0 * .pi * 440.0 * t)
                let clamped = max(-1.0, min(1.0, sample))
                let int16 = Int16(clamped * 32767.0 * 0.5) // 50% volume
                toneData.append(contentsOf: withUnsafeBytes(of: int16.littleEndian) { Array($0) })
            }
            self.pregeneratedPCM = toneData
            self.pregeneratedSampleRate = sampleRate
            self.pregeneratedChannels = 1
        }

        Self.logAudioRoutes()

        loopTask = Task { [weak self] in
            await Task { @MainActor in
                let synth = AVSpeechSynthesizer()
                let voice = AVSpeechSynthesisVoice(language: await self?.language ?? "en-US")

                while await self?.isPlaying == true && !Task.isCancelled {
                    let phrase = await self?.phrase ?? "hello world"
                    let rate = await self?.speechRate ?? 0.5

                    // Local output through glasses speaker.
                    let utterance = AVSpeechUtterance(string: phrase)
                    utterance.rate = rate
                    utterance.volume = 1.0
                    utterance.voice = voice

                    if synth.isSpeaking {
                        synth.stopSpeaking(at: .immediate)
                    }
                    synth.speak(utterance)

                    // Publish pre-generated PCM to event bus for relay streaming.
                    await self?.publishPregenerated()

                    NSLog("[AudioPlayback] spoke + published")

                    let delay = (await self?.loopDelaySeconds ?? 3) * 1_000_000_000
                    try? await Task.sleep(nanoseconds: delay)
                }
                NSLog("[AudioPlayback] Loop task ended")
            }.value
        }

        NSLog("[AudioPlayback] Started — \"\(phrase)\" every \(loopDelaySeconds)s, PCM=\(pregeneratedPCM?.count ?? 0) bytes, \(pregeneratedSampleRate)Hz")
    }

    func stop() async {
        guard isPlaying else { return }
        isPlaying = false
        loopTask?.cancel()
        loopTask = nil
        pregeneratedPCM = nil
        NSLog("[AudioPlayback] Stopped")
    }

    // MARK: - Pre-generation

    /// Pre-generate TTS PCM using write() on a temporary synthesizer.
    /// Stores Int16 PCM for relay stream publishing.
    /// The synthesizer is released after — the loop uses speak() on a separate instance.
    private func pregenerateTTS() async {
        let phrase = self.phrase
        let rate = self.speechRate
        let language = self.language

        let result: (pcm: Data, sampleRate: UInt32, channels: UInt16)? = await Task { @MainActor in
            let synth = AVSpeechSynthesizer()
            let utterance = AVSpeechUtterance(string: phrase)
            utterance.rate = rate
            utterance.voice = AVSpeechSynthesisVoice(language: language)

            var collectedBuffers: [(buffer: AVAudioPCMBuffer, format: AVAudioFormat)] = []

            synth.write(utterance) { buffer in
                if let pcmBuffer = buffer as? AVAudioPCMBuffer, pcmBuffer.frameLength > 0 {
                    let format = pcmBuffer.format
                    guard let copy = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: pcmBuffer.frameLength) else { return }
                    copy.frameLength = pcmBuffer.frameLength
                    if let src = pcmBuffer.floatChannelData?[0], let dst = copy.floatChannelData?[0] {
                        dst.initialize(from: src, count: Int(pcmBuffer.frameLength) * Int(format.channelCount))
                    }
                    collectedBuffers.append((copy, format))
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

            NSLog("[AudioPlayback] Pre-generated \(collectedBuffers.count) buffers, \(pcmData.count) bytes, \(sampleRate)Hz, \(channels)ch")
            return (pcmData, sampleRate, channels)
        }.value

        if let result {
            self.pregeneratedPCM = result.pcm
            self.pregeneratedSampleRate = result.sampleRate
            self.pregeneratedChannels = result.channels
        }
    }

    // MARK: - PCM Publish

    /// Publish pre-generated Int16 PCM to AudioEventBus in chunks for relay streaming.
    private func publishPregenerated() async {
        guard let pcm = pregeneratedPCM, let bus = eventBus else { return }

        let chunkSize = 2048
        let totalChunks = (pcm.count + chunkSize - 1) / chunkSize
        let baseTimestamp = UInt64(Date().timeIntervalSince1970 * 1000)
        let chunkDurationMs = UInt64(Double(chunkSize / 2) / Double(pregeneratedSampleRate) * 1000)

        for i in 0..<totalChunks {
            let start = i * chunkSize
            let end = min(start + chunkSize, pcm.count)
            let chunk = pcm[start..<end]

            sequenceNumber += 1

            let packet = AudioPacket(
                pcmData: Data(chunk),
                codecType: 2,
                sampleRate: pregeneratedSampleRate,
                channels: pregeneratedChannels,
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
