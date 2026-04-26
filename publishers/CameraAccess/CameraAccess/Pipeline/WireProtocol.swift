/*
 * WireProtocol.swift
 *
 * Shared wire protocol header builder for FRLY (video) and FRAU (audio).
 * Both protocols share the same framing pattern:
 *   [4-byte magic][1-byte version][4-byte payloadLen][...fields...][2-byte CRC-16][payload]
 *
 * FRLY byte[25] layout (codec+flags):
 *   Top 4 bits: codec type (0=JPEG, 1=H.264)
 *   Bottom 4 bits: codec-specific flags
 *     JPEG: quality tier (0-15, mapped from 0.0-1.0)
 *     H.264: bit0=isKeyframe, bit1=hasSPSPPS
 *
 * Provides a fluent Data builder with LE serialization helpers and CRC.
 */

import Foundation

enum WireProtocol {
    // MARK: - Header Builder

    struct HeaderBuilder {
        private var data: Data

        init(capacity: Int = 64) {
            data = Data(capacity: capacity)
        }

        // MARK: - Primitive Writers (little-endian)

        @discardableResult
        mutating func appendMagic(_ bytes: [UInt8]) -> Self {
            data.append(contentsOf: bytes)
            return self
        }

        @discardableResult
        mutating func appendUInt8(_ value: UInt8) -> Self {
            data.append(value)
            return self
        }

        @discardableResult
        mutating func appendUInt16(_ value: UInt16) -> Self {
            var v = value
            data.append(contentsOf: withUnsafeBytes(of: &v) { Array($0) })
            return self
        }

        @discardableResult
        mutating func appendUInt32(_ value: UInt32) -> Self {
            var v = value
            data.append(contentsOf: withUnsafeBytes(of: &v) { Array($0) })
            return self
        }

        @discardableResult
        mutating func appendUInt64(_ value: UInt64) -> Self {
            var v = value
            data.append(contentsOf: withUnsafeBytes(of: &v) { Array($0) })
            return self
        }

        // MARK: - CRC + Finalize

        /// Append CRC-16/CCITT-FALSE over all bytes written so far, then return the header.
        mutating func finalizeWithCRC() -> Data {
            let crc = CRC16.ccittFalse(data, offset: 0, length: data.count)
            var crcVar = crc
            data.append(contentsOf: withUnsafeBytes(of: &crcVar) { Array($0) })
            return data
        }

        /// Return the header without CRC (for protocols that don't use it).
        mutating func finalize() -> Data {
            return data
        }

        /// Current header byte count.
        var count: Int { data.count }
    }

    // MARK: - FRLY (Video Frame)

    /// Build an FRLY v1 wire protocol message.
    /// Header: magic(4) + version(1) + payloadLen(4) + seq(8) + width(4) + height(4) + quality(1) + timestamp(8) + crc(2) = 36 bytes
    static func buildFRLY(jpegData: Data, sequenceNumber: UInt64,
                          width: Int, height: Int, quality: CGFloat,
                          timestampMs: UInt64) -> Data {
        var h = HeaderBuilder(capacity: 36)
        h.appendMagic([0x46, 0x52, 0x4C, 0x59]) // "FRLY"
        h.appendUInt8(1) // version
        h.appendUInt32(UInt32(jpegData.count))
        h.appendUInt64(sequenceNumber)
        h.appendUInt32(UInt32(width))
        h.appendUInt32(UInt32(height))
        h.appendUInt8(UInt8(quality * 100))
        h.appendUInt64(timestampMs)
        var header = h.finalizeWithCRC()
        header.append(jpegData)
        return header
    }

    // MARK: - FRLY (Video — codec-aware)

    /// Build an FRLY wire protocol message with codec-aware header.
    /// Byte [25] encodes codec type + flags:
    ///   Top nibble: codec (0=JPEG, 1=H.264)
    ///   Bottom nibble: JPEG quality tier (0-15) or H.264 flags (bit0=keyframe, bit1=hasSPSPPS)
    static func buildVideoFrame(
        codec: RelayVideoCodec,
        payload: Data,
        sequenceNumber: UInt64,
        width: Int, height: Int,
        isKeyframe: Bool,
        hasParameterSets: Bool,
        jpegQuality: CGFloat = 0.5
    ) -> Data {
        let codecFlags: UInt8
        switch codec {
        case .jpeg:
            // Map quality (0.0-1.0) to 4-bit tier (0-15)
            let tier = UInt8(max(0, min(15, jpegQuality * 16)))
            codecFlags = (codec.rawValue << 4) | (tier & 0x0F)
        case .h264:
            var flags: UInt8 = 0
            if isKeyframe { flags |= 0x01 }
            if hasParameterSets { flags |= 0x02 }
            codecFlags = (codec.rawValue << 4) | (flags & 0x0F)
        }

        var h = HeaderBuilder(capacity: 36)
        h.appendMagic([0x46, 0x52, 0x4C, 0x59]) // "FRLY"
        h.appendUInt8(1) // version (same version, codec is in byte[25])
        h.appendUInt32(UInt32(payload.count))
        h.appendUInt64(sequenceNumber)
        h.appendUInt32(UInt32(width))
        h.appendUInt32(UInt32(height))
        h.appendUInt8(codecFlags)  // codec type + flags
        h.appendUInt64(UInt64(Date().timeIntervalSince1970 * 1000)) // timestamp
        var header = h.finalizeWithCRC()
        header.append(payload)
        return header
    }

    // MARK: - FRLY Parsing (codec-aware)

    /// Parse an FRLY header to extract codec type and flags from byte[25].
    static func parseFRLYCodec(_ data: Data) -> (codec: RelayVideoCodec, flags: UInt8)? {
        guard data.count >= 36 else { return nil }
        let prefix = [UInt8](data.prefix(4))
        guard prefix == [0x46, 0x52, 0x4C, 0x59] else { return nil }

        let codecAndFlags = data[25]
        let codecRaw = (codecAndFlags >> 4) & 0x0F
        let flags = codecAndFlags & 0x0F

        guard let codec = RelayVideoCodec(rawValue: codecRaw) else { return nil }
        return (codec, flags)
    }

    // MARK: - FRAU (Audio)

    /// FRAU v1 header size: magic(4) + version(1) + payloadLen(4) + codec(1) + seq(8) + sampleRate(4) + channels(2) + bitsPerSample(2) + timestamp(8) + crc(2) = 36
    static let frauHeaderSize = 36

    /// Build a FRAU v1 wire protocol message from PCM data.
    static func buildFRAU(pcmData: Data, codecType: UInt8,
                          sampleRate: UInt32, channels: UInt16,
                          bitsPerSample: UInt16, sequenceNumber: UInt64,
                          timestampMs: UInt64) -> Data {
        var h = HeaderBuilder(capacity: frauHeaderSize)
        h.appendMagic([0x46, 0x52, 0x41, 0x55]) // "FRAU"
        h.appendUInt8(1) // version
        h.appendUInt32(UInt32(pcmData.count))
        h.appendUInt8(codecType)
        h.appendUInt64(sequenceNumber)
        h.appendUInt32(sampleRate)
        h.appendUInt16(channels)
        h.appendUInt16(bitsPerSample)
        h.appendUInt64(timestampMs)
        var header = h.finalizeWithCRC()
        header.append(pcmData)
        return header
    }

    // MARK: - FRAU Parsing

    /// Parse a FRAU v1 binary message into its header fields and PCM payload.
    /// Returns nil if the data is too short or the magic bytes don't match.
    static func parseFRAU(_ data: Data) -> (codecType: UInt8, sequenceNumber: UInt64,
                                             sampleRate: UInt32, channels: UInt16,
                                             bitsPerSample: UInt16, timestampMs: UInt64,
                                             pcmData: Data)? {
        guard data.count >= frauHeaderSize else { return nil }

        // Verify magic "FRAU"
        let magic: [UInt8] = [0x46, 0x52, 0x41, 0x55]
        let prefix = [UInt8](data.prefix(4))
        guard prefix == magic else { return nil }

        // Verify CRC over header bytes [0..<34]
        let headerCRC = data.extractUInt16(at: 34)
        let computedCRC = CRC16.ccittFalse(data, offset: 0, length: 34)
        guard headerCRC == computedCRC else { return nil }

        let version = data[4]
        guard version == 1 else { return nil }

        let payloadLen = data.extractUInt32(at: 5)
        let codecType = data[9]
        let sequenceNumber = data.extractUInt64(at: 10)
        let sampleRate = data.extractUInt32(at: 18)
        let channels = data.extractUInt16(at: 22)
        let bitsPerSample = data.extractUInt16(at: 24)
        let timestampMs = data.extractUInt64(at: 26)

        let pcmStart = frauHeaderSize
        let pcmEnd = pcmStart + Int(payloadLen)
        guard pcmEnd <= data.count else { return nil }

        return (codecType, sequenceNumber, sampleRate, channels, bitsPerSample, timestampMs, Data(data[pcmStart..<pcmEnd]))
    }
}

// MARK: - Data LE extraction helpers

extension Data {
    func extractUInt16(at offset: Int) -> UInt16 {
        precondition(offset + 2 <= count, "extractUInt16: offset \(offset) out of bounds for data of size \(count)")
        var value: UInt16 = 0
        _ = Swift.withUnsafeMutableBytes(of: &value) { dest in
            dest.copyBytes(from: self[offset..<(offset + 2)])
        }
        return value
    }

    func extractUInt32(at offset: Int) -> UInt32 {
        precondition(offset + 4 <= count, "extractUInt32: offset \(offset) out of bounds for data of size \(count)")
        var value: UInt32 = 0
        _ = Swift.withUnsafeMutableBytes(of: &value) { dest in
            dest.copyBytes(from: self[offset..<(offset + 4)])
        }
        return value
    }

    func extractUInt64(at offset: Int) -> UInt64 {
        precondition(offset + 8 <= count, "extractUInt64: offset \(offset) out of bounds for data of size \(count)")
        var value: UInt64 = 0
        _ = Swift.withUnsafeMutableBytes(of: &value) { dest in
            dest.copyBytes(from: self[offset..<(offset + 8)])
        }
        return value
    }
}
