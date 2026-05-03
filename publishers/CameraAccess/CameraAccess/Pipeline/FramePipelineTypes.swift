/*
 * FramePipelineTypes.swift
 *
 * Core types for the video frame pipeline.
 * FramePacket is the immutable, Sendable unit that crosses isolation boundaries.
 * FramePipelineStage is the protocol every stage conforms to.
 */

import CoreImage
import CoreMedia
import Foundation

// MARK: - FramePacket

/// Immutable, Sendable packet created on MainActor from VideoFrame.sampleBuffer.
/// `@unchecked Sendable` is safe here: CMSampleBuffer is a reference type but
/// CoreMedia guarantees thread-safety for read-only access. All pipeline stages
/// only read the buffer. If a stage needs to hold the buffer beyond processFrame(),
/// call copySampleBuffer() to get an independent deep copy.
struct FramePacket: @unchecked Sendable {
    let sampleBuffer: CMSampleBuffer
    let timestamp: ContinuousClock.Instant
    let sequenceNumber: UInt64

    /// Creates a deep copy of the underlying CMSampleBuffer.
    /// Use when a stage must retain the buffer beyond the processFrame() call.
    func copySampleBuffer() -> CMSampleBuffer? {
        var copy: CMSampleBuffer?
        let status = CMSampleBufferCreateCopy(allocator: kCFAllocatorDefault, sampleBuffer: sampleBuffer, sampleBufferOut: &copy)
        return status == noErr ? copy : nil
    }
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

    /// Collect per-stage metrics for telemetry. Override in stages that track metrics.
    func collectMetrics() -> StageMetricsSnapshot? { nil }
}

// MARK: - Shared CIContext

/// Pipeline-wide shared CIContext.
/// CIContext is expensive to create (backs onto Metal/EAGL context).
/// Sharing one instance avoids Metal context thrashing across stages.
/// Safe to use from any isolation domain — CIContext is thread-safe.
enum PipelineCIContext {
    static let shared = CIContext(options: [.useSoftwareRenderer: false])
}
