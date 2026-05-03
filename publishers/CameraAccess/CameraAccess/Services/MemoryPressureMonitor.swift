/*
 * MemoryPressureMonitor.swift
 *
 * Monitors system memory pressure via DispatchSource and triggers
 * graceful degradation when the app approaches the per-process Jetsam limit.
 *
 * On 4GB devices (iPhone 13 mini, SE 3), the per-process Jetsam limit is ~2098MB.
 * The monitor activates at 85% of that threshold (~1780MB phys_footprint) and
 * progressively disables expensive pipeline stages to reclaim memory.
 *
 * Degradation priority (most memory-intensive first):
 *   1. YOLOStage — model weights + inference buffers (50-200MB)
 *   2. ObjectTrackingStage — Kalman filter state, appearance galleries
 *   3. ToolMeasurementStage — homography computation
 *   4. EmbeddingExtractor — OSNet model + inference buffers
 *   5. Flush CVPixelBuffer pools and CIContext caches
 */

import Foundation
import UIKit

/// Actions the monitor can request when memory pressure rises.
/// The ViewModel implements these to gracefully degrade pipeline stages.
struct MemoryPressureActions: OptionSet, Sendable {
    let rawValue: UInt
    /// Disable YOLO inference (highest memory consumer)
    static let disableYOLO = MemoryPressureActions(rawValue: 1 << 0)
    /// Disable object tracking
    static let disableTracking = MemoryPressureActions(rawValue: 1 << 1)
    /// Disable tool measurement
    static let disableMeasurement = MemoryPressureActions(rawValue: 1 << 2)
    /// Flush all buffer pools and CI caches
    static let flushCaches = MemoryPressureActions(rawValue: 1 << 3)
    /// Disable all inference stages (emergency)
    static let disableAllInference = MemoryPressureActions(rawValue: 1 << 4)
}

@MainActor
final class MemoryPressureMonitor {
    /// Callback delivering recommended actions based on memory pressure.
    var onPressureChange: (@Sendable (MemoryPressureActions) async -> Void)?

    /// Current process physical footprint in MB.
    /// Uses task_info(TASK_VM_INFO) phys_footprint — the metric the kernel tracks for Jetsam.
    static var currentFootprintMB: Double {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        guard result == KERN_SUCCESS else { return 0 }
        return Double(info.phys_footprint) / 1_048_576.0
    }

    // MARK: - Thresholds (MB)

    /// 4GB device per-process Jetsam limit
    private static let jetsamLimitMB: Double = 2098.0

    /// Warning: start disabling expensive stages (85% of limit)
    private static let warningThresholdMB: Double = jetsamLimitMB * 0.85  // ~1783MB

    /// Critical: disable all inference (92% of limit)
    private static let criticalThresholdMB: Double = jetsamLimitMB * 0.92  // ~1930MB

    // MARK: - Monitoring

    private var pressureSource: DispatchSourceMemoryPressure?
    private var periodicTimer: Task<Void, Never>?
    private var lastActions: MemoryPressureActions = []

    func start() {
        // System memory pressure dispatch source
        let source = DispatchSource.makeMemoryPressureSource(eventMask: [.warning, .critical], queue: DispatchQueue.main)
        source.setEventHandler { [weak self] in
            Task { @MainActor [weak self] in
                self?.checkAndNotify()
            }
        }
        source.resume()
        pressureSource = source

        // Periodic footprint check (every 10s) — catches gradual growth
        // that doesn't trigger the DispatchSource
        periodicTimer = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 10 * NSEC_PER_SEC)
                guard !Task.isCancelled else { return }
                await MainActor.run { [weak self] in
                    self?.checkAndNotify()
                }
            }
        }

        // UIApplication memory warning
        NotificationCenter.default.addObserver(
            forName: UIApplication.didReceiveMemoryWarningNotification,
            object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                NSLog("[MemoryPressure] UIApplication didReceiveMemoryWarning")
                var actions: MemoryPressureActions = [.flushCaches]
                if Self.currentFootprintMB > Self.warningThresholdMB {
                    actions.insert(.disableYOLO)
                }
                if Self.currentFootprintMB > Self.criticalThresholdMB {
                    actions.insert(.disableAllInference)
                }
                await self?.notify(actions)
            }
        }

        NSLog("[MemoryPressure] Monitor started (warning=\(String(format: "%.0f", Self.warningThresholdMB))MB, critical=\(String(format: "%.0f", Self.criticalThresholdMB))MB)")
    }

    func stop() {
        pressureSource?.cancel()
        pressureSource = nil
        periodicTimer?.cancel()
        periodicTimer = nil
        NotificationCenter.default.removeObserver(self)
        lastActions = []
        NSLog("[MemoryPressure] Monitor stopped")
    }

    // MARK: - Private

    private func checkAndNotify() {
        let footprintMB = Self.currentFootprintMB

        var actions: MemoryPressureActions = []

        if footprintMB > Self.criticalThresholdMB {
            NSLog("[MemoryPressure] CRITICAL: \(String(format: "%.0f", footprintMB))MB footprint")
            actions = [.disableAllInference, .flushCaches]
        } else if footprintMB > Self.warningThresholdMB {
            NSLog("[MemoryPressure] WARNING: \(String(format: "%.0f", footprintMB))MB footprint")
            actions = [.disableYOLO, .disableTracking, .disableMeasurement, .flushCaches]
        }

        // Only notify if actions changed (avoid spurious callbacks)
        if actions != lastActions {
            lastActions = actions
            if !actions.isEmpty {
                Task {
                    await onPressureChange?(actions)
                }
            }
        }
    }

    private func notify(_ actions: MemoryPressureActions) {
        lastActions = actions
        if !actions.isEmpty {
            Task {
                await onPressureChange?(actions)
            }
        }
    }
}
