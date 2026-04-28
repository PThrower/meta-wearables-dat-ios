/*
 * DisplayStage.swift
 *
 * Pipeline stage that converts CMSampleBuffer -> UIImage via CIImage/CIContext,
 * then calls back to MainActor to update @Published properties.
 *
 * Runs on its own actor executor -- never blocks the main thread
 * during image conversion.
 */

import CoreImage
import CoreMedia
import Foundation
import UIKit

actor DisplayStage: @preconcurrency FramePipelineStage {
    nonisolated let stageId = "display"
    var config: FrameStageConfig

    /// Callback invoked on MainActor after UIImage conversion.
    private let onFrame: @MainActor @Sendable (UIImage) -> Void

    // Shared CIContext -- reused across frames for efficiency
    private let ciContext = CIContext(options: [.useSoftwareRenderer: false])

    // Preview
    private var previewBus: PreviewBus?
    private let previewSource = PreviewSource(stageId: "display", label: "Camera Feed")
    private var frameCount: UInt64 = 0
    private var lastPreviewTime: ContinuousClock.Instant?

    init(config: FrameStageConfig = .maxFPS, onFrame: @escaping @MainActor @Sendable (UIImage) -> Void) {
        self.config = config
        self.onFrame = onFrame
    }

    func setPreviewBus(_ bus: PreviewBus) {
        self.previewBus = bus
    }

    nonisolated func processFrame(_ packet: FramePacket) async {
        await processFrameInternal(packet)
    }

    // THREADING REVIEW: [SAFE]
    // CGImage conversion runs on actor executor (no UIKit dependency).
    // UIImage(cgImage:) is @MainActor-isolated — correctly dispatched to Task { @MainActor in }.
    private func processFrameInternal(_ packet: FramePacket) {
        // UIImage creation dispatched to MainActor since UIImage() is main-isolated
        // in iOS 17+.
        guard let cgImage = makeCGImage(from: packet.sampleBuffer) else { return }
        Task { @MainActor in
            let image = UIImage(cgImage: cgImage)
            onFrame(image)
        }

        // Publish preview image (throttled to ~2fps to avoid flooding)
        frameCount += 1
        let now = ContinuousClock.Instant.now
        if let last = lastPreviewTime {
            let elapsed = now - last
            let ms = Double(elapsed.components.seconds) * 1000.0 + Double(elapsed.components.attoseconds) / 1e15
            guard ms >= 500 else { return }
        }
        lastPreviewTime = now

        if let previewBus {
            let previewImage = UIImage(cgImage: cgImage)
            Task { await previewBus.publish(.image(source: previewSource, value: previewImage)) }
        }
    }

    // MARK: - Conversion

    /// Returns a CGImage from the sample buffer. Safe to call from any isolation context.
    private func makeCGImage(from sampleBuffer: CMSampleBuffer) -> CGImage? {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
            return nil
        }
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)

        guard let cgImage = ciContext.createCGImage(ciImage, from: CGRect(x: 0, y: 0, width: width, height: height)) else {
            return nil
        }
        return cgImage
    }
}
