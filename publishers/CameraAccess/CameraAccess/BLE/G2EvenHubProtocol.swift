/*
 * G2EvenHubProtocol.swift
 *
 * EvenHub app protocol (0xE0 service) for Even Realities G2 smart glasses.
 * Ported from MentraOS's G2.swift — the same BLE protocol used by the official
 * Even Realities companion app.
 *
 * Protocol flow:
 *   1. Auth handshake (auth → pipeRoleChange → timeSync → skipOnboarding)
 *   2. Heartbeats every 5s (EvenHub + DevSettings)
 *   3. Display: createStartupPage → updateTextData (or rebuildPage)
 *
 * Uses BLE service UUIDs:
 *   Write:   00002760-08C2-11E1-9073-0E8AC72E5401
 *   Notify:  00002760-08C2-11E1-9073-0E8AC72E5402
 *   Audio:   00002760-08C2-11E1-9073-0E8AC72E6402
 *   Service: 00002760-08C2-11E1-9073-0E8AC72E0000
 */

import Foundation

// MARK: - CRC16 (matches MentraOS calcCRC16 / Python calc_crc)

enum G2EvenHubCRC {
    static func calc(_ data: Data) -> UInt16 {
        var crc: UInt16 = 0xFFFF
        for byte in data {
            crc = ((crc >> 8) | ((crc << 8) & 0xFF00)) ^ UInt16(byte)
            crc ^= (crc & 0xFF) >> 4
            crc ^= (crc << 12) & 0xFFFF
            crc ^= ((crc & 0xFF) << 5) & 0xFFFF
        }
        return crc & 0xFFFF
    }
}

// MARK: - Protobuf Encoding Helpers

private struct ProtobufWriter {
    private(set) var data = Data()

    mutating func writeVarint(_ value: UInt64) {
        var v = value
        while v > 0x7F {
            data.append(UInt8(v & 0x7F) | 0x80)
            v >>= 7
        }
        data.append(UInt8(v))
    }

    mutating func writeInt32Field(_ fieldNumber: Int, _ value: Int32) {
        let tag = UInt64(fieldNumber << 3) | 0
        writeVarint(tag)
        if value >= 0 {
            writeVarint(UInt64(value))
        } else {
            writeVarint(UInt64(bitPattern: Int64(value)))
        }
    }

    mutating func writeStringField(_ fieldNumber: Int, _ value: String) {
        let tag = UInt64(fieldNumber << 3) | 2
        writeVarint(tag)
        let utf8 = Array(value.utf8)
        writeVarint(UInt64(utf8.count))
        data.append(contentsOf: utf8)
    }

    mutating func writeBytesField(_ fieldNumber: Int, _ value: Data) {
        let tag = UInt64(fieldNumber << 3) | 2
        writeVarint(tag)
        writeVarint(UInt64(value.count))
        data.append(value)
    }

    mutating func writeMessageField(_ fieldNumber: Int, _ subMessage: Data) {
        let tag = UInt64(fieldNumber << 3) | 2
        writeVarint(tag)
        writeVarint(UInt64(subMessage.count))
        data.append(subMessage)
    }

    mutating func writeBoolField(_ fieldNumber: Int, _ value: Bool) {
        writeInt32Field(fieldNumber, value ? 1 : 0)
    }
}

// MARK: - Service IDs

enum G2EvenHubServiceID: UInt8 {
    case g2Setting = 9       // 0x09
    case onboarding = 16     // 0x10
    case deviceSettings = 128 // 0x80
    case evenHub = 224       // 0xE0
}

// MARK: - EvenHub Command IDs

enum EvenHubCmd: Int32 {
    case createStartupPage = 0
    case updateImageRawData = 3
    case updateTextData = 5
    case rebuildPage = 7
    case shutdownPage = 9
    case heartbeat = 12
    case audioControl = 15
}

// MARK: - DevSettings Command IDs

enum DevCfgCommandId: Int32 {
    case authentication = 4
    case pipeRoleChange = 5
    case timeSync = 128
    case baseConnHeartBeat = 14
}

// MARK: - EvenHub Protobuf Message Builders

enum EvenHubProto {
    /// Build a TextContainerProperty message
    static func textContainerProperty(
        x: Int32, y: Int32, width: Int32, height: Int32,
        borderWidth: Int32 = 0, borderColor: Int32 = 0, borderRadius: Int32 = 0,
        paddingLength: Int32 = 0, containerID: Int32,
        containerName: String? = nil, isEventCapture: Bool = false,
        content: String? = nil
    ) -> Data {
        var w = ProtobufWriter()
        w.writeInt32Field(1, x)
        w.writeInt32Field(2, y)
        w.writeInt32Field(3, width)
        w.writeInt32Field(4, height)
        w.writeInt32Field(5, borderWidth)
        w.writeInt32Field(6, borderColor)
        w.writeInt32Field(7, borderRadius)
        w.writeInt32Field(8, paddingLength)
        w.writeInt32Field(9, containerID)
        if let name = containerName {
            w.writeStringField(10, name)
        }
        w.writeInt32Field(11, isEventCapture ? 1 : 0)
        if let content = content {
            w.writeStringField(12, content)
        }
        return w.data
    }

    /// Build an evenhub_main_msg_ctx wrapper (matches MentraOS: includes magicRandom field 2)
    static func evenHubMessage(cmd: EvenHubCmd, subFieldNumber: Int, subMessage: Data, magicRandom: Int32 = 0) -> Data {
        var w = ProtobufWriter()
        w.writeInt32Field(1, cmd.rawValue)
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(subFieldNumber, subMessage)
        return w.data
    }

    /// Build a CreateStartUpPageContainer message
    static func createStartupPageContainer(
        containerTotalNum: Int32,
        textContainers: [Data] = [],
        imageContainers: [Data] = []
    ) -> Data {
        var w = ProtobufWriter()
        w.writeInt32Field(1, containerTotalNum)
        for tc in textContainers {
            w.writeMessageField(3, tc)
        }
        for ic in imageContainers {
            w.writeMessageField(4, ic)
        }
        return w.data
    }

    /// Build a TextContainerUpgrade message
    static func textContainerUpgrade(
        containerID: Int32, contentOffset: Int32 = 0,
        contentLength: Int32, content: String
    ) -> Data {
        var w = ProtobufWriter()
        w.writeInt32Field(1, containerID)
        w.writeInt32Field(3, contentOffset)
        w.writeInt32Field(4, contentLength)
        w.writeStringField(5, content)
        return w.data
    }

    /// Build a ShutDownContainer message
    static func shutdownContainer(exitMode: Int32 = 0) -> Data {
        var w = ProtobufWriter()
        w.writeInt32Field(1, exitMode)
        return w.data
    }

    /// Build a HeartBeatPacket message
    static func heartbeatPacket(cnt: Int32 = 0) -> Data {
        var w = ProtobufWriter()
        if cnt != 0 {
            w.writeInt32Field(1, cnt)
        }
        return w.data
    }

    // MARK: Convenience builders for full messages

    static func createPageMessage(textContainers: [Data] = [], imageContainers: [Data] = [], magicRandom: Int32 = 0) -> Data {
        let total = Int32(textContainers.count + imageContainers.count)
        let createMsg = createStartupPageContainer(
            containerTotalNum: total,
            textContainers: textContainers,
            imageContainers: imageContainers
        )
        return evenHubMessage(cmd: .createStartupPage, subFieldNumber: 3, subMessage: createMsg, magicRandom: magicRandom)
    }

    static func rebuildPageMessage(textContainers: [Data] = [], imageContainers: [Data] = [], magicRandom: Int32 = 0) -> Data {
        let total = Int32(textContainers.count + imageContainers.count)
        let rebuildMsg = createStartupPageContainer(
            containerTotalNum: total,
            textContainers: textContainers,
            imageContainers: imageContainers
        )
        return evenHubMessage(cmd: .rebuildPage, subFieldNumber: 7, subMessage: rebuildMsg, magicRandom: magicRandom)
    }

    static func updateTextMessage(
        containerID: Int32, contentOffset: Int32 = 0, contentLength: Int32, content: String, magicRandom: Int32 = 0
    ) -> Data {
        let upgradeMsg = textContainerUpgrade(
            containerID: containerID, contentOffset: contentOffset,
            contentLength: contentLength, content: content
        )
        return evenHubMessage(cmd: .updateTextData, subFieldNumber: 9, subMessage: upgradeMsg, magicRandom: magicRandom)
    }

    static func shutdownMessage(exitMode: Int32 = 0, magicRandom: Int32 = 0) -> Data {
        let shutdownMsg = shutdownContainer(exitMode: exitMode)
        return evenHubMessage(cmd: .shutdownPage, subFieldNumber: 11, subMessage: shutdownMsg, magicRandom: magicRandom)
    }

    static func heartbeatMessage(magicRandom: Int32 = 0) -> Data {
        let hbMsg = heartbeatPacket()
        return evenHubMessage(cmd: .heartbeat, subFieldNumber: 14, subMessage: hbMsg, magicRandom: magicRandom)
    }
}

// MARK: - DevSettings Auth Protobuf Builders

enum DevSettingsProto {
    /// DevCfgDataPackage with AUTHENTICATION command
    static func authCmd(magicRandom: Int32) -> Data {
        var w = ProtobufWriter()
        w.writeInt32Field(1, DevCfgCommandId.authentication.rawValue)
        w.writeInt32Field(2, magicRandom)

        var authW = ProtobufWriter()
        authW.writeBoolField(1, true) // secAuth
        authW.writeInt32Field(2, 3) // phoneType = PHONE_IOS

        w.writeMessageField(3, authW.data)
        return w.data
    }

    /// DevCfgDataPackage with PIPE_ROLE_CHANGE command
    static func pipeRoleChange(magicRandom: Int32) -> Data {
        var w = ProtobufWriter()
        w.writeInt32Field(1, DevCfgCommandId.pipeRoleChange.rawValue)
        w.writeInt32Field(2, magicRandom)

        var roleW = ProtobufWriter()
        roleW.writeInt32Field(1, 1) // RIGHT
        w.writeMessageField(4, roleW.data)
        return w.data
    }

    /// DevCfgDataPackage with TIME_SYNC command
    static func timeSync(magicRandom: Int32) -> Data {
        var w = ProtobufWriter()
        w.writeInt32Field(1, DevCfgCommandId.timeSync.rawValue)
        w.writeInt32Field(2, magicRandom)

        var tsW = ProtobufWriter()
        let timestamp = Int32(Date().timeIntervalSince1970)
        tsW.writeInt32Field(1, timestamp)
        let tz = Int32(TimeZone.current.secondsFromGMT() / 3600)
        tsW.writeInt32Field(2, tz)
        w.writeMessageField(128, tsW.data)
        return w.data
    }

    /// DevCfgDataPackage with BASE_CONNECT_HEART_BEAT command
    static func baseHeartbeat(magicRandom: Int32) -> Data {
        var w = ProtobufWriter()
        w.writeInt32Field(1, DevCfgCommandId.baseConnHeartBeat.rawValue)
        w.writeInt32Field(2, magicRandom)

        let hbW = ProtobufWriter()
        _ = hbW // empty message
        w.writeMessageField(13, hbW.data)
        return w.data
    }
}

// MARK: - Onboarding Protobuf Builders

enum OnboardingProto {
    /// Skip onboarding
    static func skipOnboarding(magicRandom: Int32) -> Data {
        var configW = ProtobufWriter()
        configW.writeInt32Field(1, 4) // processId = FINISH

        var w = ProtobufWriter()
        w.writeInt32Field(1, 1) // commandId = CONFIG
        w.writeInt32Field(2, magicRandom)
        w.writeMessageField(3, configW.data)
        return w.data
    }
}

// MARK: - BLE Transport Layer

/// Builds and splits payloads into BLE packets with the EvenHub transport framing.
/// Packet structure:
///   [0xAA] [SrcDst] [SyncId] [PayloadLen] [TotalPkts] [SerialNum] [ServiceId] [Status] [Payload...] [CRC]
enum EvenBLETransport {
    static let HEADER_BYTE: UInt8 = 0xAA
    static let SOURCE_PHONE: UInt8 = 1
    static let DEST_GLASSES: UInt8 = 2
    static let MAX_PACKET_PAYLOAD: Int = 236

    static func buildPackets(
        syncId: UInt8, serviceId: UInt8, payload: Data, reserveFlag: Bool = false
    ) -> [Data] {
        let maxPayload = MAX_PACKET_PAYLOAD

        var chunks: [Data] = []
        var offset = 0
        while offset < payload.count {
            let end = min(offset + maxPayload, payload.count)
            chunks.append(payload[offset ..< end])
            offset = end
        }
        if chunks.isEmpty {
            chunks.append(Data())
        }

        let needExtraCrcPacket = (chunks.last!.count == maxPayload)
        if needExtraCrcPacket {
            chunks.append(Data())
        }

        let totalPackets = UInt8(chunks.count)
        let crc = G2EvenHubCRC.calc(payload)

        var packets: [Data] = []
        for (i, chunk) in chunks.enumerated() {
            let serialNum = UInt8(i + 1)
            let isLast = (serialNum == totalPackets)
            let status: UInt8 = (reserveFlag ? 0x20 : 0x00)
            let payloadLen = UInt8(chunk.count + (isLast ? 2 : 0))

            var packet = Data()
            packet.append(HEADER_BYTE)                                   // [0]
            packet.append((DEST_GLASSES << 4) | SOURCE_PHONE)           // [1]
            packet.append(syncId)                                        // [2]
            packet.append(payloadLen)                                    // [3]
            packet.append(totalPackets)                                  // [4]
            packet.append(serialNum)                                     // [5]
            packet.append(serviceId)                                     // [6]
            packet.append(status)                                        // [7]
            packet.append(chunk)

            if isLast {
                packet.append(UInt8(crc & 0xFF))
                packet.append(UInt8((crc >> 8) & 0xFF))
            }

            packets.append(packet)
        }

        return packets
    }
}

// MARK: - G2EvenHubSendManager

/// Manages syncId and magicRandom counters and builds BLE packets
final class G2EvenHubSendManager {
    private var syncId: UInt8 = 0
    private var magicRandom: UInt8 = 0

    func nextSyncId() -> UInt8 {
        let id = syncId
        syncId = syncId &+ 1
        return id
    }

    func nextMagicRandom() -> Int32 {
        let val = magicRandom
        magicRandom = magicRandom &+ 1
        return Int32(val)
    }

    func buildPackets(serviceId: UInt8, payload: Data, reserveFlag: Bool = false) -> [Data] {
        let sid = nextSyncId()
        return EvenBLETransport.buildPackets(
            syncId: sid, serviceId: serviceId, payload: payload, reserveFlag: reserveFlag
        )
    }
}
