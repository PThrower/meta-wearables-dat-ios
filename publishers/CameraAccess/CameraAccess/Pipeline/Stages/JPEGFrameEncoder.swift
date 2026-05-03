/*
 * JPEGFrameEncoder.swift
 *
 * Encodes CVPixelBuffer frames as JPEG using CIContext (YUV->RGB)
 * and CGImageDestination (JPEG compression). Extracted from RelayStage
 * to conform to the FrameEncoder protocol.
 *
 * Includes adaptive quality: encodes at the given initial quality, then
 * the caller (RelayStage) adjusts quality via the quality property based
 * on EMA encode time feedback.
 */

import CoreImage
import CoreMedia
import Foundation
import ImageIO
import UniformTypeIdentifiers

final class JPEGFrameEncoder: FrameEncoder, @unchecked Sendable {
    let codec: RelayVideoCodec = .jpeg

    /// Current JPEG quality (0.0 - 1.0). Caller adjusts this externally.
    var quality: CGFloat

    private let minQuality: CGFloat = 0.2
    private let maxQuality: CGFloat = 0.8

    /// CIContext for YUV-to-RGB conversion (GPU-accelerated)
    private let ciContext: CIContext

    init(ciContext: CIContext? = nil, quality: CGFloat = 0.5) {
        self.ciContext = ciContext ?? CIContext(options: [.useSoftwareRenderer: false])
        self.quality = max(minQuality, min(maxQuality, quality))
    }

    func encode(_ pixelBuffer: CVPixelBuffer, width: Int, height: Int) -> EncodedFrame? {
        let currentQuality = quality

        // Step 1: CVPixelBuffer -> CIImage -> CGImage (CIContext handles YUV->RGB)
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        guard let cgImage = ciContext.createCGImage(
            ciImage,
            from: CGRect(x: 0, y: 0, width: width, height: height)
        ) else { return nil }

        // Step 2: CGImage -> JPEG via CGImageDestination (ImageIO C API, no UIKit)
        guard let mutableData = CFDataCreateMutable(kCFAllocatorDefault, 0) else { return nil }
        guard let destination = CGImageDestinationCreateWithData(
            mutableData, UTType.jpeg.identifier as CFString, 1, nil
        ) else { return nil }

        let jpegOptions: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: currentQuality]
        CGImageDestinationAddImage(destination, cgImage, jpegOptions as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }

        let jpegData = mutableData as Data

        return EncodedFrame(
            payload: jpegData,
            isKeyframe: true,
            hasParameterSets: false,
            width: width,
            height: height
        )
    }

    func destroy() {
        // CIContext is shared, nothing to tear down
    }

    /// Clamp quality to valid range (used by RelayStage's adaptive logic)
    func clampQuality(_ value: CGFloat) -> CGFloat {
        max(minQuality, min(maxQuality, value))
    }
}
