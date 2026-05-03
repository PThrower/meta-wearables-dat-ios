/*
 * FramePipelineManager.swift
 *
 * MainActor single subscriber to videoFramePublisher.
 * Extracts CMSampleBuffer from VideoFrame, wraps in FramePacket,
 * dispatches to each registered stage via Task.detached.
 */

import CoreMedia
import Foundation
import MWDATCamera
import MWDATCore

// THREADING REVIEW: [SAFE]
// Marked @MainActor. videoFramePublisher listener dispatches to @MainActor.
// Stage dispatch uses Task.detached which correctly hops to each actor's executor.
// No @MainActor-isolated APIs called from wrong contexts.
@MainActor
final class FramePipelineManager {
    private var stages: [any FramePipelineStage] = []
    private var sequenceNumber: UInt64 = 0
    private var listenerToken: AnyListenerToken?

    // Pre-broadcast transform stage (frame enhancements). nil = no transform.
    var transformStage: FrameTransformStage?

    // MARK: - Stage Registration

    func register(_ stage: any FramePipelineStage) {
        stages.append(stage)
        NSLog("[Pipeline] Registered stage: \(stage.stageId)")
    }

    func unregister(stageId: String) {
        stages.removeAll { $0.stageId == stageId }
        NSLog("[Pipeline] Unregistered stage: \(stageId)")
    }

    // MARK: - SDK Attachment

    /// Attach as the single subscriber to a StreamSession's videoFramePublisher.
    func attachToStreamSession(_ session: StreamSession) {
        // Invalidate old token
        listenerToken = nil

        listenerToken = session.videoFramePublisher.listen { [weak self] videoFrame in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.onVideoFrame(videoFrame)
            }
        }
        NSLog("[Pipeline] Attached to StreamSession")
    }

    /// Detach from the current StreamSession.
    func detachFromStreamSession() {
        listenerToken = nil
        NSLog("[Pipeline] Detached from StreamSession")
    }

    // MARK: - Raw Buffer Injection (Phone Camera)

    /// Inject a raw CMSampleBuffer into the pipeline.
    /// Used by PhoneCameraCapture to bypass StreamSession entirely.
    /// Stages receive identical FramePackets -- they cannot distinguish the source.
    func onRawSampleBuffer(_ sampleBuffer: CMSampleBuffer) {
        sequenceNumber += 1

        let finalBuffer = applyTransform(sampleBuffer)

        let packet = FramePacket(
            sampleBuffer: finalBuffer,
            timestamp: .now,
            sequenceNumber: sequenceNumber
        )

        for stage in stages {
            guard stage.config.isEnabled else { continue }
            Task.detached { [stage] in
                await stage.processFrame(packet)
            }
        }
    }

    // MARK: - Frame Dispatch

    private func onVideoFrame(_ videoFrame: VideoFrame) {
        let sampleBuffer = videoFrame.sampleBuffer
        sequenceNumber += 1

        // Apply pre-broadcast transform chain (frame enhancements) if configured.
        // Transform is synchronous GPU work (<3ms) — runs inline before fan-out.
        let finalBuffer = applyTransform(sampleBuffer)

        let packet = FramePacket(
            sampleBuffer: finalBuffer,
            timestamp: .now,
            sequenceNumber: sequenceNumber
        )

        for stage in stages {
            guard stage.config.isEnabled else { continue }
            Task.detached { [stage] in
                await stage.processFrame(packet)
            }
        }
    }

    // MARK: - Transform Helper

    /// Apply the enhancement transform chain to a CMSampleBuffer.
    /// Returns enhanced buffer or the original if no transform is configured / on failure.
    private func applyTransform(_ sampleBuffer: CMSampleBuffer) -> CMSampleBuffer {
        guard let transform = transformStage else { return sampleBuffer }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return sampleBuffer }

        let enhanced = transform.transform(pixelBuffer)

        // Same buffer = no enhancement applied (disabled or empty chain)
        if enhanced === pixelBuffer { return sampleBuffer }

        // Create new CMSampleBuffer from the enhanced pixel buffer.
        // Must derive format description from the enhanced buffer (BGRA) rather than
        // reusing the original's format description (may be a different pixel format).
        var formatDescription: CMVideoFormatDescription?
        CMVideoFormatDescriptionCreateForImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: enhanced,
            formatDescriptionOut: &formatDescription
        )
        guard let fmtDesc = formatDescription else { return sampleBuffer }

        var newSampleBuffer: CMSampleBuffer?
        var timingInfo = CMSampleTimingInfo(
            duration: CMSampleBufferGetDuration(sampleBuffer),
            presentationTimeStamp: CMSampleBufferGetPresentationTimeStamp(sampleBuffer),
            decodeTimeStamp: CMSampleBufferGetDecodeTimeStamp(sampleBuffer)
        )

        let status = CMSampleBufferCreateReadyWithImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: enhanced,
            formatDescription: fmtDesc,
            sampleTiming: &timingInfo,
            sampleBufferOut: &newSampleBuffer
        )

        return status == noErr ? (newSampleBuffer ?? sampleBuffer) : sampleBuffer
    }

    // MARK: - Lifecycle

    /// Start all registered stages.
    func startAll() async {
        for stage in stages {
            await stage.start()
        }
        NSLog("[Pipeline] All stages started (\(stages.count))")
    }

    /// Stop all registered stages.
    func stopAll() async {
        for stage in stages {
            await stage.stop()
        }
        NSLog("[Pipeline] All stages stopped (\(stages.count))")
    }

    // MARK: - Metrics Access (for StageMetricsCollector)

    /// Returns a snapshot of all registered stages for metrics collection.
    /// Called from StageMetricsCollector actor — crosses to MainActor.
    func getStagesForMetrics() -> [any FramePipelineStage] {
        return stages
    }

    /// Collect metrics from the transform stage if present.
    func getTransformMetrics() -> StageMetricsSnapshot? {
        return transformStage?.collectMetrics()
    }
}
