/*
 * FrameTransformStage.swift
 *
 * Applies an ordered chain of CoreImage CIFilters to video frames on the GPU.
 * Called by FramePipelineManager before the broadcast fan-out, so all downstream
 * observer stages (display, relay, recording, vision) see the enhanced frame.
 *
 * Not a FramePipelineStage — it's a synchronous pre-processor, not an observer.
 * Sub-millisecond per filter on Apple GPU. Zero overhead when filter chain is empty.
 */

import CoreImage
import CoreMedia
import CoreVideo
import Foundation

final class FrameTransformStage: @unchecked Sendable {
    private var config: EnhanceStageConfig
    private let ciContext = CIContext(options: [.useSoftwareRenderer: false])
    private let lock = NSLock()

    // Reusable output buffer pool
    private var outputBuffer: CVPixelBuffer?
    private var outputBufferSize: CGSize = .zero

    init(config: EnhanceStageConfig = .empty) {
        self.config = config
    }

    var isEnabled: Bool { config.isEnabled && !config.filters.isEmpty }

    func updateConfig(_ newConfig: EnhanceStageConfig) {
        self.config = newConfig
        NSLog("[FrameTransform] Config updated: \(newConfig.filters.count) filters, enabled=\(newConfig.isEnabled)")
    }

    /// Apply the filter chain to a CVPixelBuffer. Returns the original if chain is empty/disabled.
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

        // Ensure output buffer matches dimensions
        let size = CGSize(width: width, height: height)
        ensureOutputBuffer(size: size)

        guard let outBuffer = outputBuffer else { return pixelBuffer }

        // Render to output CVPixelBuffer (GPU → GPU, no copy to CPU)
        CVPixelBufferLockBaseAddress(outBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(outBuffer, []) }

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

        // Step 2: Gamma correction (via CIColorMatrix approximation)
        // CIExposureAdjust is simpler and more effective for night mode
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

    // MARK: - Buffer Management

    private func ensureOutputBuffer(size: CGSize) {
        if let existing = outputBuffer,
           CVPixelBufferGetWidth(existing) == Int(size.width),
           CVPixelBufferGetHeight(existing) == Int(size.height) {
            return
        }

        var newBuffer: CVPixelBuffer?
        let attrs: [String: Any] = [
            kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
            kCVPixelBufferMetalCompatibilityKey as String: true,
        ]
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            Int(size.width), Int(size.height),
            kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
            attrs as CFDictionary,
            &newBuffer
        )
        if status == kCVReturnSuccess {
            outputBuffer = newBuffer
            outputBufferSize = size
        }
    }
}
