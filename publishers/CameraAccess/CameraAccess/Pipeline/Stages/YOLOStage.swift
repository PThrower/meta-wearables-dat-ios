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

    // Per-stage metrics
    private var metricsTracker = StageMetricsTracker(stageId: "yolo", nodeType: "yolo-detect")

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

    // Callback for model state updates
    private var onModelState: (@Sendable (YOLOModelState) async -> Void)?

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

    func setOnModelState(_ handler: @escaping @Sendable (YOLOModelState) async -> Void) {
        self.onModelState = handler
    }

    func collectMetrics() -> StageMetricsSnapshot? {
        let memMB: Double = mlModel != nil ? 80.0 : 0
        metricsTracker.setMemoryMB(memMB)
        return metricsTracker.collect()
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
        // Full-resolution snapshot — VNCoreMLRequest.centerCrop + downscaling caused
        // coordinate mapping errors (centerCrop discards edges, shifts detection coords).
        // Memory savings from model cache (1 model), streaming inflate, and pressure
        // check are much larger than per-frame snapshot savings.
        let snapshotBuffer = SnapshotConfig.full.createSnapshot(from: packet.sampleBuffer)
        await processFrameInternal(packet, pixelBuffer: snapshotBuffer)
    }

    func start() async {
        lastProcessTime = nil
        await loadModel()
        let freeMB = os_proc_available_memory() / (1024 * 1024)
        NSLog("[YOLOStage] Started: model=\(yoloConfig.modelId) task=\(yoloConfig.task.rawValue) fps=\(yoloConfig.targetFPS) freeMem=\(freeMB)MB")
    }

    func stop() async {
        lastProcessTime = nil
        confidenceSmoother.reset()
        let modelId = yoloConfig.modelId
        mlModel = nil
        visionRequest = nil
        // Release model from YOLOModelManager in-memory cache
        await modelManager.unloadModel(id: modelId)
        NSLog("[YOLOStage] Stopped, unloaded model '\(modelId)' from cache")
    }

    // MARK: - Model Loading

    private func loadModel() async {
        let modelId = yoloConfig.modelId
        await onModelState?(.downloading(modelId: modelId, progress: 0))

        do {
            // Observe download progress
            let progressStream = await modelManager.downloadProgress(id: modelId)
            let progressTask = Task {
                for await progress in progressStream {
                    await onModelState?(.downloading(modelId: modelId, progress: progress))
                }
            }

            let result = try await modelManager.loadModel(
                id: modelId,
                serverUrl: yoloConfig.modelUrl
            )
            let model = result.model
            progressTask.cancel()

            await onModelState?(.compiling(modelId: modelId))

            self.mlModel = model

            // Extract class labels from model metadata (e.g. custom YOLO models)
            // Falls back to config labels (COCO default) if model has none
            var effectiveLabels = yoloConfig.classLabels
            if let modelLabels = YOLOModelManager.extractClassLabels(from: model) {
                NSLog("[YOLOStage] Using \(modelLabels.count) class labels from model metadata")
                effectiveLabels = modelLabels
                self.yoloConfig = YOLOStageConfig(
                    task: yoloConfig.task,
                    modelId: yoloConfig.modelId,
                    modelUrl: yoloConfig.modelUrl,
                    classLabels: modelLabels,
                    confidence: yoloConfig.confidence,
                    iouThreshold: yoloConfig.iouThreshold,
                    targetFPS: yoloConfig.targetFPS,
                    maxDetections: yoloConfig.maxDetections,
                    inputSize: yoloConfig.inputSize,
                    smoothingAlpha: yoloConfig.smoothingAlpha
                )
            }

            // Create VNCoreMLModel for Vision framework integration
            let visionBeforeMB = YOLOModelManager.physFootprintMB()
            let visionModel = try VNCoreMLModel(for: model)
            let visionAfterMB = YOLOModelManager.physFootprintMB()
            NSLog("[YOLOStage] VNCoreMLModel created, footprint: \(String(format: "%.0f", visionAfterMB))MB (delta: +\(String(format: "%.0f", visionAfterMB - visionBeforeMB))MB)")
            let request = VNCoreMLRequest(model: visionModel)
            request.imageCropAndScaleOption = .centerCrop
            self.visionRequest = request

            // Detect output format
            self.outputFormat = detectFormat(from: model)

            // Build resource info and report ready state
            let resources = YOLOResourceInfo(
                diskSizeMB: Double(result.diskSizeBytes) / (1024 * 1024),
                downloadSizeMB: Double(result.downloadSizeBytes) / (1024 * 1024),
                classCount: effectiveLabels.count,
                inputSize: yoloConfig.inputSize,
                task: yoloConfig.task
            )
            await onModelState?(.ready(modelId: modelId, resources: resources))
            NSLog("[YOLOStage] Model loaded: \(modelId), format=\(outputFormat), disk=\(String(format: "%.1f", resources.diskSizeMB))MB, classes=\(resources.classCount)")
        } catch {
            await onModelState?(.failed(modelId: modelId, error: error.localizedDescription))
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
            guard elapsed >= frameInterval else {
                metricsTracker.recordDrop()
                return
            }
        }
        lastProcessTime = now

        guard let pixelBuffer = pixelBuffer ?? CMSampleBufferGetImageBuffer(packet.sampleBuffer) else { return }

        // Autorelease pool ensures ObjC objects (CVPixelBuffer, CIImage, VNRequestHandler)
        // are released each frame, preventing accumulation in actor executor threads.
        autoreleasepool {
            let cpuStart = metricsTracker.beginFrame()
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
            metricsTracker.endFrame(cpuStart: cpuStart, wallClockMs: inferenceMs)

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
}
