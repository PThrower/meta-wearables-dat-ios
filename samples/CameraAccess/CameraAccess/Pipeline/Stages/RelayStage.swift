/*
 * RelayStage.swift
 *
 * Pipeline stage that encodes CMSampleBuffer frames as JPEG,
 * wraps them in the FRLY wire protocol, and sends them over
 * a WebSocket connection to the relay server.
 *
 * Wire protocol per frame:
 *   [4 bytes "FRLY"][8 bytes sequence][4 bytes width][4 bytes height]
 *   [1 byte quality][8 bytes timestamp_ms][JPEG payload]
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

// MARK: - Send Queue (nonisolated, bypasses actor for WebSocket writes)

final class RelaySendQueue: @unchecked Sendable {
    private var wsTask: URLSessionWebSocketTask?
    private var _active = false
    private let lock: os_unfair_lock_t

    init() {
        lock = .allocate(capacity: 1)
        lock.initialize(to: os_unfair_lock())
    }

    deinit { lock.deallocate() }

    var active: Bool {
        os_unfair_lock_lock(lock)
        defer { os_unfair_lock_unlock(lock) }
        return _active
    }

    func activate(_ task: URLSessionWebSocketTask) {
        os_unfair_lock_lock(lock)
        wsTask = task
        _active = true
        os_unfair_lock_unlock(lock)
    }

    func deactivate() {
        os_unfair_lock_lock(lock)
        wsTask = nil
        _active = false
        os_unfair_lock_unlock(lock)
    }

    func send(_ data: Data) {
        os_unfair_lock_lock(lock)
        guard _active, let ws = wsTask else {
            os_unfair_lock_unlock(lock)
            return
        }
        os_unfair_lock_unlock(lock)
        ws.send(.data(data)) { error in
            if let error {
                NSLog("[RelaySendQueue] Error: \(error)")
            }
        }
    }
}

// MARK: - RelayStage

actor RelayStage: @preconcurrency FramePipelineStage {
    nonisolated let stageId = "relay"
    var config: FrameStageConfig

    // Nonisolated send queue — audio and video send through this
    // without hopping to the actor executor.
    nonisolated let sendQueue = RelaySendQueue()

    // Connection state
    private var webSocketTask: URLSessionWebSocketTask?
    private var isConnected = false
    private var sequenceNumber: UInt64 = 0
    private var session: URLSession?
    private var delegate: RelayWebSocketDelegate?

    // Background tasks for receive loop and keepalive
    private var receiveLoopTask: Task<Void, Never>?
    private var keepAliveTask: Task<Void, Never>?

    // JPEG encoding — CIContext for YUV->RGB, CGImageDestination for JPEG (no UIKit)
    private let jpegQuality: CGFloat
    private let ciContext = CIContext(options: [.useSoftwareRenderer: false])

    // Stats
    private var framesSent: UInt64 = 0
    private var framesFailed: UInt64 = 0
    private var framesDropped: UInt64 = 0
    private var isEncoding = false

    init(config: FrameStageConfig = FrameStageConfig(targetFPS: 15), jpegQuality: CGFloat = 0.6) {
        self.config = config
        self.jpegQuality = jpegQuality
    }

    // MARK: - Connection

    func connect(to urlString: String) async throws {
        guard let url = URL(string: urlString) else {
            throw RelayError.invalidURL(urlString)
        }

        disconnect()

        NSLog("[RelayStage] Connecting to \(urlString) ...")

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
            if let ws = webSocketTask { sendQueue.activate(ws) }
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
        sendQueue.deactivate()
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
                    case .data(let data):
                        NSLog("[RelayStage] Received binary: \(data.count) bytes")
                    @unknown default:
                        break
                    }
                } catch {
                    NSLog("[RelayStage] Receive loop ended: \(error.localizedDescription)")
                    self.isConnected = false
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

    // MARK: - Frame Relay

    private func relayFrame(_ packet: FramePacket) {
        guard isConnected, let webSocketTask else { return }

        // Check socket state before encoding
        let state = webSocketTask.state
        guard state == .running else {
            NSLog("[RelayStage] Socket not running (state=\(state)), marking disconnected")
            isConnected = false
            return
        }

        // Backpressure: drop frame if previous encode is still in progress
        guard !isEncoding else {
            framesDropped += 1
            if framesDropped % 100 == 1 {
                NSLog("[RelayStage] Frame dropped (encoding busy): \(framesDropped) total")
            }
            return
        }
        isEncoding = true

        // Increment sequence first (on actor), then do heavy encoding off-actor
        sequenceNumber += 1
        let seq = sequenceNumber
        let quality = jpegQuality
        let ciCtx = ciContext

        // Capture websocket reference for off-actor use
        let wsTask = webSocketTask

        // Detach the expensive JPEG encoding + send so actor returns immediately
        Task.detached { [weak self] in
            defer { Task { [weak self] in await self?.clearEncodingFlag() } }

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

            let jpegData = mutableData as Data

            // Build wire protocol message
            var header = Data(capacity: 29)

            // Magic "FRLY"
            header.append(contentsOf: [0x46, 0x52, 0x4C, 0x59])

            // Sequence number (8 bytes LE)
            var seqVar = seq
            header.append(contentsOf: withUnsafeBytes(of: &seqVar) { Array($0) })

            // Width (4 bytes LE)
            var w = UInt32(width)
            header.append(contentsOf: withUnsafeBytes(of: &w) { Array($0) })

            // Height (4 bytes LE)
            var h = UInt32(height)
            header.append(contentsOf: withUnsafeBytes(of: &h) { Array($0) })

            // Quality (1 byte)
            header.append(UInt8(quality * 100))

            // Timestamp ms (8 bytes LE)
            var ts = UInt64(Date().timeIntervalSince1970 * 1000)
            header.append(contentsOf: withUnsafeBytes(of: &ts) { Array($0) })

            // Combine header + JPEG payload
            var message = header
            message.append(jpegData)

            self?.sendQueue.send(message)
            Task { [weak self] in await self?.onSendSuccess() }
        }
    }

    private func onSendSuccess() {
        framesSent += 1
        if framesSent % 100 == 1 {
            NSLog("[RelayStage] Frames sent: \(framesSent)")
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
    }

    private func clearEncodingFlag() {
        isEncoding = false
    }

    // MARK: - Device Identity

    // MARK: - Device Identity

    /// Send device identity to relay server as JSON after WebSocket opens.
    /// The server stores this on the Publisher object and exposes it via /stats.
    // THREADING REVIEW: [SAFE] UIDevice.current calls are inside Task { @MainActor in }.
    // hardwareModelIdentifier() reads utsname — no UIKit dependency, safe from any context.
    private func sendHello() {
        guard let wsTask = webSocketTask else { return }

        // UIDevice.current is @MainActor-isolated in iOS 17+.
        // Dispatch to main to read device info, then send from here.
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
                "wearableId": await self.wearableId ?? "",
                "wearableType": await self.wearableType ?? "",
            ]

            guard let data = try? JSONSerialization.data(withJSONObject: hello),
                  let str = String(data: data, encoding: .utf8) else { return }

            await self.sendHelloString(str, deviceName: deviceName, hardwareModel: hardwareModel)
        }
    }

    private func sendHelloString(_ str: String, deviceName: String, hardwareModel: String) {
        guard let wsTask = webSocketTask else { return }
        let wt = wearableType ?? "none"
        wsTask.send(.string(str)) { error in
            if let error {
                NSLog("[RelayStage] Hello send error: \(error)")
            } else {
                NSLog("[RelayStage] Sent hello: device=\(deviceName) model=\(hardwareModel) wearable=\(wt)")
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
