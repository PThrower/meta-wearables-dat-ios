/*
 * G2Protocol.swift
 *
 * BLE display protocol for Even Realities G2 smart glasses.
 * Uses a custom Even Realities BLE service with protobuf-encoded payloads
 * and CRC-16/CCITT packet integrity.
 *
 * G2 packet structure:
 * [0xAA] [Type] [Seq] [Len] [PktTot] [PktSer] [SvcHi] [SvcLo] [Payload...] [CRCLo] [CRCHi]
 *
 * G2 uses container-based UI (TextContainer, ListContainer) managed via
 * EvenHub SDK commands (createStartUpPageContainer, textContainerUpgrade).
 *
 * Protocol reference: community RE from i-soxi/even-g2-protocol.
 */

import CoreBluetooth
import Foundation

// MARK: - G2 Service UUIDs

enum G2UUID {
    // Base pattern: 00002760-08C2-11E1-9073-0E8AC72E{XXXX}
    static let service = CBUUID(string: "00002760-08C2-11E1-9073-0E8AC72E0000")
    static let write = CBUUID(string: "00002760-08C2-11E1-9073-0E8AC72E5401")   // Commands
    static let notify = CBUUID(string: "00002760-08C2-11E1-9073-0E8AC72E5402")  // Responses
    static let display = CBUUID(string: "00002760-08C2-11E1-9073-0E8AC72E6402") // Rendering
}

// MARK: - G2 Protocol

enum G2Protocol {

    // Packet type
    static let packetTypeCommand: UInt8 = 0x21  // Phone -> Glasses
    static let packetTypeResponse: UInt8 = 0x12 // Glasses -> Phone

    // Packet header magic
    static let magic: UInt8 = 0xAA

    // Service IDs (big-endian in packet)
    static let serviceDisplayWake: (UInt8, UInt8) = (0x04, 0x20)
    static let serviceTeleprompter: (UInt8, UInt8) = (0x06, 0x20)
    static let serviceDashboard: (UInt8, UInt8) = (0x07, 0x20)

    // MARK: - Packet Builder

    /// Build a G2 BLE packet with header + CRC.
    /// Payload is the service-specific data (already encoded).
    static func buildPacket(
        type: UInt8 = packetTypeCommand,
        sequence: UInt8,
        serviceId: (UInt8, UInt8),
        payload: Data
    ) -> Data {
        var packet = Data()
        packet.append(magic)                 // [0] Magic: 0xAA
        packet.append(type)                  // [1] Type
        packet.append(sequence)              // [2] Sequence (0-255, rolling)
        // Length = payload.count + 2 (CRC) + 2 (service ID)
        let totalPayloadLen = UInt8(payload.count + 2 + 2)
        packet.append(totalPayloadLen)       // [3] Length
        packet.append(0x01)                  // [4] Packet total (1 = single packet)
        packet.append(0x01)                  // [5] Packet serial (1 = first)
        packet.append(serviceId.0)           // [6] Service ID high
        packet.append(serviceId.1)           // [7] Service ID low
        packet.append(payload)               // [8..N-3] Service payload

        // CRC-16/CCITT over the payload bytes only (skip 8-byte header)
        let payloadForCRC = packet.suffix(from: 8)
        let crc = crc16CCITT(payloadForCRC)
        packet.append(UInt8(crc & 0xFF))     // CRC low
        packet.append(UInt8((crc >> 8) & 0xFF)) // CRC high

        return packet
    }

    // MARK: - Teleprompter (Text Display)

    /// Build a teleprompter command to display text lines.
    /// Uses simple text payload format compatible with G2 firmware.
    static func buildTeleprompterDisplay(
        lines: [String],
        sequence: UInt8
    ) -> Data {
        // Join lines, UTF-8 encode, limit to ~500 chars for single packet
        let text = lines.joined(separator: "\n")
        var textData = Data(text.utf8)
        let maxLen = 490 // 512 MTU - header - CRC
        if textData.count > maxLen {
            textData = textData.prefix(maxLen)
        }

        // Simple text payload: [textLen(2)] [text UTF-8]
        var payload = Data()
        let textLen = UInt16(textData.count)
        payload.append(UInt8(textLen & 0xFF))
        payload.append(UInt8((textLen >> 8) & 0xFF))
        payload.append(textData)

        return buildPacket(
            sequence: sequence,
            serviceId: serviceTeleprompter,
            payload: payload
        )
    }

    // MARK: - Display Wake

    static func buildDisplayWake(sequence: UInt8) -> Data {
        return buildPacket(
            sequence: sequence,
            serviceId: serviceDisplayWake,
            payload: Data([0x01])
        )
    }

    // MARK: - CRC-16/CCITT
    //
    // Init: 0xFFFF, Polynomial: 0x1021
    // Computed over payload bytes only (skip the 8-byte header).

    static func crc16CCITT(_ data: Data) -> UInt16 {
        var crc: UInt16 = 0xFFFF
        for byte in data {
            crc ^= UInt16(byte) << 8
            for _ in 0..<8 {
                if crc & 0x8000 != 0 {
                    crc = (crc << 1) ^ 0x1021
                } else {
                    crc <<= 1
                }
                crc &= 0xFFFF
            }
        }
        return crc
    }

    // MARK: - Response Parsing

    /// Parse a G2 response packet. Returns (serviceId, payload) or nil.
    static func parseResponse(_ data: Data) -> (serviceId: UInt16, payload: Data)? {
        guard data.count >= 10 else { return nil }
        guard data[0] == magic else { return nil }
        guard data[1] == packetTypeResponse else { return nil }

        let svcHi = UInt16(data[6]) << 8
        let svcLo = UInt16(data[7])
        let serviceId = svcHi | svcLo

        // Payload is between header (8 bytes) and CRC (2 bytes)
        let payloadStart = 8
        let payloadEnd = data.count - 2
        guard payloadEnd > payloadStart else { return nil }

        // Verify CRC
        let payloadBytes = data[payloadStart..<payloadEnd]
        let receivedCRC = UInt16(data[payloadEnd]) | (UInt16(data[payloadEnd + 1]) << 8)
        let computedCRC = crc16CCITT(payloadBytes)
        guard receivedCRC == computedCRC else { return nil }

        return (serviceId, Data(payloadBytes))
    }
}
