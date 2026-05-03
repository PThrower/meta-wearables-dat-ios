// EmbeddingExtractor.swift
// OSNet-x0.25 person ReID embedding extraction via VNCoreMLRequest.
// Produces a 512-dim L2-normalized embedding from a person crop.
// Used by ReIDGate for on-device appearance matching (eliminates server roundtrip).
// Pure struct — not actor-protected, used within VisionStage actor isolation.
//
// Model: OSNet-x0.25 (~1M params), 256x128 RGB input, 512-dim output embedding.
// Ref: arXiv:1905.00953 — "Omni-Scale Feature Learning for Person Re-Identification"
// Performance target: <10ms per person crop on A15/M2 Neural Engine.

import CoreImage
@preconcurrency import CoreML
import CoreVideo
import Foundation
@preconcurrency import Vision

// MARK: - Errors

enum EmbeddingError: LocalizedError {
    case modelNotFound(name: String)
    case inferenceFailed(String)
    case invalidOutput

    var errorDescription: String? {
        switch self {
        case .modelNotFound(let name):
            return "Embedding model '\(name).mlmodelc' not found in bundle"
        case .inferenceFailed(let message):
            return "Embedding inference failed: \(message)"
        case .invalidOutput:
            return "Embedding model produced unexpected output shape"
        }
    }
}

// MARK: - EmbeddingExtractor

struct EmbeddingExtractor: Sendable {

    /// OSNet input dimensions (width x height).
    /// Standard ReID aspect ratio for person crops.
    static let inputWidth = 128
    static let inputHeight = 256

    /// Expected embedding dimensionality from OSNet-x0.25.
    static let embeddingDim = 512

    /// The VNCoreMLRequest used for inference.
    /// VNCoreMLRequest is Sendable-safe when used synchronously within a single
    /// isolation domain (same guarantee as HistogramExtractor's pixel iteration).
    private let request: VNCoreMLRequest

    private init(request: VNCoreMLRequest) {
        self.request = request
    }

    // MARK: - Factory Methods

    /// Create an extractor from a compiled .mlmodelc URL.
    /// Uses cpuAndGPU to avoid ANE memory spike (same rationale as YOLOModelManager).
    /// Pre-load memory gate prevents loading when device is near Jetsam limit.
    static func create(modelURL: URL) throws -> EmbeddingExtractor {
        // Memory pressure gate — refuse if near per-process Jetsam limit
        let footprintMB = Self.physFootprintMB()
        if footprintMB > 1500.0 {
            NSLog("[Embedding] MEMORY WARNING: footprint \(String(format: "%.0f", footprintMB))MB, refusing to load OSNet model")
            throw EmbeddingError.inferenceFailed("Insufficient memory: \(String(format: "%.0f", footprintMB))MB footprint")
        }

        let config = MLModelConfiguration()
        config.computeUnits = .cpuAndGPU
        let model = try MLModel(contentsOf: modelURL, configuration: config)
        let visionModel = try VNCoreMLModel(for: model)
        let request = VNCoreMLRequest(model: visionModel)
        // NOT centerCrop — we pre-crop to exact 256x128 via CIImage transform.
        request.imageCropAndScaleOption = .scaleFill
        return EmbeddingExtractor(request: request)
    }

    /// Create an extractor from a bundled .mlmodelc resource.
    /// Default model name is "OSNet_x025".
    static func createFromBundle(name: String = "OSNet_x025") throws -> EmbeddingExtractor {
        guard let url = Bundle.main.url(forResource: name, withExtension: "mlmodelc") else {
            throw EmbeddingError.modelNotFound(name: name)
        }
        return try create(modelURL: url)
    }

    // MARK: - Extraction

    /// Extract a 512-dim L2-normalized embedding from a person crop.
    ///
    /// - Parameters:
    ///   - pixelBuffer: Source frame (BGRA).
    ///   - bbox: Normalized bounding box (0-1 coordinates) of the person.
    /// - Returns: 512-dim L2-normalized embedding, or nil on failure.
    func extract(from pixelBuffer: CVPixelBuffer,
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

        let targetW = Self.inputWidth
        let targetH = Self.inputHeight

        // Allocate fresh output buffer (BGRA, per pipeline convention — no reuse)
        var outBuffer: CVPixelBuffer?
        let attrs: [String: Any] = [
            kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any]
        ]
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            targetW,
            targetH,
            kCVPixelFormatType_32BGRA,
            attrs as CFDictionary,
            &outBuffer
        )
        guard status == kCVReturnSuccess, let outBuffer else { return nil }

        // CIImage crop + scale (same pattern as HistogramExtractor)
        let fullImage = CIImage(cvPixelBuffer: pixelBuffer)

        // Flip Y for CIImage's bottom-left origin
        let ciCropY = CGFloat(bufHeight) - CGFloat(pxY2)
        let cropRect = CGRect(x: CGFloat(pxX), y: ciCropY,
                              width: CGFloat(pxW), height: CGFloat(pxH))
        let cropped = fullImage.cropped(to: cropRect)
        guard cropped.extent.width > 0, cropped.extent.height > 0,
              fullImage.extent.intersects(cropRect) else { return nil }

        // Translate to origin and scale to OSNet input size
        let translate = CGAffineTransform(translationX: -cropRect.origin.x,
                                          y: -cropRect.origin.y)
        let scale = CGAffineTransform(scaleX: CGFloat(targetW) / cropRect.width,
                                      y: CGFloat(targetH) / cropRect.height)
        let scaledImage = cropped.transformed(by: translate.concatenating(scale))

        // GPU render — no CVPixelBufferLock (IOSurface-backed, pipeline convention)
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let renderBounds = CGRect(x: 0, y: 0, width: targetW, height: targetH)
        PipelineCIContext.shared.render(scaledImage, to: outBuffer,
                         bounds: renderBounds, colorSpace: colorSpace)

        // Run VNCoreMLRequest on the cropped/resized buffer
        return runInference(on: outBuffer)
    }

    // MARK: - Private

    /// Run VNCoreMLRequest and extract L2-normalized embedding.
    private func runInference(on buffer: CVPixelBuffer) -> [Double]? {
        let handler = VNImageRequestHandler(cvPixelBuffer: buffer, options: [:])
        do {
            try handler.perform([request])
        } catch {
            return nil
        }

        // Extract embedding from MLMultiArray output
        guard let observation = request.results?.first as? VNCoreMLFeatureValueObservation,
              let multiArray = observation.featureValue.multiArrayValue else {
            return nil
        }

        // Validate output dimensionality
        guard multiArray.count == Self.embeddingDim else {
            return nil
        }

        // Convert MLMultiArray to [Double]
        var embedding: [Double] = []
        embedding.reserveCapacity(Self.embeddingDim)
        for i in 0..<Self.embeddingDim {
            embedding.append(Double(multiArray[[i] as [NSNumber]].floatValue))
        }

        // L2-normalize
        let norm = sqrt(embedding.reduce(0.0) { $0 + $1 * $1 })
        guard norm > 0 else { return nil }
        return embedding.map { $0 / norm }
    }

    // MARK: - Memory Helper

    /// Current process physical footprint in MB (same implementation as YOLOModelManager).
    /// Uses task_info(TASK_VM_INFO) phys_footprint — the metric the kernel tracks for Jetsam.
    nonisolated private static func physFootprintMB() -> Double {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        guard result == KERN_SUCCESS else { return 0 }
        return Double(info.phys_footprint) / 1_048_576.0
    }
}
