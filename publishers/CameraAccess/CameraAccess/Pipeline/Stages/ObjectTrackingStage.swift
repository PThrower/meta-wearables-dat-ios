// ObjectTrackingStage.swift
// Pipeline stage actor for OC-SORT multi-object tracking.
// Mirrors VisionStage pattern: FPS-throttled, dual output (relay + overlay),
// confidence smoothing, Apple Vision detection front-end.

import Foundation
import Vision
import CoreVideo

/// Protocol for detection front-ends. Apple Vision today, CoreML future.
protocol ObjectDetector: Sendable {
    func detect(in pixelBuffer: CVPixelBuffer, timestamp: Double) async -> [TrackDetection]
}

/// Apple Vision person detector using VNDetectHumanRectanglesRequest.
struct PersonVisionDetector: ObjectDetector, Sendable {
    let confidence: Double
    let targetClasses: [String]

    func detect(in pixelBuffer: CVPixelBuffer, timestamp: Double) async -> [TrackDetection] {
        await withCheckedContinuation { continuation in
            let request = VNDetectHumanRectanglesRequest { request, error in
                guard error == nil, let results = request.results as? [VNHumanObservation] else {
                    continuation.resume(returning: [])
                    return
                }
                let detections = results.compactMap { obs -> TrackDetection? in
                    let bb = obs.boundingBox
                    // Vision framework: origin bottom-left. Convert to top-left.
                    let x1 = bb.origin.x
                    let y1 = 1.0 - bb.origin.y - bb.height
                    let x2 = x1 + bb.width
                    let y2 = y1 + bb.height
                    let conf = obs.confidence > 0 ? Double(obs.confidence) : 0.8
                    guard conf >= self.confidence else { return nil }
                    return TrackDetection(
                        bbox: NormalizedBoundingBox(x1: x1, y1: y1, x2: x2, y2: y2),
                        confidence: conf,
                        classLabel: "person"
                    )
                }
                continuation.resume(returning: detections)
            }
            request.upperBodyOnly = false
            let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, options: [:])
            try? handler.perform([request])
        }
    }
}

// MARK: - ObjectTrackingStage Actor

actor ObjectTrackingStage: @preconcurrency FramePipelineStage {
    nonisolated let stageId: String = "tracking"
    var config: FrameStageConfig

    // Tracking subsystems
    private var tracker: OCSORT
    private var registry: ItemRegistry
    private var smoother: ConfidenceSmoother
    private var detector: ObjectDetector?

    // FPS throttle
    private var lastProcessTime: CFAbsoluteTime = 0
    private var frameInterval: Double

    // Tracking config
    private var trackingConfig: TrackingStageConfig

    // Dual output
    var onResult: ((TrackingFrameResult) async -> Void)?
    var previewBus: PreviewBus?

    // Stage state
    private var isRunning = false

    init(config: TrackingStageConfig = TrackingStageConfig()) {
        self.config = FrameStageConfig()
        self.trackingConfig = config
        self.tracker = OCSORT(
            iouThreshold: config.iouThreshold,
            maxAge: config.maxAge,
            minHits: config.minHits,
            maxTracks: config.maxTracks
        )
        self.registry = ItemRegistry()
        self.smoother = ConfidenceSmoother()
        self.frameInterval = config.targetFPS > 0 ? 1.0 / config.targetFPS : 0
    }

    func setOnResult(_ handler: @escaping (TrackingFrameResult) async -> Void) {
        self.onResult = handler
    }

    func setPreviewBus(_ bus: PreviewBus) {
        self.previewBus = bus
    }

    func updateConfig(_ newConfig: TrackingStageConfig) {
        self.trackingConfig = newConfig
        self.tracker = OCSORT(
            iouThreshold: newConfig.iouThreshold,
            maxAge: newConfig.maxAge,
            minHits: newConfig.minHits,
            maxTracks: newConfig.maxTracks
        )
        self.registry.setZones(newConfig.zones)
        self.smoother.reset()
        self.frameInterval = newConfig.targetFPS > 0 ? 1.0 / newConfig.targetFPS : 0
    }

    func start() async {
        guard !isRunning else { return }
        isRunning = true

        // Set up detector based on target classes
        // Default to person detection via Apple Vision
        let classes = trackingConfig.targetClasses
        if classes.isEmpty || classes.contains("person") {
            self.detector = PersonVisionDetector(
                confidence: trackingConfig.confidence,
                targetClasses: classes
            )
        }

        registry.setZones(trackingConfig.zones)
        NSLog("[ObjectTrackingStage] Started: iouThreshold=\(trackingConfig.iouThreshold) maxAge=\(trackingConfig.maxAge) minHits=\(trackingConfig.minHits)")
    }

    func stop() async {
        isRunning = false
        tracker.reset()
        registry.reset()
        smoother.reset()
        detector = nil
        NSLog("[ObjectTrackingStage] Stopped")
    }

    func processFrame(_ packet: FramePacket) async {
        guard isRunning else { return }

        // FPS throttle
        let now = CFAbsoluteTimeGetCurrent()
        guard frameInterval <= 0 || (now - lastProcessTime) >= frameInterval else { return }
        lastProcessTime = now

        guard let pixelBuffer = CMSampleBufferGetImageBuffer(packet.sampleBuffer) else { return }

        let startTime = CFAbsoluteTimeGetCurrent()

        // Step 1: Detect objects
        guard let detector = detector else { return }
        var detections = await detector.detect(in: pixelBuffer, timestamp: now)

        // Step 2: Confidence smoothing
        if trackingConfig.smoothingAlpha < 1.0 {
            detections = detections.map { det in
                let smoothed = smoother.smooth(
                    key: "tracking-\(det.classLabel)",
                    raw: det.confidence,
                    bbox: det.bbox
                )
                return TrackDetection(
                    bbox: det.bbox,
                    confidence: smoothed,
                    classLabel: det.classLabel
                )
            }
        }

        // Step 3: OC-SORT update
        let tracks = tracker.update(detections: detections, timestamp: now)

        // Step 4: ItemRegistry update
        let _ = registry.update(tracks: tracks, timestamp: now)
        let snapshot = registry.snapshot(tracks: tracks)

        // Step 5: Build result
        let inferenceTimeMs = (CFAbsoluteTimeGetCurrent() - startTime) * 1000.0
        let result = TrackingFrameResult(
            tracks: tracks,
            registry: snapshot,
            inferenceTimeMs: inferenceTimeMs,
            timestamp: now
        )

        // Step 6: Dual output
        await onResult?(result)

        // Publish tracking result as JSON preview event
        let source = PreviewSource(stageId: "tracking", label: "OC-SORT Tracker")
        await previewBus?.publish(.json(source: source, value: result.jsonDict()))
    }
}
