/*
 * YOLOStage.swift
 *
 * Pipeline stage for YOLO CoreML on-device inference.
 * Supports detection, instance segmentation, and pose estimation.
 * Uses VNCoreMLRequest for Neural Engine execution.
 *
 * Mirrors VisionStage pattern:
 *   - nonisolated processFrame with synchronous pixel buffer snapshot
 *   - FPS throttle via ContinuousClock
 *   - Confidence smoothing via EMA
 *   - Dual output: PreviewBus (overlay) + onResult callback (relay)
 */

import CoreImage
import CoreML
import CoreMedia
import CoreVideo
import Foundation
import Vision

actor YOLOStage: @preconcurrency FramePipelineStage {
    nonisolated let stageId = "yolo"
    var config: FrameStageConfig

    // YOLO configuration
    private var yoloConfig: YOLOStageConfig

    // Model management
    private let modelManager = YOLOModelManager()
    private var mlModel: MLModel?
    private var visionRequest: VNCoreMLRequest?
    private var outputFormat: YOLOOutputFormat = .traditional

    // Confidence smoothing (EMA per tracked detection)
    private var confidenceSmoother = ConfidenceSmoother(alpha: 0.3)

    // FPS throttle
    private var lastProcessTime: ContinuousClock.Instant?
    private var frameInterval: Duration {
        guard yoloConfig.targetFPS > 0 else { return .zero }
        return .milliseconds(1000 / Int64(yoloConfig.targetFPS))
    }

    // PreviewBus for overlay rendering
    private var previewBus: PreviewBus?
    private let previewSource = PreviewSource(stageId: "yolo", label: "YOLO")

    // Callback for relaying results
    private var onResult: (@Sendable (YOLOFrameResult) async -> Void)?

    init(config: YOLOStageConfig = .default) {
        self.yoloConfig = config
        self.config = FrameStageConfig(targetFPS: config.targetFPS, isEnabled: true)
    }

    func setPreviewBus(_ bus: PreviewBus) {
        self.previewBus = bus
    }

    func setOnResult(_ handler: @escaping @Sendable (YOLOFrameResult) async -> Void) {
        self.onResult = handler
    }

    func updateConfig(_ newConfig: YOLOStageConfig) async {
        let modelChanged = newConfig.modelId != yoloConfig.modelId
        self.yoloConfig = newConfig
        self.config = FrameStageConfig(targetFPS: newConfig.targetFPS, isEnabled: true)
        confidenceSmoother.reset()

        if modelChanged {
            await loadModel()
        }
    }

    nonisolated func processFrame(_ packet: FramePacket) async {
        // Snapshot pixel buffer synchronously (same pattern as VisionStage)
        var snapshotBuffer: CVPixelBuffer?
        if let pixelBuffer = CMSampleBufferGetImageBuffer(packet.sampleBuffer) {
            let bufWidth = CVPixelBufferGetWidth(pixelBuffer)
            let bufHeight = CVPixelBufferGetHeight(pixelBuffer)
            let attrs: [String: Any] = [
                kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any]
            ]
            if bufWidth > 0, bufHeight > 0,
               CVPixelBufferCreate(kCFAllocatorDefault, bufWidth, bufHeight,
                                    kCVPixelFormatType_32BGRA, attrs as CFDictionary, &snapshotBuffer) == kCVReturnSuccess,
               let snap = snapshotBuffer {
                PipelineCIContext.shared.render(CIImage(cvPixelBuffer: pixelBuffer), to: snap,
                             bounds: CGRect(x: 0, y: 0, width: bufWidth, height: bufHeight),
                             colorSpace: CGColorSpaceCreateDeviceRGB())
            }
        }
        await processFrameInternal(packet, pixelBuffer: snapshotBuffer)
    }

    func start() async {
        lastProcessTime = nil
        await loadModel()
        NSLog("[YOLOStage] Started: model=\(yoloConfig.modelId) task=\(yoloConfig.task.rawValue) fps=\(yoloConfig.targetFPS)")
    }

    func stop() async {
        lastProcessTime = nil
        confidenceSmoother.reset()
        mlModel = nil
        visionRequest = nil
        NSLog("[YOLOStage] Stopped")
    }

    // MARK: - Model Loading

    private func loadModel() async {
        do {
            let model = try await modelManager.loadModel(
                id: yoloConfig.modelId,
                serverUrl: yoloConfig.modelUrl
            )
            self.mlModel = model

            // Create VNCoreMLModel for Vision framework integration
            let visionModel = try VNCoreMLModel(for: model)
            let request = VNCoreMLRequest(model: visionModel)
            request.imageCropAndScaleOption = .centerCrop
            self.visionRequest = request

            // Detect output format
            // Try to determine by checking model metadata
            self.outputFormat = detectFormat(from: model)

            NSLog("[YOLOStage] Model loaded: \(yoloConfig.modelId), format=\(outputFormat)")
        } catch {
            NSLog("[YOLOStage] Model load failed: \(error)")
        }
    }

    private func detectFormat(from model: MLModel) -> YOLOOutputFormat {
        // Check model description for output shapes
        let desc = model.modelDescription
        let outputs = desc.outputDescriptionsByName

        for (_, outputDesc) in outputs {
            if let multiArrayShape = outputDesc.multiArrayConstraint?.shape {
                // End-to-end: [1, max_det, 6]
                if multiArrayShape.count == 3 && multiArrayShape[2].intValue == 6 {
                    return .endToEnd
                }
            }
        }

        // Default to traditional — will be refined at runtime based on VNObservation types
        return .traditional
    }

    // MARK: - Frame Processing

    private func processFrameInternal(_ packet: FramePacket, pixelBuffer: CVPixelBuffer?) {
        guard config.isEnabled else { return }
        guard visionRequest != nil else { return }

        // FPS throttle
        let now = ContinuousClock.Instant.now
        if let last = lastProcessTime {
            let elapsed = now - last
            guard elapsed >= frameInterval else { return }
        }
        lastProcessTime = now

        guard let pixelBuffer = pixelBuffer ?? CMSampleBufferGetImageBuffer(packet.sampleBuffer) else { return }

        let startTime = ContinuousClock.Instant.now

        // Create VNImageRequestHandler per frame
        let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, options: [:])

        var detections: [YOLODetection] = []

        do {
            guard let request = visionRequest else { return }
            try handler.perform([request])

            let results = request.results ?? []

            // Determine format from result types
            if results.first is VNRecognizedObjectObservation {
                // Format A: Vision NMS-pipelined
                detections = YOLODecoder.decodeVisionNMS(
                    from: results,
                    classLabels: yoloConfig.classLabels,
                    task: yoloConfig.task,
                    confidence: Float(yoloConfig.confidence),
                    maxSize: CGSize(width: CVPixelBufferGetWidth(pixelBuffer), height: CVPixelBufferGetHeight(pixelBuffer))
                )
            } else if let mlResults = request.results as? [VNCoreMLFeatureValueObservation],
                      let firstOutput = mlResults.first?.featureValue.multiArrayValue {
                // Format B or C: raw MLMultiArray output
                if outputFormat == .endToEnd {
                    detections = YOLODecoder.decodeEndToEnd(
                        output: firstOutput,
                        classLabels: yoloConfig.classLabels,
                        task: yoloConfig.task,
                        confidence: Float(yoloConfig.confidence),
                        maxDetections: yoloConfig.maxDetections,
                        inputSize: yoloConfig.inputSize
                    )
                } else {
                    detections = YOLODecoder.decodeTraditional(
                        output: firstOutput,
                        classLabels: yoloConfig.classLabels,
                        task: yoloConfig.task,
                        confidence: Float(yoloConfig.confidence),
                        iouThreshold: Float(yoloConfig.iouThreshold),
                        maxDetections: yoloConfig.maxDetections,
                        inputSize: yoloConfig.inputSize
                    )
                }
            }
        } catch {
            NSLog("[YOLOStage] Inference error: \(error)")
            return
        }

        let endTime = ContinuousClock.Instant.now
        let inferenceTime = endTime - startTime
        let inferenceMs = Double(inferenceTime.components.seconds) * 1000.0
            + Double(inferenceTime.components.attoseconds) / 1e15

        // Apply confidence smoothing (EMA, keyed by class+spatial)
        if yoloConfig.smoothingAlpha < 1.0 {
            confidenceSmoother.alpha = yoloConfig.smoothingAlpha
            detections = detections.map { detection in
                let key = confidenceSmoother.spatialKey(
                    type: "yolo-\(detection.classLabel)",
                    bbox: detection.bbox
                )
                let smoothed = confidenceSmoother.smooth(key: key, raw: detection.confidence, bbox: detection.bbox)
                return YOLODetection(
                    bbox: detection.bbox,
                    confidence: smoothed,
                    classIndex: detection.classIndex,
                    classLabel: detection.classLabel,
                    task: detection.task,
                    maskCoefficients: detection.maskCoefficients,
                    keypoints: detection.keypoints
                )
            }
            confidenceSmoother.prune()
        }

        // Filter by (smoothed) confidence
        detections = detections.filter { $0.confidence >= yoloConfig.confidence }

        // Cap by maxDetections
        if detections.count > yoloConfig.maxDetections {
            detections = Array(detections.prefix(yoloConfig.maxDetections))
        }

        let result = YOLOFrameResult(
            timestamp: CFAbsoluteTimeGetCurrent(),
            sequenceNumber: packet.sequenceNumber,
            detections: detections,
            inferenceTimeMs: inferenceMs,
            task: yoloConfig.task
        )

        // Publish to PreviewBus for overlay rendering
        if let previewBus {
            Task { await previewBus.publish(.json(source: previewSource, value: result.jsonDict())) }
        }

        // Relay to server via callback
        if let onResult {
            Task { await onResult(result) }
        }
    }
}
