/*
 * AudioTapClientTests.swift
 *
 * TDD tests for AudioTapClient — WebSocket client that receives
 * JSON audio frames from the relay server's /tap/audio endpoint.
 *
 * Contract:
 *   Connects to ws://host:port/tap/audio?session=<id>
 *   Receives JSON messages: { type, codecType, sequence, sampleRate, channels,
 *                             bitsPerSample, timestampMs, pcmBase64 }
 *   Decodes to AudioPacket, publishes to AudioEventBus for local consumers.
 *   Reconnects with exponential backoff on disconnect.
 *   Multiple tap clients can connect simultaneously.
 */

import Foundation
import XCTest

@testable import CameraAccess

@MainActor
class AudioTapClientTests: XCTestCase {

    // MARK: - JSON Decoding

    func testDecodeAudioFrameJSON() throws {
        // Simulate the JSON the relay server sends over /tap/audio
        let json = """
        {
            "type": "audio",
            "codecType": 0,
            "sequence": 42,
            "sampleRate": 48000,
            "channels": 1,
            "bitsPerSample": 16,
            "timestampMs": 1700000000123,
            "pcmBase64": "AQIDBAUG"
        }
        """.data(using: .utf8)!

        let frame = try JSONDecoder().decode(RemoteAudioFrame.self, from: json)

        XCTAssertEqual(frame.type, "audio")
        XCTAssertEqual(frame.codecType, 0)
        XCTAssertEqual(frame.sequence, 42)
        XCTAssertEqual(frame.sampleRate, 48000)
        XCTAssertEqual(frame.channels, 1)
        XCTAssertEqual(frame.bitsPerSample, 16)
        XCTAssertEqual(frame.timestampMs, 1700000000123)
        XCTAssertEqual(frame.pcmBase64, "AQIDBAUG")
    }

    func testDecodeAudioFrameToAudioPacket() throws {
        let pcmData = Data([0x01, 0x02, 0x03, 0x04, 0x05, 0x06])
        let base64 = pcmData.base64EncodedString()

        let frame = RemoteAudioFrame(
            type: "audio",
            codecType: 1,
            sequence: 7,
            sampleRate: 16000,
            channels: 1,
            bitsPerSample: 16,
            timestampMs: 999,
            pcmBase64: base64
        )

        let packet = frame.toAudioPacket()

        XCTAssertEqual(packet.codecType, 1)
        XCTAssertEqual(packet.sequenceNumber, 7)
        XCTAssertEqual(packet.sampleRate, 16000)
        XCTAssertEqual(packet.channels, 1)
        XCTAssertEqual(packet.bitsPerSample, 16)
        XCTAssertEqual(packet.timestampMs, 999)
        XCTAssertEqual(packet.pcmData, pcmData)
    }

    func testDecodeHFP8kHzFrame() throws {
        let pcmData = Data(repeating: 0x80, count: 2048)
        let frame = RemoteAudioFrame(
            type: "audio",
            codecType: 0,
            sequence: 1,
            sampleRate: 8000,
            channels: 1,
            bitsPerSample: 16,
            timestampMs: 1000,
            pcmBase64: pcmData.base64EncodedString()
        )

        let packet = frame.toAudioPacket()
        XCTAssertEqual(packet.sampleRate, 8000, "HFP narrowband = 8kHz")
        XCTAssertEqual(packet.pcmData.count, 2048)
    }

    func testDecodeWideband16kHzFrame() throws {
        let pcmData = Data(repeating: 0x00, count: 1024)
        let frame = RemoteAudioFrame(
            type: "audio",
            codecType: 0,
            sequence: 5,
            sampleRate: 16000,
            channels: 1,
            bitsPerSample: 16,
            timestampMs: 5000,
            pcmBase64: pcmData.base64EncodedString()
        )

        let packet = frame.toAudioPacket()
        XCTAssertEqual(packet.sampleRate, 16000, "HFP wideband = 16kHz")
    }

    // MARK: - Client Lifecycle

    func testClientInitializesDisconnected() async {
        let bus = AudioEventBus()
        let client = AudioTapClient(eventBus: bus)

        let connected = await client.isConnected
        XCTAssertFalse(connected, "Should start disconnected")
    }

    func testClientBuildsTapURL() async {
        let bus = AudioEventBus()
        let client = AudioTapClient(eventBus: bus)

        let url = await client.tapURL(for: "ws://192.168.1.5:3000", session: "test-session")
        XCTAssertEqual(url, "ws://192.168.1.5:3000/tap/audio?session=test-session")
    }

    func testClientBuildsTapURLDefaultSession() async {
        let bus = AudioEventBus()
        let client = AudioTapClient(eventBus: bus)

        let url = await client.tapURL(for: "ws://192.168.1.5:3000", session: nil)
        XCTAssertEqual(url, "ws://192.168.1.5:3000/tap/audio?session=default")
    }

    func testClientBuildsTapURLFromPublishURL() async {
        let bus = AudioEventBus()
        let client = AudioTapClient(eventBus: bus)

        // Should strip /publish and use /tap/audio
        let url = await client.tapURL(for: "ws://relay.example.com/publish?session=abc", session: "abc")
        XCTAssertEqual(url, "ws://relay.example.com/tap/audio?session=abc")
    }

    func testClientDisconnectCleansUp() async {
        let bus = AudioEventBus()
        let client = AudioTapClient(eventBus: bus)

        await client.disconnect()

        let connected = await client.isConnected
        XCTAssertFalse(connected, "Should be disconnected after disconnect()")
    }

    // MARK: - Frame Delivery to EventBus

    func testReceivedFramesPublishToEventBus() async throws {
        let bus = AudioEventBus()
        let (subId, stream) = await bus.subscribe()

        let client = AudioTapClient(eventBus: bus)

        // Simulate receiving a remote frame
        let pcmData = Data([0xAA, 0xBB, 0xCC, 0xDD])
        let frame = RemoteAudioFrame(
            type: "audio",
            codecType: 0,
            sequence: 1,
            sampleRate: 48000,
            channels: 1,
            bitsPerSample: 16,
            timestampMs: UInt64(Date().timeIntervalSince1970 * 1000),
            pcmBase64: pcmData.base64EncodedString()
        )

        // Directly inject frame (simulating WebSocket receive)
        await client.handleReceivedFrame(frame)

        // Read from the event bus
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

        XCTAssertNotNil(received, "Event bus should receive the audio packet")
        XCTAssertEqual(received?.sampleRate, 48000)
        XCTAssertEqual(received?.channels, 1)
        XCTAssertEqual(received?.pcmData, pcmData)

        await bus.unsubscribe(subId)
    }

    func testMultipleFramesPublishInOrder() async throws {
        let bus = AudioEventBus()
        let (subId, stream) = await bus.subscribe()

        let client = AudioTapClient(eventBus: bus)

        // Inject 5 frames
        for i in 0..<5 {
            let frame = RemoteAudioFrame(
                type: "audio",
                codecType: 0,
                sequence: UInt64(i),
                sampleRate: 48000,
                channels: 1,
                bitsPerSample: 16,
                timestampMs: UInt64(i),
                pcmBase64: Data([UInt8(i)]).base64EncodedString()
            )
            await client.handleReceivedFrame(frame)
        }

        // Read all 5 from stream
        var received: [AudioPacket] = []
        for await packet in stream {
            received.append(packet)
            if received.count == 5 { break }
        }

        XCTAssertEqual(received.count, 5)
        for i in 0..<5 {
            XCTAssertEqual(received[i].sequenceNumber, UInt64(i), "Frame \(i) should have seq \(i)")
        }

        await bus.unsubscribe(subId)
    }

    // MARK: - Non-Audio Messages Ignored

    func testNonAudioMessageIgnored() async throws {
        let bus = AudioEventBus()
        let (subId, stream) = await bus.subscribe()

        let client = AudioTapClient(eventBus: bus)

        // Inject a non-audio message
        let frame = RemoteAudioFrame(
            type: "status",
            codecType: 0,
            sequence: 0,
            sampleRate: 0,
            channels: 0,
            bitsPerSample: 0,
            timestampMs: 0,
            pcmBase64: ""
        )

        await client.handleReceivedFrame(frame)

        // Should not publish anything to the bus
        let received: Bool = await withUnsafeContinuation { continuation in
            let task = Task {
                var gotPacket = false
                for await _ in stream {
                    gotPacket = true
                    break
                }
                return gotPacket
            }
            Task {
                try? await Task.sleep(nanoseconds: 500_000_000) // 500ms
                task.cancel()
                continuation.resume(returning: false)
            }
            Task {
                let result = await task.value
                continuation.resume(returning: result)
            }
        }

        XCTAssertFalse(received, "Non-audio messages should be ignored")

        await bus.unsubscribe(subId)
    }

    // MARK: - Empty PCM Ignored

    func testEmptyPCMIgnored() async throws {
        let bus = AudioEventBus()
        let (subId, stream) = await bus.subscribe()

        let client = AudioTapClient(eventBus: bus)

        let frame = RemoteAudioFrame(
            type: "audio",
            codecType: 0,
            sequence: 0,
            sampleRate: 48000,
            channels: 1,
            bitsPerSample: 16,
            timestampMs: 1000,
            pcmBase64: ""
        )

        await client.handleReceivedFrame(frame)

        // Should not publish empty PCM to bus
        let received: Bool = await withUnsafeContinuation { continuation in
            let task = Task {
                var gotPacket = false
                for await _ in stream {
                    gotPacket = true
                    break
                }
                return gotPacket
            }
            Task {
                try? await Task.sleep(nanoseconds: 500_000_000)
                task.cancel()
                continuation.resume(returning: false)
            }
            Task {
                let result = await task.value
                continuation.resume(returning: result)
            }
        }

        XCTAssertFalse(received, "Empty PCM should be ignored")

        await bus.unsubscribe(subId)
    }

    // MARK: - Stats

    func testClientTracksFrameCount() async {
        let bus = AudioEventBus()
        let client = AudioTapClient(eventBus: bus)

        let initialCount = await client.framesReceived
        XCTAssertEqual(initialCount, 0)

        let frame = RemoteAudioFrame(
            type: "audio",
            codecType: 0,
            sequence: 0,
            sampleRate: 48000,
            channels: 1,
            bitsPerSample: 16,
            timestampMs: 1000,
            pcmBase64: Data([0x00]).base64EncodedString()
        )

        await client.handleReceivedFrame(frame)
        await client.handleReceivedFrame(frame)
        await client.handleReceivedFrame(frame)

        let count = await client.framesReceived
        XCTAssertEqual(count, 3)
    }
}
