/*
 * EvenRealitiesManager.swift
 *
 * Central BLE manager for Even Realities smart glasses (G1 and G2).
 * Handles scanning, connection lifecycle, display content dispatch,
 * and microphone audio capture bridging.
 *
 * G1: Nordic UART Service, binary UART commands
 * G2: Custom Even BLE service, protobuf-encoded commands
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

    // Sequence counters
    private var commandSequence: UInt8 = 0
    private var heartbeatSequence: UInt8 = 0

    // Heartbeat task (G1 requires every 28-30s)
    private var heartbeatTask: Task<Void, Never>?

    // Audio callback — delivers raw PCM to EvenRealitiesAudioSource
    private var onAudioData: (@Sendable (Data) -> Void)?

    // Display callback — reports state changes
    private var onConnectionStateChanged: (@Sendable (EvenRealitiesConnectionState) -> Void)?

    // MARK: - Init

    override init() {
        super.init()
        self.centralManager = CBCentralManager(delegate: self, queue: nil)
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
        guard centralManager.state == .poweredOn else {
            NSLog("[EvenRealities] BLE not powered on, state: \(centralManager.state.rawValue)")
            return
        }
        connectionState = .scanning
        notifyStateChanged()

        // Scan for both G1 (Nordic UART) and G2 (Even custom service)
        centralManager.scanForPeripherals(
            withServices: [G1UUID.service, G2UUID.service],
            options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
        )
        NSLog("[EvenRealities] Scanning for G1 and G2 devices...")
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
        connectionState = .disconnected
        connectedModel = nil
        notifyStateChanged()
    }

    /// Send text lines to the connected glasses display.
    func sendDisplayContent(lines: [String]) {
        guard !devices.isEmpty else { return }

        let seq = nextCommandSequence()

        // Determine model and build protocol-specific command
        for (_, device) in devices {
            guard let writeChar = device.writeCharacteristic else { continue }

            let payload: Data
            if connectedModel == "even-g1" {
                payload = G1Protocol.buildSendText(
                    lines: lines,
                    sequence: seq
                )
            } else {
                payload = G2Protocol.buildTeleprompterDisplay(
                    lines: lines,
                    sequence: seq
                )
            }

            device.peripheral.writeValue(payload, for: writeChar, type: .withResponse)
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
            // G2: send empty teleprompter to clear
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
            NSLog("[EvenRealities] BLE powered on")
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

        // Determine model and side from advertising name
        let model: String
        let side: String

        if name.hasPrefix("Even G2") || advertisementData.contains(where: { $0.key == "kCBAdvDataServiceUUIDs" && (($0.value as? [CBUUID])?.contains(G2UUID.service) ?? false) }) {
            model = "even-g2"
            side = name.contains("_L_") ? "left" : "right"
        } else if let services = advertisementData["kCBAdvDataServiceUUIDs"] as? [CBUUID], services.contains(G1UUID.service) {
            model = "even-g1"
            // G1 doesn't advertise side in name — assume both sides connect
            side = name.lowercased().contains("left") ? "left" : "right"
        } else {
            return
        }

        NSLog("[EvenRealities] Found \(model) \(side) arm: \(name) RSSI=\(rssi)")

        // Stop scanning and connect
        centralManager.stopScan()
        connectionState = .connecting
        notifyStateChanged()

        peripheral.delegate = self
        let device = EvenDevice(peripheral: peripheral, model: model, side: side)
        devices[peripheral.identifier.uuidString] = device
        centralManager.connect(peripheral)
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
            // G1: NUS RX (write) and TX (notify)
            if char.uuid == G1UUID.rx && char.properties.contains(.write) {
                devices[key]?.writeCharacteristic = char
                NSLog("[EvenRealities] Found G1 write characteristic")
            }
            if char.uuid == G1UUID.tx && char.properties.contains(.notify) {
                devices[key]?.notifyCharacteristic = char
                peripheral.setNotifyValue(true, for: char)
                NSLog("[EvenRealities] Subscribed to G1 notify")
            }

            // G2: Even custom write and notify
            if char.uuid == G2UUID.write && char.properties.contains(.write) {
                devices[key]?.writeCharacteristic = char
                NSLog("[EvenRealities] Found G2 write characteristic")
            }
            if char.uuid == G2UUID.notify && char.properties.contains(.notify) {
                devices[key]?.notifyCharacteristic = char
                peripheral.setNotifyValue(true, for: char)
                NSLog("[EvenRealities] Subscribed to G2 notify")
            }
        }

        // Check if we have all required characteristics
        checkConnectionReady()
    }

    nonisolated func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard let data = characteristic.value else { return }
        Task { await self.handleCharacteristicUpdate(characteristic, data: data) }
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

        // G2: Parse response
        if characteristic.uuid == G2UUID.notify {
            if let response = G2Protocol.parseResponse(data) {
                NSLog("[EvenRealities] G2 response: serviceId=0x\(String(response.serviceId, radix: 16)) payload=\(response.payload.count) bytes")
            }
        }
    }

    // MARK: - Private Helpers

    private func checkConnectionReady() {
        // Check if all connected devices have their characteristics
        let allReady = devices.values.allSatisfy { $0.writeCharacteristic != nil }
        if allReady && !devices.isEmpty {
            let model = devices.values.first?.model ?? "unknown"
            connectedModel = model
            connectionState = .connected(model: model)
            notifyStateChanged()
            NSLog("[EvenRealities] Connection ready: \(model), \(devices.count) arm(s)")

            // Start heartbeat for G1
            if model == "even-g1" {
                startHeartbeat()
            }
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
        let proto = model == "even-g1" ? "uart" : "protobuf"
        return (model, proto)
    }
}
