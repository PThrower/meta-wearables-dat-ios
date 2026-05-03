/*
 * StageMetricsTypes.swift
 *
 * Per-stage CPU and memory metrics for pipeline monitoring.
 * Each stage self-reports wall-clock time, thread CPU time delta,
 * estimated memory, and frame counts.
 *
 * StageMetricsCollector samples these at 1Hz and pushes via stage_telemetry WS.
 */

import Foundation
import os

// MARK: - StageMetricsSnapshot

/// Per-stage metrics snapshot. Both wall-clock EMA and thread CPU time.
struct StageMetricsSnapshot: Sendable {
    let stageId: String
    let nodeType: String          // "vision-face-detect", "tracking-ocsort", etc.
    let wallClockMs: Double       // wall-clock time in processFrame (EMA)
    let cpuTimeMs: Double         // thread CPU time delta since last sample
    let memoryMB: Double          // estimated memory (stage self-report)
    let framesProcessed: UInt64   // frames since last sample
    let framesDropped: UInt64     // frames skipped due to throttle/error

    func toDict() -> [String: Any] {
        [
            "stageId": stageId,
            "nodeType": nodeType,
            "wallClockMs": wallClockMs,
            "cpuMs": cpuTimeMs,
            "memMB": memoryMB,
            "frames": framesProcessed,
            "dropped": framesDropped,
        ]
    }
}

// MARK: - ThreadCPUTime

/// Helper for thread CPU time measurement via mach thread_info.
enum ThreadCPUTime {
    /// Returns cumulative user+system CPU time in ms for the calling thread.
    static func currentMs() -> Double {
        var info = thread_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<thread_basic_info>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                thread_info(mach_thread_self(), thread_flavor_t(THREAD_BASIC_INFO), $0, &count)
            }
        }
        guard result == KERN_SUCCESS else { return 0 }
        let userMs = Int64(info.user_time.seconds) * 1000
            + Int64(info.user_time.microseconds) / 1000
        let sysMs = Int64(info.system_time.seconds) * 1000
            + Int64(info.system_time.microseconds) / 1000
        return Double(userMs + sysMs)
    }
}

// MARK: - StageMetricsTracker

/// Per-stage metrics accumulator. Each stage holds one of these.
/// Not an actor — protected by the enclosing stage's actor isolation.
struct StageMetricsTracker {
    let stageId: String
    let nodeType: String

    init(stageId: String, nodeType: String) {
        self.stageId = stageId
        self.nodeType = nodeType
    }

    private var wallClockEmaMs: Double = 0
    private let emaAlpha: Double = 0.3
    private var threadCpuAccumMs: Double = 0
    private var framesSinceLastSample: UInt64 = 0
    private var droppedSinceLastSample: UInt64 = 0
    private var estimatedMemoryMB: Double = 0

    /// Call at the start of processFrame() to capture thread CPU baseline.
    mutating func beginFrame() -> Double {
        return ThreadCPUTime.currentMs()
    }

    /// Call at the end of processFrame() with the baseline and wall-clock duration.
    mutating func endFrame(cpuStart: Double, wallClockMs: Double, dropped: Bool = false) {
        let cpuEnd = ThreadCPUTime.currentMs()
        let cpuDelta = max(0, cpuEnd - cpuStart)
        threadCpuAccumMs += cpuDelta

        // EMA for wall-clock
        if wallClockEmaMs == 0 {
            wallClockEmaMs = wallClockMs
        } else {
            wallClockEmaMs = emaAlpha * wallClockMs + (1 - emaAlpha) * wallClockEmaMs
        }

        framesSinceLastSample += 1
        if dropped { droppedSinceLastSample += 1 }
    }

    /// Record a dropped frame (throttled, error, etc.)
    mutating func recordDrop() {
        framesSinceLastSample += 1
        droppedSinceLastSample += 1
    }

    /// Update estimated memory (stage self-reports based on known allocations).
    mutating func setMemoryMB(_ mb: Double) {
        estimatedMemoryMB = mb
    }

    /// Collect and reset. Returns snapshot with accumulated values, counters reset.
    mutating func collect() -> StageMetricsSnapshot {
        let snapshot = StageMetricsSnapshot(
            stageId: stageId,
            nodeType: nodeType,
            wallClockMs: wallClockEmaMs,
            cpuTimeMs: threadCpuAccumMs,
            memoryMB: estimatedMemoryMB,
            framesProcessed: framesSinceLastSample,
            framesDropped: droppedSinceLastSample
        )
        // Reset accumulators but keep EMA
        threadCpuAccumMs = 0
        framesSinceLastSample = 0
        droppedSinceLastSample = 0
        return snapshot
    }
}
