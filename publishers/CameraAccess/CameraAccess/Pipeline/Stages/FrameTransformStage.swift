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
    private let ciContext = PipelineCIContext.shared

    // Per-stage metrics
    private var metricsTracker = StageMetricsTracker(stageId: "enhance", nodeType: "enhance-brightness")

    // CVPixelBuffer pool — recycles IOSurface memory across frames.
    // Pool of 3: one being rendered to, one held by downstream stages, one spare.
    // Eliminates ~8MB allocation/deallocation churn per frame on 4GB devices.
    private var bufferPool: CVPixelBufferPool?
    private var poolWidth: Int = 0
    private var poolHeight: Int = 0

    init(config: EnhanceStageConfig = .empty) {
        self.config = config
    }

    var isEnabled: Bool { config.isEnabled && !config.filters.isEmpty }

    func updateConfig(_ newConfig: EnhanceStageConfig) {
        self.config = newConfig
        // Update nodeType to reflect primary filter
        if let primary = newConfig.filters.first {
            metricsTracker = StageMetricsTracker(stageId: "enhance", nodeType: "enhance-\(primary.type.rawValue)")
        }
        NSLog("[FrameTransform] Config updated: \(newConfig.filters.count) filters, enabled=\(newConfig.isEnabled)")
    }

    func collectMetrics() -> StageMetricsSnapshot? {
        metricsTracker.setMemoryMB(1.0)
        return metricsTracker.collect()
    }

    /// Apply the filter chain to a CVPixelBuffer. Returns the original if chain is empty/disabled.
    /// Each call allocates a fresh output buffer so downstream async stages don't race.
    func transform(_ pixelBuffer: CVPixelBuffer) -> CVPixelBuffer {
        guard isEnabled else { return pixelBuffer }

        let cpuStart = metricsTracker.beginFrame()
        let startTime = ContinuousClock.Instant.now

        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        guard width > 0, height > 0 else { return pixelBuffer }

        var ciImage = CIImage(cvPixelBuffer: pixelBuffer)

        for filterConfig in config.filters {
            if let output = applyFilter(filterConfig, to: ciImage) {
                ciImage = output
            }
        }

        // Allocate output buffer from pool (recycles IOSurface memory).
        // IMPORTANT: Each frame still gets its own CVPixelBuffer. Reuse would cause a race:
        // main actor renders frame N+1 into the buffer while VisionStage (Task.detached)
        // is still reading frame N for OCR. The pool recycles the underlying IOSurface
        // memory (not the same buffer object), avoiding ~8MB allocation churn per frame.
        // Use BGRA — native CIImage/CGImage format, no RGB→YCbCr conversion,
        // directly compatible with display pipeline and Vision framework.
        let size = CGSize(width: width, height: height)
        let outBuffer: CVPixelBuffer? = getPoolBuffer(width: width, height: height)
        guard let outBuffer else { return pixelBuffer }

        // Render to output CVPixelBuffer (GPU → GPU, no copy to CPU).
        // No CVPixelBufferLockBaseAddress needed — CIContext.render writes
        // directly to the IOSurface backing via GPU, lock only maps for CPU access.
        ciContext.render(ciImage, to: outBuffer, bounds: CGRect(origin: .zero, size: size), colorSpace: ciImage.colorSpace ?? CGColorSpaceCreateDeviceRGB())

        let endTime = ContinuousClock.Instant.now
        let duration = endTime - startTime
        let ms = Double(duration.components.seconds) * 1000.0 + Double(duration.components.attoseconds) / 1e15
        metricsTracker.endFrame(cpuStart: cpuStart, wallClockMs: ms)

        return outBuffer
    }

    // MARK: - Buffer Pool

    /// Get a CVPixelBuffer from the pool. Recreates pool if dimensions change.
    /// Returns nil if pool creation or allocation fails (caller falls back to original buffer).
    private func getPoolBuffer(width: Int, height: Int) -> CVPixelBuffer? {
        // Recreate pool if dimensions changed
        if width != poolWidth || height != poolHeight || bufferPool == nil {
            let poolAttrs: [String: Any] = [
                kCVPixelBufferPoolMinimumBufferCountKey as String: 3
            ]
            let bufferAttrs: [String: Any] = [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: width,
                kCVPixelBufferHeightKey as String: height,
                kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
                kCVPixelBufferMetalCompatibilityKey as String: true,
            ]
            var newPool: CVPixelBufferPool?
            let status = CVPixelBufferPoolCreate(
                kCFAllocatorDefault,
                poolAttrs as CFDictionary,
                bufferAttrs as CFDictionary,
                &newPool
            )
            guard status == kCVReturnSuccess, let newPool else { return nil }
            bufferPool = newPool
            poolWidth = width
            poolHeight = height
        }

        // Get a buffer from the pool. If all 3 are in-flight, pool allocates a new one.
        var buffer: CVPixelBuffer?
        guard let pool = bufferPool else { return nil }
        let status = CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &buffer)
        guard status == kCVReturnSuccess, let buffer else { return nil }
        return buffer
    }

    /// Flush idle buffers from the pool on memory pressure.
    func flushPool() {
        if let pool = bufferPool {
            CVPixelBufferPoolFlush(pool, CVPixelBufferPoolFlushFlags(rawValue: 0))
        }
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
