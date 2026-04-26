/*
 * G1Protocol.swift
 *
 * BLE display protocol for Even Realities G1 smart glasses.
 * Uses Nordic UART Service (NUS) with binary command 0x4E for text display.
 *
 * G1 uses two BLE connections (left arm + right arm). Display commands
 * must be sent to both sides. Text is limited to ~176 bytes per chunk
 * due to NUS MTU constraints.
 *
 * Protocol reference: community reverse-engineered from EvenDemoApp.
 */

import CoreBluetooth
import Foundation

// MARK: - NUS Service UUIDs

enum G1UUID {
    static let service = CBUUID(string: "6E400001-B5A3-F393-E0A9-E50E24DCCA9E")
    static let rx = CBUUID(string: "6E400002-B5A3-F393-E0A9-E50E24DCCA9E") // Phone -> Glasses
    static let tx = CBUUID(string: "6E400003-B5A3-F393-E0A9-E50E24DCCA9E") // Glasses -> Phone
}

// MARK: - G1 Protocol Encoder

enum G1Protocol {

    // MARK: - Send Text (0x4E)
    //
    // Byte layout:
    // [0x4E] [seq] [0x01] [0x00] [screenStatus] [0x00] [0x00] [currentPage] [totalPages] [textBytes...]

    /// Screen status codes for the 0x4E command
    enum ScreenStatus: UInt8 {
        case clear = 0x00
        case display = 0x01
        case append = 0x02
    }

    /// Build a 0x4E send-text command payload.
    /// Text is UTF-8 encoded, truncated to fit within the BLE chunk limit.
    static func buildSendText(
        lines: [String],
        currentPage: UInt8 = 0,
        totalPages: UInt8 = 1,
        screenStatus: ScreenStatus = .display,
        sequence: UInt8
    ) -> Data {
        // Join lines with newline, encode to UTF-8
        let text = lines.joined(separator: "\n")
        var textBytes = Data(text.utf8)

        // Truncate to fit BLE chunk limit (176 bytes minus 9-byte header = 167 bytes of text)
        let maxTextBytes = 167
        if textBytes.count > maxTextBytes {
            textBytes = textBytes.prefix(maxTextBytes)
        }

        var payload = Data()
        payload.append(0x4E)                            // Command: send text
        payload.append(sequence)                        // Sequence (0-255, rolling)
        payload.append(0x01)                            // Fixed
        payload.append(0x00)                            // Fixed
        payload.append(screenStatus.rawValue)           // Screen status
        payload.append(0x00)                            // Fixed
        payload.append(0x00)                            // Fixed
        payload.append(currentPage)                     // Current page (0-indexed)
        payload.append(totalPages)                      // Total pages
        payload.append(textBytes)                       // Text payload

        return payload
    }

    // MARK: - Clear Screen (0x18)

    static func buildClearScreen(sequence: UInt8) -> Data {
        return Data([0x18, sequence])
    }

    // MARK: - Heartbeat (0x25)
    //
    // Must be sent every 28-30 seconds to keep the connection alive.
    // Uses its own sequence counter, separate from command sequence.

    static func buildHeartbeat(sequence: UInt8) -> Data {
        return Data([0x25, sequence])
    }

    // MARK: - Microphone Control (0x0E)

    static func buildMicEnable(sequence: UInt8) -> Data {
        return Data([0x0E, sequence, 0x01])
    }

    static func buildMicDisable(sequence: UInt8) -> Data {
        return Data([0x0E, sequence, 0x00])
    }

    // MARK: - Audio Data Parsing (0xF1)
    //
    // Glasses send: [0xF1] [seq] [audioData...]
    // Returns raw audio payload (LC3 encoded, ~200 bytes per packet).

    static func parseAudioData(_ data: Data) -> (sequence: UInt8, audioPayload: Data)? {
        guard data.count >= 3, data[0] == 0xF1 else { return nil }
        let seq = data[1]
        let payload = Data(data[2...])
        return (seq, payload)
    }

    // MARK: - State Change Parsing (0xF5)

    static func parseStateChange(_ data: Data) -> G1StateEvent? {
        guard data.count >= 2, data[0] == 0xF5 else { return nil }
        return G1StateEvent(rawValue: data[1])
    }
}

// MARK: - G1 State Events

enum G1StateEvent: UInt8 {
    case touchDoubleTap = 0x00
    case touchSingleTap = 0x01
    case headUp = 0x02
    case headDown = 0x03
    case touchTripleTap = 0x04
    case worn = 0x06
    case removed = 0x07
    case caseOpen = 0x08
    case caseClosed = 0x0B
}
