/*
 * FramePipelineTypes.swift
 *
 * Core types for the video frame pipeline.
 * FramePacket is the immutable, Sendable unit that crosses isolation boundaries.
 * FramePipelineStage is the protocol every stage conforms to.
 */

import CoreMedia
import Foundation

// MARK: - FramePacket

/// Immutable, Sendable packet created on MainActor from VideoFrame.sampleBuffer.
/// Safe to share across actor boundaries.
struct FramePacket: @unchecked Sendable {
    let sampleBuffer: CMSampleBuffer
    let timestamp: ContinuousClock.Instant
    let sequenceNumber: UInt64
}

// MARK: - FrameStageConfig

/// Per-stage configuration controlling FPS throttle and enabled state.
struct FrameStageConfig: Sendable {
    let targetFPS: UInt
    let isEnabled: Bool

    static let maxFPS = FrameStageConfig(targetFPS: .max, isEnabled: true)

    init(targetFPS: UInt = 30, isEnabled: Bool = true) {
        self.targetFPS = targetFPS
        self.isEnabled = isEnabled
    }
}

// MARK: - FramePipelineStage

/// Protocol every pipeline stage conforms to.
/// Each stage is a Swift actor for thread safety without locks.
protocol FramePipelineStage: AnyObject, Sendable {
    nonisolated var stageId: String { get }
    var config: FrameStageConfig { get set }

    /// Process a single frame packet.
    func processFrame(_ packet: FramePacket) async

    /// Start the stage (allocate resources, open writers, etc.)
    func start() async

    /// Stop the stage (flush buffers, close writers, etc.)
    func stop() async
}

// Default no-op implementations
extension FramePipelineStage {
    func start() async {}
    func stop() async {}
}
