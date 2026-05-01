// ObjectTrackingStage.swift
// Pipeline stage actor for OC-SORT multi-object tracking.
// Paper: arXiv:2203.14360 (CVPR 2023)
// Consumes detections from VisionStage via feedDetections(), runs OC-SORT
// for persistent ID assignment, zone accounting, and dual output (relay + overlay).
// processFrame is a no-op — tracking is detection-driven, not frame-driven.

import Foundation
import CoreVideo

// MARK: - ObjectTrackingStage Actor

actor ObjectTrackingStage: @preconcurrency FramePipelineStage {
    nonisolated let stageId: String = "tracking"
    var config: FrameStageConfig

    // Tracking subsystems
    private var tracker: OCSORT
    private var registry: ItemRegistry
    private var smoother: ConfidenceSmoother

    // Tracking config
    // Ref: arXiv:2203.14360 Sec 4.2 — OCM parameters (deltaT, inertia, detThresh)
    private var trackingConfig: TrackingStageConfig

    // Dual output
    var onResult: ((TrackingFrameResult) async -> Void)?
    var previewBus: PreviewBus?

    // Stage state
    private var isRunning = false

    init(config: TrackingStageConfig = TrackingStageConfig()) {
        self.config = FrameStageConfig()
        self.trackingConfig = config
        // Paper: OCSort.__init__ — detThresh, maxAge, minHits, iouThreshold, deltaT, inertia
        self.tracker = OCSORT(
            detThresh: config.detThresh,
            maxAge: config.maxAge,
            minHits: config.minHits,
            iouThreshold: config.iouThreshold,
            deltaT: config.deltaT,
            inertia: config.inertia,
            maxTracks: config.maxTracks
        )
        self.registry = ItemRegistry()
        self.smoother = ConfidenceSmoother()
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
            detThresh: newConfig.detThresh,
            maxAge: newConfig.maxAge,
            minHits: newConfig.minHits,
            iouThreshold: newConfig.iouThreshold,
            deltaT: newConfig.deltaT,
            inertia: newConfig.inertia,
            maxTracks: newConfig.maxTracks
        )
        self.registry.setZones(newConfig.zones)
        self.smoother.reset()
    }

    func start() async {
        guard !isRunning else { return }
        isRunning = true
        registry.setZones(trackingConfig.zones)
        NSLog("[ObjectTrackingStage] Started: detThresh=\(trackingConfig.detThresh) iouThreshold=\(trackingConfig.iouThreshold) maxAge=\(trackingConfig.maxAge) minHits=\(trackingConfig.minHits) deltaT=\(trackingConfig.deltaT) inertia=\(trackingConfig.inertia)")
    }

    func stop() async {
        isRunning = false
        tracker.reset()
        registry.reset()
        smoother.reset()
        NSLog("[ObjectTrackingStage] Stopped")
    }

    /// No-op — tracking is driven by feedDetections(), not by frames.
    func processFrame(_ packet: FramePacket) async {
        // Intentionally empty. Tracking consumes vision detections via feedDetections().
    }

    /// Feed vision detections into OC-SORT tracker. Called from ViewModel
    /// when vision stage produces results and tracking is active.
    // Paper: OCSort.update() — takes detections, returns tracks with persistent IDs
    func feedDetections(_ detections: [TrackDetection], timestamp: Double) async {
        guard isRunning else { return }

        let startTime = CFAbsoluteTimeGetCurrent()

        // Confidence smoothing
        var smoothed = detections
        if trackingConfig.smoothingAlpha < 1.0 {
            smoothed = detections.map { det in
                let smoothedConf = smoother.smooth(
                    key: "tracking-\(det.classLabel)",
                    raw: det.confidence,
                    bbox: det.bbox
                )
                return TrackDetection(
                    bbox: det.bbox,
                    confidence: smoothedConf,
                    classLabel: det.classLabel
                )
            }
        }

        // OC-SORT update — runs ORU, OCM, OCR internally
        let tracks = tracker.update(detections: smoothed, timestamp: timestamp)

        // ItemRegistry update — zone accounting
        let _ = registry.update(tracks: tracks, timestamp: timestamp)
        let snapshot = registry.snapshot(tracks: tracks)

        // Build result
        let inferenceTimeMs = (CFAbsoluteTimeGetCurrent() - startTime) * 1000.0
        let result = TrackingFrameResult(
            tracks: tracks,
            registry: snapshot,
            inferenceTimeMs: inferenceTimeMs,
            timestamp: timestamp
        )

        // Dual output
        await onResult?(result)

        #if DEBUG
        let source = PreviewSource(stageId: "tracking", label: "OC-SORT Tracker")
        await previewBus?.publish(.json(source: source, value: result.jsonDict()))
        #endif
    }
}
