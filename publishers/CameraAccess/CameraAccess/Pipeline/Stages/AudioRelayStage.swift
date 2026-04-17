/*
 * AudioRelayStage.swift
 *
 * Subscribes to AudioEventBus, encodes AudioPacket as FRAU wire protocol,
 * and sends over the relay WebSocket via RelayStage.sendRawData().
 *
 * This stage bridges the decoupled audio pipeline:
 *   AudioStage -> AudioEventBus -> AudioRelayStage -> RelayStage -> WebSocket
 *
 * FRAU wire protocol v1 per audio chunk (36-byte header):
 *   [4 bytes "FRAU"][1 byte version=1][4 bytes payloadLength][1 byte codecType]
 *   [8 bytes sequence][4 bytes sampleRate][2 bytes channels][2 bytes bitsPerSample]
 *   [8 bytes timestamp_ms][2 bytes headerCrc16][PCM payload]
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

    // FRAU v1 header: magic(4) + version(1) + payloadLength(4) + codec(1) + seq(8) + sampleRate(4) + channels(2) + bitsPerSample(2) + timestamp(8) + crc16(2) = 36
    static let frauHeaderSize = 36

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

    /// Build FRAU v1 wire protocol message from an AudioPacket.
    /// Pure function — no actor state access needed.
    nonisolated private static func buildFRAU(_ packet: AudioPacket) -> Data {
        var header = Data(capacity: frauHeaderSize)

        // [0:4] Magic "FRAU"
        header.append(contentsOf: [0x46, 0x52, 0x41, 0x55])

        // [4] Version = 1
        header.append(UInt8(1))

        // [5:9] Payload length (u32 LE) — PCM data size
        var payloadLen = UInt32(packet.pcmData.count)
        header.append(contentsOf: withUnsafeBytes(of: &payloadLen) { Array($0) })

        // [9] Codec type (u8): 0 = built-in mic, 1 = glasses HFP mic, 2 = playback
        header.append(packet.codecType)

        // [10:18] Sequence number (u64 LE)
        var seq = packet.sequenceNumber
        header.append(contentsOf: withUnsafeBytes(of: &seq) { Array($0) })

        // [18:22] Sample rate (u32 LE)
        var sr = packet.sampleRate
        header.append(contentsOf: withUnsafeBytes(of: &sr) { Array($0) })

        // [22:24] Channels (u16 LE)
        var ch = packet.channels
        header.append(contentsOf: withUnsafeBytes(of: &ch) { Array($0) })

        // [24:26] Bits per sample (u16 LE)
        var bps = packet.bitsPerSample
        header.append(contentsOf: withUnsafeBytes(of: &bps) { Array($0) })

        // [26:34] Timestamp ms (u64 LE)
        var ts = packet.timestampMs
        header.append(contentsOf: withUnsafeBytes(of: &ts) { Array($0) })

        // [34:36] CRC-16/CCITT-FALSE over header bytes [0..33]
        let crc = crc16ccitt(header, offset: 0, length: 34)
        header.append(contentsOf: withUnsafeBytes(of: crc) { Array($0) })

        var message = header
        message.append(packet.pcmData)
        return message
    }

    // MARK: - FramePipelineStage

    nonisolated func processFrame(_ packet: FramePacket) async {
        // Audio relay stage ignores video frames
    }
}
