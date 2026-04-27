/*
 * SensorWireProtocol.swift
 *
 * FRSE v1 wire protocol builder for phone-side sensor telemetry.
 * Relays TelemetrySnapshot data from TelemetryService through the
 * relay WebSocket to viewers/AI services at 1Hz.
 *
 * Header layout (36 bytes):
 *   [0:4]   magic "FRSE"
 *   [4]     version      (u8)
 *   [5:9]   payloadLen   (u32 LE)
 *   [9:17]  sequence     (u64 LE)
 *   [17:21] sensorFlags  (u32 LE) — bitmask of included sensor groups
 *   [21]    frequencyHz  (u8)
 *   [22:26] reserved     (4 bytes, zero)
 *   [26:34] timestamp_ms (u64 LE)
 *   [34:36] crc16        (u16 LE)
 *   [35:]   JSON payload
 */

import Foundation

// MARK: - Sensor Flags

struct SensorFlags: OptionSet, Sendable {
    let rawValue: UInt32

    static let motion        = SensorFlags(rawValue: 0x0001)
    static let gyro          = SensorFlags(rawValue: 0x0002)
    static let magnetometer  = SensorFlags(rawValue: 0x0004)
    static let barometer     = SensorFlags(rawValue: 0x0008)
    static let location      = SensorFlags(rawValue: 0x0010)
    static let proximity     = SensorFlags(rawValue: 0x0020)
    static let battery       = SensorFlags(rawValue: 0x0040)
    static let network       = SensorFlags(rawValue: 0x0080)
    static let thermal       = SensorFlags(rawValue: 0x0100)
    static let orientation   = SensorFlags(rawValue: 0x0200)
    static let memory        = SensorFlags(rawValue: 0x0400)
    static let cpu           = SensorFlags(rawValue: 0x0800)
    static let disk          = SensorFlags(rawValue: 0x1000)
    static let streamMetrics = SensorFlags(rawValue: 0x2000)
}

// MARK: - FRSE Builder

enum SensorWireProtocol {
    static let frseMagic: [UInt8] = [0x46, 0x52, 0x53, 0x45] // "FRSE"
    static let headerSize = 36

    /// Build an FRSE v1 wire protocol message from a telemetry snapshot.
    /// Only includes sensor groups present in the provided flags.
    static func buildFRSE(
        snapshot: TelemetrySnapshot,
        flags: SensorFlags,
        sequenceNumber: UInt64
    ) -> Data? {
        // Build JSON payload with only flagged sensor groups
        var payload: [String: Any] = [:]

        if flags.contains(.motion), let motion = snapshot.motion {
            payload["motion"] = [
                "accelX": motion.accelX,
                "accelY": motion.accelY,
                "accelZ": motion.accelZ,
                "isStationary": motion.isStationary,
            ]
        }

        if flags.contains(.gyro), let gyro = snapshot.gyro {
            payload["gyro"] = [
                "rotationX": gyro.rotationX,
                "rotationY": gyro.rotationY,
                "rotationZ": gyro.rotationZ,
            ]
        }

        if flags.contains(.magnetometer), let mag = snapshot.magnetometer {
            payload["magnetometer"] = [
                "magX": mag.magX,
                "magY": mag.magY,
                "magZ": mag.magZ,
            ]
        }

        if flags.contains(.barometer), let baro = snapshot.barometer {
            payload["barometer"] = ["pressureKPa": baro.pressureKPa]
        }

        if flags.contains(.location), let loc = snapshot.location {
            var locDict: [String: Any] = [:]
            if let speed = loc.speed { locDict["speed"] = speed }
            if let altitude = loc.altitude { locDict["altitude"] = altitude }
            if let accuracy = loc.accuracy { locDict["accuracy"] = accuracy }
            payload["location"] = locDict
        }

        if flags.contains(.proximity) {
            payload["proximity"] = ["near": snapshot.proximity.near]
        }

        if flags.contains(.battery) {
            payload["battery"] = [
                "level": snapshot.battery.level,
                "state": snapshot.battery.state,
                "lowPowerMode": snapshot.battery.lowPowerMode,
            ]
        }

        if flags.contains(.network) {
            payload["network"] = [
                "type": snapshot.network.type,
                "expensive": snapshot.network.expensive,
                "constrained": snapshot.network.constrained,
            ]
        }

        if flags.contains(.thermal) {
            payload["thermal"] = ["state": snapshot.thermal.state]
        }

        if flags.contains(.orientation) {
            payload["orientation"] = ["orientation": snapshot.orientation.orientation]
        }

        if flags.contains(.memory) {
            payload["memory"] = [
                "availableMB": snapshot.memory.availableMB,
                "pressure": snapshot.memory.pressure,
                "footprintMB": snapshot.memoryFootprint.footprintMB,
            ]
        }

        if flags.contains(.cpu) {
            payload["cpu"] = ["usagePercent": snapshot.cpu.usagePercent]
        }

        if flags.contains(.disk) {
            payload["disk"] = [
                "availableGB": snapshot.disk.availableGB,
                "totalGB": snapshot.disk.totalGB,
            ]
        }

        if flags.contains(.streamMetrics) {
            payload["streamMetrics"] = [
                "fps": snapshot.frame.effectiveFPS,
                "jitter": snapshot.frame.jitterMs ?? 0,
                "totalFrames": snapshot.frame.totalFramesReceived,
                "encodeTimeEma": snapshot.relay.map { _ in 0.0 } ?? 0,
            ]
        }

        guard let jsonPayload = try? JSONSerialization.data(withJSONObject: payload) else {
            return nil
        }

        let timestampMs = UInt64(Date().timeIntervalSince1970 * 1000)

        var h = WireProtocol.HeaderBuilder(capacity: headerSize)
        h.appendMagic(frseMagic)                           // [0:4]
        h.appendUInt8(1)                                    // [4] version
        h.appendUInt32(UInt32(jsonPayload.count))           // [5:9] payloadLen
        h.appendUInt64(sequenceNumber)                      // [9:17] sequence
        h.appendUInt32(flags.rawValue)                      // [17:21] sensorFlags
        h.appendUInt8(1)                                    // [21] frequencyHz (1Hz)
        h.appendUInt8(0)                                    // [22] reserved
        h.appendUInt8(0)                                    // [23] reserved
        h.appendUInt8(0)                                    // [24] reserved
        h.appendUInt8(0)                                    // [25] reserved (4th byte)
        h.appendUInt64(timestampMs)                         // [26:34] timestamp_ms
        var header = h.finalizeWithCRC()                    // [33:35] crc16
        header.append(jsonPayload)
        return header
    }
}
