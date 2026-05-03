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
    private var heatMapBuffer: HeatMapBuffer?

    // Tracking config
    // Ref: arXiv:2203.14360 Sec 4.2 — OCM parameters (deltaT, inertia, detThresh)
    private var trackingConfig: TrackingStageConfig

    // Dual output
    var onResult: ((TrackingFrameResult) async -> Void)?
    var previewBus: PreviewBus?

    // Frame-skip throttle state
    private var lastTrackTime: Double = 0

    // Per-stage metrics
    private var metricsTracker = StageMetricsTracker(stageId: "tracking", nodeType: "tracking-ocsort")

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
            maxTracks: config.maxTracks,
            useByte: config.useByte,
            forecastSteps: config.forecastSteps,
            gates: config.gates,
            costFunctionType: config.costFunction,
            reconciliationEnabled: config.reconciliationEnabled,
            reconciliationMaxGap: config.reconciliationMaxGap,
            reconciliationThreshold: config.reconciliationThreshold,
            reconciliationSpatialWeight: config.reconciliationSpatialWeight
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

    func collectMetrics() -> StageMetricsSnapshot? {
        // Track state proportional to active tracks
        let memMB = Double(tracker.activeTrackCount) * 0.5 + 5.0
        metricsTracker.setMemoryMB(memMB)
        return metricsTracker.collect()
    }

    func updateConfig(_ newConfig: TrackingStageConfig) {
        self.trackingConfig = newConfig
        // Heat map buffer: create when enabled, nil when disabled (zero overhead)
        if newConfig.heatmapEnabled {
            self.heatMapBuffer = HeatMapBuffer(config: HeatMapConfig(
                enabled: true,
                resolution: newConfig.heatmapResolution,
                decayRate: newConfig.heatmapDecayRate,
                gaussianRadius: newConfig.heatmapGaussianRadius,
                opacity: newConfig.heatmapOpacity,
                mode: HeatMapMode(rawValue: newConfig.heatmapMode) ?? .detection
            ))
        } else {
            self.heatMapBuffer = nil
        }
        self.tracker = OCSORT(
            detThresh: newConfig.detThresh,
            maxAge: newConfig.maxAge,
            minHits: newConfig.minHits,
            iouThreshold: newConfig.iouThreshold,
            deltaT: newConfig.deltaT,
            inertia: newConfig.inertia,
            maxTracks: newConfig.maxTracks,
            useByte: newConfig.useByte,
            forecastSteps: newConfig.forecastSteps,
            gates: newConfig.gates,
            costFunctionType: newConfig.costFunction,
            reconciliationEnabled: newConfig.reconciliationEnabled,
            reconciliationMaxGap: newConfig.reconciliationMaxGap,
            reconciliationThreshold: newConfig.reconciliationThreshold,
            reconciliationSpatialWeight: newConfig.reconciliationSpatialWeight
        )
        self.registry.setZones(newConfig.zones)
        self.smoother.reset()
    }

    func start() async {
        guard !isRunning else { return }
        isRunning = true
        registry.setZones(trackingConfig.zones)
        NSLog("[ObjectTrackingStage] Started: detThresh=\(trackingConfig.detThresh) iouThreshold=\(trackingConfig.iouThreshold) maxAge=\(trackingConfig.maxAge) minHits=\(trackingConfig.minHits) deltaT=\(trackingConfig.deltaT) inertia=\(trackingConfig.inertia) forecastSteps=\(trackingConfig.forecastSteps)")
    }

    func stop() async {
        isRunning = false
        lastTrackTime = 0
        tracker.reset()
        registry.reset()
        smoother.reset()
        heatMapBuffer = nil
        NSLog("[ObjectTrackingStage] Stopped")
    }

    /// No-op — tracking is driven by feedDetections(), not by frames.
    func processFrame(_ packet: FramePacket) async {
        // Intentionally empty. Tracking consumes vision detections via feedDetections().
    }

    /// Inject late-arriving ReID embeddings into matched tracks.
    /// Called from ViewModel when server sends reid_embeddings message.
    /// Maps detection indices to matched tracks via OCSORT.lastMatchPairs.
    func injectEmbeddings(_ embeddings: [Int: [Double]]) {
        guard isRunning, !embeddings.isEmpty else { return }
        tracker.updateEmbeddings(embeddings)
    }

    /// Feed vision detections into OC-SORT tracker. Called from ViewModel
    /// when vision stage produces results and tracking is active.
    // Paper: OCSort.update() — takes detections, returns tracks with persistent IDs
    func feedDetections(_ detections: [TrackDetection], timestamp: Double) async {
        guard isRunning else { return }

        // Frame-skip: drop detections arriving faster than targetFPS
        let interval = 1.0 / max(trackingConfig.targetFPS, 1)
        if timestamp - lastTrackTime < interval {
            metricsTracker.recordDrop()
            return
        }
        lastTrackTime = timestamp

        let cpuStart = metricsTracker.beginFrame()
        let startTime = CFAbsoluteTimeGetCurrent()

        // Confidence smoothing (spatial matching — same pattern as YOLOStage)
        var smoothed = detections
        if trackingConfig.smoothingAlpha < 1.0 {
            smoother.alpha = trackingConfig.smoothingAlpha
            smoothed = detections.map { det in
                let key = smoother.spatialKey(
                    type: "tracking-\(det.classLabel)",
                    bbox: det.bbox
                )
                let smoothedConf = smoother.smooth(
                    key: key,
                    raw: det.confidence,
                    bbox: det.bbox
                )
                return TrackDetection(
                    bbox: det.bbox,
                    confidence: smoothedConf,
                    classLabel: det.classLabel,
                    histogram: det.histogram,
                    embedding: det.embedding
                )
            }
            smoother.prune()
        }

        // OC-SORT update — runs ORU, OCM, OCR internally
        let tracks = tracker.update(detections: smoothed, timestamp: timestamp)

        // Heat map accumulation — splat each track center into the grid
        if var hbuf = heatMapBuffer {
            for track in tracks {
                let cx = (track.bbox.x1 + track.bbox.x2) / 2
                let cy = (track.bbox.y1 + track.bbox.y2) / 2
                hbuf.splat(x: cx, y: cy, weight: 1.0)
            }
            hbuf.decay()
            heatMapBuffer = hbuf
        }

        // Restore reconciled track zone histories from deadItems cache.
        // When a dead track is matched to a new track, restore its TrackedItem
        // so zone history continuity is preserved across the occlusion gap.
        if !tracker.reconciliationMap.isEmpty {
            for (_, deadId) in tracker.reconciliationMap {
                registry.restoreItem(trackId: deadId)
            }
        }

        // ItemRegistry update — zone accounting
        // Pass lost track IDs to preserve zone history during temporary occlusion
        let _ = registry.update(tracks: tracks, timestamp: timestamp, lostTrackIds: tracker.lostTrackIds)
        let snapshot = registry.snapshot(tracks: tracks)

        // Zone breach prediction from trajectory forecasts.
        // Check if any forecast position enters a zone that the track is not currently in.
        var predictedBreaches: [ZoneTransition] = []
        if !trackingConfig.zones.isEmpty {
            for track in tracks {
                guard !track.forecast.isEmpty else { continue }
                // Determine which zone the track is currently in (if any)
                let currentCenter = ((track.bbox.x1 + track.bbox.x2) / 2, (track.bbox.y1 + track.bbox.y2) / 2)
                let currentZone = trackingConfig.zones.first { $0.contains(center: currentCenter) }

                for pos in track.forecast {
                    let enteredZone = trackingConfig.zones.first { $0.contains(center: pos.center) }
                    // Only flag if entering a DIFFERENT zone than current
                    if let entered = enteredZone, entered.id != currentZone?.id {
                        predictedBreaches.append(ZoneTransition(
                            trackId: track.trackId,
                            classLabel: track.classLabel,
                            fromZone: currentZone?.label,
                            toZone: entered.label,
                            timestamp: timestamp + Double(pos.step) / max(trackingConfig.targetFPS, 1),
                            predicted: true
                        ))
                        break // One breach per track per frame
                    }
                }
            }
        }

        // Build result
        let inferenceTimeMs = (CFAbsoluteTimeGetCurrent() - startTime) * 1000.0
        metricsTracker.endFrame(cpuStart: cpuStart, wallClockMs: inferenceTimeMs)
        let result = TrackingFrameResult(
            tracks: tracks,
            registry: snapshot,
            inferenceTimeMs: inferenceTimeMs,
            timestamp: timestamp,
            predictedZoneBreaches: predictedBreaches,
            heatMap: heatMapBuffer?.snapshot
        )

        // Dual output
        await onResult?(result)

        #if DEBUG
        let source = PreviewSource(stageId: "tracking", label: "OC-SORT Tracker")
        await previewBus?.publish(.json(source: source, value: result.jsonDict()))
        #endif
    }
}
