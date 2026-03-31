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

@MainActor
final class FramePipelineManager {
    private var stages: [any FramePipelineStage] = []
    private var sequenceNumber: UInt64 = 0
    private var listenerToken: AnyListenerToken?

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

    // MARK: - Frame Dispatch

    private func onVideoFrame(_ videoFrame: VideoFrame) {
        let sampleBuffer = videoFrame.sampleBuffer

        sequenceNumber += 1
        let packet = FramePacket(
            sampleBuffer: sampleBuffer,
            timestamp: .now,
            sequenceNumber: sequenceNumber
        )

        for stage in stages {
            guard stage.config.isEnabled else { continue }
            // Fire-and-forget to each stage actor — never blocks main thread
            Task.detached { [stage] in
                await stage.processFrame(packet)
            }
        }
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
}
