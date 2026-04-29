/*
 * VisionStage.swift
 *
 * Pipeline stage that runs Apple Vision framework VNRequests on video frames.
 * Executes on the Neural Engine with negligible battery cost.
 *
 * Configurable via VisionStageConfig -- builds VNRequest array from detection types.
 * Uses VNImageRequestHandler per frame (thread-safe, no reuse per Apple docs).
 * FPS throttled via FrameStageConfig.targetFPS (default 5fps).
 *
 * Dual output:
 *   1. PreviewBus: VisionFrameResult for overlay rendering
 *   2. JSON control message: relayed to server for AI context / event triggers
 */

import CoreMedia
import CoreVideo
import Foundation
import Vision

actor VisionStage: @preconcurrency FramePipelineStage {
    nonisolated let stageId = "vision"
    var config: FrameStageConfig

    // Vision configuration
    private var visionConfig: VisionStageConfig

    // Confidence smoothing (EMA per tracked detection)
    private var confidenceSmoother = ConfidenceSmoother(alpha: 0.3)

    // Built VNRequests (rebuilt when config changes)
    private var requests: [VNRequest] = []

    // Nonisolated request builder for init context
    private static func buildRequests(config: VisionStageConfig) -> [VNRequest] {
        var requests: [VNRequest] = []
        for type in config.detectionTypes {
            switch type {
            case .faceDetect:
                let req = VNDetectFaceRectanglesRequest()
                req.revision = VNDetectFaceRectanglesRequestRevision2
                requests.append(req)
            case .barcodeScan:
                let req = VNDetectBarcodesRequest()
                configureBarcodeSymbologiesStatic(req, symbologies: config.symbologies)
                requests.append(req)
            case .ocr:
                let req = VNRecognizeTextRequest()
                req.recognitionLevel = .accurate
                req.recognitionLanguages = [config.language]
                req.usesLanguageCorrection = true
                requests.append(req)
            case .sceneClassify:
                requests.append(VNClassifyImageRequest())
            case .personDetect:
                let req = VNDetectHumanRectanglesRequest()
                req.upperBodyOnly = false
                requests.append(req)
            case .bodyPose:
                requests.append(VNDetectHumanBodyPoseRequest())
            }
        }
        return requests
    }

    private static func configureBarcodeSymbologiesStatic(_ req: VNDetectBarcodesRequest, symbologies: [String]) {
        var symbologyTypes: [VNBarcodeSymbology] = []
        for sym in symbologies {
            switch sym.lowercased() {
            case "qr": symbologyTypes.append(.qr)
            case "ean13": symbologyTypes.append(.ean13)
            case "code128": symbologyTypes.append(.code128)
            case "datamatrix": symbologyTypes.append(.dataMatrix)
            case "pdf417": symbologyTypes.append(.pdf417)
            case "aztec": symbologyTypes.append(.aztec)
            default: break
            }
        }
        if !symbologyTypes.isEmpty {
            req.symbologies = symbologyTypes
        }
    }

    // FPS throttle
    private var lastProcessTime: ContinuousClock.Instant?
    private var frameInterval: Duration {
        guard visionConfig.targetFPS > 0 else { return .zero }
        return .milliseconds(1000 / Int64(visionConfig.targetFPS))
    }

    // PreviewBus for overlay rendering
    private var previewBus: PreviewBus?
    private let previewSource = PreviewSource(stageId: "vision", label: "Vision")

    // Callback for relaying results to server
    private var onResult: (@Sendable (VisionFrameResult) async -> Void)?

    init(config: VisionStageConfig = .default) {
        self.visionConfig = config
        self.config = FrameStageConfig(targetFPS: config.targetFPS, isEnabled: true)
        self.requests = Self.buildRequests(config: config)
    }

    func setPreviewBus(_ bus: PreviewBus) {
        self.previewBus = bus
    }

    func setOnResult(_ handler: @escaping @Sendable (VisionFrameResult) async -> Void) {
        self.onResult = handler
    }

    func updateConfig(_ newConfig: VisionStageConfig) {
        self.visionConfig = newConfig
        self.config = FrameStageConfig(targetFPS: newConfig.targetFPS, isEnabled: true)
        self.requests = Self.buildRequests(config: newConfig)
        confidenceSmoother.reset()
    }

    nonisolated func processFrame(_ packet: FramePacket) async {
        await processFrameInternal(packet)
    }

    func start() async {
        lastProcessTime = nil
        NSLog("[VisionStage] Started with \(requests.count) requests, targetFPS=\(visionConfig.targetFPS)")
    }

    func stop() async {
        lastProcessTime = nil
        confidenceSmoother.reset()
        NSLog("[VisionStage] Stopped")
    }

    // MARK: - Private

    private func processFrameInternal(_ packet: FramePacket) {
        // FPS throttle
        let now = ContinuousClock.Instant.now
        if let last = lastProcessTime {
            let elapsed = now - last
            guard elapsed >= frameInterval else { return }
        }
        lastProcessTime = now

        guard let pixelBuffer = CMSampleBufferGetImageBuffer(packet.sampleBuffer) else { return }
        guard !requests.isEmpty else { return }

        let startTime = ContinuousClock.Instant.now

        // VNImageRequestHandler must be created per frame (Apple docs)
        let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, options: [:])

        do {
            try handler.perform(requests)
        } catch {
            NSLog("[VisionStage] VNRequest error: \(error)")
            return
        }

        let endTime = ContinuousClock.Instant.now
        let inferenceTime = endTime - startTime
        let inferenceMs = Double(inferenceTime.components.seconds) * 1000.0
            + Double(inferenceTime.components.attoseconds) / 1e15

        var detections: [VisionDetection] = []
        for (index, request) in requests.enumerated() {
            guard index < visionConfig.detectionTypes.count else { break }
            let detType = visionConfig.detectionTypes[index]

            switch detType {
            case .faceDetect:
                detections.append(contentsOf: extractFaces(request))
            case .barcodeScan:
                detections.append(contentsOf: extractBarcodes(request))
            case .ocr:
                detections.append(contentsOf: extractOCR(request))
            case .sceneClassify:
                detections.append(contentsOf: extractScene(request))
            case .personDetect:
                detections.append(contentsOf: extractPersons(request))
            case .bodyPose:
                detections.append(contentsOf: extractBodyPose(request))
            }
        }

        // Smooth confidence values with EMA (skip if alpha == 1.0 = disabled)
        if visionConfig.smoothingAlpha < 1.0 {
            confidenceSmoother.alpha = visionConfig.smoothingAlpha
            detections = detections.map { detection in
                let key: String
                switch detection {
                case .face, .person, .bodyPose:
                    guard let bbox = detection.boundingBox else {
                        return detection
                    }
                    key = confidenceSmoother.spatialKey(type: detection.detectionType.rawValue, bbox: bbox)
                case .barcode(let d):
                    key = "barcode-\(d.payloadString)"
                case .ocr(let d):
                    // Truncate to avoid unbounded keys from varying text
                    key = "ocr-\(d.text.prefix(80))"
                case .scene(let cls):
                    // Smooth each scene label individually
                    let smoothedLabels = cls.labels.map { label in
                        let labelKey = "scene-\(label.label)"
                        let smoothed = confidenceSmoother.smooth(key: labelKey, raw: label.confidence)
                        return SceneLabel(label: label.label, confidence: smoothed)
                    }
                    return detection.withSmoothedLabels(smoothedLabels)
                }
                let smoothed = confidenceSmoother.smooth(key: key, raw: detection.confidence, bbox: detection.boundingBox)
                return detection.withConfidence(smoothed)
            }
            confidenceSmoother.prune()
        }

        // Filter by (smoothed) confidence
        detections = detections.filter { $0.confidence >= visionConfig.confidence }

        // Filter by maxResults
        if visionConfig.maxResults > 0 && detections.count > visionConfig.maxResults {
            detections = Array(detections.prefix(visionConfig.maxResults))
        }

        let result = VisionFrameResult(
            timestamp: packet.timestamp,
            sequenceNumber: packet.sequenceNumber,
            detections: detections,
            inferenceTimeMs: inferenceMs
        )

        // Publish to PreviewBus for overlay rendering
        if let previewBus {
            Task { await previewBus.publish(.json(source: previewSource, value: result.jsonDict)) }
        }

        // Relay to server via callback
        if let onResult {
            Task { await onResult(result) }
        }
    }

    // MARK: - Result Extraction

    private func extractFaces(_ request: VNRequest) -> [VisionDetection] {
        guard let observations = request.results as? [VNFaceObservation] else { return [] }
        return observations.map { obs in
            let bb = obs.boundingBox
            // Vision uses bottom-left origin, convert to top-left (0,0 = top-left)
            let converted = NormalizedBoundingBox(
                x1: bb.origin.x,
                y1: 1.0 - bb.origin.y - bb.height,
                x2: bb.origin.x + bb.width,
                y2: 1.0 - bb.origin.y
            )
            return .face(FaceDetection(
                boundingBox: converted,
                confidence: Double(obs.confidence),
                landmarkCount: obs.landmarks?.allPoints?.pointCount ?? 0
            ))
        }
    }

    private func extractBarcodes(_ request: VNRequest) -> [VisionDetection] {
        guard let observations = request.results as? [VNBarcodeObservation] else { return [] }
        return observations.map { obs in
            let bb = obs.boundingBox
            let converted = NormalizedBoundingBox(
                x1: bb.origin.x,
                y1: 1.0 - bb.origin.y - bb.height,
                x2: bb.origin.x + bb.width,
                y2: 1.0 - bb.origin.y
            )
            return .barcode(BarcodeDetection(
                boundingBox: converted,
                payloadString: obs.payloadStringValue ?? "",
                symbology: stringForSymbology(obs.symbology),
                confidence: Double(obs.confidence)
            ))
        }
    }

    private func extractOCR(_ request: VNRequest) -> [VisionDetection] {
        guard let observations = request.results as? [VNRecognizedTextObservation] else { return [] }
        var results: [VisionDetection] = []
        for obs in observations {
            guard let candidate = obs.topCandidates(1).first else { continue }
            let bb = obs.boundingBox
            let converted = NormalizedBoundingBox(
                x1: bb.origin.x,
                y1: 1.0 - bb.origin.y - bb.height,
                x2: bb.origin.x + bb.width,
                y2: 1.0 - bb.origin.y
            )
            results.append(.ocr(OCRResult(
                boundingBox: converted,
                text: candidate.string,
                confidence: Double(candidate.confidence)
            )))
        }
        return results
    }

    private func extractScene(_ request: VNRequest) -> [VisionDetection] {
        guard let observations = request.results as? [VNClassificationObservation] else { return [] }
        let filtered = observations.prefix(visionConfig.maxLabels)
        let labels = filtered.map { obs in
            SceneLabel(label: obs.identifier, confidence: Double(obs.confidence))
        }
        guard !labels.isEmpty else { return [] }
        return [.scene(SceneClassification(labels: labels))]
    }

    private func extractPersons(_ request: VNRequest) -> [VisionDetection] {
        guard let observations = request.results as? [VNHumanObservation] else { return [] }
        return observations.map { obs in
            let bb = obs.boundingBox
            let converted = NormalizedBoundingBox(
                x1: bb.origin.x,
                y1: 1.0 - bb.origin.y - bb.height,
                x2: bb.origin.x + bb.width,
                y2: 1.0 - bb.origin.y
            )
            return .person(PersonDetection(
                boundingBox: converted,
                confidence: Double(obs.confidence)
            ))
        }
    }

    private func extractBodyPose(_ request: VNRequest) -> [VisionDetection] {
        guard let observations = request.results as? [VNHumanBodyPoseObservation] else { return [] }
        return observations.compactMap { obs in
            // Extract all recognized body joints
            var joints: [JointPoint] = []
            var minX = 1.0, minY = 1.0, maxX = 0.0, maxY = 0.0
            if let allPoints = try? obs.recognizedPoints(.all) {
                for (name, point) in allPoints {
                    guard point.confidence > 0 else { continue }
                    let px = Double(point.location.x)
                    let py = Double(point.location.y)
                    joints.append(JointPoint(
                        name: String(describing: name),
                        x: px,
                        y: 1.0 - py,  // Convert Vision bottom-left to top-left
                        confidence: Double(point.confidence)
                    ))
                    minX = min(minX, px)
                    minY = min(minY, py)
                    maxX = max(maxX, px)
                    maxY = max(maxY, py)
                }
            }

            guard !joints.isEmpty else { return nil }

            // Compute bounding box from joint extremes (convert Vision coords to top-left)
            let converted = NormalizedBoundingBox(
                x1: minX,
                y1: 1.0 - maxY,
                x2: maxX,
                y2: 1.0 - minY
            )

            return .bodyPose(BodyPoseDetection(
                boundingBox: converted,
                confidence: Double(obs.confidence),
                joints: joints
            ))
        }
    }

    // MARK: - Helpers

    private func stringForSymbology(_ sym: VNBarcodeSymbology) -> String {
        switch sym {
        case .QR: return "QR"
        case .EAN13: return "EAN-13"
        case .code128: return "Code128"
        case .dataMatrix: return "DataMatrix"
        case .PDF417: return "PDF417"
        case .aztec: return "Aztec"
        default: return String(describing: sym)
        }
    }
}
