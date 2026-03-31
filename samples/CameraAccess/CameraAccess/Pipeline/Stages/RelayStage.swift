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

actor RelayStage: @preconcurrency FramePipelineStage {
    nonisolated let stageId = "relay"
    var config: FrameStageConfig

    // Connection state
    private var webSocketTask: URLSessionWebSocketTask?
    private var isConnected = false
    private var sequenceNumber: UInt64 = 0

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

        let session = URLSession(configuration: .default)
        webSocketTask = session.webSocketTask(with: url)
        webSocketTask?.resume()

        // Brief wait for connection to establish
        try await Task.sleep(nanoseconds: 200_000_000) // 200ms

        isConnected = true
        NSLog("[RelayStage] Connected to \(urlString)")
    }

    func disconnect() {
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
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
    }

    private func onSendError(_ error: Error) {
        framesFailed += 1
        if framesFailed % 10 == 1 {
            NSLog("[RelayStage] Send error (\(framesFailed) total): \(error)")
        }
    }
}

// MARK: - Errors

enum RelayError: LocalizedError {
    case invalidURL(String)
    case notConnected

    var errorDescription: String? {
        switch self {
        case .invalidURL(let url): return "Invalid relay URL: \(url)"
        case .notConnected: return "Relay not connected"
        }
    }
}
