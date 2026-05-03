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

import CoreImage
import CoreMedia
import CoreVideo
import Foundation
import ImageIO
import Vision

actor VisionStage: @preconcurrency FramePipelineStage {
    nonisolated let stageId = "vision"
    var config: FrameStageConfig

    // Vision configuration
    private var visionConfig: VisionStageConfig

    // Per-stage metrics
    private var metricsTracker: StageMetricsTracker

    // Confidence smoothing (EMA per tracked detection)
    private var confidenceSmoother = ConfidenceSmoother(alpha: 0.3)

    // CIContext for thumbnail extraction (shared pipeline-wide, avoids duplicate Metal contexts)
    private lazy var ciContext: CIContext = PipelineCIContext.shared

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

    // Callback for relaying results to server (includes optional thumbnails + histograms + embeddings)
    private var onResult: (@Sendable (VisionFrameResult, [(Int, String)]?, [(Int, [Double])], [(Int, [Double])]) async -> Void)?

    /// Whether to extract HSV histograms for Bhattacharyya gate.
    var extractHistograms: Bool = false

    /// Whether to extract OSNet embeddings for ReID gate (on-device, bypasses server roundtrip).
    var extractEmbeddings: Bool = false

    /// On-device OSNet embedding extractor (loaded by ViewModel when gate-reid + useOnDevice).
    var embeddingExtractor: EmbeddingExtractor?

    /// Setter for extractHistograms callable from outside the actor.
    func setExtractHistograms(_ value: Bool) {
        extractHistograms = value
    }

    /// Setter for embedding extraction and extractor callable from outside the actor.
    func setEmbeddingExtractor(_ extractor: EmbeddingExtractor?) {
        embeddingExtractor = extractor
        extractEmbeddings = extractor != nil
    }

    init(config: VisionStageConfig = .default) {
        self.visionConfig = config
        self.config = FrameStageConfig(targetFPS: config.targetFPS, isEnabled: true)
        self.requests = Self.buildRequests(config: config)
        self.metricsTracker = StageMetricsTracker(stageId: "vision", nodeType: "vision-face-detect")
    }

    func setPreviewBus(_ bus: PreviewBus) {
        self.previewBus = bus
    }

    func setOnResult(_ handler: @escaping @Sendable (VisionFrameResult, [(Int, String)]?, [(Int, [Double])], [(Int, [Double])]) async -> Void) {
        self.onResult = handler
    }

    func updateConfig(_ newConfig: VisionStageConfig) {
        self.visionConfig = newConfig
        self.config = FrameStageConfig(targetFPS: newConfig.targetFPS, isEnabled: true)
        self.requests = Self.buildRequests(config: newConfig)
        confidenceSmoother.reset()
        // Update metrics nodeType to reflect primary detection type
        if let primary = newConfig.detectionTypes.first {
            metricsTracker = StageMetricsTracker(stageId: "vision", nodeType: "vision-\(primary.rawValue)")
        }
    }

    nonisolated func processFrame(_ packet: FramePacket) async {
        // Snapshot pixel buffer SYNCHRONOUSLY before actor hop.
        // Task.detached in FramePipelineManager introduces a scheduling delay —
        // by the time the actor runs, the SDK may have recycled the IOSurface.
        // Capturing here (still synchronous, still on the calling thread) ensures
        // the snapshot matches the frame that produced the detections.
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
        await processFrameInternal(packet, snapshotBuffer: snapshotBuffer)
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

    func collectMetrics() -> StageMetricsSnapshot? {
        // CoreML model ~40-80MB depending on detection types
        let memMB = Double(requests.count) * 15.0
        metricsTracker.setMemoryMB(memMB)
        return metricsTracker.collect()
    }

    // MARK: - Private

    private func processFrameInternal(_ packet: FramePacket, snapshotBuffer: CVPixelBuffer?) {
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

        guard let pixelBuffer = CMSampleBufferGetImageBuffer(packet.sampleBuffer) else { return }
        guard !requests.isEmpty else { return }

        let cpuStart = metricsTracker.beginFrame()
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

        metricsTracker.endFrame(cpuStart: cpuStart, wallClockMs: inferenceMs)

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

        // Extract thumbnails if enabled and there are detections with bounding boxes.
        // Only extract for detection types specified in thumbnailDetectionTypes (edge-connected).
        // Use the pre-snapped buffer from processFrame (captured synchronously before actor hop).
        var thumbnails: [(Int, String)]? = nil
        if visionConfig.thumbnailsEnabled, let snapshotBuffer {
            let allowedTypes = visionConfig.thumbnailDetectionTypes
            let maxSize = visionConfig.thumbnailMaxCount > 0
                ? visionConfig.thumbnailMaxCount
                : detections.count
            var extracted: [(Int, String)] = []
            for (i, detection) in detections.enumerated() {
                guard extracted.count < maxSize else { break }
                // Filter: if thumbnailDetectionTypes is set, only extract for those types
                if !allowedTypes.isEmpty && !allowedTypes.contains(detection.detectionType) {
                    continue
                }
                if let bbox = detection.boundingBox {
                    if let thumb = extractThumbnail(from: snapshotBuffer, bbox: bbox) {
                        extracted.append((i, thumb))
                    }
                }
            }
            if !extracted.isEmpty {
                thumbnails = extracted
            }
        }

        // Extract HSV histograms for Bhattacharyya gate (on-device, cheap <0.5ms per crop)
        var histograms: [(Int, [Double])] = []
        if extractHistograms, let snapshotBuffer {
            for (i, detection) in detections.enumerated() {
                guard let bbox = detection.boundingBox else { continue }
                if let hist = HistogramExtractor.extractHSV(from: snapshotBuffer, bbox: bbox) {
                    histograms.append((i, hist))
                }
            }
        }

        // Extract OSNet embeddings for ReID gate (on-device, <10ms per crop)
        var embeddings: [(Int, [Double])] = []
        if extractEmbeddings, let snapshotBuffer, let extractor = embeddingExtractor {
            for (i, detection) in detections.enumerated() {
                guard let bbox = detection.boundingBox else { continue }
                if let embed = extractor.extract(from: snapshotBuffer, bbox: bbox) {
                    embeddings.append((i, embed))
                }
            }
        }

        // Publish to PreviewBus for overlay rendering
        if let previewBus {
            Task { await previewBus.publish(.json(source: previewSource, value: result.jsonDict(thumbnails: nil))) }
        }

        // Relay to server via callback (includes thumbnails + histograms + embeddings)
        if let onResult {
            Task { await onResult(result, thumbnails, histograms, embeddings) }
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

    /// Extract a thumbnail from the pixel buffer at the given normalized bounding box.
    /// Returns a base64-encoded JPEG string, or nil if extraction fails.
    private func extractThumbnail(from pixelBuffer: CVPixelBuffer, bbox: NormalizedBoundingBox) -> String? {
        let bufWidth = CVPixelBufferGetWidth(pixelBuffer)
        let bufHeight = CVPixelBufferGetHeight(pixelBuffer)
        guard bufWidth > 0, bufHeight > 0 else { return nil }

        // Convert normalized 0-1 coordinates to pixel coordinates, clamped to buffer bounds
        let pxX = max(0, Int(bbox.x1 * Double(bufWidth)))
        let pxY = max(0, Int(bbox.y1 * Double(bufHeight)))
        let pxX2 = min(bufWidth, Int(bbox.x2 * Double(bufWidth)))
        let pxY2 = min(bufHeight, Int(bbox.y2 * Double(bufHeight)))
        let pxW = pxX2 - pxX
        let pxH = pxY2 - pxY
        guard pxW > 0, pxH > 0 else { return nil }

        // Flip Y for CIImage's bottom-left origin: our bbox uses top-left Y (0=top),
        // but CIImage expects Y=0 at bottom. So ciCropY = bufHeight - pxY2.
        let ciCropY = CGFloat(bufHeight) - CGFloat(pxY2)
        let cropRect = CGRect(x: CGFloat(pxX), y: ciCropY, width: CGFloat(pxW), height: CGFloat(pxH))
        let targetSize = visionConfig.thumbnailSize

        // Create CIImage from pixel buffer and crop
        let fullImage = CIImage(cvPixelBuffer: pixelBuffer)
        let cropped = fullImage.cropped(to: cropRect)

        // Skip if cropped image extent is empty or doesn't intersect the source
        guard cropped.extent.width > 0, cropped.extent.height > 0,
              fullImage.extent.intersects(cropRect) else { return nil }

        // Skip if the crop region is too small (< 4px in either dimension) — produces black/empty thumbnails
        guard pxW >= 4, pxH >= 4 else { return nil }

        // Allocate a fresh output CVPixelBuffer (BGRA, per pipeline convention)
        var outBuffer: CVPixelBuffer?
        let attrs: [String: Any] = [
            kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any]
        ]
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            targetSize,
            targetSize,
            kCVPixelFormatType_32BGRA,
            attrs as CFDictionary,
            &outBuffer
        )
        guard status == kCVReturnSuccess, let outBuffer else { return nil }

        // Translate cropped image to origin (0,0) then scale to target size.
        // CIImage.cropped(to:) preserves the crop rect origin in the extent,
        // so without translating, the scaled image would be offset and not
        // overlap the render bounds (0,0,targetSize,targetSize) — producing black.
        let translate = CGAffineTransform(translationX: -cropRect.origin.x, y: -cropRect.origin.y)
        let scale = CGAffineTransform(scaleX: CGFloat(targetSize) / cropRect.width, y: CGFloat(targetSize) / cropRect.height)
        let scaledImage = cropped.transformed(by: translate.concatenating(scale))

        let colorSpace = CGColorSpaceCreateDeviceRGB()
        ciContext.render(scaledImage, to: outBuffer, bounds: CGRect(x: 0, y: 0, width: targetSize, height: targetSize), colorSpace: colorSpace)

        // Convert to JPEG via CIContext
        let jpegCIImage = CIImage(cvPixelBuffer: outBuffer)
        guard let jpegData = ciContext.jpegRepresentation(of: jpegCIImage, colorSpace: colorSpace, options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: visionConfig.thumbnailQuality]) else {
            return nil
        }

        return jpegData.base64EncodedString()
    }

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
