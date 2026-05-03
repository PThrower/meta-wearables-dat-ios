/*
 * StageMetricsCollector.swift
 *
 * Actor that collects per-stage metrics from all active pipeline stages.
 * Produces a `stage_telemetry` JSON payload at 1Hz for relay to the server.
 *
 * Two registries:
 *   1. Pipeline stages (FramePipelineStage) — registered via FramePipelineManager
 *   2. Standalone stages (AudioClassificationStage, LocationStage, etc.) — registered separately
 *
 * Also includes process-level stats (total CPU, memory footprint, thermal state).
 */

import Foundation

actor StageMetricsCollector {
    // Standalone stages that don't conform to FramePipelineStage
    private var standaloneMetrics: [() -> StageMetricsSnapshot?] = []

    // Weak reference to pipeline manager for iterating registered stages
    private weak var pipelineManager: FramePipelineManager?

    init(pipelineManager: FramePipelineManager) {
        self.pipelineManager = pipelineManager
    }

    /// Register a standalone stage's metrics collector closure.
    func registerStandalone(_ collector: @escaping () -> StageMetricsSnapshot?) {
        standaloneMetrics.append(collector)
    }

    /// Clear all standalone collectors (called on teardown).
    func clearStandalones() {
        standaloneMetrics.removeAll()
    }

    /// Collect metrics from all sources and produce telemetry dict.
    func telemetryDict() async -> [String: Any] {
        var stageSnapshots: [[String: Any]] = []

        // 1. Collect from pipeline stages (MainActor-bound)
        if let manager = pipelineManager {
            let stages = await manager.getStagesForMetrics()
            for stage in stages {
                if let snapshot = stage.collectMetrics() {
                    stageSnapshots.append(snapshot.toDict())
                }
            }
            // Transform stage (enhance)
            if let transformSnapshot = await manager.getTransformMetrics() {
                stageSnapshots.append(transformSnapshot.toDict())
            }
        }

        // 2. Collect from standalone stages
        for collector in standaloneMetrics {
            if let snapshot = collector() {
                stageSnapshots.append(snapshot.toDict())
            }
        }

        // 3. Process-level stats
        let processInfo = Self.collectProcessInfo()

        return [
            "type": "stage_telemetry",
            "stages": stageSnapshots,
            "process": processInfo,
        ]
    }

    // MARK: - Process-Level Info

    private static func collectProcessInfo() -> [String: Any] {
        // Memory footprint via task_basic_info
        var memoryMB: Double = 0
        var taskInfo = task_basic_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_basic_info_data_t>.size / MemoryLayout<natural_t>.size)
        let taskResult = withUnsafeMutablePointer(to: &taskInfo) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_BASIC_INFO), $0, &count)
            }
        }
        if taskResult == KERN_SUCCESS {
            memoryMB = Double(taskInfo.resident_size) / (1024.0 * 1024.0)
        }

        // Thermal state
        let thermal: String
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: thermal = "nominal"
        case .fair: thermal = "fair"
        case .serious: thermal = "serious"
        case .critical: thermal = "critical"
        @unknown default: thermal = "unknown"
        }

        return [
            "memoryMB": memoryMB,
            "thermal": thermal,
        ]
    }
}
