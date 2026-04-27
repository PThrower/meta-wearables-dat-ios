/*
 * G2Protocol.swift
 *
 * BLE protocol for Even Realities G2 smart glasses.
 * Implements the full teleprompter protocol from i-soxi/even-g2-protocol:
 *
 *   1. Auth handshake (7 packets)
 *   2. Display config (0x0E-20)
 *   3. Teleprompter init (0x06-20, type=1)
 *   4. Content pages 0-9 (0x06-20, type=3)
 *   5. Mid-stream marker (0x06-20, type=0xFF)
 *   6. Content pages 10-11
 *   7. Sync trigger (0x80-00, type=14)
 *   8. Remaining pages
 *
 * Packet structure:
 *   [0xAA] [Type] [Seq] [Len] [PktTot] [PktSer] [SvcHi] [SvcLo] [Payload...] [CRCLo] [CRCHi]
 *
 * Reference: https://github.com/i-soxi/even-g2-protocol
 */

import CoreBluetooth
import Foundation

// MARK: - G2 Service UUIDs

enum G2UUID {
    static let service = CBUUID(string: "00002760-08C2-11E1-9073-0E8AC72E0000")
    static let write = CBUUID(string: "00002760-08C2-11E1-9073-0E8AC72E5401")   // Commands (Write Without Response)
    static let notify = CBUUID(string: "00002760-08C2-11E1-9073-0E8AC72E5402")  // Responses
    static let display = CBUUID(string: "00002760-08C2-11E1-9073-0E8AC72E6402") // Rendering
}

// MARK: - G2 Protocol

enum G2Protocol {

    static let magic: UInt8 = 0xAA
    static let packetTypeCommand: UInt8 = 0x21
    static let packetTypeResponse: UInt8 = 0x12

    // Service IDs (hi, lo)
    static let svcAuthControl: (UInt8, UInt8) = (0x80, 0x00)
    static let svcAuthData: (UInt8, UInt8) = (0x80, 0x20)
    static let svcDisplayWake: (UInt8, UInt8) = (0x04, 0x20)
    static let svcTeleprompter: (UInt8, UInt8) = (0x06, 0x20)
    static let svcDisplayConfig: (UInt8, UInt8) = (0x0E, 0x20)

    // MARK: - Varint Encoding (protobuf-style)

    static func encodeVarint(_ value: Int) -> Data {
        var result = Data()
        var v = value
        repeat {
            var byte = UInt8(v & 0x7F)
            v >>= 7
            if v > 0 { byte |= 0x80 }
            result.append(byte)
        } while v > 0
        return result
    }

    // MARK: - Packet Builder

    static func buildPacket(
        seq: UInt8,
        service: (UInt8, UInt8),
        payload: Data
    ) -> Data {
        let header = Data([
            magic,
            packetTypeCommand,
            seq,
            UInt8(payload.count + 2), // length = payload + CRC
            0x01, 0x01,               // single packet
            service.0, service.1
        ])
        let body = header + payload
        let crc = crc16CCITT(payload)
        return body + Data([UInt8(crc & 0xFF), UInt8((crc >> 8) & 0xFF)])
    }

    // MARK: - Auth Handshake (7 packets)

    static func buildAuthSequence() -> [Data] {
        let timestamp = Int(Date().timeIntervalSince1970)
        let tsVarint = encodeVarint(timestamp)
        let txid = Data([0xE8, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x01])

        var packets: [Data] = []

        // Auth 1: Capability query (svc 0x80-00)
        packets.append(addCRC(Data([
            0xAA, 0x21, 0x01, 0x0C, 0x01, 0x01, 0x80, 0x00,
            0x08, 0x04, 0x10, 0x0C, 0x1A, 0x04, 0x08, 0x01, 0x10, 0x04
        ])))

        // Auth 2: Capability response request (svc 0x80-20)
        packets.append(addCRC(Data([
            0xAA, 0x21, 0x02, 0x0A, 0x01, 0x01, 0x80, 0x20,
            0x08, 0x05, 0x10, 0x0E, 0x22, 0x02, 0x08, 0x02
        ])))

        // Auth 3: Time sync with transaction ID (svc 0x80-20)
        let auth3Payload = Data([0x08, 0x80, 0x01, 0x10, 0x0F, 0x82, 0x08, 0x11, 0x08]) + tsVarint + Data([0x10]) + txid
        packets.append(addCRC(Data([0xAA, 0x21, 0x03, UInt8(auth3Payload.count + 2), 0x01, 0x01, 0x80, 0x20]) + auth3Payload))

        // Auth 4: Capability (svc 0x80-00)
        packets.append(addCRC(Data([
            0xAA, 0x21, 0x04, 0x0C, 0x01, 0x01, 0x80, 0x00,
            0x08, 0x04, 0x10, 0x10, 0x1A, 0x04, 0x08, 0x01, 0x10, 0x04
        ])))

        // Auth 5: Capability (svc 0x80-00)
        packets.append(addCRC(Data([
            0xAA, 0x21, 0x05, 0x0C, 0x01, 0x01, 0x80, 0x00,
            0x08, 0x04, 0x10, 0x11, 0x1A, 0x04, 0x08, 0x01, 0x10, 0x04
        ])))

        // Auth 6: Capability (svc 0x80-20)
        packets.append(addCRC(Data([
            0xAA, 0x21, 0x06, 0x0A, 0x01, 0x01, 0x80, 0x20,
            0x08, 0x05, 0x10, 0x12, 0x22, 0x02, 0x08, 0x01
        ])))

        // Auth 7: Final time sync (svc 0x80-20)
        let auth7Payload = Data([0x08, 0x80, 0x01, 0x10, 0x13, 0x82, 0x08, 0x11, 0x08]) + tsVarint + Data([0x10]) + txid
        packets.append(addCRC(Data([0xAA, 0x21, 0x07, UInt8(auth7Payload.count + 2), 0x01, 0x01, 0x80, 0x20]) + auth7Payload))

        return packets
    }

    // MARK: - Display Config (0x0E-20, type=2)

    static func buildDisplayConfig(seq: UInt8, msgId: Int) -> Data {
        // Fixed config blob from protocol capture
        let config = Data([
            0x08, 0x01, 0x12, 0x13, 0x08, 0x02, 0x10, 0x90,
            0x4E, 0x1D, 0x00, 0xE0, 0x94, 0x44, 0x25, 0x00,
            0x00, 0x00, 0x00, 0x28, 0x00, 0x30, 0x00, 0x12, 0x13,
            0x08, 0x03, 0x10, 0x0D, 0x0F, 0x1D, 0x00, 0x40,
            0x8D, 0x44, 0x25, 0x00, 0x00, 0x00, 0x00, 0x28, 0x00, 0x30, 0x00,
            0x12, 0x12, 0x08, 0x04, 0x10, 0x00, 0x1D, 0x00, 0x00, 0x88, 0x42,
            0x25, 0x00, 0x00, 0x00, 0x00, 0x00, 0x28, 0x00, 0x30, 0x00,
            0x12, 0x12, 0x08, 0x05, 0x10, 0x00, 0x1D, 0x00, 0x00, 0x92, 0x42,
            0x25, 0x00, 0x00, 0xA2, 0x42, 0x28, 0x00, 0x30, 0x00,
            0x12, 0x12, 0x08, 0x06, 0x10, 0x00, 0x1D, 0x00, 0x00, 0xC6, 0x42,
            0x25, 0x00, 0x00, 0xC4, 0x42, 0x28, 0x00, 0x30, 0x00,
            0x18, 0x00
        ])

        var payload = Data([0x08, 0x02, 0x10])
        payload.append(encodeVarint(msgId))
        payload.append(0x22)
        payload.append(encodeVarint(config.count))
        payload.append(config)

        return buildPacket(seq: seq, service: svcDisplayConfig, payload: payload)
    }

    // MARK: - Teleprompter Init (0x06-20, type=1)

    static func buildTeleprompterInit(seq: UInt8, msgId: Int, totalLines: Int = 10, manualMode: Bool = true) -> Data {
        let mode: UInt8 = manualMode ? 0x00 : 0x01

        // Scale content height: 140 lines = 2665 units
        let contentHeight = max(1, (totalLines * 2665) / 140)

        // Display settings sub-block
        var display = Data([0x08, 0x01, 0x10, 0x00, 0x18, 0x00, 0x20, 0x8B, 0x02])
        display.append(0x28)
        display.append(encodeVarint(contentHeight))
        display.append(Data([0x30, 0xE6, 0x01]))   // line height = 230
        display.append(Data([0x38, 0x8E, 0x0A]))   // viewport = 1294
        display.append(Data([0x40, 0x05, 0x48, mode])) // font size + mode

        var settings = Data([0x08, 0x01, 0x12])
        settings.append(encodeVarint(display.count))
        settings.append(display)

        var payload = Data([0x08, 0x01, 0x10])
        payload.append(encodeVarint(msgId))
        payload.append(0x1A)
        payload.append(encodeVarint(settings.count))
        payload.append(settings)

        return buildPacket(seq: seq, service: svcTeleprompter, payload: payload)
    }

    // MARK: - Content Page (0x06-20, type=3)

    static func buildContentPage(seq: UInt8, msgId: Int, pageNum: Int, text: String) -> Data {
        // Text starts with \n prefix
        let textBytes = Data(("\n" + text).utf8)

        // Inner block: page_num + line_count(10) + text
        var inner = Data([0x08])
        inner.append(encodeVarint(pageNum))
        inner.append(Data([0x10, 0x0A]))  // 10 lines
        inner.append(0x1A)
        inner.append(encodeVarint(textBytes.count))
        inner.append(textBytes)

        // Content wrapper
        var content = Data([0x2A])
        content.append(encodeVarint(inner.count))
        content.append(inner)

        // Full payload: type=3 + msg_id + content
        var payload = Data([0x08, 0x03, 0x10])
        payload.append(encodeVarint(msgId))
        payload.append(content)

        return buildPacket(seq: seq, service: svcTeleprompter, payload: payload)
    }

    // MARK: - Mid-Stream Marker (0x06-20, type=255)

    static func buildMarker(seq: UInt8, msgId: Int) -> Data {
        // Type 255 varint = 0xFF 0x01
        var payload = Data([0x08, 0xFF, 0x01, 0x10])
        payload.append(encodeVarint(msgId))
        payload.append(Data([0x6A, 0x04, 0x08, 0x00, 0x10, 0x06]))

        return buildPacket(seq: seq, service: svcTeleprompter, payload: payload)
    }

    // MARK: - Sync Trigger (0x80-00, type=14)

    static func buildSync(seq: UInt8, msgId: Int) -> Data {
        var payload = Data([0x08, 0x0E, 0x10])
        payload.append(encodeVarint(msgId))
        payload.append(Data([0x6A, 0x00]))

        return buildPacket(seq: seq, service: svcAuthControl, payload: payload)
    }

    // MARK: - Display Wake (0x04-20)

    static func buildDisplayWake(seq: UInt8) -> Data {
        return buildPacket(seq: seq, service: svcDisplayWake, payload: Data([0x08, 0x01]))
    }

    // MARK: - Text Formatting

    /// Format raw text lines into teleprompter pages (10 lines/page, ~25 chars/line).
    /// Returns minimum 14 pages as required by G2 firmware.
    static func formatPages(from lines: [String]) -> [String] {
        let charsPerLine = 25
        let linesPerPage = 10

        // Wrap long lines
        var wrapped: [String] = []
        for line in lines {
            if line.isEmpty {
                wrapped.append(" ")
                continue
            }
            let words = line.split(separator: " ", omittingEmptySubsequences: false)
            var current = ""
            for word in words {
                if current.isEmpty {
                    current = String(word)
                } else if current.count + 1 + word.count <= charsPerLine {
                    current += " " + word
                } else {
                    wrapped.append(current)
                    current = String(word)
                }
            }
            if !current.isEmpty { wrapped.append(current) }
        }

        // Ensure minimum lines
        while wrapped.count < linesPerPage {
            wrapped.append(" ")
        }

        // Split into pages
        var pages: [String] = []
        for i in stride(from: 0, to: wrapped.count, by: linesPerPage) {
            let slice = Array(wrapped[i..<min(i + linesPerPage, wrapped.count)])
            let padded = slice + Array(repeating: " ", count: linesPerPage - slice.count)
            pages.append(padded.joined(separator: "\n") + " \n")
        }

        // Minimum 14 pages
        let emptyPage = Array(repeating: " ", count: linesPerPage).joined(separator: "\n") + " \n"
        while pages.count < 14 {
            pages.append(emptyPage)
        }

        return pages
    }

    // MARK: - Full Display Sequence

    /// Build the complete packet sequence to display text on G2 glasses.
    /// Returns an ordered array of packets to send sequentially with ~100ms delays.
    static func buildFullDisplaySequence(lines: [String]) -> [Data] {
        var packets: [Data] = []
        var seq: UInt8 = 0x01
        var msgId: Int = 0x0C

        // 1. Auth handshake (7 packets)
        let authPackets = buildAuthSequence()
        packets.append(contentsOf: authPackets)
        seq = 0x08
        msgId = 0x14

        // 2. Display config
        packets.append(buildDisplayConfig(seq: seq, msgId: msgId))
        seq &+= 1; msgId += 1

        // 3. Format pages and init teleprompter
        let pages = formatPages(from: lines)
        packets.append(buildTeleprompterInit(seq: seq, msgId: msgId, totalLines: pages.count * 10))
        seq &+= 1; msgId += 1

        // 4. Content pages 0-9
        for i in 0..<min(10, pages.count) {
            packets.append(buildContentPage(seq: seq, msgId: msgId, pageNum: i, text: pages[i]))
            seq &+= 1; msgId += 1
        }

        // 5. Mid-stream marker
        packets.append(buildMarker(seq: seq, msgId: msgId))
        seq &+= 1; msgId += 1

        // 6. Pages 10-11
        for i in 10..<min(12, pages.count) {
            packets.append(buildContentPage(seq: seq, msgId: msgId, pageNum: i, text: pages[i]))
            seq &+= 1; msgId += 1
        }

        // 7. Sync trigger
        packets.append(buildSync(seq: seq, msgId: msgId))
        seq &+= 1; msgId += 1

        // 8. Remaining pages
        for i in 12..<pages.count {
            packets.append(buildContentPage(seq: seq, msgId: msgId, pageNum: i, text: pages[i]))
            seq &+= 1; msgId += 1
        }

        return packets
    }

    // MARK: - CRC-16/CCITT

    static func crc16CCITT(_ data: Data) -> UInt16 {
        var crc: UInt16 = 0xFFFF
        for byte in data {
            crc ^= UInt16(byte) << 8
            for _ in 0..<8 {
                crc = (crc & 0x8000 != 0) ? (crc << 1) ^ 0x1021 : crc << 1
                crc &= 0xFFFF
            }
        }
        return crc
    }

    /// Append CRC to an already-formed packet (for auth packets built with raw bytes).
    static func addCRC(_ packet: Data) -> Data {
        let crc = crc16CCITT(packet.suffix(from: 8))
        return packet + Data([UInt8(crc & 0xFF), UInt8((crc >> 8) & 0xFF)])
    }

    // MARK: - Response Parsing

    static func parseResponse(_ data: Data) -> (serviceId: UInt16, payload: Data)? {
        guard data.count >= 10 else { return nil }
        guard data[0] == magic else { return nil }
        guard data[1] == packetTypeResponse else { return nil }

        let svcHi = UInt16(data[6]) << 8
        let svcLo = UInt16(data[7])
        let serviceId = svcHi | svcLo

        let payloadStart = 8
        let payloadEnd = data.count - 2
        guard payloadEnd > payloadStart else { return nil }

        let payloadBytes = data[payloadStart..<payloadEnd]
        let receivedCRC = UInt16(data[payloadEnd]) | (UInt16(data[payloadEnd + 1]) << 8)
        let computedCRC = crc16CCITT(Data(payloadBytes))
        guard receivedCRC == computedCRC else { return nil }

        return (serviceId, Data(payloadBytes))
    }
}
