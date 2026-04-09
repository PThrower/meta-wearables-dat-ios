/*
 * FRAUWireProtocolTests.swift
 *
 * Unit tests for AudioPacket construction and FRAU wire protocol encoding.
 * Validates the binary layout: magic, codec, sequence, sampleRate, channels,
 * bitsPerSample, timestamp, and PCM payload.
 *
 * No SDK dependencies required.
 */

import Foundation
import XCTest

@testable import CameraAccess

// MARK: - Byte Extraction Helpers

private extension Data {
    func extractUInt8(at offset: Int) -> UInt8 {
        self[offset]
    }

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

final class FRAUWireProtocolTests: XCTestCase {

    // MARK: - FRAU Reference Encoder
    // Mirrors the FRAU wire protocol spec from AudioRelayStage.buildFRAU.

    private func buildFRAUReference(_ packet: AudioPacket) -> Data {
        let headerSize = 29
        var header = Data(capacity: headerSize)

        // Magic "FRAU"
        header.append(contentsOf: [0x46, 0x52, 0x41, 0x55])

        // Codec type (1 byte)
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

    // MARK: - FRAU Header Layout

    func testFRAUMagicBytes() {
        let packet = Self.makePacket()
        let message = buildFRAUReference(packet)

        XCTAssertEqual(message.extractUInt8(at: 0), 0x46)
        XCTAssertEqual(message.extractUInt8(at: 1), 0x52)
        XCTAssertEqual(message.extractUInt8(at: 2), 0x41)
        XCTAssertEqual(message.extractUInt8(at: 3), 0x55)
    }

    func testFRAUCodecTypeOffset() {
        let packet = AudioPacket(
            pcmData: Data([0xFF]),
            codecType: 1,
            sampleRate: 48000,
            channels: 1,
            bitsPerSample: 16,
            sequenceNumber: 1,
            timestampMs: 100
        )
        let message = buildFRAUReference(packet)
        XCTAssertEqual(message.extractUInt8(at: 4), 1, "Codec type at offset 4")
    }

    func testFRAUSequenceNumberLayout() {
        let packet = AudioPacket(
            pcmData: Data([0x00]),
            codecType: 0,
            sampleRate: 48000,
            channels: 1,
            bitsPerSample: 16,
            sequenceNumber: 0x0102030405060708,
            timestampMs: 0
        )
        let message = buildFRAUReference(packet)
        let seq = message.extractUInt64(at: 5)
        XCTAssertEqual(seq, 0x0102030405060708, "Sequence number LE at offset 5")
    }

    func testFRAUSampleRateLayout() {
        let packet = AudioPacket(
            pcmData: Data([0x00]),
            codecType: 0,
            sampleRate: 48000,
            channels: 1,
            bitsPerSample: 16,
            sequenceNumber: 1,
            timestampMs: 0
        )
        let message = buildFRAUReference(packet)
        let sr = message.extractUInt32(at: 13)
        XCTAssertEqual(sr, 48000, "Sample rate LE at offset 13")
    }

    func testFRAUChannelsLayout() {
        let packet = AudioPacket(
            pcmData: Data([0x00]),
            codecType: 0,
            sampleRate: 48000,
            channels: 2,
            bitsPerSample: 16,
            sequenceNumber: 1,
            timestampMs: 0
        )
        let message = buildFRAUReference(packet)
        let ch = message.extractUInt16(at: 17)
        XCTAssertEqual(ch, 2, "Channels LE at offset 17")
    }

    func testFRAUBitsPerSampleLayout() {
        let packet = AudioPacket(
            pcmData: Data([0x00]),
            codecType: 0,
            sampleRate: 48000,
            channels: 1,
            bitsPerSample: 16,
            sequenceNumber: 1,
            timestampMs: 0
        )
        let message = buildFRAUReference(packet)
        let bps = message.extractUInt16(at: 19)
        XCTAssertEqual(bps, 16, "Bits per sample LE at offset 19")
    }

    func testFRAUTimestampLayout() {
        let packet = AudioPacket(
            pcmData: Data([0x00]),
            codecType: 0,
            sampleRate: 48000,
            channels: 1,
            bitsPerSample: 16,
            sequenceNumber: 1,
            timestampMs: 1700000000123
        )
        let message = buildFRAUReference(packet)
        let ts = message.extractUInt64(at: 21)
        XCTAssertEqual(ts, 1700000000123, "Timestamp LE at offset 21")
    }

    // MARK: - Header Size

    func testFRAUHeaderSize() {
        XCTAssertEqual(AudioRelayStage.frauHeaderSize, 29, "FRAU header is 29 bytes")
    }

    func testEmptyPayloadIsHeaderOnly() {
        let packet = Self.makePacket(pcmData: Data())
        let message = buildFRAUReference(packet)
        XCTAssertEqual(message.count, 29, "Empty payload = header only = 29 bytes")
    }

    // MARK: - Payload

    func testPayloadAppendedAfterHeader() {
        let pcmData = Data([0xAA, 0xBB, 0xCC, 0xDD])
        let packet = Self.makePacket(pcmData: pcmData)
        let message = buildFRAUReference(packet)

        XCTAssertEqual(message.count, 29 + 4, "Header + 4 bytes payload")
        XCTAssertEqual(message[29], 0xAA)
        XCTAssertEqual(message[30], 0xBB)
        XCTAssertEqual(message[31], 0xCC)
        XCTAssertEqual(message[32], 0xDD)
    }

    func testLargePayload() {
        let pcmData = Data(repeating: 0x80, count: 4096)
        let packet = Self.makePacket(pcmData: pcmData)
        let message = buildFRAUReference(packet)
        XCTAssertEqual(message.count, 29 + 4096)
        XCTAssertEqual(message[29], 0x80)
        XCTAssertEqual(message[message.count - 1], 0x80)
    }

    // MARK: - Round-Trip

    func testRoundTripSequenceNumber() {
        let testValues: [UInt64] = [0, 1, 255, 256, 65535, UInt64.max]
        for seq in testValues {
            let packet = AudioPacket(
                pcmData: Data([0x00]),
                codecType: 0,
                sampleRate: 48000,
                channels: 1,
                bitsPerSample: 16,
                sequenceNumber: seq,
                timestampMs: 0
            )
            let message = buildFRAUReference(packet)
            let decoded = message.extractUInt64(at: 5)
            XCTAssertEqual(decoded, seq, "Round-trip failed for sequence \(seq)")
        }
    }

    func testRoundTripSampleRate() {
        let testRates: [UInt32] = [8000, 16000, 22050, 44100, 48000, 96000]
        for rate in testRates {
            let packet = AudioPacket(
                pcmData: Data([0x00]),
                codecType: 0,
                sampleRate: rate,
                channels: 1,
                bitsPerSample: 16,
                sequenceNumber: 1,
                timestampMs: 0
            )
            let message = buildFRAUReference(packet)
            let decoded = message.extractUInt32(at: 13)
            XCTAssertEqual(decoded, rate, "Round-trip failed for sample rate \(rate)")
        }
    }

    // MARK: - Helpers

    private static func makePacket(pcmData: Data = Data([0x01, 0x02])) -> AudioPacket {
        AudioPacket(
            pcmData: pcmData,
            codecType: 0,
            sampleRate: 48000,
            channels: 1,
            bitsPerSample: 16,
            sequenceNumber: 1,
            timestampMs: 1000
        )
    }
}
