/*
 * FRLYWireProtocolTests.swift
 *
 * Unit tests for the FRLY video wire protocol binary layout.
 * Validates the header structure: magic, sequence, width, height, quality, timestamp,
 * and JPEG payload placement.
 *
 * Mirrors FRAUWireProtocolTests pattern for the video side.
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

final class FRLYWireProtocolTests: XCTestCase {

    // MARK: - FRLY Reference Encoder
    // Mirrors the FRLY wire protocol spec from RelayStage.

    private func buildFRLYReference(
        sequence: UInt64,
        width: UInt32,
        height: UInt32,
        quality: UInt8,
        timestampMs: UInt64,
        jpegPayload: Data
    ) -> Data {
        let headerSize = 29
        var header = Data(capacity: headerSize)

        // Magic "FRLY"
        header.append(contentsOf: [0x46, 0x52, 0x4C, 0x59])

        // Sequence number (8 bytes LE)
        var seq = sequence
        header.append(contentsOf: withUnsafeBytes(of: &seq) { Array($0) })

        // Width (4 bytes LE)
        var w = width
        header.append(contentsOf: withUnsafeBytes(of: &w) { Array($0) })

        // Height (4 bytes LE)
        var h = height
        header.append(contentsOf: withUnsafeBytes(of: &h) { Array($0) })

        // Quality (1 byte)
        header.append(quality)

        // Timestamp ms (8 bytes LE)
        var ts = timestampMs
        header.append(contentsOf: withUnsafeBytes(of: &ts) { Array($0) })

        var message = header
        message.append(jpegPayload)
        return message
    }

    // MARK: - Magic Bytes

    func testFRLYMagicBytes() {
        let message = buildFRLYReference(
            sequence: 1, width: 640, height: 480,
            quality: 80, timestampMs: 1000, jpegPayload: Data([0xFF, 0xD8])
        )

        XCTAssertEqual(message.extractUInt8(at: 0), 0x46, "FRLY byte 0 = 'F'")
        XCTAssertEqual(message.extractUInt8(at: 1), 0x52, "FRLY byte 1 = 'R'")
        XCTAssertEqual(message.extractUInt8(at: 2), 0x4C, "FRLY byte 2 = 'L'")
        XCTAssertEqual(message.extractUInt8(at: 3), 0x59, "FRLY byte 3 = 'Y'")
    }

    // MARK: - Sequence Number Layout

    func testSequenceNumberLayout() {
        let message = buildFRLYReference(
            sequence: 0x0102030405060708, width: 640, height: 480,
            quality: 80, timestampMs: 0, jpegPayload: Data([0x00])
        )
        let seq = message.extractUInt64(at: 4)
        XCTAssertEqual(seq, 0x0102030405060708, "Sequence number LE at offset 4")
    }

    // MARK: - Width Layout

    func testWidthLayout() {
        let message = buildFRLYReference(
            sequence: 1, width: 1280, height: 720,
            quality: 80, timestampMs: 0, jpegPayload: Data([0x00])
        )
        let w = message.extractUInt32(at: 12)
        XCTAssertEqual(w, 1280, "Width LE at offset 12")
    }

    // MARK: - Height Layout

    func testHeightLayout() {
        let message = buildFRLYReference(
            sequence: 1, width: 640, height: 1080,
            quality: 80, timestampMs: 0, jpegPayload: Data([0x00])
        )
        let h = message.extractUInt32(at: 16)
        XCTAssertEqual(h, 1080, "Height LE at offset 16")
    }

    // MARK: - Quality Layout

    func testQualityLayout() {
        let message = buildFRLYReference(
            sequence: 1, width: 640, height: 480,
            quality: 90, timestampMs: 0, jpegPayload: Data([0x00])
        )
        let q = message.extractUInt8(at: 20)
        XCTAssertEqual(q, 90, "Quality at offset 20")
    }

    // MARK: - Timestamp Layout

    func testTimestampLayout() {
        let message = buildFRLYReference(
            sequence: 1, width: 640, height: 480,
            quality: 80, timestampMs: 1700000000123, jpegPayload: Data([0x00])
        )
        let ts = message.extractUInt64(at: 21)
        XCTAssertEqual(ts, 1700000000123, "Timestamp LE at offset 21")
    }

    // MARK: - Header Size

    func testFRLYHeaderSize() {
        let message = buildFRLYReference(
            sequence: 0, width: 0, height: 0,
            quality: 0, timestampMs: 0, jpegPayload: Data()
        )
        XCTAssertEqual(message.count, 29, "FRLY header is 29 bytes (no payload)")
    }

    // MARK: - Payload

    func testEmptyPayloadIsHeaderOnly() {
        let message = buildFRLYReference(
            sequence: 0, width: 0, height: 0,
            quality: 0, timestampMs: 0, jpegPayload: Data()
        )
        XCTAssertEqual(message.count, 29, "Empty payload = header only = 29 bytes")
    }

    func testPayloadAppendedAfterHeader() {
        let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x02, 0xFF, 0xD9])
        let message = buildFRLYReference(
            sequence: 1, width: 640, height: 480,
            quality: 80, timestampMs: 1000, jpegPayload: jpeg
        )
        XCTAssertEqual(message.count, 29 + 8, "Header + 8 bytes JPEG payload")
        XCTAssertEqual(message[29], 0xFF, "JPEG SOI byte 0")
        XCTAssertEqual(message[30], 0xD8, "JPEG SOI byte 1")
        XCTAssertEqual(message[33], 0xE0, "JPEG APP0 byte")
    }

    func testLargePayload() {
        let jpeg = Data(repeating: 0xAB, count: 65536)
        let message = buildFRLYReference(
            sequence: 1, width: 1920, height: 1080,
            quality: 95, timestampMs: 1000, jpegPayload: jpeg
        )
        XCTAssertEqual(message.count, 29 + 65536)
        XCTAssertEqual(message[29], 0xAB)
        XCTAssertEqual(message[message.count - 1], 0xAB)
    }

    // MARK: - Round-Trip

    func testRoundTripSequenceNumber() {
        let testValues: [UInt64] = [0, 1, 255, 256, 65535, UInt64.max]
        for seq in testValues {
            let message = buildFRLYReference(
                sequence: seq, width: 640, height: 480,
                quality: 80, timestampMs: 0, jpegPayload: Data([0x00])
            )
            let decoded = message.extractUInt64(at: 4)
            XCTAssertEqual(decoded, seq, "Round-trip failed for sequence \(seq)")
        }
    }

    func testRoundTripResolution() {
        let resolutions: [(UInt32, UInt32)] = [
            (640, 480), (1280, 720), (1920, 1080), (3840, 2160),
        ]
        for (w, h) in resolutions {
            let message = buildFRLYReference(
                sequence: 1, width: w, height: h,
                quality: 80, timestampMs: 0, jpegPayload: Data([0x00])
            )
            XCTAssertEqual(message.extractUInt32(at: 12), w, "Round-trip width \(w)")
            XCTAssertEqual(message.extractUInt32(at: 16), h, "Round-trip height \(h)")
        }
    }

    func testRoundTripTimestamp() {
        let timestamps: [UInt64] = [0, 1, 1000, 1700000000000, UInt64.max]
        for ts in timestamps {
            let message = buildFRLYReference(
                sequence: 1, width: 640, height: 480,
                quality: 80, timestampMs: ts, jpegPayload: Data([0x00])
            )
            let decoded = message.extractUInt64(at: 21)
            XCTAssertEqual(decoded, ts, "Round-trip failed for timestamp \(ts)")
        }
    }

    // MARK: - Cross-Protocol Validation

    func testFRLYNotConfusedWithFRAU() {
        let frlyMessage = buildFRLYReference(
            sequence: 1, width: 640, height: 480,
            quality: 80, timestampMs: 0, jpegPayload: Data([0x00])
        )
        // FRLY starts with 0x46 0x52 0x4C 0x59
        // FRAU starts with 0x46 0x52 0x41 0x55
        // Byte 2 should differ: 0x4C ('L') vs 0x41 ('A')
        XCTAssertEqual(frlyMessage.extractUInt8(at: 2), 0x4C)
        XCTAssertNotEqual(frlyMessage.extractUInt8(at: 2), 0x41)
    }
}
