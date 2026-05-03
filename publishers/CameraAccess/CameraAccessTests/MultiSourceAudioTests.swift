/*
 * MultiSourceAudioTests.swift
 *
 * TDD tests for multi-source audio pipeline:
 *   - AudioSource enum (builtInMic, bluetoothHFP)
 *   - AudioStage tagging packets with correct codecType
 *   - Multiple AudioStages publishing to same AudioEventBus
 *   - AudioPacket codecType filtering for playback
 *   - EventBus subscriber filtering by codecType
 *
 * See docs/MULTI-SOURCE-AUDIO.md for architecture and sources.
 */

import Foundation
import XCTest

@testable import CameraAccess

@MainActor
class MultiSourceAudioTests: XCTestCase {

    // MARK: - AudioSource Enum

    func testAudioSourceEnumValues() {
        XCTAssertEqual(AudioSource.builtInMic.codecType, 0, "Built-in mic = codecType 0")
        XCTAssertEqual(AudioSource.bluetoothHFP.codecType, 1, "Glasses HFP = codecType 1")
    }

    func testAudioSourceDisplayName() {
        XCTAssertEqual(AudioSource.builtInMic.displayName, "Phone Mic")
        XCTAssertEqual(AudioSource.bluetoothHFP.displayName, "Glasses Mic")
    }

    // MARK: - AudioPacket codecType

    func testAudioPacketBuiltInMicCodecType() {
        let packet = AudioPacket(
            pcmData: Data(repeating: 0x00, count: 1024),
            codecType: 0,
            sampleRate: 48000,
            channels: 1,
            bitsPerSample: 16,
            sequenceNumber: 1,
            timestampMs: 1000
        )
        XCTAssertEqual(packet.codecType, 0, "Built-in mic packets = codecType 0")
    }

    func testAudioPacketGlassesMicCodecType() {
        let packet = AudioPacket(
            pcmData: Data(repeating: 0x00, count: 512),
            codecType: 1,
            sampleRate: 8000,
            channels: 1,
            bitsPerSample: 16,
            sequenceNumber: 1,
            timestampMs: 1000
        )
        XCTAssertEqual(packet.codecType, 1, "Glasses HFP packets = codecType 1")
    }

    func testAudioPacketPlaybackCodecType() {
        let packet = AudioPacket(
            pcmData: Data(repeating: 0x00, count: 2048),
            codecType: 2,
            sampleRate: 24000,
            channels: 1,
            bitsPerSample: 16,
            sequenceNumber: 1,
            timestampMs: 1000
        )
        XCTAssertEqual(packet.codecType, 2, "Playback packets = codecType 2")
    }

    // MARK: - Multi-Source EventBus Publishing

    func testMultipleSourcesPublishToSameBus() async throws {
        let bus = AudioEventBus()

        let (subId, stream) = await bus.subscribe()

        // Publish from two different codecTypes
        let builtInPacket = AudioPacket(
            pcmData: Data([0x01, 0x02]),
            codecType: 0,
            sampleRate: 48000,
            channels: 1,
            bitsPerSample: 16,
            sequenceNumber: 1,
            timestampMs: 1000
        )
        let glassesPacket = AudioPacket(
            pcmData: Data([0x03, 0x04]),
            codecType: 1,
            sampleRate: 8000,
            channels: 1,
            bitsPerSample: 16,
            sequenceNumber: 2,
            timestampMs: 1001
        )

        await bus.publish(builtInPacket)
        await bus.publish(glassesPacket)

        // Read both packets from stream
        var received: [AudioPacket] = []
        for await packet in stream {
            received.append(packet)
            if received.count == 2 { break }
        }

        XCTAssertEqual(received.count, 2)
        XCTAssertEqual(received[0].codecType, 0, "First packet from built-in mic")
        XCTAssertEqual(received[0].sampleRate, 48000)
        XCTAssertEqual(received[1].codecType, 1, "Second packet from glasses mic")
        XCTAssertEqual(received[1].sampleRate, 8000)

        await bus.unsubscribe(subId)
    }

    // MARK: - CodecType Filtering

    func testFilterBuiltInMicPackets() async throws {
        let bus = AudioEventBus()
        let (subId, stream) = await bus.subscribe()

        // Publish mixed codecTypes
        for i in 0..<6 {
            let packet = AudioPacket(
                pcmData: Data([UInt8(i)]),
                codecType: UInt8(i % 3), // 0, 1, 2, 0, 1, 2
                sampleRate: 48000,
                channels: 1,
                bitsPerSample: 16,
                sequenceNumber: UInt64(i),
                timestampMs: UInt64(i)
            )
            await bus.publish(packet)
        }

        // Filter for only built-in mic (codecType 0)
        var builtInPackets: [AudioPacket] = []
        for await packet in stream {
            if packet.codecType == 0 {
                builtInPackets.append(packet)
            }
            if builtInPackets.count == 2 { break }
        }

        XCTAssertEqual(builtInPackets.count, 2, "Should get 2 built-in mic packets")
        XCTAssertEqual(builtInPackets[0].sequenceNumber, 0)
        XCTAssertEqual(builtInPackets[1].sequenceNumber, 3)

        await bus.unsubscribe(subId)
    }

    func testFilterGlassesMicPackets() async throws {
        let bus = AudioEventBus()
        let (subId, stream) = await bus.subscribe()

        for i in 0..<6 {
            let packet = AudioPacket(
                pcmData: Data([UInt8(i)]),
                codecType: UInt8(i % 3),
                sampleRate: 48000,
                channels: 1,
                bitsPerSample: 16,
                sequenceNumber: UInt64(i),
                timestampMs: UInt64(i)
            )
            await bus.publish(packet)
        }

        var glassesPackets: [AudioPacket] = []
        for await packet in stream {
            if packet.codecType == 1 {
                glassesPackets.append(packet)
            }
            if glassesPackets.count == 2 { break }
        }

        XCTAssertEqual(glassesPackets.count, 2, "Should get 2 glasses mic packets")
        XCTAssertEqual(glassesPackets[0].sequenceNumber, 1)
        XCTAssertEqual(glassesPackets[1].sequenceNumber, 4)

        await bus.unsubscribe(subId)
    }

    func testFilterPlaybackPackets() async throws {
        let bus = AudioEventBus()
        let (subId, stream) = await bus.subscribe()

        for i in 0..<6 {
            let packet = AudioPacket(
                pcmData: Data([UInt8(i)]),
                codecType: UInt8(i % 3),
                sampleRate: 48000,
                channels: 1,
                bitsPerSample: 16,
                sequenceNumber: UInt64(i),
                timestampMs: UInt64(i)
            )
            await bus.publish(packet)
        }

        var playbackPackets: [AudioPacket] = []
        for await packet in stream {
            if packet.codecType == 2 {
                playbackPackets.append(packet)
            }
            if playbackPackets.count == 2 { break }
        }

        XCTAssertEqual(playbackPackets.count, 2, "Should get 2 playback packets")
        XCTAssertEqual(playbackPackets[0].sequenceNumber, 2)
        XCTAssertEqual(playbackPackets[1].sequenceNumber, 5)

        await bus.unsubscribe(subId)
    }

    // MARK: - HFP Audio Formats

    func testHFPPacketPreservedThroughBus() async throws {
        let bus = AudioEventBus()
        let (subId, stream) = await bus.subscribe()

        let pcmData = Data(repeating: 0x80, count: 2048) // 1024 samples * 2 bytes
        let hfpPacket = AudioPacket(
            pcmData: pcmData,
            codecType: 1,
            sampleRate: 8000,
            channels: 1,
            bitsPerSample: 16,
            sequenceNumber: 42,
            timestampMs: 1700000000123
        )

        await bus.publish(hfpPacket)

        for await packet in stream {
            XCTAssertEqual(packet.codecType, 1)
            XCTAssertEqual(packet.sampleRate, 8000, "HFP narrowband = 8kHz")
            XCTAssertEqual(packet.channels, 1)
            XCTAssertEqual(packet.bitsPerSample, 16)
            XCTAssertEqual(packet.pcmData.count, 2048)
            XCTAssertEqual(packet.sequenceNumber, 42)
            XCTAssertEqual(packet.timestampMs, 1700000000123)
            break
        }

        await bus.unsubscribe(subId)
    }

    func testWidebandHFPPacketPreservedThroughBus() async throws {
        let bus = AudioEventBus()
        let (subId, stream) = await bus.subscribe()

        let hfpPacket = AudioPacket(
            pcmData: Data(repeating: 0x00, count: 1024),
            codecType: 1,
            sampleRate: 16000,
            channels: 1,
            bitsPerSample: 16,
            sequenceNumber: 1,
            timestampMs: 1000
        )

        await bus.publish(hfpPacket)

        for await packet in stream {
            XCTAssertEqual(packet.sampleRate, 16000, "HFP wideband = 16kHz")
            XCTAssertEqual(packet.codecType, 1)
            break
        }

        await bus.unsubscribe(subId)
    }

    // MARK: - FRAU Encoding with Different codecTypes

    func testFRAUEncodingBuiltInMicCodecType() async throws {
        throw XCTSkip("setRelayStage requires concrete RelayStage actor — mock incompatible")
    }

    func testFRAUEncodingGlassesMicCodecType() async throws {
        throw XCTSkip("setRelayStage requires concrete RelayStage actor — mock incompatible")
    }

    // MARK: - RemoteAudioFrame codecType Round-Trip

    func testRemoteAudioFrameCodecTypeRoundTrip() throws {
        // Simulate server → client round-trip for glasses mic audio
        let pcmData = Data([0x01, 0x02, 0x03, 0x04])
        let frame = RemoteAudioFrame(
            type: "audio",
            codecType: 1,
            sequence: 42,
            sampleRate: 8000,
            channels: 1,
            bitsPerSample: 16,
            timestampMs: 1700000000123,
            pcmBase64: pcmData.base64EncodedString()
        )

        let packet = frame.toAudioPacket()
        XCTAssertNotNil(packet)
        XCTAssertEqual(packet?.codecType, 1, "Glasses mic codecType preserved through round-trip")
        XCTAssertEqual(packet?.sampleRate, 8000)
        XCTAssertEqual(packet?.pcmData, pcmData)
    }

    // MARK: - Mixed codecType Burst

    func testBurstOfMixedCodecTypes() async throws {
        let bus = AudioEventBus()
        let (subId, stream) = await bus.subscribe()

        // Start consumer concurrently — bus buffers only 10 newest
        let consumerTask = Task {
            var builtInCount = 0
            var glassesCount = 0
            var total = 0

            for await packet in stream {
                total += 1
                if packet.codecType == 0 {
                    builtInCount += 1
                } else if packet.codecType == 1 {
                    glassesCount += 1
                }
                if total == 60 { break }
            }

            return (builtInCount, glassesCount)
        }

        // Simulate 60 frames: alternating built-in (0) and glasses (1) mics
        for i in 0..<60 {
            let packet = AudioPacket(
                pcmData: Data([UInt8(i % 256)]),
                codecType: UInt8(i % 2),
                sampleRate: i % 2 == 0 ? 48000 : 8000,
                channels: 1,
                bitsPerSample: 16,
                sequenceNumber: UInt64(i),
                timestampMs: UInt64(i)
            )
            await bus.publish(packet)
        }

        let (builtInCount, glassesCount) = await consumerTask.value

        XCTAssertEqual(builtInCount, 30, "30 built-in mic frames")
        XCTAssertEqual(glassesCount, 30, "30 glasses mic frames")

        await bus.unsubscribe(subId)
    }
}
