// HistogramExtractor.swift
// HSV color histogram extraction from CVPixelBuffer crops.
// Produces a 24-dim normalized vector (H: 16 bins, S: 8 bins).
// Used by BhattacharyyaGate for on-device appearance matching.
// Pure struct — not actor-protected, used within VisionStage actor isolation.
// Performance: <0.5ms per person crop at typical 100x200px.

import CoreImage
import CoreVideo
import Foundation

struct HistogramExtractor: Sendable {
    /// H: 16 bins, S: 8 bins = 24-dim normalized vector (sums to 1.0).
    /// Returns nil if extraction fails or crop is too small.
    static func extractHSV(from pixelBuffer: CVPixelBuffer,
                           bbox: NormalizedBoundingBox) -> [Double]? {
        let bufWidth = CVPixelBufferGetWidth(pixelBuffer)
        let bufHeight = CVPixelBufferGetHeight(pixelBuffer)
        guard bufWidth > 0, bufHeight > 0 else { return nil }

        // Convert normalized bbox to pixel coordinates, clamped
        let pxX = max(0, Int(bbox.x1 * Double(bufWidth)))
        let pxY = max(0, Int(bbox.y1 * Double(bufHeight)))
        let pxX2 = min(bufWidth, Int(bbox.x2 * Double(bufWidth)))
        let pxY2 = min(bufHeight, Int(bbox.y2 * Double(bufHeight)))
        let pxW = pxX2 - pxX
        let pxH = pxY2 - pxY
        guard pxW >= 4, pxH >= 4 else { return nil }

        // Crop to a small size for fast histogram computation
        let maxDim = 100
        let cropW = min(pxW, maxDim)
        let cropH = min(pxH, maxDim)

        // Allocate fresh output buffer (BGRA, per pipeline convention)
        var outBuffer: CVPixelBuffer?
        let attrs: [String: Any] = [
            kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any]
        ]
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            cropW,
            cropH,
            kCVPixelFormatType_32BGRA,
            attrs as CFDictionary,
            &outBuffer
        )
        guard status == kCVReturnSuccess, let outBuffer else { return nil }

        // CIImage crop + scale (same pattern as VisionStage.extractThumbnail)
        let fullImage = CIImage(cvPixelBuffer: pixelBuffer)
        // Flip Y for CIImage's bottom-left origin
        let ciCropY = CGFloat(bufHeight) - CGFloat(pxY2)
        let cropRect = CGRect(x: CGFloat(pxX), y: ciCropY,
                              width: CGFloat(pxW), height: CGFloat(pxH))
        let cropped = fullImage.cropped(to: cropRect)
        guard cropped.extent.width > 0, cropped.extent.height > 0,
              fullImage.extent.intersects(cropRect) else { return nil }

        // Translate to origin and scale
        let translate = CGAffineTransform(translationX: -cropRect.origin.x, y: -cropRect.origin.y)
        let scale = CGAffineTransform(scaleX: CGFloat(cropW) / cropRect.width,
                                      y: CGFloat(cropH) / cropRect.height)
        let scaledImage = cropped.transformed(by: translate.concatenating(scale))

        let ciContext = CIContext(options: [.useSoftwareRenderer: false])
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        ciContext.render(scaledImage, to: outBuffer,
                         bounds: CGRect(x: 0, y: 0, width: cropW, height: cropH),
                         colorSpace: colorSpace)

        // Lock and iterate BGRA pixels
        CVPixelBufferLockBaseAddress(outBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(outBuffer, []) }

        guard let baseAddress = CVPixelBufferGetBaseAddress(outBuffer) else { return nil }
        let bytesPerRow = CVPixelBufferGetBytesPerRow(outBuffer)
        let buffer = baseAddress.assumingMemoryBound(to: UInt8.self)

        // H: 16 bins, S: 8 bins
        let hBins = 16
        let sBins = 8
        let totalBins = hBins + sBins  // 24
        var bins = [Double](repeating: 0, count: totalBins)
        var pixelCount = 0

        for y in 0..<cropH {
            let rowOffset = y * bytesPerRow
            for x in 0..<cropW {
                let offset = rowOffset + x * 4
                // BGRA order
                let b = Double(buffer[offset])
                let g = Double(buffer[offset + 1])
                let r = Double(buffer[offset + 2])

                // Convert RGB to HSV
                let maxC = max(r, g, b)
                let minC = min(r, g, b)
                let delta = maxC - minC

                // Saturation
                let s = maxC < 1e-6 ? 0.0 : delta / maxC

                // Hue (0-360)
                var h: Double = 0
                if delta > 1e-6 {
                    if maxC == r {
                        h = 60.0 * ((g - b) / delta)
                    } else if maxC == g {
                        h = 60.0 * (2.0 + (b - r) / delta)
                    } else {
                        h = 60.0 * (4.0 + (r - g) / delta)
                    }
                    if h < 0 { h += 360.0 }
                }

                // Skip near-black pixels (noise floor)
                guard maxC > 10.0 else { continue }

                // Bin H (0-360 -> 0..15) and S (0-1 -> 0..7)
                let hBin = min(Int(h / (360.0 / Double(hBins))), hBins - 1)
                let sBin = min(Int(s * Double(sBins)), sBins - 1)
                bins[hBin] += 1
                bins[hBins + sBin] += 1
                pixelCount += 1
            }
        }

        guard pixelCount > 0 else { return nil }

        // Normalize to sum = 1.0
        let total = bins.reduce(0, +)
        guard total > 0 else { return nil }
        return bins.map { $0 / total }
    }
}
