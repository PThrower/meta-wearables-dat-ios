/*
 * AudioRelayStage.swift
 *
 * Subscribes to AudioEventBus, encodes AudioPacket as FRAU wire protocol,
 * and sends over the relay WebSocket via RelayStage.sendRawData().
 *
 * This stage bridges the decoupled audio pipeline:
 *   AudioStage -> AudioEventBus -> AudioRelayStage -> RelayStage -> WebSocket
 *
 * FRAU wire protocol per audio chunk:
 *   [4 bytes "FRAU"][1 byte codecType][8 bytes sequence][4 bytes sampleRate]
 *   [2 bytes channels][2 bytes bitsPerSample][8 bytes timestamp_ms][PCM payload]
 *
 * Runs on its own actor executor -- never blocks the main thread.
 */

import Foundation

actor AudioRelayStage: @preconcurrency FramePipelineStage, @preconcurrency AudioTransport {
    nonisolated let stageId = "audio-relay"
    var config: FrameStageConfig

    private var relayStage: RelayStage?
    private var subscriptionId: UUID?
    private var listenTask: Task<Void, Never>?
    private var isListening = false

    // FRAU header: magic(4) + codec(1) + seq(8) + sampleRate(4) + channels(2) + bitsPerSample(2) + timestamp(8) = 29
    static let frauHeaderSize = 29

    init(config: FrameStageConfig = FrameStageConfig.maxFPS) {
        self.config = config
    }

    func setRelayStage(_ stage: RelayStage) {
        self.relayStage = stage
    }

    // MARK: - EventBus Subscription

    /// Subscribe to AudioEventBus and relay audio packets to the WebSocket.
    func attachToEventBus(_ bus: AudioEventBus) async {
        let (id, stream) = await bus.subscribe()
        subscriptionId = id
        isListening = true

        listenTask = Task { [weak self] in
            for await packet in stream {
                guard let self else { break }
                await self.sendAudio(packet)
            }
            await self?.setListening(false)
        }
        NSLog("[AudioRelayStage] Attached to event bus")
    }

    /// Detach from AudioEventBus.
    func detachFromEventBus(_ bus: AudioEventBus) async {
        if let id = subscriptionId {
            await bus.unsubscribe(id)
            subscriptionId = nil
        }
        listenTask?.cancel()
        listenTask = nil
        isListening = false
        NSLog("[AudioRelayStage] Detached from event bus")
    }

    private func setListening(_ value: Bool) {
        isListening = value
    }

    // MARK: - AudioTransport

    func sendAudio(_ packet: AudioPacket) async {
        guard let relayStage else { return }
        let message = Self.buildFRAU(packet)
        await relayStage.sendRawData(message)
    }

    // MARK: - FRAU Wire Protocol

    /// Build FRAU wire protocol message from an AudioPacket.
    /// Pure function — no actor state access needed.
    nonisolated private static func buildFRAU(_ packet: AudioPacket) -> Data {
        var header = Data(capacity: frauHeaderSize)

        // Magic "FRAU"
        header.append(contentsOf: [0x46, 0x52, 0x41, 0x55])

        // Codec type (1 byte): 0 = built-in mic, 1 = glasses HFP mic, 2 = playback
        header.append(packet.codecType)

        // Sequence number (8 bytes LE)
        var seq = packet.sequenceNumber
        header.append(contentsOf: withUnsafeBytes(of: &seq) { Array($0) })

        // Sample rate (4 bytes LE)
        var sr = packet.sampleRate
        header.append(contentsOf: withUnsafeBytes(of: &sr) { Array($0) })

        // Channels (2 bytes LE)
        var ch = packet.channels
        header.append(contentsOf: withUnsafeBytes(of: &ch) { Array($0) })

        // Bits per sample (2 bytes LE)
        var bps = packet.bitsPerSample
        header.append(contentsOf: withUnsafeBytes(of: &bps) { Array($0) })

        // Timestamp ms (8 bytes LE)
        var ts = packet.timestampMs
        header.append(contentsOf: withUnsafeBytes(of: &ts) { Array($0) })

        var message = header
        message.append(packet.pcmData)
        return message
    }

    // MARK: - FramePipelineStage

    nonisolated func processFrame(_ packet: FramePacket) async {
        // Audio relay stage ignores video frames
    }
}
