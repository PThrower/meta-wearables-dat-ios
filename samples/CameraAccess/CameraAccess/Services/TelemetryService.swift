//
// TelemetryService.swift
//
// Comprehensive telemetry and observability for TRIBE v2 integration.
// Tracks frame rates, API latency, chunk processing, errors, and brain predictions.
//

import Foundation
import OSLog

// MARK: - Telemetry Logger

/// Centralized telemetry logging using Apple's OSLog
enum TelemetryLogger {
    private static let subsystem = "com.tribe.brain-service"

    static let brain = Logger(subsystem: subsystem, category: "BrainPrediction")
    static let network = Logger(subsystem: subsystem, category: "Network")
    static let frames = Logger(subsystem: subsystem, category: "Frames")
    static let chunks = Logger(subsystem: subsystem, category: "Chunks")
    static let performance = Logger(subsystem: subsystem, category: "Performance")
    static let errors = Logger(subsystem: subsystem, category: "Errors")
}

// MARK: - Metrics Types

/// Frame processing metrics
struct FrameMetrics {
    var totalFramesReceived: Int = 0
    var framesProcessed: Int = 0
    var framesDropped: Int = 0
    var averageProcessingTimeMs: Double = 0
    var lastFrameTimestamp: Double = 0

    mutating func recordFrame(processed: Bool, processingTimeMs: Double) {
        totalFramesReceived += 1
        if processed {
            framesProcessed += 1
            // Rolling average
            averageProcessingTimeMs = (averageProcessingTimeMs * Double(framesProcessed - 1) + processingTimeMs) / Double(framesProcessed)
        } else {
            framesDropped += 1
        }
        lastFrameTimestamp = Date().timeIntervalSince1970
    }
}

/// Chunk export metrics
struct ChunkMetrics {
    var totalChunksExported: Int = 0
    var totalChunksSent: Int = 0
    var averageChunkSize: Int = 0
    var averageExportTimeMs: Double = 0
    var lastChunkTimestamp: Double = 0

    mutating func recordExport(size: Int, exportTimeMs: Double, sent: Bool) {
        totalChunksExported += 1
        if sent {
            totalChunksSent += 1
        }
        // Rolling averages
        averageChunkSize = (averageChunkSize * (totalChunksExported - 1) + size) / totalChunksExported
        averageExportTimeMs = (averageExportTimeMs * Double(totalChunksExported - 1) + exportTimeMs) / Double(totalChunksExported)
        lastChunkTimestamp = Date().timeIntervalSince1970
    }
}

/// API/network metrics
struct NetworkMetrics {
    var totalRequests: Int = 0
    var successfulRequests: Int = 0
    var failedRequests: Int = 0
    var averageLatencyMs: Double = 0
    var minLatencyMs: Double = .infinity
    var maxLatencyMs: Double = 0
    var totalBytesSent: Int = 0
    var totalBytesReceived: Int = 0
    var lastRequestTimestamp: Double = 0

    mutating func recordRequest(
        success: Bool,
        latencyMs: Double,
        bytesSent: Int,
        bytesReceived: Int
    ) {
        totalRequests += 1
        if success {
            successfulRequests += 1
        } else {
            failedRequests += 1
        }

        // Update latency stats
        averageLatencyMs = (averageLatencyMs * Double(totalRequests - 1) + latencyMs) / Double(totalRequests)
        minLatencyMs = min(minLatencyMs, latencyMs)
        maxLatencyMs = max(maxLatencyMs, latencyMs)

        totalBytesSent += bytesSent
        totalBytesReceived += bytesReceived
        lastRequestTimestamp = Date().timeIntervalSince1970
    }
}

/// Brain prediction metrics
struct PredictionMetrics {
    var totalPredictions: Int = 0
    var averageVisualActivation: Double = 0
    var averageAuditoryActivation: Double = 0
    var averageLanguageActivation: Double = 0
    var averagePrefrontalActivation: Double = 0
    var averageMotorActivation: Double = 0
    var lastPredictionTimestamp: Double = 0
    var predictionRate: Double = 0  // predictions per second

    mutating func recordPrediction(
        visual: Float,
        auditory: Float,
        language: Float,
        prefrontal: Float,
        motor: Float
    ) {
        totalPredictions += 1
        let n = Double(totalPredictions)

        // Rolling averages for each ROI
        averageVisualActivation = (averageVisualActivation * (n - 1) + Double(visual)) / n
        averageAuditoryActivation = (averageAuditoryActivation * (n - 1) + Double(auditory)) / n
        averageLanguageActivation = (averageLanguageActivation * (n - 1) + Double(language)) / n
        averagePrefrontalActivation = (averagePrefrontalActivation * (n - 1) + Double(prefrontal)) / n
        averageMotorActivation = (averageMotorActivation * (n - 1) + Double(motor)) / n

        lastPredictionTimestamp = Date().timeIntervalSince1970
    }
}

/// Error tracking
struct ErrorMetrics {
    var totalErrors: Int = 0
    var errorsByType: [String: Int] = [:]
    var recentErrors: [(timestamp: Double, message: String, type: String)] = []
    let maxRecentErrors = 50

    mutating func recordError(_ error: Error, context: String? = nil) {
        totalErrors += 1

        let errorType = String(describing: type(of: error))
        errorsByType[errorType, default: 0] += 1

        let message = context.map { "\($0): \(error.localizedDescription)" } ?? error.localizedDescription
        recentErrors.append((Date().timeIntervalSince1970, message, errorType))

        // Keep only recent errors
        if recentErrors.count > maxRecentErrors {
            recentErrors.removeFirst()
        }
    }
}

// MARK: - Telemetry Service

/// Central telemetry service that aggregates all metrics
@MainActor
class TelemetryService: ObservableObject {
    static let shared = TelemetryService()

    // Published metrics for UI display
    @Published var frameMetrics = FrameMetrics()
    @Published var chunkMetrics = ChunkMetrics()
    @Published var networkMetrics = NetworkMetrics()
    @Published var predictionMetrics = PredictionMetrics()
    @Published var errorMetrics = ErrorMetrics()

    // Session tracking
    @Published var sessionStartTime: Date?
    @Published var isSessionActive: Bool = false

    private init() {}

    // MARK: - Session Management

    func startSession() {
        sessionStartTime = Date()
        isSessionActive = true
        TelemetryLogger.brain.info("🧠 TRIBE v2 session started")
    }

    func endSession() {
        isSessionActive = false
        if let startTime = sessionStartTime {
            let duration = Date().timeIntervalSince(startTime)
            TelemetryLogger.brain.info("🧠 TRIBE v2 session ended - Duration: \(duration)s")
        }
        sessionStartTime = nil
    }

    // MARK: - Frame Tracking

    func trackFrameReceived() {
        TelemetryLogger.frames.debug("📷 Frame received")
    }

    func trackFrameProcessed(processingTimeMs: Double) {
        frameMetrics.recordFrame(processed: true, processingTimeMs: processingTimeMs)
        TelemetryLogger.frames.debug("✅ Frame processed in \(processingTimeMs)ms")
    }

    func trackFrameDropped(reason: String) {
        frameMetrics.recordFrame(processed: false, processingTimeMs: 0)
        TelemetryLogger.frames.warning("⚠️ Frame dropped: \(reason)")
    }

    // MARK: - Chunk Tracking

    func trackChunkExported(size: Int, exportTimeMs: Double) {
        chunkMetrics.recordExport(size: size, exportTimeMs: exportTimeMs, sent: false)
        TelemetryLogger.chunks.info("📦 Chunk exported - Size: \(size) bytes, Time: \(exportTimeMs)ms")
    }

    func trackChunkSent(size: Int) {
        chunkMetrics.totalChunksSent += 1
        TelemetryLogger.chunks.info("📤 Chunk sent - Size: \(size) bytes")
    }

    // MARK: - API Tracking

    func trackAPIRequest(
        endpoint: String,
        success: Bool,
        latencyMs: Double,
        bytesSent: Int,
        bytesReceived: Int
    ) {
        networkMetrics.recordRequest(
            success: success,
            latencyMs: latencyMs,
            bytesSent: bytesSent,
            bytesReceived: bytesReceived
        )

        let status = success ? "✅" : "❌"
        TelemetryLogger.network.info("\(status) API \(endpoint) - Latency: \(latencyMs)ms, Sent: \(bytesSent)B, Recv: \(bytesReceived)B")
    }

    // MARK: - Network Tracking

    func trackAPIRequest(
        endpoint: String,
        success: Bool,
        latencyMs: Double,
        bytesSent: Int,
        bytesReceived: Int
    ) {
        networkMetrics.recordRequest(
            success: success,
            latencyMs: latencyMs,
            bytesSent: bytesSent,
            bytesReceived: bytesReceived
        )

        let status = success ? "✅" : "❌"
        TelemetryLogger.network.info("\(status) API \(endpoint) - Latency: \(latencyMs)ms, Sent: \(bytesSent)B, Recv: \(bytesReceived)B")
    }

    // MARK: - Prediction Tracking

    func trackPrediction(
        visual: Float,
        auditory: Float,
        language: Float,
        prefrontal: Float,
        motor: Float,
        isMock: Bool
    ) {
        predictionMetrics.recordPrediction(
            visual: visual,
            auditory: auditory,
            language: language,
            prefrontal: prefrontal,
            motor: motor
        )

        TelemetryLogger.brain.info("""
        🧠 Brain prediction received:
           Visual: \(visual)
           Auditory: \(auditory)
           Language: \(language)
           Prefrontal: \(prefrontal)
           Motor: \(motor)
           Mock: \(isMock)
        """)
    }

    // MARK: - Error Tracking

    func trackError(_ error: Error, context: String? = nil) {
        errorMetrics.recordError(error, context: context)

        let contextStr = context.map { " [\($0)]" } ?? ""
        TelemetryLogger.errors.error("❌ Error\(contextStr): \(error.localizedDescription)")
    }

    // MARK: - Performance Reporting

    func generateReport() -> TelemetryReport {
        let duration = sessionStartTime.map { Date().timeIntervalSince($0) } ?? 0

        return TelemetryReport(
            sessionDurationSeconds: duration,
            frames: frameMetrics,
            chunks: chunkMetrics,
            network: networkMetrics,
            predictions: predictionMetrics,
            errors: errorMetrics
        )
    }

    /// Log a summary report
    func logSummary() {
        let report = generateReport()

        TelemetryLogger.performance.info("""
        ═══════════════════════════════════════════
        TRIBE v2 Performance Summary
        ═══════════════════════════════════════════
        Session Duration: \(report.sessionDurationSeconds)s

        📷 Frames:
           Total Received: \(report.frames.totalFramesReceived)
           Processed: \(report.frames.framesProcessed)
           Dropped: \(report.frames.framesDropped)
           Avg Processing: \(report.frames.averageProcessingTimeMs)ms

        📦 Chunks:
           Exported: \(report.chunks.totalChunksExported)
           Sent: \(report.chunks.totalChunksSent)
           Avg Size: \(report.chunks.averageChunkSize) bytes
           Avg Export: \(report.chunks.averageExportTimeMs)ms

        🌐 Network:
           Total Requests: \(report.network.totalRequests)
           Successful: \(report.network.successfulRequests)
           Failed: \(report.network.failedRequests)
           Avg Latency: \(report.network.averageLatencyMs)ms
           Min/Max: \(report.network.minLatencyMs)ms / \(report.network.maxLatencyMs)ms

        🧠 Predictions:
           Total: \(report.predictions.totalPredictions)
           Avg Visual: \(report.predictions.averageVisualActivation)
           Avg Language: \(report.predictions.averageLanguageActivation)

        ❌ Errors:
           Total: \(report.errors.totalErrors)
           By Type: \(report.errors.errorsByType)
        ═══════════════════════════════════════════
        """)
    }

    /// Reset all metrics
    func reset() {
        frameMetrics = FrameMetrics()
        chunkMetrics = ChunkMetrics()
        networkMetrics = NetworkMetrics()
        predictionMetrics = PredictionMetrics()
        errorMetrics = ErrorMetrics()
        sessionStartTime = nil
        isSessionActive = false
    }
}

// MARK: - Report Structure

struct TelemetryReport {
    let sessionDurationSeconds: Double
    let frames: FrameMetrics
    let chunks: ChunkMetrics
    let network: NetworkMetrics
    let predictions: PredictionMetrics
    let errors: ErrorMetrics

    /// Convert to JSON for export
    var jsonData: Data? {
        let dict: [String: Any] = [
            "sessionDurationSeconds": sessionDurationSeconds,
            "frames": [
                "totalReceived": frames.totalFramesReceived,
                "processed": frames.framesProcessed,
                "dropped": frames.framesDropped,
                "avgProcessingMs": frames.averageProcessingTimeMs
            ],
            "chunks": [
                "exported": chunks.totalChunksExported,
                "sent": chunks.totalChunksSent,
                "avgSize": chunks.averageChunkSize,
                "avgExportMs": chunks.averageExportTimeMs
            ],
            "network": [
                "totalRequests": network.totalRequests,
                "successful": network.successfulRequests,
                "failed": network.failedRequests,
                "avgLatencyMs": network.averageLatencyMs,
                "minLatencyMs": network.minLatencyMs == .infinity ? 0 : network.minLatencyMs,
                "maxLatencyMs": network.maxLatencyMs,
                "bytesSent": network.totalBytesSent,
                "bytesReceived": network.totalBytesReceived
            ],
            "predictions": [
                "total": predictions.totalPredictions,
                "avgVisual": predictions.averageVisualActivation,
                "avgAuditory": predictions.averageAuditoryActivation,
                "avgLanguage": predictions.averageLanguageActivation,
                "avgPrefrontal": predictions.averagePrefrontalActivation,
                "avgMotor": predictions.averageMotorActivation
            ],
            "errors": [
                "total": errors.totalErrors,
                "byType": errors.errorsByType
            ]
        ]

        return try? JSONSerialization.data(withJSONObject: dict, options: .prettyPrinted)
    }
}

// MARK: - Timing Helper

/// Simple timer for measuring elapsed time
struct MetricsTimer {
    private let startTime = Date()

    var elapsedMs: Double {
        Date().timeIntervalSince(startTime) * 1000
    }

    var elapsedSeconds: Double {
        Date().timeIntervalSince(startTime)
    }
}
