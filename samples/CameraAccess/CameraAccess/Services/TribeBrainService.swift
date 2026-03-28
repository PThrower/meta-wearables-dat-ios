//
// TribeBrainService.swift
//
// Service for streaming video chunks to TRIBE v2 brain prediction API.
// Designed to work with mock server during development, swap to Modal GPU for production.
// Includes comprehensive telemetry and observability.
//

import Foundation
import UIKit

// MARK: - Models

/// Brain region activations from TRIBE v2 prediction
struct BrainPrediction: Codable {
    let roiActivations: [String: Float]
    let timestamp: Double
    let shape: [Int]
    let mock: Bool

    /// Computed properties for common ROIs
    var visualCortex: Float { roiActivations["visual_cortex"] ?? 0 }
    var auditoryCortex: Float { roiActivations["auditory_cortex"] ?? 0 }
    var languageNetwork: Float { roiActivations["language_network"] ?? 0 }
    var prefrontal: Float { roiActivations["prefrontal"] ?? 0 }
    var motor: Float { roiActivations["motor"] ?? 0 }
}

/// Health check response from the API
struct HealthStatus: Codable {
    let status: String
    let mode: String?
}

/// API configuration
struct TribeAPIConfig {
    let baseURL: String
    let useMock: Bool

    #if DEBUG
    static let `default` = TribeAPIConfig(
        baseURL: "http://localhost:8000",  // Mock server
        useMock: true
    )
    #else
    static let `default` = TribeAPIConfig(
        baseURL: "https://your-app--tribe-v2.modal.run",  // Modal deployment
        useMock: false
    )
    #endif
}

// MARK: - API Protocol (easy swap between mock and real)

protocol TribeBrainAPI {
    func predictChunk(videoData: Data, timestamp: Double) async throws -> BrainPrediction
    func healthCheck() async throws -> HealthStatus
}

// MARK: - HTTP Implementation

class TribeHTTPAPI: TribeBrainAPI {
    private let config: TribeAPIConfig
    private let session: URLSession

    init(config: TribeAPIConfig = .default) {
        self.config = config
        self.session = URLSession.shared
    }

    func predictChunk(videoData: Data, timestamp: Double) async throws -> BrainPrediction {
        let timer = MetricsTimer()
        let url = URL(string: "\(config.baseURL)/predict_stream")!

        var request = URLRequest(url: url)
        request.httpMethod = "POST"

        let boundary = UUID().uuidString
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()

        // Video chunk part
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"video_chunk\"; filename=\"chunk.mp4\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: video/mp4\r\n\r\n".data(using: .utf8)!)
        body.append(videoData)
        body.append("\r\n".data(using: .utf8)!)

        // Timestamp part
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"timestamp\"\r\n\r\n".data(using: .utf8)!)
        body.append("\(timestamp)".data(using: .utf8)!)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)

        request.httpBody = body

        do {
            let (data, response) = try await session.data(for: request)

            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else {
                let error = TribeError.apiError("HTTP error: \(response)")
                TelemetryService.shared.trackError(error, context: "predictChunk")
                throw error
            }

            let prediction = try JSONDecoder().decode(BrainPrediction.self, from: data)

            // Track successful API call
            await MainActor.run {
                TelemetryService.shared.trackAPIRequest(
                    endpoint: "predict_stream",
                    success: true,
                    latencyMs: timer.elapsedMs,
                    bytesSent: body.count,
                    bytesReceived: data.count
                )
            }

            return prediction

        } catch {
            // Track failed API call
            await MainActor.run {
                TelemetryService.shared.trackAPIRequest(
                    endpoint: "predict_stream",
                    success: false,
                    latencyMs: timer.elapsedMs,
                    bytesSent: body.count,
                    bytesReceived: 0
                )
            }
            throw error
        }
    }

    func healthCheck() async throws -> HealthStatus {
        let timer = MetricsTimer()
        let url = URL(string: "\(config.baseURL)/health")!

        do {
            let (data, _) = try await session.data(from: url)
            let status = try JSONDecoder().decode(HealthStatus.self, from: data)

            await MainActor.run {
                TelemetryService.shared.trackAPIRequest(
                    endpoint: "health",
                    success: true,
                    latencyMs: timer.elapsedMs,
                    bytesSent: 0,
                    bytesReceived: data.count
                )
            }

            return status

        } catch {
            await MainActor.run {
                TelemetryService.shared.trackAPIRequest(
                    endpoint: "health",
                    success: false,
                    latencyMs: timer.elapsedMs,
                    bytesSent: 0,
                    bytesReceived: 0
                )
            }
            throw error
        }
    }
}

// MARK: - Video Chunk Buffer

/// Buffers video frames and exports them as chunks for API
actor VideoChunkBuffer {
    private var frames: [UIImage] = []
    private var frameTimestamps: [Double] = []
    private let chunkDuration: Double  // seconds
    private var chunkStartTime: Double?

    var frameCount: Int { frames.count }

    init(chunkDuration: Double = 2.0) {
        self.chunkDuration = chunkDuration
    }

    /// Add a frame to the buffer
    func addFrame(_ image: UIImage, timestamp: Double) {
        if chunkStartTime == nil {
            chunkStartTime = timestamp
        }
        frames.append(image)
        frameTimestamps.append(timestamp)
    }

    /// Check if buffer has enough for a chunk
    func isReady(timestamp: Double) -> Bool {
        guard let startTime = chunkStartTime else { return false }
        return (timestamp - startTime) >= chunkDuration
    }

    /// Export buffer as video data and clear
    func exportAndClear() async throws -> (Data, Double, Int)? {
        guard !frames.isEmpty, let startTime = chunkStartTime else { return nil }

        let exportTimer = MetricsTimer()
        let frameCount = frames.count

        // For now, use a simple approach: encode frames as JPEG sequence
        // In production, you'd use AVAssetWriter to create proper MP4
        let chunkData = try await encodeFramesAsVideo(frames)
        let exportTimeMs = exportTimer.elapsedMs

        // Track chunk export
        await MainActor.run {
            TelemetryService.shared.trackChunkExported(size: chunkData.count, exportTimeMs: exportTimeMs)
        }

        // Clear buffer
        let timestamp = startTime
        frames.removeAll()
        frameTimestamps.removeAll()
        chunkStartTime = nil

        return (chunkData, timestamp, frameCount)
    }

    /// Simple frame encoding (placeholder - use AVAssetWriter for real MP4)
    private func encodeFramesAsVideo(_ frames: [UIImage]) async throws -> Data {
        // For mock development: just serialize first frame as JPEG
        // TODO: Use AVAssetWriter for real video encoding
        guard let firstFrame = frames.first,
              let data = firstFrame.jpegData(compressionQuality: 0.8) else {
            let error = TribeError.encodingError("Failed to encode frame")
            await MainActor.run {
                TelemetryService.shared.trackError(error, context: "encodeFramesAsVideo")
            }
            throw error
        }
        return data
    }

    /// Clear buffer without exporting
    func clear() {
        frames.removeAll()
        frameTimestamps.removeAll()
        chunkStartTime = nil
    }
}

// MARK: - Brain Service

/// Main service that coordinates video buffering and API calls
@MainActor
class TribeBrainService: ObservableObject {
    @Published var currentPrediction: BrainPrediction?
    @Published var connectionStatus: String = "Disconnected"
    @Published var isMockMode: Bool = false
    @Published var isEnabled: Bool = false

    // Telemetry data for UI
    @Published var framesInBuffer: Int = 0
    @Published var lastChunkSize: Int = 0
    @Published var lastAPILatency: Double = 0

    private let api: TribeBrainAPI
    private let chunkBuffer: VideoChunkBuffer
    private var processingTask: Task<Void, Never>?
    private var bufferUpdateTask: Task<Void, Never>?

    init(api: TribeBrainAPI? = nil) {
        self.api = api ?? TribeHTTPAPI()
        self.chunkBuffer = VideoChunkBuffer(chunkDuration: 2.0)
    }

    /// Start processing video frames
    func start() {
        isEnabled = true
        TelemetryService.shared.startSession()

        // Start buffer monitoring
        startBufferMonitoring()

        Task {
            await checkConnection()
        }
    }

    /// Stop processing
    func stop() async {
        isEnabled = false
        processingTask?.cancel()
        processingTask = nil
        bufferUpdateTask?.cancel()
        bufferUpdateTask = nil
        await chunkBuffer.clear()
        currentPrediction = nil
        framesInBuffer = 0

        TelemetryService.shared.endSession()
        TelemetryService.shared.logSummary()
    }

    /// Process incoming video frame from DAT SDK
    func processFrame(_ image: UIImage) async {
        guard isEnabled else { return }

        let timer = MetricsTimer()
        let timestamp = Date().timeIntervalSince1970

        await chunkBuffer.addFrame(image, timestamp: timestamp)

        // Track frame processing
        TelemetryService.shared.trackFrameProcessed(processingTimeMs: timer.elapsedMs)

        // Check if we have enough for a chunk
        if await chunkBuffer.isReady(timestamp: timestamp) {
            await sendChunkToAPI()
        }
    }

    private func startBufferMonitoring() {
        bufferUpdateTask = Task { [weak self] in
            while !Task.isCancelled {
                await Task.sleep(nanoseconds: 100_000_000)  // 100ms
                guard let self = self else { return }
                self.framesInBuffer = await self.chunkBuffer.frameCount
            }
        }
    }

    private func sendChunkToAPI() async {
        do {
            guard let (chunkData, timestamp, frameCount) = try await chunkBuffer.exportAndClear() else { return }

            connectionStatus = "Processing..."
            lastChunkSize = chunkData.count

            // Track chunk being sent
            TelemetryService.shared.trackChunkSent(size: chunkData.count)

            let apiTimer = MetricsTimer()
            let prediction = try await api.predictChunk(videoData: chunkData, timestamp: timestamp)
            lastAPILatency = apiTimer.elapsedMs

            self.currentPrediction = prediction
            self.connectionStatus = "Connected"
            self.isMockMode = prediction.mock
            self.framesInBuffer = await chunkBuffer.frameCount

            // Track prediction with individual parameters
            TelemetryService.shared.trackPrediction(
                visual: prediction.visualCortex,
                auditory: prediction.auditoryCortex,
                language: prediction.languageNetwork,
                prefrontal: prediction.prefrontal,
                motor: prediction.motor,
                isMock: prediction.mock
            )

        } catch {
            connectionStatus = "Error: \(error.localizedDescription)"
            TelemetryService.shared.trackError(error, context: "sendChunkToAPI")
        }
    }

    private func checkConnection() async {
        do {
            let health = try await api.healthCheck()
            connectionStatus = "Connected (\(health.status))"
            isMockMode = health.mode == "mock"
        } catch {
            connectionStatus = "Error: \(error.localizedDescription)"
            TelemetryService.shared.trackError(error, context: "checkConnection")
        }
    }

    /// Export telemetry report as JSON
    func exportTelemetry() -> Data? {
        return TelemetryService.shared.generateReport().jsonData
    }
}

// MARK: - Errors

enum TribeError: Error, LocalizedError {
    case apiError(String)
    case encodingError(String)

    var errorDescription: String? {
        switch self {
        case .apiError(let msg): return "API Error: \(msg)"
        case .encodingError(let msg): return "Encoding Error: \(msg)"
        }
    }
}
