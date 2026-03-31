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
 * Runs on its own actor executor -- never blocks the main thread.
 */

import CoreMedia
import Foundation
import UIKit

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

    // JPEG encoding
    private let jpegQuality: CGFloat

    // Stats
    private var framesSent: UInt64 = 0
    private var framesFailed: UInt64 = 0

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

        // Use delegate to get actual connection events
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
            Task {
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                guard !resumed else { return }
                resumed = true
                NSLog("[RelayStage] Connection timed out after 5s")
                continuation.resume(returning: false)
            }
        }

        if connected {
            isConnected = true
            NSLog("[RelayStage] Connected to \(urlString)")
        } else {
            disconnect()
            throw RelayError.connectionFailed(urlString)
        }
    }

    func disconnect() {
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

    // MARK: - Frame Relay

    private func relayFrame(_ packet: FramePacket) {
        guard isConnected, let webSocketTask else { return }

        // Convert CMSampleBuffer -> UIImage -> JPEG
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(packet.sampleBuffer) else { return }
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)

        let ciContext = CIContext(options: [.useSoftwareRenderer: false])
        guard let cgImage = ciContext.createCGImage(ciImage, from: CGRect(x: 0, y: 0, width: width, height: height)) else { return }

        let uiImage = UIImage(cgImage: cgImage)
        guard let jpegData = uiImage.jpegData(compressionQuality: jpegQuality) else { return }

        // Build wire protocol message
        sequenceNumber += 1
        var header = Data(capacity: 29)

        // Magic "FRLY"
        header.append(contentsOf: [0x46, 0x52, 0x4C, 0x59])

        // Sequence number (8 bytes LE)
        var seq = sequenceNumber
        header.append(contentsOf: withUnsafeBytes(of: &seq) { Array($0) })

        // Width (4 bytes LE)
        var w = UInt32(width)
        header.append(contentsOf: withUnsafeBytes(of: &w) { Array($0) })

        // Height (4 bytes LE)
        var h = UInt32(height)
        header.append(contentsOf: withUnsafeBytes(of: &h) { Array($0) })

        // Quality (1 byte)
        header.append(UInt8(jpegQuality * 100))

        // Timestamp ms (8 bytes LE)
        var ts = UInt64(Date().timeIntervalSince1970 * 1000)
        header.append(contentsOf: withUnsafeBytes(of: &ts) { Array($0) })

        // Combine header + JPEG payload
        var message = header
        message.append(jpegData)

        webSocketTask.send(.data(message)) { [weak self] error in
            Task { [weak self] in
                if let error {
                    await self?.onSendError(error)
                } else {
                    await self?.onSendSuccess()
                }
            }
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
        if framesFailed % 10 == 1 {
            NSLog("[RelayStage] Send error (\(framesFailed) total): \(error)")
        }
    }

    // MARK: - Raw Data Send (for audio and other binary protocols)

    /// Send pre-built binary data (e.g. FRAU audio frames) over the WebSocket.
    /// The caller is responsible for building the wire protocol header.
    func sendRawData(_ data: Data) {
        guard isConnected, let webSocketTask else { return }
        webSocketTask.send(.data(data)) { error in
            if let error {
                NSLog("[RelayStage] Raw send error: \(error)")
            }
        }
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
