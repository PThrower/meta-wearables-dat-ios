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

// MARK: - Snapshot Configuration

/// Controls how a pipeline stage creates its per-frame CVPixelBuffer snapshot.
///
/// Stages run via `Task.detached` fan-out — the original camera buffer may be
/// recycled by the SDK before the actor processes it. Each stage that needs to
/// read pixel data must create its own snapshot in the `nonisolated processFrame`
/// before hopping to actor isolation.
///
/// Memory budget per snapshot (BGRA, 4 bytes/pixel):
///   - 1920x1080 (full):   ~8.3 MB
///   - 1280x720 (high):    ~3.7 MB
///   - 960x540  (medium):  ~2.1 MB
///   - 640x360  (low):     ~0.9 MB
///
/// On 4GB devices (2GB per-process Jetsam limit), prefer `.medium` or `.low`
/// for inference-only stages. Stages that extract thumbnails/embeddings from
/// the original resolution should use `.full` or `.high`.
struct SnapshotConfig: Sendable {
    /// Sizing strategy for the snapshot buffer.
    enum Sizing: Sendable {
        /// Full source resolution, no downscaling.
        case full

        /// Downscale so the longest dimension fits `maxDimension`, preserving aspect ratio.
        /// E.g. maxDimension=960 on a 1920x1080 source produces 960x540.
        case capped(maxDimension: Int)

        /// Fixed output size. The source image is rendered to exactly this size.
        /// WARNING: If the aspect ratio doesn't match the source, the image will be
        /// distorted. Prefer `.capped` for inference stages.
        case fixed(width: Int, height: Int)
    }

    let sizing: Sizing

    /// Create a snapshot from a source pixel buffer using this configuration.
    /// Returns nil if the source is invalid or buffer allocation fails.
    /// Must be called from a nonisolated or synchronous context (same thread as frame arrival).
    nonisolated func createSnapshot(from source: CVPixelBuffer) -> CVPixelBuffer? {
        let srcWidth = CVPixelBufferGetWidth(source)
        let srcHeight = CVPixelBufferGetHeight(source)
        guard srcWidth > 0, srcHeight > 0 else { return nil }

        let (outWidth, outHeight): (Int, Int) = {
            switch sizing {
            case .full:
                return (srcWidth, srcHeight)
            case .capped(let maxDim):
                let scale = min(Double(maxDim) / Double(srcWidth), Double(maxDim) / Double(srcHeight), 1.0)
                return (max(1, Int(Double(srcWidth) * scale)), max(1, Int(Double(srcHeight) * scale)))
            case .fixed(let w, let h):
                return (w, h)
            }
        }()

        var buffer: CVPixelBuffer?
        let attrs: [String: Any] = [
            kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any]
        ]
        guard CVPixelBufferCreate(
            kCFAllocatorDefault, outWidth, outHeight,
            kCVPixelFormatType_32BGRA, attrs as CFDictionary, &buffer
        ) == kCVReturnSuccess, let buffer else {
            return nil
        }

        PipelineCIContext.shared.render(
            CIImage(cvPixelBuffer: source),
            to: buffer,
            bounds: CGRect(x: 0, y: 0, width: outWidth, height: outHeight),
            colorSpace: CGColorSpaceCreateDeviceRGB()
        )
        return buffer
    }

    /// Convenience: create a snapshot directly from a CMSampleBuffer's image buffer.
    nonisolated func createSnapshot(from sampleBuffer: CMSampleBuffer) -> CVPixelBuffer? {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return nil }
        return createSnapshot(from: pixelBuffer)
    }

    // MARK: - Presets

    /// Full source resolution — for stages that need pixel-perfect data
    /// (thumbnails, embeddings, measurement).
    static let full = SnapshotConfig(sizing: .full)

    /// High quality downscale (max 1280) — ~3.7MB for 16:9. Good balance for
    /// stages that need detail but not full resolution.
    static let high = SnapshotConfig(sizing: .capped(maxDimension: 1280))

    /// Medium quality downscale (max 960) — ~2.1MB for 16:9.
    /// Recommended for inference stages (YOLO, Vision) on 4GB devices.
    static let medium = SnapshotConfig(sizing: .capped(maxDimension: 960))

    /// Low quality downscale (max 640) — ~0.9MB for 16:9.
    /// For lightweight stages where detection quality is less critical.
    static let low = SnapshotConfig(sizing: .capped(maxDimension: 640))
}
