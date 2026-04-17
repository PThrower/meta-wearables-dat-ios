/*
 * RelayStage.swift
 *
 * Pipeline stage that encodes CMSampleBuffer frames as JPEG,
 * wraps them in the FRLY wire protocol, and sends them over
 * a WebSocket connection to the gateway (which proxies to the relay server).
 *
 * Wire protocol v1 per frame (36-byte header):
 *   [4 bytes "FRLY"][1 byte version=1][4 bytes payloadLength][8 bytes sequence]
 *   [4 bytes width][4 bytes height][1 byte quality][8 bytes timestamp_ms]
 *   [2 bytes headerCrc16][JPEG payload]
 *
 * Includes a receive loop (required for URLSessionWebSocketTask protocol
 * handling) and ping keepalive (prevents proxy/NAT idle disconnects).
 *
 * Runs on its own actor executor -- never blocks the main thread.
 */

import CoreImage
import CoreMedia
import Foundation
import ImageIO
import UIKit
import UniformTypeIdentifiers

// MARK: - CRC-16/CCITT-FALSE

/// CRC-16/CCITT-FALSE: polynomial 0x1021, init 0xFFFF, no reflect, no final XOR.
/// Used for header integrity in both FRLY v1 and FRAU v1 wire protocols.
func crc16ccitt(_ data: Data, offset: Int, length: Int) -> UInt16 {
    var crc: UInt16 = 0xFFFF
    let end = offset + length
    for i in offset..<end {
        crc ^= UInt16(data[i]) << 8
        for _ in 0..<8 {
            if crc & 0x8000 != 0 {
                crc = (crc << 1) ^ 0x1021
            } else {
                crc = crc << 1
            }
        }
    }
    return crc
}

// MARK: - WebSocket Delegate

private final class RelayWebSocketDelegate: NSObject, URLSessionWebSocketDelegate, Sendable {
    let onOpen: @Sendable () -> Void
    let onClose: @Sendable (Error?) -> Void

    init(onOpen: @Sendable @escaping () -> Void, onClose: @Sendable @escaping (Error?) -> Void) {
        self.onOpen = onOpen
        self.onClose = onClose
        super.init()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol proto: String?) {
        NSLog("[RelayStage] WebSocket did open, protocol: \(proto ?? "none")")
        onOpen()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        NSLog("[RelayStage] WebSocket closed: \(closeCode.rawValue)")
        onClose(nil)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error {
            NSLog("[RelayStage] WebSocket connection failed: \(error)")
            onClose(error)
        }
    }
}

// MARK: - RelayStage

actor RelayStage: @preconcurrency FramePipelineStage {
    nonisolated let stageId = "relay"
    var config: FrameStageConfig

    // Connection state
    private var webSocketTask: URLSessionWebSocketTask?
    private var isConnected = false
    private var sequenceNumber: UInt64 = 0
    private var session: URLSession?
    private var delegate: RelayWebSocketDelegate?

    // Background tasks for receive loop and keepalive
    private var receiveLoopTask: Task<Void, Never>?
    private var keepAliveTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?

    // Reconnection config
    private var shouldAutoReconnect = false
    private var reconnectDelay: UInt64 = 1_000_000_000 // 1 second
    private let maxReconnectDelay: UInt64 = 30_000_000_000 // 30 seconds
    private var lastConnectedURL: String?

    /// Public accessor for the URL last connected to (for foreground reconnection).
    var currentURL: String? { lastConnectedURL }

    // JPEG encoding — CIContext for YUV->RGB, CGImageDestination for JPEG (no UIKit)
    private var adaptiveQuality: CGFloat       // Adjusted by encode time feedback
    private let minQuality: CGFloat = 0.2
    private let maxQuality: CGFloat = 0.8
    private let ciContext = CIContext(options: [.useSoftwareRenderer: false])

    /// Callback to dispatch received FRAU audio to the AudioEventBus.
    /// Set by StreamSessionViewModel before connecting.
    private var onReceivedAudio: (@Sendable (Data) -> Void)?

    /// Callback for JSON control responses from the server (e.g. app_status).
    /// Set by StreamSessionViewModel before connecting.
    var onControlMessage: (@Sendable ([String: Any]) -> Void)?

    // Frame pacing — time-based throttle using config.targetFPS
    private var lastRelayTime: ContinuousClock.Instant?

    // Server backpressure state (overrides local targetFPS when set)
    private var serverTargetFps: Double?

    // EMA encode time tracking (adaptive FPS)
    // Smoothing factor α — higher = more responsive to recent samples.
    // α=0.3 means ~3 samples to converge on a new encode time regime.
    private let encodeTimeAlpha: Double = 0.3
    private var encodeTimeEmaMs: Double?   // nil until first sample

    // Stats
    private var framesSent: UInt64 = 0
    private var framesFailed: UInt64 = 0
    private var framesDropped: UInt64 = 0
    private var framesDroppedByPacing: UInt64 = 0
    private var framesDroppedByBackpressure: UInt64 = 0
    private var isEncoding = false

    init(config: FrameStageConfig = FrameStageConfig(targetFPS: 15), jpegQuality: CGFloat = 0.5) {
        self.config = config
        self.adaptiveQuality = jpegQuality
    }

    // MARK: - Connection

    func connect(to urlString: String) async throws {
        guard let url = URL(string: urlString) else {
            throw RelayError.invalidURL(urlString)
        }

        disconnect()

        NSLog("[RelayStage] Connecting to \(urlString) ...")

        // Store for reconnection
        lastConnectedURL = urlString

        let connected = await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            var resumed = false

            let delegate = RelayWebSocketDelegate(
                onOpen: {
                    guard !resumed else { return }
                    resumed = true
                    NSLog("[RelayStage] onOpen fired")
                    continuation.resume(returning: true)
                },
                onClose: { error in
                    guard !resumed else { return }
                    resumed = true
                    if let error {
                        NSLog("[RelayStage] onClose with error: \(error)")
                    }
                    continuation.resume(returning: false)
                }
            )

            let session = URLSession(configuration: .default, delegate: delegate, delegateQueue: nil)
            let task = session.webSocketTask(with: url)

            self.session = session
            self.delegate = delegate
            self.webSocketTask = task
            task.resume()

            // Timeout: if no open/close event in 5 seconds, assume failure
            _ = Task {
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                guard !resumed else { return }
                resumed = true
                NSLog("[RelayStage] Connection timed out after 5s")
                continuation.resume(returning: false)
            }
        }

        if connected {
            isConnected = true
            shouldAutoReconnect = true
            reconnectDelay = 1_000_000_000 // Reset backoff on successful connect
            sendHello()
            startReceiveLoop()
            startKeepAlive()
            NSLog("[RelayStage] Connected to \(urlString)")
        } else {
            disconnect()
            throw RelayError.connectionFailed(urlString)
        }
    }

    func disconnect() {
        shouldAutoReconnect = false
        reconnectTask?.cancel()
        reconnectTask = nil
        receiveLoopTask?.cancel()
        keepAliveTask?.cancel()
        receiveLoopTask = nil
        keepAliveTask = nil
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        session?.invalidateAndCancel()
        session = nil
        delegate = nil
        isConnected = false
        serverTargetFps = nil
        lastRelayTime = nil
        NSLog("[RelayStage] Disconnected")
    }

    var connected: Bool {
        isConnected
    }

    // MARK: - FramePipelineStage

    nonisolated func processFrame(_ packet: FramePacket) async {
        await relayFrame(packet)
    }

    func start() async {
        sequenceNumber = 0
        framesSent = 0
        framesFailed = 0
        framesDropped = 0
        framesDroppedByPacing = 0
        framesDroppedByBackpressure = 0
        serverTargetFps = nil
        lastRelayTime = nil
        encodeTimeEmaMs = nil
        adaptiveQuality = 0.5  // Reset to default
    }

    func stop() async {
        disconnect()
    }

    // MARK: - Receive Loop
    // URLSessionWebSocketTask requires an active receive() loop to properly
    // process the WebSocket protocol (handle pings, close frames, etc.).
    // Without this, the OS may silently drop the connection.

    private func startReceiveLoop() {
        receiveLoopTask = Task {
            while !Task.isCancelled {
                guard let wsTask = self.webSocketTask else { break }
                do {
                    let message = try await wsTask.receive()
                    switch message {
                    case .string(let text):
                        NSLog("[RelayStage] Received: \(text.prefix(100))")
                        if let data = text.data(using: .utf8),
                           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                            // Handle backpressure messages from the server
                            if json["type"] as? String == "backpressure",
                               let targetFps = json["targetFps"] as? Double {
                                NSLog("[RelayStage] Backpressure from server: targetFps=\(targetFps)")
                                await self.handleBackpressure(targetFps: targetFps)
                            }
                            if let handler = await self.onControlMessage {
                                handler(json)
                            }
                        }
                    case .data(let data):
                        // Check if this is a FRAU audio frame (server → publisher)
                        if data.count >= 36 {
                            let magic: [UInt8] = [0x46, 0x52, 0x41, 0x55] // "FRAU"
                            let prefix = [UInt8](data.prefix(4))
                            if prefix == magic {
                                if let handler = await self.onReceivedAudio {
                                    handler(data)
                                }
                            } else {
                                NSLog("[RelayStage] Received binary: \(data.count) bytes")
                            }
                        } else {
                            NSLog("[RelayStage] Received binary: \(data.count) bytes")
                        }
                    @unknown default:
                        break
                    }
                } catch {
                    NSLog("[RelayStage] Receive loop ended: \(error.localizedDescription)")
                    self.isConnected = false
                    Task { [weak self] in await self?.triggerReconnect() }
                    break
                }
            }
            NSLog("[RelayStage] Receive loop exited")
        }
    }

    // MARK: - Keepalive Ping
    // Sends periodic pings to keep the connection alive through
    // proxies (Caddy), NATs, and load balancers that may drop idle connections.

    private func startKeepAlive() {
        keepAliveTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 5_000_000_000) // 5 seconds
                guard !Task.isCancelled else { break }
                guard let wsTask = self.webSocketTask else { break }
                wsTask.sendPing { [weak self] error in
                    if let error {
                        NSLog("[RelayStage] Ping failed: \(error)")
                        Task { [weak self] in
                            await self?.markDisconnected()
                        }
                    }
                }
            }
        }
    }

    // MARK: - Server Backpressure

    /// Apply server-requested FPS throttle and acknowledge back.
    private func handleBackpressure(targetFps: Double) {
        serverTargetFps = targetFps
        lastRelayTime = nil // Reset gate so next frame uses new rate immediately

        // Send ack back to server
        let ack: [String: Any] = [
            "type": "backpressure-ack",
            "targetFps": targetFps,
        ]
        sendJson(ack)
        NSLog("[RelayStage] Backpressure applied: serverTargetFps=\(targetFps), ack sent")
    }

    // MARK: - Frame Relay

    /// Effective FPS: the lesser of configured target, server backpressure, and hardware cap.
    /// Hardware cap is derived from EMA encode time: if encode averages 100ms, real max is ~10fps.
    private var effectiveTargetFps: Double {
        // Server backpressure always wins
        if let server = serverTargetFps, server > 0 { return server }

        let configured = config.targetFPS > 0 ? Double(config.targetFPS) : 30.0

        // EMA-based hardware cap: fps ≤ 1000 / encodeTime
        // Add 10% headroom so we don't saturate the encoder at exactly capacity.
        if let ema = encodeTimeEmaMs, ema > 0 {
            let hardwareCap = 1000.0 / (ema * 1.1)
            return min(configured, hardwareCap)
        }

        return configured
    }

    private func relayFrame(_ packet: FramePacket) {
        guard isConnected, let webSocketTask else { return }

        // Check socket state before encoding
        let state = webSocketTask.state
        guard state == .running else {
            NSLog("[RelayStage] Socket not running (state=\(state)), marking disconnected")
            isConnected = false
            return
        }

        // Time-based frame pacing: enforce minimum interval between frames.
        // This produces evenly-spaced output regardless of encode duration variance.
        let now = ContinuousClock.Instant.now
        if let last = lastRelayTime {
            let minInterval = 1.0 / effectiveTargetFps
            let elapsed = now - last
            let elapsedSeconds = Double(elapsed.components.seconds)
                + Double(elapsed.components.attoseconds) / 1e18
            if elapsedSeconds < minInterval {
                framesDroppedByPacing += 1
                framesDropped += 1
                if framesDroppedByPacing % 500 == 1 {
                    NSLog("[RelayStage] Frame dropped (pacing): \(framesDroppedByPacing) total, effectiveFps=\(effectiveTargetFps), elapsed=\(String(format: "%.1f", elapsedSeconds * 1000))ms < \(String(format: "%.1f", minInterval * 1000))ms")
                }
                return
            }
        }
        lastRelayTime = now

        // Skip if previous encode still in progress (prevents unbounded concurrent encodes)
        guard !isEncoding else { return }
        isEncoding = true

        // Increment sequence first (on actor), then do heavy encoding off-actor
        sequenceNumber += 1
        let seq = sequenceNumber
        let quality = adaptiveQuality
        let ciCtx = ciContext

        // Capture websocket reference for off-actor use
        let wsTask = webSocketTask

        // Detach the expensive JPEG encoding + send so actor returns immediately
        Task.detached { [weak self] in
            defer { Task { [weak self] in await self?.clearEncodingFlag() } }

            let encodeStart = ContinuousClock.Instant.now

            // Step 1: CVPixelBuffer -> CIImage -> CGImage (CIContext handles YUV->RGB)
            guard let pixelBuffer = CMSampleBufferGetImageBuffer(packet.sampleBuffer) else { return }
            let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
            let width = CVPixelBufferGetWidth(pixelBuffer)
            let height = CVPixelBufferGetHeight(pixelBuffer)

            guard let cgImage = ciCtx.createCGImage(ciImage, from: CGRect(x: 0, y: 0, width: width, height: height)) else { return }

            // Step 2: CGImage -> JPEG via CGImageDestination (ImageIO C API, no UIKit)
            let mutableData = CFDataCreateMutable(kCFAllocatorDefault, 0)!
            guard let destination = CGImageDestinationCreateWithData(
                mutableData, UTType.jpeg.identifier as CFString, 1, nil
            ) else { return }

            let jpegOptions: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: quality]
            CGImageDestinationAddImage(destination, cgImage, jpegOptions as CFDictionary)
            guard CGImageDestinationFinalize(destination) else { return }

            let encodeEnd = ContinuousClock.Instant.now
            let encodeDuration = encodeEnd - encodeStart
            let encodeMs = Double(encodeDuration.components.seconds) * 1000.0
                + Double(encodeDuration.components.attoseconds) / 1e15

            // Update EMA on actor
            Task { [weak self] in await self?.updateEncodeTime(encodeMs) }

            let jpegData = mutableData as Data

            // Build FRLY v1 wire protocol message (36-byte header)
            var header = Data(capacity: 36)

            // [0:4] Magic "FRLY"
            header.append(contentsOf: [0x46, 0x52, 0x4C, 0x59])

            // [4] Version = 1
            header.append(UInt8(1))

            // [5:9] Payload length (u32 LE) — JPEG data size
            var payloadLen = UInt32(jpegData.count)
            header.append(contentsOf: withUnsafeBytes(of: &payloadLen) { Array($0) })

            // [9:17] Sequence number (u64 LE)
            var seqVar = seq
            header.append(contentsOf: withUnsafeBytes(of: &seqVar) { Array($0) })

            // [17:21] Width (u32 LE)
            var w = UInt32(width)
            header.append(contentsOf: withUnsafeBytes(of: &w) { Array($0) })

            // [21:25] Height (u32 LE)
            var h = UInt32(height)
            header.append(contentsOf: withUnsafeBytes(of: &h) { Array($0) })

            // [25] Quality (u8)
            header.append(UInt8(quality * 100))

            // [26:34] Timestamp ms (u64 LE)
            var ts = UInt64(Date().timeIntervalSince1970 * 1000)
            header.append(contentsOf: withUnsafeBytes(of: &ts) { Array($0) })

            // [34:36] CRC-16/CCITT-FALSE over header bytes [0..33]
            let crc = crc16ccitt(header, offset: 0, length: 34)
            header.append(contentsOf: withUnsafeBytes(of: crc) { Array($0) })

            // Combine header + JPEG payload
            var message = header
            message.append(jpegData)

            wsTask.send(.data(message)) { error in
                if let error {
                    NSLog("[RelayStage] Send error: \(error)")
                    Task { [weak self] in
                        await self?.onSendError(error)
                    }
                } else {
                    Task { [weak self] in
                        await self?.onSendSuccess()
                    }
                }
            }
        }
    }

    private func onSendSuccess() {
        framesSent += 1
        if framesSent % 50 == 1 {
            NSLog("[RelayStage] Frames sent: \(framesSent), encodeEma=\(String(format: "%.1f", encodeTimeEmaMs ?? 0))ms, adaptiveFps=\(String(format: "%.1f", effectiveTargetFps))")
        }
    }

    private func onSendError(_ error: Error) {
        framesFailed += 1
        isConnected = false
        if framesFailed % 10 == 1 {
            NSLog("[RelayStage] Send error (\(framesFailed) total): \(error)")
        }
    }

    // MARK: - Raw Data Send (for audio and other binary protocols)

    /// Send a JSON control message over the WebSocket.
    /// Used for app activation/deactivation and other control plane messages.
    func sendJson(_ dict: [String: Any]) {
        guard isConnected, let webSocketTask else { return }
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let str = String(data: data, encoding: .utf8) else {
            NSLog("[RelayStage] sendJson: failed to serialize")
            return
        }
        webSocketTask.send(.string(str)) { [weak self] error in
            if let error {
                NSLog("[RelayStage] sendJson error: \(error)")
                Task { [weak self] in await self?.markDisconnected() }
            }
        }
    }

    /// Send pre-built binary data (e.g. FRAU audio frames) over the WebSocket.
    /// The caller is responsible for building the wire protocol header.
    func sendRawData(_ data: Data) {
        guard isConnected, let webSocketTask else { return }
        let state = webSocketTask.state
        guard state == .running else {
            isConnected = false
            return
        }
        webSocketTask.send(.data(data)) { [weak self] error in
            if let error {
                NSLog("[RelayStage] Raw send error: \(error)")
                Task { [weak self] in
                    await self?.markDisconnected()
                }
            }
        }
    }

    private func markDisconnected() {
        isConnected = false
        Task { [weak self] in await self?.triggerReconnect() }
    }

    private func clearEncodingFlag() {
        isEncoding = false
    }

    /// Update EMA encode time and adapt JPEG quality toward target FPS.
    /// If encode is slower than the frame budget, reduce quality to speed up.
    /// If encode is faster than needed, increase quality for sharper frames.
    private func updateEncodeTime(_ encodeMs: Double) {
        let previous: Double
        if let ema = encodeTimeEmaMs {
            previous = ema
            encodeTimeEmaMs = encodeTimeAlpha * encodeMs + (1 - encodeTimeAlpha) * ema
        } else {
            previous = encodeMs
            encodeTimeEmaMs = encodeMs  // First sample: initialize
        }
        let ema = encodeTimeEmaMs!

        // Frame budget in ms — how long we can afford per encode to hit target FPS
        let targetFps = effectiveTargetFps
        let frameBudgetMs = (targetFps > 0) ? 1000.0 / targetFps : 100.0

        // Adapt quality: multiplicative decrease if over budget, additive increase if under
        let oldQuality = adaptiveQuality
        if ema > frameBudgetMs * 1.2 {
            // Encode too slow — reduce quality to speed up
            adaptiveQuality = max(minQuality, adaptiveQuality * 0.95)
        } else if ema < frameBudgetMs * 0.8 {
            // Encode fast enough — reclaim quality
            adaptiveQuality = min(maxQuality, adaptiveQuality * 1.02)
        }

        // Log quality changes and periodic EMA updates
        let hardwareCap = 1000.0 / (ema * 1.1)
        if abs(adaptiveQuality - oldQuality) > 0.01 {
            NSLog("[RelayStage] Quality adapt: \(String(format: "%.2f", oldQuality))→\(String(format: "%.2f", adaptiveQuality)), encode=\(String(format: "%.1f", ema))ms, budget=\(String(format: "%.1f", frameBudgetMs))ms, hwCap=\(String(format: "%.1f", hardwareCap))fps")
        }
    }

    // MARK: - Reconnection

    /// Internal reconnection with exponential backoff (same pattern as AudioTapClient).
    private func triggerReconnect() {
        guard shouldAutoReconnect else { return }
        guard let urlString = lastConnectedURL else { return }

        reconnectTask?.cancel()
        reconnectTask = Task {
            try? await Task.sleep(nanoseconds: reconnectDelay)
            guard !Task.isCancelled else { return }
            guard self.shouldAutoReconnect else { return }

            NSLog("[RelayStage] Reconnecting in \(self.reconnectDelay / 1_000_000_000)s ...")

            // Exponential backoff
            self.reconnectDelay = min(self.reconnectDelay * 2, self.maxReconnectDelay)

            do {
                try await self.connect(to: urlString)
            } catch {
                NSLog("[RelayStage] Reconnect failed: \(error)")
            }
        }
    }

    /// Explicit reconnect for foreground recovery. Resets backoff delay.
    func reconnect() async throws {
        guard let urlString = lastConnectedURL else {
            throw RelayError.notConnected
        }
        reconnectDelay = 1_000_000_000
        try await connect(to: urlString)
    }

    // MARK: - Device Identity

    /// Send device identity to relay server as JSON after WebSocket opens.
    /// The server stores this on the Publisher object and exposes it via /stats.
    // THREADING REVIEW: [SAFE] Actor-isolated values (wsTask, wearableId, wearableType)
    // are captured BEFORE the @MainActor hop — no async gaps where disconnect() could nil them.
    // UIDevice.current calls happen inside Task { @MainActor in }.
    // hardwareModelIdentifier() reads utsname — no UIKit dependency, safe from any context.
    private func sendHello() {
        // Capture all actor-isolated state BEFORE leaving the actor.
        // This eliminates the race where disconnect() nils webSocketTask
        // during an async hop back to the actor.
        guard let wsTask = webSocketTask else { return }
        let capturedWearableId = wearableId
        let capturedWearableType = wearableType

        // UIDevice.current is @MainActor-isolated in iOS 17+.
        // Dispatch to main to read device info, then send using captured wsTask.
        // No await back to self — the captured references are all we need.
        Task { @MainActor in
            let deviceId = UIDevice.current.identifierForVendor?.uuidString ?? "unknown"
            let deviceName = UIDevice.current.name
            let hardwareModel = Self.hardwareModelIdentifier()   // e.g. "iPhone14,4"
            let systemVersion = UIDevice.current.systemVersion

            let hello: [String: String] = [
                "type": "hello",
                "deviceId": deviceId,
                "deviceName": deviceName,
                "deviceModel": hardwareModel,
                "systemVersion": systemVersion,
                "wearableId": capturedWearableId ?? "",
                "wearableType": capturedWearableType ?? "",
                "appVersion": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown",
                "buildNumber": Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "unknown",
            ]

            guard let data = try? JSONSerialization.data(withJSONObject: hello),
                  let str = String(data: data, encoding: .utf8) else { return }

            // Send using the captured wsTask — no actor hop needed.
            // wsTask.send() is nonisolated on URLSessionWebSocketTask, safe from MainActor.
            // If disconnect() already cancelled the task, the completion reports an error.
            wsTask.send(.string(str)) { error in
                if let error {
                    NSLog("[RelayStage] Hello send error: \(error)")
                } else {
                    NSLog("[RelayStage] Sent hello: device=\(deviceName) model=\(hardwareModel) wearable=\(capturedWearableType ?? "none")")
                }
            }
        }
    }

    // MARK: - Hardware Model

    /// Read the hardware model identifier from `utsname.machine` (e.g. "iPhone14,4").
    /// Returns the canonical device identifier — no lookup table needed.
    nonisolated private static func hardwareModelIdentifier() -> String {
        var info = utsname()
        uname(&info)
        return withUnsafePointer(to: &info.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: 256) {
                String(cString: $0)
            }
        }
    }

    /// Connected wearable device info (set before connect).
    /// The view model sets these from the DAT SDK device info.
    var wearableId: String?
    var wearableType: String?

    /// Set device identity before connecting. Called by StreamSessionViewModel.
    func setDeviceIdentity(wearableId: String?, wearableType: String?) {
        self.wearableId = wearableId
        self.wearableType = wearableType
    }

    /// Set the callback for server-to-publisher FRAU audio frames.
    /// Called by StreamSessionViewModel before connecting.
    func setOnReceivedAudio(_ handler: @Sendable @escaping (Data) -> Void) {
        self.onReceivedAudio = handler
    }

    /// Set the callback for JSON control responses from the server.
    /// Called by StreamSessionViewModel before connecting.
    func setOnControlMessage(_ handler: @Sendable @escaping ([String: Any]) -> Void) {
        self.onControlMessage = handler
    }
}

// MARK: - Errors

enum RelayError: LocalizedError {
    case invalidURL(String)
    case notConnected
    case connectionFailed(String)

    var errorDescription: String? {
        switch self {
        case .invalidURL(let url): return "Invalid relay URL: \(url)"
        case .notConnected: return "Relay not connected"
        case .connectionFailed(let url): return "Failed to connect to relay: \(url)"
        }
    }
}
