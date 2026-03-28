//
// TelemetryDebugView.swift
//
// Debug view showing all telemetry metrics for TRIBE v2 integration.
// Useful during development to monitor performance and diagnose issues.
//

import SwiftUI

struct TelemetryDebugView: View {
    @ObservedObject var telemetry = TelemetryService.shared
    @ObservedObject var brainService: TribeBrainService

    @State private var showExportSheet = false

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(spacing: 16) {
                    // Session Status
                    SessionStatusCard(isActive: telemetry.isSessionActive)

                    // Live Stats
                    LiveStatsCard(
                        framesInBuffer: brainService.framesInBuffer,
                        lastChunkSize: brainService.lastChunkSize,
                        lastAPILatency: brainService.lastAPILatency
                    )

                    // Frame Metrics
                    MetricsCard(title: "📷 Frames", icon: "camera.fill") {
                        MetricRow(label: "Total Received", value: "\(telemetry.frameMetrics.totalFramesReceived)")
                        MetricRow(label: "Processed", value: "\(telemetry.frameMetrics.framesProcessed)")
                        MetricRow(label: "Dropped", value: "\(telemetry.frameMetrics.framesDropped)")
                        MetricRow(label: "Avg Processing", value: String(format: "%.1f ms", telemetry.frameMetrics.averageProcessingTimeMs))
                    }

                    // Chunk Metrics
                    MetricsCard(title: "📦 Chunks", icon: "rectangle.stack.fill") {
                        MetricRow(label: "Exported", value: "\(telemetry.chunkMetrics.totalChunksExported)")
                        MetricRow(label: "Sent", value: "\(telemetry.chunkMetrics.totalChunksSent)")
                        MetricRow(label: "Avg Size", value: "\(telemetry.chunkMetrics.averageChunkSize) bytes")
                        MetricRow(label: "Avg Export", value: String(format: "%.1f ms", telemetry.chunkMetrics.averageExportTimeMs))
                    }

                    // Network Metrics
                    MetricsCard(title: "🌐 Network", icon: "network") {
                        MetricRow(label: "Total Requests", value: "\(telemetry.networkMetrics.totalRequests)")
                        MetricRow(label: "Successful", value: "\(telemetry.networkMetrics.successfulRequests)")
                        MetricRow(label: "Failed", value: "\(telemetry.networkMetrics.failedRequests)")
                        MetricRow(label: "Avg Latency", value: String(format: "%.1f ms", telemetry.networkMetrics.averageLatencyMs))
                        MetricRow(label: "Min/Max", value: String(format: "%.1f / %.1f ms", telemetry.networkMetrics.minLatencyMs == .infinity ? 0 : telemetry.networkMetrics.minLatencyMs, telemetry.networkMetrics.maxLatencyMs))
                        MetricRow(label: "Bytes Sent", value: "\(telemetry.networkMetrics.totalBytesSent)")
                        MetricRow(label: "Bytes Recv", value: "\(telemetry.networkMetrics.totalBytesReceived)")
                    }

                    // Prediction Metrics
                    MetricsCard(title: "🧠 Predictions", icon: "brain.head.profile") {
                        MetricRow(label: "Total", value: "\(telemetry.predictionMetrics.totalPredictions)")
                        MetricRow(label: "Avg Visual", value: String(format: "%.3f", telemetry.predictionMetrics.averageVisualActivation))
                        MetricRow(label: "Avg Auditory", value: String(format: "%.3f", telemetry.predictionMetrics.averageAuditoryActivation))
                        MetricRow(label: "Avg Language", value: String(format: "%.3f", telemetry.predictionMetrics.averageLanguageActivation))
                        MetricRow(label: "Avg Prefrontal", value: String(format: "%.3f", telemetry.predictionMetrics.averagePrefrontalActivation))
                        MetricRow(label: "Avg Motor", value: String(format: "%.3f", telemetry.predictionMetrics.averageMotorActivation))
                    }

                    // Error Metrics
                    MetricsCard(title: "❌ Errors", icon: "exclamationmark.triangle.fill") {
                        MetricRow(label: "Total", value: "\(telemetry.errorMetrics.totalErrors)")

                        if !telemetry.errorMetrics.errorsByType.isEmpty {
                            Divider()
                            Text("By Type:")
                                .font(.caption)
                                .foregroundColor(.gray)

                            ForEach(Array(telemetry.errorMetrics.errorsByType.sorted(by: { $0.value > $1.value })), id: \.key) { type, count in
                                MetricRow(label: type, value: "\(count)")
                            }
                        }

                        if !telemetry.errorMetrics.recentErrors.isEmpty {
                            Divider()
                            Text("Recent Errors:")
                                .font(.caption)
                                .foregroundColor(.gray)

                            ForEach(telemetry.errorMetrics.recentErrors.suffix(5), id: \.timestamp) { error in
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(error.type)
                                        .font(.caption2)
                                        .fontWeight(.bold)
                                        .foregroundColor(.red)
                                    Text(error.message)
                                        .font(.caption2)
                                        .foregroundColor(.gray)
                                        .lineLimit(2)
                                }
                                .padding(.vertical, 2)
                            }
                        }
                    }

                    // Actions
                    HStack(spacing: 16) {
                        Button(action: {
                            TelemetryService.shared.logSummary()
                        }) {
                            Label("Log Summary", systemImage: "doc.text")
                                .font(.caption)
                        }
                        .buttonStyle(.bordered)

                        Button(action: {
                            showExportSheet = true
                        }) {
                            Label("Export", systemImage: "square.and.arrow.up")
                                .font(.caption)
                        }
                        .buttonStyle(.bordered)

                        Button(action: {
                            TelemetryService.shared.reset()
                        }) {
                            Label("Reset", systemImage: "arrow.counterclockwise")
                                .font(.caption)
                        }
                        .buttonStyle(.bordered)
                    }
                    .padding(.vertical, 8)
                }
                .padding()
            }
            .navigationTitle("Telemetry")
            .navigationBarTitleDisplayMode(.inline)
            .sheet(isPresented: $showExportSheet) {
                TelemetryExportView(report: telemetry.generateReport())
            }
        }
    }
}

// MARK: - Component Views

struct SessionStatusCard: View {
    let isActive: Bool

    var body: some View {
        HStack {
            Circle()
                .fill(isActive ? Color.green : Color.red)
                .frame(width: 12, height: 12)

            Text(isActive ? "Session Active" : "Session Inactive")
                .font(.headline)

            Spacer()

            if isActive {
                Text("Recording...")
                    .font(.caption)
                    .foregroundColor(.green)
            }
        }
        .padding()
        .background(Color(.systemGray6))
        .cornerRadius(12)
    }
}

struct LiveStatsCard: View {
    let framesInBuffer: Int
    let lastChunkSize: Int
    let lastAPILatency: Double

    var body: some View {
        HStack(spacing: 24) {
            LiveStatItem(value: "\(framesInBuffer)", label: "Buffer")
            LiveStatItem(value: "\(lastChunkSize)", label: "Chunk (B)")
            LiveStatItem(value: String(format: "%.0fms", lastAPILatency), label: "Latency")
        }
        .padding()
        .background(Color(.systemGray6))
        .cornerRadius(12)
    }
}

struct LiveStatItem: View {
    let value: String
    let label: String

    var body: some View {
        VStack(spacing: 4) {
            Text(value)
                .font(.title2)
                .fontWeight(.bold)
                .foregroundColor(.blue)
            Text(label)
                .font(.caption2)
                .foregroundColor(.gray)
        }
    }
}

struct MetricsCard<Content: View>: View {
    let title: String
    let icon: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: icon)
                    .foregroundColor(.blue)
                Text(title)
                    .font(.headline)
            }

            content
        }
        .padding()
        .background(Color(.systemGray6))
        .cornerRadius(12)
    }
}

struct MetricRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack {
            Text(label)
                .font(.subheadline)
                .foregroundColor(.primary)
            Spacer()
            Text(value)
                .font(.subheadline)
                .fontWeight(.medium)
                .foregroundColor(.secondary)
        }
    }
}

struct TelemetryExportView: View {
    let report: TelemetryReport
    @Environment(\.dismiss) var dismiss

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let jsonData = report.jsonData,
                       let jsonString = String(data: jsonData, encoding: .utf8) {
                        Text(jsonString)
                            .font(.system(.caption, design: .monospaced))
                            .padding()
                            .background(Color(.systemGray6))
                            .cornerRadius(8)
                    } else {
                        Text("Failed to generate JSON")
                            .foregroundColor(.red)
                    }
                }
                .padding()
            }
            .navigationTitle("Export Telemetry")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Close") {
                        dismiss()
                    }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    if let jsonData = report.jsonData {
                        ShareLink(item: jsonData, preview: SharePreview("telemetry.json", image: Image(systemName: "doc.text")))
                    }
                }
            }
        }
    }
}

#Preview {
    TelemetryDebugView(brainService: TribeBrainService())
}
