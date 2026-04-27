/*
 * EvenRealitiesManager.swift
 *
 * Central BLE manager for Even Realities smart glasses (G1 and G2).
 * Handles scanning, connection lifecycle, display content dispatch,
 * and microphone audio capture bridging.
 *
 * G1: Nordic UART Service, binary UART commands
 * G2: EvenHub app protocol (0xE0 service, protobuf) — primary path
 *     Teleprompter protocol (0x06-20 service) — fallback
 *
 * Display flow:
 *   Server -> display_frame JSON -> DisplayBridgeStage -> EvenRealitiesManager -> BLE
 *
 * Audio flow:
 *   Glasses BLE mic -> EvenRealitiesAudioSource -> AudioEventBus (codecType=1)
 */

import CoreBluetooth
import Foundation

// MARK: - Connection State

enum EvenRealitiesConnectionState {
    case disconnected
    case scanning
    case connecting
    case connected(model: String) // "even-g1" or "even-g2"
}

// MARK: - Even Realities Device

private struct EvenDevice {
    let peripheral: CBPeripheral
    let model: String // "even-g1" or "even-g2"
    let side: String  // "left" or "right"
    var writeCharacteristic: CBCharacteristic?
    var notifyCharacteristic: CBCharacteristic?
}

// MARK: - EvenRealitiesManager

actor EvenRealitiesManager: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate, Sendable {
    nonisolated let stageId = "even-realities-manager"

    // BLE
    private var centralManager: CBCentralManager!
    private var devices: [String: EvenDevice] = [:] // key: peripheral.identifier.uuidString

    // State
    private(set) var connectionState: EvenRealitiesConnectionState = .disconnected
    private(set) var connectedModel: String? = nil
    private var scanRequested = false // true if startScanning() was called before BLE powered on

    // Sequence counters (G1 teleprompter)
    private var commandSequence: UInt8 = 0
    private var heartbeatSequence: UInt8 = 0

    // Heartbeat tasks
    private var heartbeatTask: Task<Void, Never>?      // G1: 28s interval
    private var evenHubHeartbeatTask: Task<Void, Never>? // G2 EvenHub: 5s interval
    private var devSettingsHeartbeatTask: Task<Void, Never>? // G2 DevSettings: 5s interval

    // EvenHub protocol state (G2 primary path)
    private let evenHubSendManager = G2EvenHubSendManager()
    private var evenHubAuthDone = false
    private var startupPageCreated = false
    private var pageCreated = false
    private var pageHasTextContainer = false
    private var currentTextContent = ""
    private var textContainerID: Int32 = 1
    private var evenHubHeartbeatCounter = 0
    private var pendingDisplayLines: [String]? = nil // queued until auth completes
    private var notifyRxCount = 0
    private var writeFailCount = 0
    private var notifySubCount = 0
    private var lastResponseInfo = ""

    // BLE log for UI debugging
    private var bleLog: [String] = []
    private let maxLogEntries = 200

    private func log(_ msg: String) {
        NSLog("[EvenRealities] \(msg)")
        bleLog.append(msg)
        if bleLog.count > maxLogEntries { bleLog.removeFirst() }
    }

    func getBLELog() -> [String] { bleLog }

    // Audio callback — delivers raw PCM to EvenRealitiesAudioSource
    private var onAudioData: (@Sendable (Data) -> Void)?

    // Display callback — reports state changes
    private var onConnectionStateChanged: (@Sendable (EvenRealitiesConnectionState) -> Void)?

    // MARK: - Init

    override init() {
        super.init()
        self.centralManager = CBCentralManager(delegate: self, queue: nil)
        NSLog("[EvenRealities] Manager init — BLE state: \(centralManager.state.rawValue)")
    }

    // MARK: - Public API

    func setOnAudioData(_ handler: @Sendable @escaping (Data) -> Void) {
        self.onAudioData = handler
    }

    func setOnConnectionStateChanged(_ handler: @Sendable @escaping (EvenRealitiesConnectionState) -> Void) {
        self.onConnectionStateChanged = handler
    }

    /// Start scanning for Even Realities devices
    func startScanning() {
        // Skip if already connected (avoids disrupting auth when wireEvenRealities re-calls this)
        if case .connected = connectionState {
            NSLog("[EvenRealities] Already connected — skipping scan")
            return
        }
        // Skip if devices are already connecting
        if !devices.isEmpty {
            NSLog("[EvenRealities] Already have \(devices.count) device(s) — skipping scan")
            return
        }

        guard centralManager.state == .poweredOn else {
            NSLog("[EvenRealities] BLE not powered on yet (state=\(centralManager.state.rawValue)), will scan when ready")
            scanRequested = true
            connectionState = .scanning
            notifyStateChanged()
            return
        }
        scanRequested = false
        connectionState = .scanning
        notifyStateChanged()

        // Step 1: Check for already-connected peripherals (like MentraOS does)
        let serviceUUIDs = [
            G2UUID.service,
            CBUUID(string: "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"), // Nordic UART
        ]
        for svc in serviceUUIDs {
            let connected = centralManager.retrieveConnectedPeripherals(withServices: [svc])
            for peripheral in connected {
                let name = peripheral.name ?? ""
                let isG2 = name.hasPrefix("Even G2") || name.contains("G2")
                let isG1 = name.hasPrefix("Even G1")
                guard isG2 || isG1 else { continue }
                let key = peripheral.identifier.uuidString
                guard devices[key] == nil else { continue }

                let model = isG2 ? "even-g2" : "even-g1"
                let side: String
                if isG2 {
                    if name.contains("_L_") { side = "left" }
                    else if name.contains("_R_") { side = "right" }
                    else { side = devices.isEmpty ? "right" : "left" }
                } else {
                    side = name.lowercased().contains("left") ? "left" : "right"
                }

                NSLog("[EvenRealities] retrieveConnectedPeripherals found: \(name) side=\(side)")
                peripheral.delegate = self
                devices[key] = EvenDevice(peripheral: peripheral, model: model, side: side)
                centralManager.connect(peripheral)
            }
        }

        // Step 2: Also scan for new peripherals
        centralManager.scanForPeripherals(
            withServices: nil,
            options: [CBCentralManagerScanOptionAllowDuplicatesKey: true]
        )
        NSLog("[EvenRealities] Scanning for Even Realities (found \(devices.count) via retrieve)...")
    }

    /// Stop scanning and disconnect
    func stop() {
        centralManager.stopScan()
        for (_, device) in devices {
            centralManager.cancelPeripheralConnection(device.peripheral)
        }
        devices.removeAll()
        heartbeatTask?.cancel()
        heartbeatTask = nil
        evenHubHeartbeatTask?.cancel()
        evenHubHeartbeatTask = nil
        devSettingsHeartbeatTask?.cancel()
        devSettingsHeartbeatTask = nil
        resetEvenHubState()
        connectionState = .disconnected
        connectedModel = nil
        notifyStateChanged()
    }

    /// Send text lines to the connected glasses display.
    /// G1: single packet. G2 EvenHub: protobuf page/text. G2 fallback: teleprompter sequence.
    func sendDisplayContent(lines: [String]) {
        NSLog("[EvenRealities] sendDisplayContent called: devices=\(devices.count) model=\(connectedModel ?? "nil") lines=\(lines)")

        guard !devices.isEmpty else {
            NSLog("[EvenRealities] ERROR: no BLE devices connected — display_frame dropped")
            return
        }

        if connectedModel == "even-g1" {
            let seq = nextCommandSequence()
            for (_, device) in devices {
                guard let writeChar = device.writeCharacteristic else { continue }
                let payload = G1Protocol.buildSendText(lines: lines, sequence: seq)
                device.peripheral.writeValue(payload, for: writeChar, type: .withResponse)
            }
        } else if evenHubAuthDone {
            // G2 EvenHub protocol (0xE0 service) — primary path
            sendG2EvenHubText(lines: lines)
        } else if connectedModel == "even-g2" {
            // G2 connected but auth not done yet — queue for after auth
            NSLog("[EvenRealities] G2 EvenHub: Queuing display (auth not done, devices=\(devices.count))")
            pendingDisplayLines = lines

            // Safety: if auth should have started but didn't, trigger it now
            let hasWriteChar = devices.values.contains { $0.writeCharacteristic != nil }
            if hasWriteChar && !evenHubAuthDone {
                NSLog("[EvenRealities] G2 EvenHub: Safety-triggering auth sequence from sendDisplayContent")
                runEvenHubAuthSequence()
            }
        } else {
            // No devices connected yet — queue for after connect + auth
            NSLog("[EvenRealities] G2 EvenHub: Queuing display (no devices yet)")
            pendingDisplayLines = lines
        }
    }

    /// Send the full G2 teleprompter protocol sequence with inter-packet delays.
    private func sendG2DisplaySequence(lines: [String]) {
        let packets = G2Protocol.buildFullDisplaySequence(lines: lines)
        NSLog("[EvenRealities] G2 display sequence: \(packets.count) packets for \(lines.joined(separator: " | "))")

        Task {
            for (index, packet) in packets.enumerated() {
                for (_, device) in self.devices {
                    guard let writeChar = device.writeCharacteristic else { continue }
                    device.peripheral.writeValue(packet, for: writeChar, type: .withoutResponse)
                }

                // Inter-packet delays matching Python reference timing
                if index < 7 {
                    // Auth packets: 100ms between each
                    try? await Task.sleep(nanoseconds: 100_000_000)
                } else if index == 7 {
                    // After auth: 500ms pause
                    try? await Task.sleep(nanoseconds: 500_000_000)
                } else if index == 8 {
                    // After display config: 300ms
                    try? await Task.sleep(nanoseconds: 300_000_000)
                } else if index == 9 {
                    // After teleprompter init: 500ms
                    try? await Task.sleep(nanoseconds: 500_000_000)
                } else {
                    // Content pages: 100ms
                    try? await Task.sleep(nanoseconds: 100_000_000)
                }
            }
            NSLog("[EvenRealities] G2 display sequence complete")
        }
    }

    /// Clear the glasses display.
    func clearDisplay() {
        let seq = nextCommandSequence()
        for (_, device) in devices {
            guard let writeChar = device.writeCharacteristic else { continue }
            if connectedModel == "even-g1" {
                let payload = G1Protocol.buildClearScreen(sequence: seq)
                device.peripheral.writeValue(payload, for: writeChar, type: .withResponse)
            }
        }

        // G2 EvenHub: clear by sending a space
        if connectedModel == "even-g2" && pageCreated {
            sendG2EvenHubText(lines: [" "])
        }
    }

    /// Enable microphone on connected glasses.
    /// Both G1 and G2 use the same NUS command 0x0E sent to the right arm only.
    /// G2 audio arrives on UUID 6402 (the display notify characteristic).
    func enableMicrophone() {
        let seq = nextCommandSequence()
        for (_, device) in devices where device.side == "right" {
            guard let writeChar = device.writeCharacteristic else { continue }
            // G1 and G2 both use the raw NUS 0x0E command for mic control
            let payload = G1Protocol.buildMicEnable(sequence: seq)
            device.peripheral.writeValue(payload, for: writeChar, type: .withResponse)
            NSLog("[EvenRealities] Mic enabled on right arm (\(connectedModel ?? "unknown"))")
        }
    }

    /// Disable microphone on connected glasses
    func disableMicrophone() {
        guard connectedModel == "even-g1" else { return }
        let seq = nextCommandSequence()
        for (_, device) in devices where device.side == "right" {
            guard let writeChar = device.writeCharacteristic else { continue }
            let payload = G1Protocol.buildMicDisable(sequence: seq)
            device.peripheral.writeValue(payload, for: writeChar, type: .withResponse)
        }
    }

    // MARK: - CBCentralManagerDelegate

    nonisolated func centralManagerDidUpdateState(_ central: CBCentralManager) {
        Task { await self.handleBLEStateChange(central.state) }
    }

    private func handleBLEStateChange(_ state: CBManagerState) {
        if state == .poweredOn {
            NSLog("[EvenRealities] BLE powered on — ready to scan")
            if scanRequested {
                NSLog("[EvenRealities] Triggering deferred scan")
                scanRequested = false
                startScanning()
            }
        } else {
            NSLog("[EvenRealities] BLE state changed: \(state.rawValue)")
            connectionState = .disconnected
            notifyStateChanged()
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        Task {
            await self.handleDiscoveredPeripheral(peripheral, advertisementData: advertisementData, rssi: RSSI)
        }
    }

    private func handleDiscoveredPeripheral(_ peripheral: CBPeripheral, advertisementData: [String: Any], rssi: NSNumber) {
        let name = peripheral.name ?? ""

        // Only log/consider Even Realities devices (filter by name prefix or known service UUIDs)
        let isG2 = name.hasPrefix("Even G2")
                  || name.contains("G2")
                  || advertisementData.contains(where: { $0.key == "kCBAdvDataServiceUUIDs" && (($0.value as? [CBUUID])?.contains(G2UUID.service) ?? false) })
        let isG1 = name.hasPrefix("Even G1")
                  || advertisementData.contains(where: { $0.key == "kCBAdvDataServiceUUIDs" && (($0.value as? [CBUUID])?.contains(G1UUID.service) ?? false) })

        guard isG2 || isG1 else { return }

        let key = peripheral.identifier.uuidString

        // Skip if already connected/connecting this peripheral
        guard devices[key] == nil else { return }

        NSLog("[EvenRealities] Matched peripheral: name='\(name)' UUID=\(key) RSSI=\(rssi) services=\(advertisementData["kCBAdvDataServiceUUIDs"] ?? "none")")

        let model: String
        let side: String

        if isG2 {
            model = "even-g2"
            // Detect side from name: "Even G2_XX_L_XXXXXX" or "Even G2_XX_R_XXXXXX"
            if name.contains("_L_") {
                side = "left"
            } else if name.contains("_R_") {
                side = "right"
            } else {
                // No side info in name — use UUID uniqueness, label first as "right" (primary)
                side = devices.isEmpty ? "right" : "left"
            }
        } else {
            model = "even-g1"
            side = name.lowercased().contains("left") ? "left" : "right"
        }

        NSLog("[EvenRealities] Found \(model) arm: \(name) side=\(side) RSSI=\(rssi)")

        // For G2: connect up to 2 peripherals (left + right arms)
        // For G1: connect single arm
        if model == "even-g2" && devices.count >= 2 {
            NSLog("[EvenRealities] Already have 2 G2 arms — stopping scan")
            centralManager.stopScan()
            return
        }

        peripheral.delegate = self
        let device = EvenDevice(peripheral: peripheral, model: model, side: side)
        devices[key] = device
        connectionState = .connecting
        notifyStateChanged()
        centralManager.connect(peripheral)

        // For G1: stop scanning after first device
        // For G2: keep scanning for second arm
        if model == "even-g1" {
            centralManager.stopScan()
        }
        // G2 keeps scanning to find second arm
    }

    nonisolated func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        Task { await self.handleConnected(peripheral) }
    }

    private func handleConnected(_ peripheral: CBPeripheral) {
        NSLog("[EvenRealities] Connected to \(peripheral.name ?? "unknown")")
        peripheral.discoverServices(nil)
    }

    nonisolated func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        Task { await self.handleDisconnected(peripheral, error: error) }
    }

    private func handleDisconnected(_ peripheral: CBPeripheral, error: Error?) {
        NSLog("[EvenRealities] Disconnected from \(peripheral.name ?? "unknown"): \(error?.localizedDescription ?? "clean")")
        devices.removeValue(forKey: peripheral.identifier.uuidString)
        heartbeatTask?.cancel()
        heartbeatTask = nil
        evenHubHeartbeatTask?.cancel()
        evenHubHeartbeatTask = nil
        devSettingsHeartbeatTask?.cancel()
        devSettingsHeartbeatTask = nil
        resetEvenHubState()

        if devices.isEmpty {
            connectionState = .disconnected
            connectedModel = nil
            notifyStateChanged()
        }
    }

    // MARK: - CBPeripheralDelegate

    nonisolated func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        Task { await self.handleServicesDiscovered(peripheral, error: error) }
    }

    private func handleServicesDiscovered(_ peripheral: CBPeripheral, error: Error?) {
        guard let services = peripheral.services else { return }

        for service in services {
            NSLog("[EvenRealities] Discovered service: \(service.uuid.uuidString)")
            peripheral.discoverCharacteristics(nil, for: service)
        }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        Task { await self.handleCharacteristicsDiscovered(peripheral, service: service, error: error) }
    }

    private func handleCharacteristicsDiscovered(_ peripheral: CBPeripheral, service: CBService, error: Error?) {
        guard let characteristics = service.characteristics else { return }
        let key = peripheral.identifier.uuidString

        for char in characteristics {
            let props = char.properties
            NSLog("[EvenRealities] Char: \(char.uuid.uuidString) props: write=\(props.contains(.write)) notify=\(props.contains(.notify)) indicate=\(props.contains(.indicate))")

            // G1: NUS RX (write) and TX (notify)
            if char.uuid == G1UUID.rx && (props.contains(.write) || props.contains(.writeWithoutResponse)) {
                devices[key]?.writeCharacteristic = char
                NSLog("[EvenRealities] Found G1 write characteristic")
            }
            if char.uuid == G1UUID.tx && (props.contains(.notify) || props.contains(.indicate)) {
                devices[key]?.notifyCharacteristic = char
                peripheral.setNotifyValue(true, for: char)
                NSLog("[EvenRealities] Subscribed to G1 notify/indicate")
            }

            // G2: Even custom write and notify/indicate
            if char.uuid == G2UUID.write && (props.contains(.write) || props.contains(.writeWithoutResponse)) {
                devices[key]?.writeCharacteristic = char
                NSLog("[EvenRealities] Found G2 write characteristic")
            }
            if char.uuid == G2UUID.notify && (props.contains(.notify) || props.contains(.indicate)) {
                devices[key]?.notifyCharacteristic = char
                peripheral.setNotifyValue(true, for: char)
                NSLog("[EvenRealities] Subscribed to G2 notify/indicate")
            }
        }

        // Check if we have all required characteristics
        checkConnectionReady()
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard let data = characteristic.value else { return }
        Task { await self.handleCharacteristicUpdate(characteristic, data: data) }
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        if let error = error {
            Task { await self.handleWriteError(peripheral, characteristic: characteristic, error: error) }
        }
    }

    private func handleWriteError(_ peripheral: CBPeripheral, characteristic: CBCharacteristic, error: Error) {
        writeFailCount += 1
        NSLog("[EvenRealities] WRITE ERROR #\(writeFailCount) on \(peripheral.name ?? "unknown") char=\(characteristic.uuid.uuidString): \(error.localizedDescription)")
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        let name = peripheral.name ?? "unknown"
        if let error = error {
            NSLog("[EvenRealities] NOTIFY SUB FAIL on \(name) char=\(characteristic.uuid.uuidString): \(error.localizedDescription)")
        } else {
            NSLog("[EvenRealities] NOTIFY SUB OK on \(name) char=\(characteristic.uuid.uuidString) isNotifying=\(characteristic.isNotifying)")
            Task { await self.incrementNotifySub() }
        }
    }

    private func incrementNotifySub() {
        notifySubCount += 1
    }

    private func handleCharacteristicUpdate(_ characteristic: CBCharacteristic, data: Data) {
        // G1: Check for audio data (0xF1)
        if characteristic.uuid == G1UUID.tx {
            if let audioInfo = G1Protocol.parseAudioData(data) {
                // Deliver raw audio payload to audio source callback
                onAudioData?(audioInfo.audioPayload)
                return
            }
            // Check for state changes (0xF5)
            if let event = G1Protocol.parseStateChange(data) {
                NSLog("[EvenRealities] G1 state event: \(event)")
                return
            }
        }

        // G2: Parse response — log hex dump and parse EvenHub error codes
        if characteristic.uuid == G2UUID.notify {
            notifyRxCount += 1

            // Show raw header info in banner
            if data.count >= 8 && data[0] == 0xAA {
                let dir = data[1]
                let total = data[4]
                let serial = data[5]
                let svc = data[6]
                let status = data[7]
                lastResponseInfo = "s:\(String(format: "%02x", svc)) t:\(total)/\(serial)"
                let hex = data.prefix(20).map { String(format: "%02x", $0) }.joined(separator: " ")
                log("RX #\(notifyRxCount) svc=\(String(format: "%02x", svc)) \(hex)")

                // Parse EvenHub response if single packet and service = 0xE0
                if dir == 0x12 && total == 1 && svc == 0xE0 && data.count > 10 {
                    let payloadStart = 8
                    let payloadEnd = data.count - 2
                    if payloadEnd > payloadStart {
                        parseEvenHubResponse(Data(data[payloadStart..<payloadEnd]))
                    }
                }
            }
        }
    }

    // MARK: - EvenHub Protocol Methods (G2 Primary Path)

    /// Reset EvenHub protocol state
    private func resetEvenHubState() {
        evenHubAuthDone = false
        authSequenceRunning = false
        startupPageCreated = false
        pageCreated = false
        pageHasTextContainer = false
        currentTextContent = ""
        evenHubHeartbeatCounter = 0
        pendingDisplayLines = nil
    }

    /// Send raw BLE packets to all connected G2 devices (both arms)
    private func sendPacketsToGlasses(_ packets: [Data]) {
        let targets = devices.values.filter { $0.writeCharacteristic != nil }
        let msg = "TX → ALL: \(packets.count) pkts to \(targets.count) device(s)"
        NSLog("[EvenRealities] \(msg)")
        log(msg)
        for packet in packets {
            let hex = packet.prefix(min(packet.count, 40)).map { String(format: "%02x", $0) }.joined(separator: " ")
            let entry = "TX[ALL]: \(hex)\(packet.count > 40 ? " ..." : "")"
            NSLog("[EvenRealities]   \(entry)")
            log(entry)
            for device in targets {
                device.peripheral.writeValue(packet, for: device.writeCharacteristic!, type: .withoutResponse)
            }
        }
    }

    /// Send raw BLE packets to RIGHT arm only (EvenHub display commands)
    /// Falls back to any available arm if no right arm is connected.
    private func sendPacketsToRightArm(_ packets: [Data]) {
        sendPacketsToArm(packets, side: "right")
    }

    /// Send raw BLE packets to LEFT arm only
    private func sendPacketsToLeftArm(_ packets: [Data]) {
        sendPacketsToArm(packets, side: "left")
    }

    /// Send raw BLE packets to a specific arm by side ("left" or "right")
    private func sendPacketsToArm(_ packets: [Data], side: String) {
        let targets = devices.values.filter { $0.side == side && $0.writeCharacteristic != nil }
        let actual = targets.isEmpty ? devices.values.filter { $0.writeCharacteristic != nil } : targets
        let msg = "TX → \(side.uppercased()): \(packets.count) pkts, \(actual.count) device(s) (exact: \(targets.count))"
        NSLog("[EvenRealities] \(msg)")
        log(msg)

        for packet in packets {
            let hex = packet.prefix(min(packet.count, 40)).map { String(format: "%02x", $0) }.joined(separator: " ")
            let entry = "TX[\(side)]: \(hex)\(packet.count > 40 ? " ..." : "")"
            NSLog("[EvenRealities]   \(entry)")
            log(entry)
            for device in actual {
                device.peripheral.writeValue(packet, for: device.writeCharacteristic!, type: .withoutResponse)
            }
        }
    }

    /// Send an EvenHub command (service 0xE0) — RIGHT arm only (per MentraOS protocol)
    private func sendEvenHubCommand(_ payload: Data) {
        let packets = evenHubSendManager.buildPackets(
            serviceId: G2EvenHubServiceID.evenHub.rawValue,
            payload: payload,
            reserveFlag: true
        )
        sendPacketsToRightArm(packets)
    }

    /// Send a DevSettings command (service 0x80) — BOTH arms (auth goes to both)
    private func sendDevSettingsCommand(_ payload: Data) {
        let packets = evenHubSendManager.buildPackets(
            serviceId: G2EvenHubServiceID.deviceSettings.rawValue,
            payload: payload
        )
        sendPacketsToGlasses(packets)
    }

    /// Send an Onboarding command (service 0x10) — RIGHT arm only
    private func sendOnboardingCommand(_ payload: Data) {
        let packets = evenHubSendManager.buildPackets(
            serviceId: G2EvenHubServiceID.onboarding.rawValue,
            payload: payload,
            reserveFlag: true
        )
        sendPacketsToRightArm(packets)
    }

    /// Run the EvenHub auth sequence matching MentraOS G2.swift exactly:
    ///   1. Auth to LEFT arm
    ///   2. Auth to RIGHT arm
    ///   3. pipeRoleChange to RIGHT arm
    ///   4. timeSync to RIGHT arm
    ///   5. skipOnboarding to RIGHT arm
    /// Guard: only runs once (tracked by evenHubAuthDone)
    private var authSequenceRunning = false

    private func runEvenHubAuthSequence() {
        guard !authSequenceRunning && !evenHubAuthDone else {
            NSLog("[EvenRealities] G2 EvenHub: Auth sequence already running/done — skipping")
            return
        }
        authSequenceRunning = true
        let armCount = devices.count
        let sides = devices.values.map(\.side).sorted().joined(separator: "+")
        log("AUTH START: \(armCount) arms [\(sides)]")

        Task {
            // 1. Authentication to LEFT arm (matches MentraOS: auth LEFT first)
            log("AUTH 1/5: LEFT")
            let authLeftPayload = DevSettingsProto.authCmd(magicRandom: evenHubSendManager.nextMagicRandom())
            let authLeftPackets = evenHubSendManager.buildPackets(
                serviceId: G2EvenHubServiceID.deviceSettings.rawValue, payload: authLeftPayload)
            sendPacketsToLeftArm(authLeftPackets)
            try? await Task.sleep(nanoseconds: 200_000_000) // 200ms

            // 2. Authentication to RIGHT arm (matches MentraOS: then auth RIGHT)
            log("AUTH 2/5: RIGHT")
            let authRightPayload = DevSettingsProto.authCmd(magicRandom: evenHubSendManager.nextMagicRandom())
            let authRightPackets = evenHubSendManager.buildPackets(
                serviceId: G2EvenHubServiceID.deviceSettings.rawValue, payload: authRightPayload)
            sendPacketsToRightArm(authRightPackets)
            try? await Task.sleep(nanoseconds: 200_000_000)

            // 3. Pipe role change to RIGHT arm only (matches MentraOS)
            log("AUTH 3/5: PIPE")
            let rolePayload = DevSettingsProto.pipeRoleChange(magicRandom: evenHubSendManager.nextMagicRandom())
            let rolePackets = evenHubSendManager.buildPackets(
                serviceId: G2EvenHubServiceID.deviceSettings.rawValue, payload: rolePayload)
            sendPacketsToRightArm(rolePackets)
            try? await Task.sleep(nanoseconds: 200_000_000)

            // 4. Time sync to RIGHT arm only (matches MentraOS)
            log("AUTH 4/5: TIMESYNC")
            let timeSyncPayload = DevSettingsProto.timeSync(magicRandom: evenHubSendManager.nextMagicRandom())
            let tsPackets = evenHubSendManager.buildPackets(
                serviceId: G2EvenHubServiceID.deviceSettings.rawValue, payload: timeSyncPayload)
            sendPacketsToRightArm(tsPackets)
            try? await Task.sleep(nanoseconds: 200_000_000)

            // 5. Skip onboarding to RIGHT arm only (matches MentraOS)
            log("AUTH 5/5: ONBOARD")
            let onboardingPayload = OnboardingProto.skipOnboarding(magicRandom: evenHubSendManager.nextMagicRandom())
            sendOnboardingCommand(onboardingPayload)
            NSLog("[EvenRealities] G2 EvenHub: Sent onboarding skip")

            // Start heartbeats
            startEvenHubHeartbeats()

            // Mark auth complete after 500ms settle time
            try? await Task.sleep(nanoseconds: 500_000_000)
            evenHubAuthDone = true
            self.authSequenceRunning = false
            log("AUTH DONE")

            // Flush any display content that was queued during auth
            if let pending = self.pendingDisplayLines {
                self.pendingDisplayLines = nil
                log("Sending queued display: '\(pending.joined(separator: "|"))'")
                self.sendG2EvenHubText(lines: pending)
            } else {
                // Send test message to verify display works
                log("Sending test display message → RIGHT arm")
                self.sendG2EvenHubText(lines: ["hello ebowwa"])
            }
        }
    }

    /// Start EvenHub + DevSettings heartbeat timers (5s each)
    private func startEvenHubHeartbeats() {
        // EvenHub heartbeat every 5s
        evenHubHeartbeatTask?.cancel()
        evenHubHeartbeatTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                guard !Task.isCancelled else { return }
                let mr = self.evenHubSendManager.nextMagicRandom()
                let msg = EvenHubProto.heartbeatMessage(magicRandom: mr)
                self.sendEvenHubCommand(msg)
                self.evenHubHeartbeatCounter += 1
            }
        }

        // DevSettings heartbeat every 5s
        devSettingsHeartbeatTask?.cancel()
        devSettingsHeartbeatTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                guard !Task.isCancelled else { return }
                let msg = DevSettingsProto.baseHeartbeat(magicRandom: self.evenHubSendManager.nextMagicRandom())
                self.sendDevSettingsCommand(msg)
            }
        }
    }

    /// Send text to G2 via EvenHub protocol
    private func sendG2EvenHubText(lines: [String]) {
        let text = lines.joined(separator: "\n")

        if text.isEmpty {
            // Clear display by sending a space
            if pageCreated && pageHasTextContainer {
                let mr = evenHubSendManager.nextMagicRandom()
                let msg = EvenHubProto.updateTextMessage(
                    containerID: textContainerID,
                    contentLength: 1,
                    content: " ",
                    magicRandom: mr
                )
                sendEvenHubCommand(msg)
            }
            return
        }

        if !pageCreated || !pageHasTextContainer {
            // Create or rebuild page with text container (matching EvenHub SDK exactly)
            let tc = EvenHubProto.textContainerProperty(
                x: 0, y: 0, width: 576, height: 288,
                borderWidth: 0, borderColor: 5, borderRadius: 0,
                paddingLength: 4, containerID: textContainerID,
                containerName: "main", isEventCapture: true,
                content: text
            )

            let mr = evenHubSendManager.nextMagicRandom()
            let msg: Data
            if !startupPageCreated {
                log("SEND: create page '\(text)' mr=\(mr)")
                msg = EvenHubProto.createPageMessage(textContainers: [tc], magicRandom: mr)
                startupPageCreated = true
            } else {
                log("REBUILD: page with '\(text)' mr=\(mr)")
                msg = EvenHubProto.rebuildPageMessage(textContainers: [tc], magicRandom: mr)
            }
            sendEvenHubCommand(msg)
            pageCreated = true
            pageHasTextContainer = true
            currentTextContent = text
        } else {
            // Update existing text container
            if text == currentTextContent { return } // no change
            let mr = evenHubSendManager.nextMagicRandom()
            let msg = EvenHubProto.updateTextMessage(
                containerID: textContainerID,
                contentOffset: 0,
                contentLength: Int32(text.utf8.count),
                content: text,
                magicRandom: mr
            )
            sendEvenHubCommand(msg)
            currentTextContent = text
        }
    }

    // MARK: - Private Helpers

    private func checkConnectionReady() {
        // Check if all connected devices have their characteristics
        let allReady = devices.values.allSatisfy { $0.writeCharacteristic != nil }
        if !allReady || devices.isEmpty { return }

        let model = devices.values.first?.model ?? "unknown"
        connectedModel = model
        connectionState = .connected(model: model)
        notifyStateChanged()

        NSLog("[EvenRealities] Connection ready: \(model), \(devices.count) arm(s)")
        for (_, d) in devices {
            NSLog("[EvenRealities]   - \(d.side): write=\(d.writeCharacteristic != nil) notify=\(d.notifyCharacteristic != nil)")
        }

        if model == "even-g1" {
            startHeartbeat()
        } else if model == "even-g2" {
            // MentraOS requires BOTH arms initialized before auth
            // If only 1 arm, wait up to 5s for second arm before proceeding
            if devices.count < 2 {
                NSLog("[EvenRealities] G2: Only \(devices.count) arm(s) — waiting up to 5s for second arm")
                // Keep scanning during wait — don't stop scan yet
                Task {
                    try? await Task.sleep(nanoseconds: 5_000_000_000) // 5s wait for second arm
                    self.centralManager.stopScan()
                    if !self.evenHubAuthDone && !self.authSequenceRunning {
                        NSLog("[EvenRealities] G2: Proceeding with \(self.devices.count) arm(s) after wait")
                        self.runEvenHubAuthSequence()
                    }
                }
                return
            }
            // Both arms ready
            centralManager.stopScan()
            NSLog("[EvenRealities] G2 ready — both arms connected, starting EvenHub auth sequence")
            runEvenHubAuthSequence()
        }
    }

    private func startHeartbeat() {
        heartbeatTask?.cancel()
        heartbeatTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 28_000_000_000) // 28 seconds
                guard !Task.isCancelled else { return }
                let seq = nextHeartbeatSequence()
                for (_, device) in devices {
                    guard let writeChar = device.writeCharacteristic else { continue }
                    let payload = G1Protocol.buildHeartbeat(sequence: seq)
                    device.peripheral.writeValue(payload, for: writeChar, type: .withResponse)
                }
            }
        }
    }

    private func nextCommandSequence() -> UInt8 {
        defer { commandSequence = (commandSequence + 1) & 0xFF }
        return commandSequence
    }

    private func nextHeartbeatSequence() -> UInt8 {
        defer { heartbeatSequence = (heartbeatSequence + 1) & 0xFF }
        return heartbeatSequence
    }

    private func notifyStateChanged() {
        onConnectionStateChanged?(connectionState)
    }

    /// Returns display_viewer info for the hello message, or nil if no device connected.
    func displayViewerInfo() -> (model: String, protocol: String)? {
        guard let model = connectedModel else { return nil }
        let proto: String
        if model == "even-g1" {
            proto = "uart"
        } else if evenHubAuthDone {
            proto = "evenhub"
        } else {
            proto = "protobuf" // teleprompter fallback
        }
        return (model, proto)
    }

    /// Debug info string for UI display
    func debugInfo() -> String {
        let a = evenHubAuthDone ? "A" : "a"
        let p = pageCreated ? "P" : "p"
        return "\(a)\(p) rx:\(notifyRxCount) \(lastResponseInfo)"
    }

    // MARK: - BLE Log for UI

    /// Parse simple protobuf varint from data at offset
    private func readVarint(_ data: Data, offset: Int) -> (value: UInt64, newOffset: Int)? {
        var result: UInt64 = 0
        var shift = 0
        var idx = offset
        while idx < data.count {
            let byte = data[idx]
            idx += 1
            result |= UInt64(byte & 0x7F) << shift
            if byte & 0x80 == 0 { return (result, idx) }
            shift += 7
            if shift >= 64 { return nil }
        }
        return nil
    }

    /// Parse EvenHub response for error codes
    private func parseEvenHubResponse(_ payload: Data) {
        var offset = 0
        while offset < payload.count {
            guard let (tag, newOff) = readVarint(payload, offset: offset) else { break }
            offset = newOff
            let fieldNumber = Int(tag >> 3)
            let wireType = Int(tag & 0x7)

            // Field 1 = cmd (varint)
            if fieldNumber == 1 && wireType == 0 {
                guard let (cmd, off2) = readVarint(payload, offset: offset) else { break }
                offset = off2
                let cmdName: String
                switch cmd {
                case 0: cmdName = "createPage"
                case 1: cmdName = "pageResult"
                case 5: cmdName = "textResult"
                case 7: cmdName = "rebuildResult"
                case 9: cmdName = "shutdown"
                case 12: cmdName = "heartbeat"
                default: cmdName = "cmd\(cmd)"
                }
                NSLog("[EvenRealities] EvenHub cmd: \(cmdName) (\(cmd))")
                continue
            }

            // Field 4 = StartupResCmd (length-delimited)
            if fieldNumber == 4 && wireType == 2 {
                guard let (len, off2) = readVarint(payload, offset: offset) else { break }
                offset = off2
                let subData = payload[offset..<min(offset + Int(len), payload.count)]
                // Parse StartupResCmd: field 1 = errorCode
                if let (tag2, off3) = readVarint(subData, offset: 0) {
                    if tag2 >> 3 == 1 { // field 1 = errorCode
                        if let (errCode, _) = readVarint(subData, offset: off3) {
                            lastResponseInfo = "pg:\(errCode == 0 ? "ok" : "err\(errCode)")"
                            NSLog("[EvenRealities] Page create result: \(errCode == 0 ? "SUCCESS" : "ERROR \(errCode)")")
                        }
                    }
                }
                offset += Int(len)
                continue
            }

            // Field 10 = TextResCmd (length-delimited)
            if fieldNumber == 10 && wireType == 2 {
                guard let (len, off2) = readVarint(payload, offset: offset) else { break }
                offset = off2
                let subData = payload[offset..<min(offset + Int(len), payload.count)]
                if let (tag2, off3) = readVarint(subData, offset: 0) {
                    if tag2 >> 3 == 1 {
                        if let (errCode, _) = readVarint(subData, offset: off3) {
                            lastResponseInfo = "txt:\(errCode == 0 ? "ok" : "err\(errCode)")"
                            NSLog("[EvenRealities] Text update result: \(errCode == 0 ? "SUCCESS" : "ERROR \(errCode)")")
                        }
                    }
                }
                offset += Int(len)
                continue
            }

            // Skip other fields
            switch wireType {
            case 0: // varint
                guard let (_, off2) = readVarint(payload, offset: offset) else { break }
                offset = off2
            case 2: // length-delimited
                guard let (len, off2) = readVarint(payload, offset: offset) else { break }
                offset = off2
                offset += Int(len)
            default:
                break
            }
        }
    }
}
