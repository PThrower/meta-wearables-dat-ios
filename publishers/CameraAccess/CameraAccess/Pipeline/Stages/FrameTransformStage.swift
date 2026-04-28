/*
 * FrameTransformStage.swift
 *
 * Applies an ordered chain of CoreImage CIFilters to video frames on the GPU.
 * Called by FramePipelineManager before the broadcast fan-out, so all downstream
 * observer stages (display, relay, recording, vision) see the enhanced frame.
 *
 * Not a FramePipelineStage — it's a synchronous pre-processor, not an observer.
 * Sub-millisecond per filter on Apple GPU. Zero overhead when filter chain is empty.
 *
 * IMPORTANT: A fresh CVPixelBuffer is allocated per frame. Downstream stages
 * (VisionStage, RelayStage, etc.) process frames asynchronously via Task.detached,
 * so buffer reuse would create a read-write race on the pixel data.
 */

import CoreImage
import CoreMedia
import CoreVideo
import Foundation

final class FrameTransformStage: @unchecked Sendable {
    private var config: EnhanceStageConfig
    private let ciContext = CIContext(options: [.useSoftwareRenderer: false])

    init(config: EnhanceStageConfig = .empty) {
        self.config = config
    }

    var isEnabled: Bool { config.isEnabled && !config.filters.isEmpty }

    func updateConfig(_ newConfig: EnhanceStageConfig) {
        self.config = newConfig
        NSLog("[FrameTransform] Config updated: \(newConfig.filters.count) filters, enabled=\(newConfig.isEnabled)")
    }

    /// Apply the filter chain to a CVPixelBuffer. Returns the original if chain is empty/disabled.
    /// Each call allocates a fresh output buffer so downstream async stages don't race.
    func transform(_ pixelBuffer: CVPixelBuffer) -> CVPixelBuffer {
        guard isEnabled else { return pixelBuffer }

        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        guard width > 0, height > 0 else { return pixelBuffer }

        var ciImage = CIImage(cvPixelBuffer: pixelBuffer)

        for filterConfig in config.filters {
            if let output = applyFilter(filterConfig, to: ciImage) {
                ciImage = output
            }
        }

        // Allocate a fresh output buffer per frame.
        // Reuse would cause a race: main actor renders frame N+1 into the buffer
        // while VisionStage (Task.detached) is still reading frame N for OCR.
        let size = CGSize(width: width, height: height)
        var outBuffer: CVPixelBuffer?
        let attrs: [String: Any] = [
            kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
            kCVPixelBufferMetalCompatibilityKey as String: true,
        ]
        // Use BGRA — native CIImage/CGImage format, no RGB→YCbCr conversion,
        // directly compatible with display pipeline and Vision framework.
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            Int(size.width), Int(size.height),
            kCVPixelFormatType_32BGRA,
            attrs as CFDictionary,
            &outBuffer
        )
        guard status == kCVReturnSuccess, let outBuffer else { return pixelBuffer }

        // Render to output CVPixelBuffer (GPU → GPU, no copy to CPU).
        // No CVPixelBufferLockBaseAddress needed — CIContext.render writes
        // directly to the IOSurface backing via GPU, lock only maps for CPU access.
        ciContext.render(ciImage, to: outBuffer, bounds: CGRect(origin: .zero, size: size), colorSpace: ciImage.colorSpace ?? CGColorSpaceCreateDeviceRGB())

        return outBuffer
    }

    // MARK: - Filter Application

    private func applyFilter(_ config: EnhanceFilterConfig, to image: CIImage) -> CIImage? {
        switch config.type {
        case .brightness:
            return applyColorControls(config, to: image)
        case .sharpen:
            return applySharpen(config, to: image)
        case .whiteBalance:
            return applyWhiteBalance(config, to: image)
        case .noiseReduce:
            return applyNoiseReduction(config, to: image)
        case .edgeDetect:
            return applyEdgeDetect(config, to: image)
        case .nightMode:
            return applyNightMode(config, to: image)
        }
    }

    private func applyColorControls(_ config: EnhanceFilterConfig, to image: CIImage) -> CIImage? {
        guard let filter = CIFilter(name: "CIColorControls") else { return nil }
        filter.setValue(image, forKey: kCIInputImageKey)
        filter.setValue(config.params["brightness"] ?? 0.0, forKey: kCIInputBrightnessKey)
        filter.setValue(config.params["contrast"] ?? 1.0, forKey: kCIInputContrastKey)
        filter.setValue(config.params["saturation"] ?? 1.0, forKey: kCIInputSaturationKey)
        return filter.outputImage
    }

    private func applySharpen(_ config: EnhanceFilterConfig, to image: CIImage) -> CIImage? {
        guard let filter = CIFilter(name: "CISharpenLuminance") else { return nil }
        filter.setValue(image, forKey: kCIInputImageKey)
        filter.setValue(config.params["sharpness"] ?? 0.4, forKey: kCIInputSharpnessKey)
        return filter.outputImage
    }

    private func applyWhiteBalance(_ config: EnhanceFilterConfig, to image: CIImage) -> CIImage? {
        guard let filter = CIFilter(name: "CIWhiteBalanceAdjust") else { return nil }
        filter.setValue(image, forKey: kCIInputImageKey)
        filter.setValue(NSNumber(value: config.params["warmth"] ?? 5500), forKey: "inputWarmth")
        filter.setValue(NSNumber(value: config.params["tint"] ?? 0), forKey: "inputTint")
        return filter.outputImage
    }

    private func applyNoiseReduction(_ config: EnhanceFilterConfig, to image: CIImage) -> CIImage? {
        guard let filter = CIFilter(name: "CINoiseReduction") else { return nil }
        filter.setValue(image, forKey: kCIInputImageKey)
        filter.setValue(config.params["noiseLevel"] ?? 0.02, forKey: "inputNoiseLevel")
        filter.setValue(config.params["sharpness"] ?? 0.4, forKey: kCIInputSharpnessKey)
        return filter.outputImage
    }

    private func applyEdgeDetect(_ config: EnhanceFilterConfig, to image: CIImage) -> CIImage? {
        guard let filter = CIFilter(name: "CIEdges") else { return nil }
        filter.setValue(image, forKey: kCIInputImageKey)
        filter.setValue(config.params["intensity"] ?? 1.0, forKey: kCIInputIntensityKey)
        return filter.outputImage
    }

    private func applyNightMode(_ config: EnhanceFilterConfig, to image: CIImage) -> CIImage? {
        // Chain: brightness boost → gamma correction → highlight/shadow recovery
        var result = image

        // Step 1: Brightness + contrast
        if let brightFilter = CIFilter(name: "CIColorControls") {
            brightFilter.setValue(result, forKey: kCIInputImageKey)
            brightFilter.setValue(config.params["brightness"] ?? 0.15, forKey: kCIInputBrightnessKey)
            brightFilter.setValue(1.1, forKey: kCIInputContrastKey)
            if let out = brightFilter.outputImage { result = out }
        }

        // Step 2: Gamma correction
        if let gammaFilter = CIFilter(name: "CIGammaAdjust") {
            gammaFilter.setValue(result, forKey: kCIInputImageKey)
            gammaFilter.setValue(config.params["gamma"] ?? 0.8, forKey: "inputPower")
            if let out = gammaFilter.outputImage { result = out }
        }

        // Step 3: Highlight/shadow recovery
        if let hsFilter = CIFilter(name: "CIHighlightShadowAdjust") {
            hsFilter.setValue(result, forKey: kCIInputImageKey)
            hsFilter.setValue(config.params["highlightAmount"] ?? 1.5, forKey: "inputHighlightAmount")
            hsFilter.setValue(0.5, forKey: "inputShadowAmount")
            if let out = hsFilter.outputImage { result = out }
        }

        return result
    }
}
