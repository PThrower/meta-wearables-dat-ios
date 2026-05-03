/*
 * FRAUWireProtocolTests.swift
 *
 * Unit tests for WireProtocol.buildFRAU encoding and parsing.
 * Validates the binary layout: magic, version, payloadLen, codec, sequence,
 * sampleRate, channels, bitsPerSample, timestamp, CRC-16, and PCM payload.
 *
 * No SDK dependencies required.
 */

import Foundation
import XCTest

@testable import CameraAccess

final class FRAUWireProtocolTests: XCTestCase {

    // MARK: - AudioPacket Construction

    func testAudioPacketStoresAllFields() {
        let pcmData = Data([0x01, 0x02, 0x03, 0x04])
        let packet = AudioPacket(
            pcmData: pcmData,
            codecType: 1,
            sampleRate: 48000,
            channels: 1,
            bitsPerSample: 16,
            sequenceNumber: 42,
            timestampMs: 1700000000000
        )

        XCTAssertEqual(packet.pcmData, pcmData)
        XCTAssertEqual(packet.codecType, 1)
        XCTAssertEqual(packet.sampleRate, 48000)
        XCTAssertEqual(packet.channels, 1)
        XCTAssertEqual(packet.bitsPerSample, 16)
        XCTAssertEqual(packet.sequenceNumber, 42)
        XCTAssertEqual(packet.timestampMs, 1700000000000)
    }

    func testAudioPacketWithEmptyPCM() {
        let packet = AudioPacket(
            pcmData: Data(),
            codecType: 0,
            sampleRate: 8000,
            channels: 1,
            bitsPerSample: 16,
            sequenceNumber: 0,
            timestampMs: 0
        )
        XCTAssertEqual(packet.pcmData.count, 0, "Empty PCM data should be valid")
    }

    func testAudioPacketIsSendable() {
        let packet = AudioPacket(
            pcmData: Data(),
            codecType: 0,
            sampleRate: 48000,
            channels: 1,
            bitsPerSample: 16,
            sequenceNumber: 1,
            timestampMs: 0
        )
        let _: any Sendable = packet
    }

    // MARK: - FRAU Header Layout (via WireProtocol.buildFRAU)

    func testFRAUMagicBytes() {
        let message = buildTestFRAU()
        XCTAssertEqual(message[0], 0x46) // 'F'
        XCTAssertEqual(message[1], 0x52) // 'R'
        XCTAssertEqual(message[2], 0x41) // 'A'
        XCTAssertEqual(message[3], 0x55) // 'U'
    }

    func testFRAUVersion() {
        let message = buildTestFRAU()
        XCTAssertEqual(message[4], 1, "Version = 1 at offset 4")
    }

    func testFRAUPayloadLength() {
        let pcmData = Data([0xAA, 0xBB, 0xCC, 0xDD])
        let message = WireProtocol.buildFRAU(
            pcmData: pcmData, codecType: 0, sampleRate: 48000,
            channels: 1, bitsPerSample: 16, sequenceNumber: 1, timestampMs: 1000
        )
        let payloadLen = message.extractUInt32(at: 5)
        XCTAssertEqual(payloadLen, 4, "Payload length at offset 5")
    }

    func testFRAUCodecTypeOffset() {
        let message = WireProtocol.buildFRAU(
            pcmData: Data([0xFF]), codecType: 1, sampleRate: 48000,
            channels: 1, bitsPerSample: 16, sequenceNumber: 1, timestampMs: 100
        )
        XCTAssertEqual(message[9], 1, "Codec type at offset 9")
    }

    func testFRAUSequenceNumberLayout() {
        let message = WireProtocol.buildFRAU(
            pcmData: Data([0x00]), codecType: 0, sampleRate: 48000,
            channels: 1, bitsPerSample: 16,
            sequenceNumber: 0x0102030405060708, timestampMs: 0
        )
        let seq = message.extractUInt64(at: 10)
        XCTAssertEqual(seq, 0x0102030405060708, "Sequence number LE at offset 10")
    }

    func testFRAUSampleRateLayout() {
        let message = WireProtocol.buildFRAU(
            pcmData: Data([0x00]), codecType: 0, sampleRate: 48000,
            channels: 1, bitsPerSample: 16, sequenceNumber: 1, timestampMs: 0
        )
        let sr = message.extractUInt32(at: 18)
        XCTAssertEqual(sr, 48000, "Sample rate LE at offset 18")
    }

    func testFRAUChannelsLayout() {
        let message = WireProtocol.buildFRAU(
            pcmData: Data([0x00]), codecType: 0, sampleRate: 48000,
            channels: 2, bitsPerSample: 16, sequenceNumber: 1, timestampMs: 0
        )
        let ch = message.extractUInt16(at: 22)
        XCTAssertEqual(ch, 2, "Channels LE at offset 22")
    }

    func testFRAUBitsPerSampleLayout() {
        let message = WireProtocol.buildFRAU(
            pcmData: Data([0x00]), codecType: 0, sampleRate: 48000,
            channels: 1, bitsPerSample: 16, sequenceNumber: 1, timestampMs: 0
        )
        let bps = message.extractUInt16(at: 24)
        XCTAssertEqual(bps, 16, "Bits per sample LE at offset 24")
    }

    func testFRAUTimestampLayout() {
        let message = WireProtocol.buildFRAU(
            pcmData: Data([0x00]), codecType: 0, sampleRate: 48000,
            channels: 1, bitsPerSample: 16, sequenceNumber: 1,
            timestampMs: 1700000000123
        )
        let ts = message.extractUInt64(at: 26)
        XCTAssertEqual(ts, 1700000000123, "Timestamp LE at offset 26")
    }

    // MARK: - Header Size

    func testFRAUHeaderSize() {
        XCTAssertEqual(WireProtocol.frauHeaderSize, 36, "FRAU header is 36 bytes")
        XCTAssertEqual(AudioRelayStage.frauHeaderSize, 36, "AudioRelayStage exposes same header size")
    }

    func testEmptyPayloadIsHeaderOnly() {
        let message = WireProtocol.buildFRAU(
            pcmData: Data(), codecType: 0, sampleRate: 48000,
            channels: 1, bitsPerSample: 16, sequenceNumber: 1, timestampMs: 1000
        )
        XCTAssertEqual(message.count, 36, "Empty payload = header only = 36 bytes")
    }

    // MARK: - Payload

    func testPayloadAppendedAfterHeader() {
        let pcmData = Data([0xAA, 0xBB, 0xCC, 0xDD])
        let message = WireProtocol.buildFRAU(
            pcmData: pcmData, codecType: 0, sampleRate: 48000,
            channels: 1, bitsPerSample: 16, sequenceNumber: 1, timestampMs: 1000
        )

        XCTAssertEqual(message.count, 36 + 4, "Header + 4 bytes payload")
        XCTAssertEqual(message[36], 0xAA)
        XCTAssertEqual(message[37], 0xBB)
        XCTAssertEqual(message[38], 0xCC)
        XCTAssertEqual(message[39], 0xDD)
    }

    func testLargePayload() {
        let pcmData = Data(repeating: 0x80, count: 4096)
        let message = WireProtocol.buildFRAU(
            pcmData: pcmData, codecType: 0, sampleRate: 48000,
            channels: 1, bitsPerSample: 16, sequenceNumber: 1, timestampMs: 1000
        )
        XCTAssertEqual(message.count, 36 + 4096)
        XCTAssertEqual(message[36], 0x80)
        XCTAssertEqual(message[message.count - 1], 0x80)
    }

    // MARK: - CRC-16

    func testCRC16IsCorrect() {
        let message = buildTestFRAU()
        let headerCRC = message.extractUInt16(at: 34)
        let computedCRC = CRC16.ccittFalse(message, offset: 0, length: 34)
        XCTAssertEqual(headerCRC, computedCRC, "CRC-16 in header should match computed CRC")
    }

    func testCRC16DetectsCorruption() {
        var message = buildTestFRAU()
        // Flip a bit in the codecType field
        message[9] = message[9] ^ 0xFF
        let headerCRC = message.extractUInt16(at: 34)
        let computedCRC = CRC16.ccittFalse(message, offset: 0, length: 34)
        XCTAssertNotEqual(headerCRC, computedCRC, "CRC should detect corruption")
    }

    // MARK: - Parse Round-Trip

    func testParseFRAURoundTrip() {
        let pcmData = Data([0x01, 0x02, 0x03, 0x04, 0x05])
        let message = WireProtocol.buildFRAU(
            pcmData: pcmData, codecType: 1, sampleRate: 8000,
            channels: 1, bitsPerSample: 16,
            sequenceNumber: 42, timestampMs: 1700000000123
        )

        let parsed = WireProtocol.parseFRAU(message)
        XCTAssertNotNil(parsed, "Should parse valid FRAU message")

        XCTAssertEqual(parsed?.codecType, 1)
        XCTAssertEqual(parsed?.sequenceNumber, 42)
        XCTAssertEqual(parsed?.sampleRate, 8000)
        XCTAssertEqual(parsed?.channels, 1)
        XCTAssertEqual(parsed?.bitsPerSample, 16)
        XCTAssertEqual(parsed?.timestampMs, 1700000000123)
        XCTAssertEqual(parsed?.pcmData, pcmData)
    }

    func testParseFRAURejectsBadMagic() {
        var message = buildTestFRAU()
        message[0] = 0x00 // Corrupt magic
        XCTAssertNil(WireProtocol.parseFRAU(message), "Should reject bad magic")
    }

    func testParseFRAURejectsTruncatedData() {
        let message = Data(repeating: 0x00, count: 10) // Too short
        XCTAssertNil(WireProtocol.parseFRAU(message), "Should reject truncated data")
    }

    func testParseFRAURejectsBadCRC() {
        var message = buildTestFRAU()
        message[34] = 0xFF // Corrupt CRC
        XCTAssertNil(WireProtocol.parseFRAU(message), "Should reject bad CRC")
    }

    // MARK: - Round-Trip Edge Values

    func testRoundTripSequenceNumber() {
        let testValues: [UInt64] = [0, 1, 255, 256, 65535, UInt64.max]
        for seq in testValues {
            let message = WireProtocol.buildFRAU(
                pcmData: Data([0x00]), codecType: 0, sampleRate: 48000,
                channels: 1, bitsPerSample: 16, sequenceNumber: seq, timestampMs: 0
            )
            let parsed = WireProtocol.parseFRAU(message)
            XCTAssertEqual(parsed?.sequenceNumber, seq, "Round-trip failed for sequence \(seq)")
        }
    }

    func testRoundTripSampleRate() {
        let testRates: [UInt32] = [8000, 16000, 22050, 44100, 48000, 96000]
        for rate in testRates {
            let message = WireProtocol.buildFRAU(
                pcmData: Data([0x00]), codecType: 0, sampleRate: rate,
                channels: 1, bitsPerSample: 16, sequenceNumber: 1, timestampMs: 0
            )
            let parsed = WireProtocol.parseFRAU(message)
            XCTAssertEqual(parsed?.sampleRate, rate, "Round-trip failed for sample rate \(rate)")
        }
    }

    // MARK: - Helpers

    private func buildTestFRAU(pcmData: Data = Data([0x01, 0x02])) -> Data {
        WireProtocol.buildFRAU(
            pcmData: pcmData, codecType: 0, sampleRate: 48000,
            channels: 1, bitsPerSample: 16, sequenceNumber: 1, timestampMs: 1000
        )
    }
}
