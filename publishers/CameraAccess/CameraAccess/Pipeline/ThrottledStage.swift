/*
 * ThrottledStage.swift
 *
 * Actor base class providing per-stage FPS throttling.
 * Subclasses override processThrottledFrame(_:) — the throttle
 * drops frames that arrive faster than the configured targetFPS.
 */

import CoreMedia
import Foundation

actor ThrottledStage: @preconcurrency FramePipelineStage {
    nonisolated let stageId: String
    var config: FrameStageConfig

    // Throttle state
    private var lastProcessedTimestamp: ContinuousClock.Instant?
    private var minimumInterval: Duration {
        guard config.targetFPS > 0 else { return .zero }
        let ns = UInt64(1_000_000_000) / UInt64(config.targetFPS)
        return .nanoseconds(Int64(ns))
    }

    init(stageId: String, config: FrameStageConfig = .maxFPS) {
        self.stageId = stageId
        self.config = config
    }

    // MARK: - FramePipelineStage

    nonisolated func processFrame(_ packet: FramePacket) async {
        await throttledProcess(packet)
    }

    func start() async {
        lastProcessedTimestamp = nil
    }

    func stop() async {
        lastProcessedTimestamp = nil
    }

    // MARK: - Throttle Logic

    private func throttledProcess(_ packet: FramePacket) {
        guard config.isEnabled else { return }

        if let last = lastProcessedTimestamp {
            let elapsed = packet.timestamp - last
            if elapsed < minimumInterval {
                return // Drop — too soon
            }
        }

        lastProcessedTimestamp = packet.timestamp
        processThrottledFrame(packet)
    }

    /// Override in subclass to handle throttled frames.
    func processThrottledFrame(_ packet: FramePacket) {
        // No-op by default
    }
}
