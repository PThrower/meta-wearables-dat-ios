/*
 * RelayPipelineTests.swift
 *
 * Integration tests for the audio/video relay pipeline using MockDeviceKit.
 * Tests the full flow: MockDevice → StreamSession → Pipeline stages → Wire protocol output.
 *
 * Validates:
 * 1. MockDeviceKit produces frames that the pipeline can process
 * 2. AudioEventBus delivers packets to subscribers
 * 3. AudioRelayStage encodes FRAU correctly
 * 4. FramePipelineManager dispatches to registered stages
 *
 * Requires: MWDATMockDevice framework, Wearables.configure()
 */

import Foundation
import MWDATCore
import MWDATMockDevice
import XCTest

@testable import CameraAccess

@MainActor
class RelayPipelineTests: XCTestCase {

    private var mockDevice: MockRaybanMeta?
    private var cameraKit: MockCameraKit?

    override func setUp() async throws {
        try await super.setUp()
        try? Wearables.configure()

        let pairedMockDevice = MockDeviceKit.shared.pairRaybanMeta()
        mockDevice = pairedMockDevice
        cameraKit = pairedMockDevice.getCameraKit()

        pairedMockDevice.powerOn()
        pairedMockDevice.unfold()

        try await Task.sleep(nanoseconds: 1_000_000_000)
    }

    override func tearDown() async throws {
        MockDeviceKit.shared.pairedDevices.forEach { mockDevice in
            MockDeviceKit.shared.unpairDevice(mockDevice)
        }
        mockDevice = nil
        cameraKit = nil
        try await super.tearDown()
    }

    // MARK: - MockDeviceKit + StreamSession Integration

    func testMockDeviceStreamingProducesFrames() async throws {
        guard let camera = cameraKit else {
            XCTFail("Mock device should be available")
            return
        }

        guard let videoURL = Bundle.main.url(forResource: "plant", withExtension: "mp4") else {
            XCTFail("Test video resource not found")
            return
        }

        await camera.setCameraFeed(fileURL: videoURL)

        let viewModel = StreamSessionViewModel(wearables: Wearables.shared)
        await viewModel.handleStartStreaming()

        // Wait for frames to arrive
        try await Task.sleep(nanoseconds: 5_000_000_000)

        XCTAssertTrue(viewModel.isStreaming, "Should be streaming after start")
        XCTAssertTrue(viewModel.hasReceivedFirstFrame, "Should have received at least one frame")
        XCTAssertNotNil(viewModel.currentVideoFrame, "Current frame should be non-nil")

        await viewModel.stopSession()
        try await Task.sleep(nanoseconds: 1_000_000_000)

        XCTAssertFalse(viewModel.isStreaming, "Should not be streaming after stop")
    }

    // MARK: - Audio Pipeline Integration

    func testAudioEventBusDeliversToSubscriber() async throws {
        let bus = AudioEventBus()

        let (subscriptionId, stream) = await bus.subscribe()

        // Publish a test packet
        let testPacket = AudioPacket(
            pcmData: Data(repeating: 0x80, count: 1024),
            codecType: 0,
            sampleRate: 48000,
            channels: 1,
            bitsPerSample: 16,
            sequenceNumber: 1,
            timestampMs: UInt64(Date().timeIntervalSince1970 * 1000)
        )

        await bus.publish(testPacket)

        // Read from stream with timeout
        let received: AudioPacket? = await withUnsafeContinuation { continuation in
            let task = Task {
                for await packet in stream {
                    return packet
                }
                return nil as AudioPacket?
            }
            Task {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                task.cancel()
                continuation.resume(returning: nil)
            }
            Task {
                if let result = await task.value {
                    continuation.resume(returning: result)
                }
            }
        }

        XCTAssertNotNil(received, "Should receive published audio packet")
        XCTAssertEqual(received?.sampleRate, 48000)
        XCTAssertEqual(received?.channels, 1)
        XCTAssertEqual(received?.pcmData.count, 1024)

        await bus.unsubscribe(subscriptionId)
    }

    func testAudioEventBusMultiSubscriber() async throws {
        let bus = AudioEventBus()

        let (_, stream1) = await bus.subscribe()
        let (_, stream2) = await bus.subscribe()

        let testPacket = AudioPacket(
            pcmData: Data([0x01, 0x02]),
            codecType: 0,
            sampleRate: 8000,
            channels: 1,
            bitsPerSample: 16,
            sequenceNumber: 1,
            timestampMs: 1000
        )

        await bus.publish(testPacket)

        // Both subscribers should get the packet
        var received1 = false
        var received2 = false

        for await packet in stream1 {
            if packet.sampleRate == 8000 { received1 = true }
            break
        }
        for await packet in stream2 {
            if packet.sampleRate == 8000 { received2 = true }
            break
        }

        XCTAssertTrue(received1, "First subscriber should receive packet")
        XCTAssertTrue(received2, "Second subscriber should receive packet")
    }

    // MARK: - FRAU Encoding from AudioRelayStage

    func testFRAUEncodingFromAudioPacket() async throws {
        // Verify AudioRelayStage.buildFRAU produces correct wire protocol
        // by encoding a packet and checking the binary layout

        let packet = AudioPacket(
            pcmData: Data([0xAA, 0xBB, 0xCC, 0xDD]),
            codecType: 1,
            sampleRate: 16000,
            channels: 2,
            bitsPerSample: 16,
            sequenceNumber: 42,
            timestampMs: 1700000000123
        )

        // Use a mock relay to capture the raw data
        let mockRelay = MockRelayStage()
        let audioStage = AudioRelayStage()
        await audioStage.setRelayStage(mockRelay)

        // Send audio through the stage
        await audioStage.sendAudio(packet)

        // Wait for the send to complete
        try await Task.sleep(nanoseconds: 100_000_000)

        let sentData = await mockRelay.lastSentData
        XCTAssertNotNil(sentData, "Should have sent FRAU-encoded data")

        guard let data = sentData else { return }

        // Verify FRAU header
        XCTAssertEqual(data.count, 29 + 4, "29 byte header + 4 byte PCM payload")

        // Magic bytes
        XCTAssertEqual(data[0], 0x46, "FRAU byte 0")
        XCTAssertEqual(data[1], 0x52, "FRAU byte 1")
        XCTAssertEqual(data[2], 0x41, "FRAU byte 2")
        XCTAssertEqual(data[3], 0x55, "FRAU byte 3")

        // Codec type at offset 4
        XCTAssertEqual(data[4], 1, "Codec type = 1")

        // Sequence at offset 5 (8 bytes LE)
        let seq = data.extractUInt64(at: 5)
        XCTAssertEqual(seq, 42, "Sequence number")

        // Sample rate at offset 13 (4 bytes LE)
        let sr = data.extractUInt32(at: 13)
        XCTAssertEqual(sr, 16000, "Sample rate")

        // Channels at offset 17 (2 bytes LE)
        let ch = data.extractUInt16(at: 17)
        XCTAssertEqual(ch, 2, "Channels")

        // Bits per sample at offset 19 (2 bytes LE)
        let bps = data.extractUInt16(at: 19)
        XCTAssertEqual(bps, 16, "Bits per sample")

        // Timestamp at offset 21 (8 bytes LE)
        let ts = data.extractUInt64(at: 21)
        XCTAssertEqual(ts, 1700000000123, "Timestamp")

        // Payload after header
        XCTAssertEqual(data[29], 0xAA)
        XCTAssertEqual(data[30], 0xBB)
        XCTAssertEqual(data[31], 0xCC)
        XCTAssertEqual(data[32], 0xDD)
    }

    // MARK: - HFP Audio Format Handling

    func testHPFAudioPacketCreation() {
        // Simulate 8kHz HFP narrowband audio packet
        let pcmData = Data(repeating: 0x00, count: 2048) // 1024 samples * 2 bytes
        let packet = AudioPacket(
            pcmData: pcmData,
            codecType: 0,
            sampleRate: 8000,
            channels: 1,
            bitsPerSample: 16,
            sequenceNumber: 1,
            timestampMs: 1000
        )

        XCTAssertEqual(packet.sampleRate, 8000, "HFP narrowband = 8kHz")
        XCTAssertEqual(packet.channels, 1, "Mono")
        XCTAssertEqual(packet.bitsPerSample, 16, "16-bit")
        XCTAssertEqual(packet.pcmData.count, 2048)
    }

    func testBuiltInMicAudioPacketCreation() {
        // Simulate 48kHz built-in mic audio packet
        let pcmData = Data(repeating: 0x00, count: 4096)
        let packet = AudioPacket(
            pcmData: pcmData,
            codecType: 0,
            sampleRate: 48000,
            channels: 1,
            bitsPerSample: 16,
            sequenceNumber: 1,
            timestampMs: 1000
        )

        XCTAssertEqual(packet.sampleRate, 48000, "Built-in mic = 48kHz")
        XCTAssertEqual(packet.channels, 1, "Mono")
    }

    func testWidebandHPFAudioPacketCreation() {
        // Simulate 16kHz HFP wideband audio packet
        let pcmData = Data(repeating: 0x00, count: 2048)
        let packet = AudioPacket(
            pcmData: pcmData,
            codecType: 0,
            sampleRate: 16000,
            channels: 1,
            bitsPerSample: 16,
            sequenceNumber: 1,
            timestampMs: 1000
        )

        XCTAssertEqual(packet.sampleRate, 16000, "HFP wideband = 16kHz")
    }
}

// MARK: - Mock Relay Stage

/// Captures raw data sent by AudioRelayStage for wire protocol verification.
actor MockRelayStage: FramePipelineStage, AudioTransport {
    nonisolated let stageId = "mock-relay"
    var config: FrameStageConfig = .maxFPS

    private(set) var lastSentData: Data?
    private(set) var sendCount: Int = 0

    nonisolated func processFrame(_ packet: FramePacket) async {
        // Ignore video frames
    }

    func sendAudio(_ packet: AudioPacket) async {
        // Build FRAU manually (same as AudioRelayStage.buildFRAU)
        var header = Data(capacity: 29)
        header.append(contentsOf: [0x46, 0x52, 0x41, 0x55])
        header.append(packet.codecType)
        var seq = packet.sequenceNumber
        header.append(contentsOf: withUnsafeBytes(of: &seq) { Array($0) })
        var sr = packet.sampleRate
        header.append(contentsOf: withUnsafeBytes(of: &sr) { Array($0) })
        var ch = packet.channels
        header.append(contentsOf: withUnsafeBytes(of: &ch) { Array($0) })
        var bps = packet.bitsPerSample
        header.append(contentsOf: withUnsafeBytes(of: &bps) { Array($0) })
        var ts = packet.timestampMs
        header.append(contentsOf: withUnsafeBytes(of: &ts) { Array($0) })
        var message = header
        message.append(packet.pcmData)
        lastSentData = message
        sendCount += 1
    }

    func sendRawData(_ data: Data) async {
        lastSentData = data
        sendCount += 1
    }
}

// MARK: - Byte extraction for Data (test-local)

private extension Data {
    func extractUInt16(at offset: Int) -> UInt16 {
        var value: UInt16 = 0
        _ = Swift.withUnsafeMutableBytes(of: &value) { dest in
            dest.copyBytes(from: self[offset..<(offset + 2)])
        }
        return value
    }

    func extractUInt32(at offset: Int) -> UInt32 {
        var value: UInt32 = 0
        _ = Swift.withUnsafeMutableBytes(of: &value) { dest in
            dest.copyBytes(from: self[offset..<(offset + 4)])
        }
        return value
    }

    func extractUInt64(at offset: Int) -> UInt64 {
        var value: UInt64 = 0
        _ = Swift.withUnsafeMutableBytes(of: &value) { dest in
            dest.copyBytes(from: self[offset..<(offset + 8)])
        }
        return value
    }
}
