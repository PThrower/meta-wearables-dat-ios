//
// PipelineStore.swift
//
// Vision, YOLO, tracking, sensor, speech, enhance, and measurement pipeline stages.
// Manages stage lifecycle and publishes detection state for UI overlays.
//

import SwiftUI

@MainActor
@Observable
final class PipelineStore {

  // MARK: - Detection State (UI overlays)

  var boundingBoxes: [BoundingBox] = []
  var visionDetections: [VisionDetection] = []
  var visionSceneLabel: String?
  var showBboxOverlay: Bool = true
  var overlayTranscription: String? = nil
  var yoloModelState: YOLOModelState = .idle
  var yoloDetections: [YOLODetection] = []
  var trackingTracks: [Track] = []
  var trackingSnapshot: RegistrySnapshot? = nil
  var heatMap: HeatMapSnapshot? = nil
  var toolMeasureResult: ToolMeasureResult?

  var activeZones: [ZoneDefinition] {
    trackingConfig?.zones ?? []
  }

  var isYoloConfigured: Bool { yoloStage != nil }

  /// Called when any pipeline stage encounters a fatal error that should be shown to the user.
  var onError: ((String) -> Void)?

  // MARK: - Pipeline Stage References

  private let pipeline: FramePipelineManager
  private var visionStage: VisionStage?
  private var enhanceStage: FrameTransformStage?
  private var audioClassificationStage: AudioClassificationStage?
  private var locationStage: LocationStage?
  private var speechRecognitionStage: SpeechRecognitionStage?
  private var voiceActivityStage: VoiceActivityStage?
  private var trackingStage: ObjectTrackingStage?
  private var trackingConfig: TrackingStageConfig?
  private var measureStage: ToolMeasurementStage?
  private var yoloStage: YOLOStage?

  #if DEBUG
  let previewBus = PreviewBus()
  #endif

  // Weak reference back to coordinator for relay access
  private weak var relayStage: RelayStage?

  init(pipeline: FramePipelineManager, relayStage: RelayStage) {
    self.pipeline = pipeline
    self.relayStage = relayStage
  }

  // MARK: - Vision Stage

  func configureVisionStage(config: [String: Any]) async {
    if let existing = visionStage {
      await existing.stop()
      pipeline.unregister(stageId: existing.stageId)
      visionStage = nil
      visionDetections = []
      visionSceneLabel = nil
    }

    let detectionTypeStrings = config["detectionTypes"] as? [String]
      ?? ((config["nodeType"] as? String).map { [$0] } ?? [])
    let detectionTypes = detectionTypeStrings.compactMap { VisionDetectionType(rawValue: $0) }
    guard !detectionTypes.isEmpty else { return }

    let confidence = config["confidence"] as? Double ?? 0.5
    let smoothingAlpha = config["smoothingAlpha"] as? Double ?? 0.3
    let targetFPS = config["targetFPS"] as? UInt ?? 5
    let maxResults = config["maxResults"] as? Int ?? 0
    let language = config["language"] as? String ?? "en-US"
    let maxLabels = config["maxLabels"] as? Int ?? 5
    let symbologies: [String] = (config["symbologies"] as? [String]) ?? ["qr"]

    let thumbnailsEnabled = config["thumbnailsEnabled"] as? Bool ?? false
    let thumbnailDetTypeStrings = config["thumbnailDetectionTypes"] as? [String] ?? []
    let thumbnailDetectionTypes = thumbnailDetTypeStrings.compactMap { VisionDetectionType(rawValue: $0) }
    let thumbnailSize = config["thumbnailSize"] as? Int ?? 64
    let thumbnailMaxCount = config["thumbnailMaxCount"] as? Int ?? 4
    let thumbnailQuality = config["thumbnailQuality"] as? Double ?? 0.6

    let visionConfig = VisionStageConfig(
      detectionTypes: detectionTypes,
      confidence: confidence,
      targetFPS: targetFPS,
      maxResults: maxResults,
      smoothingAlpha: smoothingAlpha,
      language: language,
      symbologies: symbologies,
      maxLabels: maxLabels,
      thumbnailsEnabled: thumbnailsEnabled,
      thumbnailDetectionTypes: thumbnailDetectionTypes,
      thumbnailSize: thumbnailSize,
      thumbnailMaxCount: thumbnailMaxCount,
      thumbnailQuality: CGFloat(thumbnailQuality)
    )

    let stage = VisionStage(config: visionConfig)

    await stage.setOnResult { [weak self] (result: VisionFrameResult, thumbnails: [(Int, String)]?, histograms: [(Int, [Double])], embeddings: [(Int, [Double])]) in
      await MainActor.run {
        if self?.trackingStage != nil {
          self?.visionDetections = result.detections.filter { $0.boundingBox == nil }
        } else {
          self?.visionDetections = result.detections
        }
        for det in result.detections {
          if case .scene(let cls) = det, let first = cls.labels.first {
            self?.visionSceneLabel = "\(first.label) \(Int(first.confidence * 100))%"
          }
        }
      }
      if !result.isEmpty {
        await self?.relayStage?.sendJson(result.jsonDict(thumbnails: thumbnails))
      }
      if let trackingStage = await self?.trackingStage {
        let histMap = Dictionary(uniqueKeysWithValues: histograms)
        let embedMap = Dictionary(uniqueKeysWithValues: embeddings)
        let hasOnDeviceEmbedding = !embedMap.isEmpty
        let trackDets: [TrackDetection] = result.detections.enumerated().compactMap { (i, det) in
          guard let bbox = det.boundingBox else { return nil }
          return TrackDetection(
            bbox: bbox,
            confidence: det.confidence,
            classLabel: det.displayLabel,
            histogram: histMap[i],
            embedding: embedMap[i]
          )
        }
        if !trackDets.isEmpty {
          await trackingStage.feedDetections(trackDets, timestamp: CFAbsoluteTimeGetCurrent())
        }
        let hasReID: Bool
        if let self {
          hasReID = await self.trackingConfig?.gates.contains(where: { $0.gateType == "gate-reid" }) ?? false
        } else {
          hasReID = false
        }
        if let self,
           await self.trackingStage != nil,
           hasReID,
           !hasOnDeviceEmbedding,
           let thumbnails {
          let reidCrops = thumbnails.filter { (i, _) in
            result.detections[i].boundingBox != nil
          }.map { (i, data) -> [String: Any] in
            return ["detectionIndex": i, "data": data]
          }
          if !reidCrops.isEmpty {
            await self.relayStage?.sendJson([
              "type": "reid_crops",
              "crops": reidCrops
            ])
          }
        }
      }
    }

    #if DEBUG
    await stage.setPreviewBus(previewBus)
    #endif

    pipeline.register(stage)
    await stage.start()
    visionStage = stage

    NSLog("[PipelineStore] VisionStage registered: \(detectionTypes.map { $0.rawValue }) confidence=\(confidence) fps=\(targetFPS)")
  }

  func disableVisionStage() async {
    guard let existing = visionStage else { return }
    await existing.stop()
    pipeline.unregister(stageId: existing.stageId)
    visionStage = nil
    visionDetections = []
    visionSceneLabel = nil
    NSLog("[PipelineStore] VisionStage disabled")
  }

  // MARK: - YOLO Stage

  func configureYOLOStage(config: [String: Any]) async throws {
    if let existing = yoloStage {
      await existing.stop()
      pipeline.unregister(stageId: existing.stageId)
      yoloStage = nil
      yoloDetections = []
      yoloModelState = .idle
    }

    let taskStr = config["task"] as? String ?? "detect"
    let task = YOLOTask(rawValue: taskStr) ?? .detect
    let modelId = config["modelId"] as? String ?? "yolo11n"
    let modelUrl = config["modelUrl"] as? String
    let classLabels = config["classLabels"] as? [String] ?? COCOClassLabels
    let confidence = config["confidence"] as? Double ?? 0.25
    let iouThreshold = config["iouThreshold"] as? Double ?? 0.45
    let targetFPS = config["targetFPS"] as? UInt ?? 10
    let maxDetections = config["maxDetections"] as? Int ?? 100
    let inputSize = config["inputSize"] as? Int ?? 640
    let smoothingAlpha = config["smoothingAlpha"] as? Double ?? 0.3

    let yoloConfig = YOLOStageConfig(
      task: task,
      modelId: modelId,
      modelUrl: modelUrl,
      classLabels: classLabels,
      confidence: confidence,
      iouThreshold: iouThreshold,
      targetFPS: targetFPS,
      maxDetections: maxDetections,
      inputSize: inputSize,
      smoothingAlpha: smoothingAlpha
    )

    let stage = YOLOStage(config: yoloConfig)

    await stage.setOnModelState { [weak self] (state: YOLOModelState) in
      await MainActor.run {
        self?.yoloModelState = state
      }
      if case .failed(let modelId, let error) = state {
        await self?.relayStage?.sendJson([
          "type": "publisher_error",
          "error": "YOLO model '\(modelId)' failed: \(error)",
          "stage": "yolo",
          "modelId": modelId,
        ])
        let message = "YOLO model failed to load (\(modelId)): \(error)"
        await MainActor.run { self?.onError?(message) }
      }
    }

    await stage.setOnResult { [weak self] (result: YOLOFrameResult) in
      await MainActor.run {
        self?.yoloDetections = result.detections
      }
      if !result.isEmpty {
        await self?.relayStage?.sendJson(result.jsonDict())
      }
      if let trackingStage = await self?.trackingStage {
        let trackDets: [TrackDetection] = result.detections.map { det in
          return TrackDetection(
            bbox: det.bbox,
            confidence: det.confidence,
            classLabel: det.classLabel,
            histogram: nil,
            embedding: nil
          )
        }
        if !trackDets.isEmpty {
          await trackingStage.feedDetections(trackDets, timestamp: CFAbsoluteTimeGetCurrent())
        }
      }
    }

    #if DEBUG
    await stage.setPreviewBus(previewBus)
    #endif

    pipeline.register(stage)
    await stage.start()
    yoloStage = stage

    NSLog("[PipelineStore] YOLOStage registered: model=\(modelId) task=\(task.rawValue) confidence=\(confidence) fps=\(targetFPS)")
  }

  func disableYOLOStage() async {
    guard let existing = yoloStage else { return }
    await existing.stop()
    pipeline.unregister(stageId: existing.stageId)
    yoloStage = nil
    yoloDetections = []
    NSLog("[PipelineStore] YOLOStage disabled")
  }

  // MARK: - Enhance Stage

  func configureEnhanceStage(config: [String: Any]) {
    let enhanceConfig = EnhanceStageConfig.fromServerConfig(config)

    if enhanceConfig.filters.isEmpty {
      pipeline.transformStage = nil
      enhanceStage = nil
      NSLog("[PipelineStore] EnhanceStage removed (no filters)")
      return
    }

    let stage = FrameTransformStage(config: enhanceConfig)
    pipeline.transformStage = stage
    enhanceStage = stage

    NSLog("[PipelineStore] EnhanceStage configured: \(enhanceConfig.filters.count) filters")
  }

  func disableEnhanceStage() {
    pipeline.transformStage = nil
    enhanceStage = nil
    NSLog("[PipelineStore] EnhanceStage disabled")
  }

  // MARK: - Sensor Stages

  func configureSensorStage(config: [String: Any]) async {
    let sensorConfig = SensorStageConfig.fromServerConfig(config)

    if let audioStage = audioClassificationStage {
      await audioStage.stop()
      audioClassificationStage = nil
    }
    if let locStage = locationStage {
      await locStage.stop()
      locationStage = nil
    }

    for sensor in sensorConfig.sensors {
      switch sensor.type {
      case .sound:
        let stage = AudioClassificationStage()
        let cfg = sensor.config
        let targetLabels = cfg["targetLabels"] as? [String]
        let audioSource: AudioSource? = {
          if let sourceStr = cfg["audioSource"] as? String, sourceStr == "glasses" {
            return .bluetoothHFP
          }
          return .builtInMic
        }()
        await stage.configure(
          windowDuration: cfg["windowDuration"] as? Double ?? 1.5,
          overlapFactor: cfg["overlapFactor"] as? Double ?? 0.5,
          confidence: cfg["confidence"] as? Double ?? 0.3,
          maxLabels: cfg["maxLabels"] as? Int ?? 5,
          targetLabels: targetLabels,
          smoothingAlpha: cfg["smoothingAlpha"] as? Double ?? 0.3,
          source: audioSource
        )
        await stage.setOnResult { [weak self] classification in
          await self?.relayStage?.sendJson(classification.jsonDict)
        }
        await stage.start()
        audioClassificationStage = stage
        NSLog("[PipelineStore] AudioClassificationStage started source=\(audioSource?.displayName ?? "Phone Mic")")

      case .location, .locationSignificant, .locationVisits, .locationGeofence:
        let stage = LocationStage()
        let cfg = sensor.config
        let resolvedMode = cfg["mode"] as? String ?? sensor.type.locationMode ?? "continuous"
        await stage.configure(
          accuracy: cfg["accuracy"] as? String ?? "best",
          minDistance: cfg["minDistance"] as? Double ?? 5,
          updateIntervalSec: cfg["updateIntervalSec"] as? Double ?? 5,
          mode: resolvedMode,
          geofences: cfg["geofences"] as? [[String: Any]]
        )
        await stage.setOnResult { [weak self] update in
          await self?.relayStage?.sendJson(update.jsonDict)
        }
        await stage.start()
        locationStage = stage
        NSLog("[PipelineStore] LocationStage started mode=\(resolvedMode)")
      }
    }
  }

  func disableSensorStages() async {
    if let audioStage = audioClassificationStage {
      await audioStage.stop()
      audioClassificationStage = nil
    }
    if let locStage = locationStage {
      await locStage.stop()
      locationStage = nil
    }
    NSLog("[PipelineStore] Sensor stages disabled")
  }

  // MARK: - Speech Stages

  func configureSpeechStage(config: [String: Any], audioEventBus: AudioEventBus) async {
    let speechConfig = SpeechStageConfig.fromServerConfig(config)

    if let sttStage = speechRecognitionStage {
      await sttStage.stop()
      speechRecognitionStage = nil
    }
    if let vadStage = voiceActivityStage {
      await vadStage.stop()
      voiceActivityStage = nil
    }

    for stage in speechConfig.stages {
      switch stage.type {
      case .stt:
        let sttStage = SpeechRecognitionStage()
        let cfg = stage.config
        await sttStage.configure(
          language: cfg["language"] as? String ?? "en-US",
          onDeviceOnly: (cfg["recognitionMode"] as? String ?? "onDevice") == "onDevice",
          partialResults: cfg["partialResults"] as? Bool ?? true
        )
        await sttStage.setOnResult { [weak self] result in
          await self?.relayStage?.sendJson(result.jsonDict)
          if !result.text.isEmpty {
            await MainActor.run { [weak self] in
              self?.overlayTranscription = result.text
            }
          }
          if result.error != nil {
            await MainActor.run { [weak self] in
              self?.overlayTranscription = nil
            }
          }
        }
        await sttStage.setEventBus(audioEventBus)
        await sttStage.start()
        speechRecognitionStage = sttStage
        NSLog("[PipelineStore] SpeechRecognitionStage started")

      case .vad:
        let vadStage = VoiceActivityStage()
        let cfg = stage.config
        await vadStage.configure(
          energyThreshold: cfg["energyThreshold"] as? Float ?? -40.0,
          speechDurationMs: cfg["speechDurationMs"] as? Double ?? 100.0,
          silenceDurationMs: cfg["silenceDurationMs"] as? Double ?? 300.0,
          cooldownMs: cfg["cooldownMs"] as? Double ?? 200.0
        )
        await vadStage.setEventBus(audioEventBus)
        await vadStage.setOnResult { [weak self] result in
          await self?.relayStage?.sendJson(result.jsonDict)
        }
        await vadStage.start()
        voiceActivityStage = vadStage
        NSLog("[PipelineStore] VoiceActivityStage started")
      }
    }
  }

  func disableSpeechStages() async {
    if let sttStage = speechRecognitionStage {
      await sttStage.stop()
      speechRecognitionStage = nil
    }
    if let vadStage = voiceActivityStage {
      await vadStage.stop()
      voiceActivityStage = nil
    }
    overlayTranscription = nil
    NSLog("[PipelineStore] Speech stages disabled")
  }

  // MARK: - Tracking Stage

  func configureTrackingStage(config: [String: Any]) async {
    if let existing = trackingStage {
      await existing.stop()
      pipeline.unregister(stageId: existing.stageId)
      trackingStage = nil
      trackingConfig = nil
      trackingTracks = []
      trackingSnapshot = nil
      heatMap = nil
    }

    let newTrackingConfig = TrackingStageConfig(
      targetClasses: config["targetClasses"] as? [String] ?? [],
      confidence: config["confidence"] as? Double ?? 0.5,
      iouThreshold: config["iouThreshold"] as? Double ?? 0.3,
      maxAge: config["maxAge"] as? Int ?? 30,
      minHits: config["minHits"] as? Int ?? 3,
      maxTracks: config["maxTracks"] as? Int ?? 0,
      targetFPS: config["targetFPS"] as? Double ?? 10,
      smoothingAlpha: config["smoothingAlpha"] as? Double ?? 0.3,
      zones: (config["zones"] as? [[String: Any]])?.compactMap { z -> ZoneDefinition? in
        guard let label = z["label"] as? String,
              let x1 = z["x1"] as? Double,
              let y1 = z["y1"] as? Double,
              let x2 = z["x2"] as? Double,
              let y2 = z["y2"] as? Double else { return nil }
        return ZoneDefinition(
          id: z["id"] as? String ?? UUID().uuidString,
          label: label, x1: x1, y1: y1, x2: x2, y2: y2,
          color: z["color"] as? String
        )
      } ?? [],
      deltaT: config["deltaT"] as? Int ?? 3,
      inertia: config["inertia"] as? Double ?? 0.2,
      detThresh: config["detThresh"] as? Double ?? 0.5,
      useByte: config["useByte"] as? Bool ?? false,
      gates: (config["gates"] as? [[String: Any]])?.map { dict -> GateConfig in
        GateConfig(
          gateType: dict["gateType"] as? String ?? "",
          params: dict["params"] as? [String: Double] ?? [:]
        )
      } ?? [],
      costFunction: config["costFunction"] as? String,
      forecastSteps: config["forecastSteps"] as? Int ?? 0,
      heatmapEnabled: config["heatmapEnabled"] as? Bool ?? false,
      heatmapResolution: config["heatmapResolution"] as? Int ?? 40,
      heatmapDecayRate: config["heatmapDecayRate"] as? Double ?? 0.97,
      heatmapGaussianRadius: config["heatmapGaussianRadius"] as? Int ?? 1,
      heatmapOpacity: config["heatmapOpacity"] as? Double ?? 0.4,
      heatmapMode: config["heatmapMode"] as? String ?? "detection"
    )

    let stage = ObjectTrackingStage(config: newTrackingConfig)
    self.trackingConfig = newTrackingConfig

    let hasBhattacharyya = newTrackingConfig.gates.contains(where: { $0.gateType == "gate-bhattacharyya" })
    if let visionStage {
      await visionStage.setExtractHistograms(hasBhattacharyya)
    }

    let reidGate = newTrackingConfig.gates.first(where: { $0.gateType == "gate-reid" })
    let useOnDeviceReID = reidGate?.params["useOnDevice"] == 1.0
    if useOnDeviceReID, let visionStage {
      do {
        let extractor = try EmbeddingExtractor.createFromBundle()
        await visionStage.setEmbeddingExtractor(extractor)
        NSLog("[PipelineStore] On-device ReID enabled: OSNet-x0.25 embedding extraction active")
      } catch {
        NSLog("[PipelineStore] Failed to load on-device ReID model: \(error.localizedDescription)")
        await visionStage.setEmbeddingExtractor(nil)
      }
    } else if let visionStage {
      await visionStage.setEmbeddingExtractor(nil)
    }

    await stage.setOnResult { [weak self] result in
      await MainActor.run {
        self?.trackingTracks = result.tracks
        self?.trackingSnapshot = result.registry
        self?.heatMap = result.heatMap
      }
      await self?.relayStage?.sendJson(result.jsonDict())
    }

    #if DEBUG
    await stage.setPreviewBus(previewBus)
    #endif

    pipeline.register(stage)
    await stage.start()
    trackingStage = stage

    NSLog("[PipelineStore] ObjectTrackingStage registered: confidence=\(newTrackingConfig.confidence) iou=\(newTrackingConfig.iouThreshold) zones=\(newTrackingConfig.zones.count) gates=\(newTrackingConfig.gates.map { $0.gateType })")
  }

  func disableTrackingStage() async {
    guard let existing = trackingStage else { return }
    await existing.stop()
    pipeline.unregister(stageId: existing.stageId)
    trackingStage = nil
    trackingConfig = nil
    trackingTracks = []
    trackingSnapshot = nil
    heatMap = nil
    NSLog("[PipelineStore] ObjectTrackingStage disabled")
  }

  func injectReidEmbeddings(_ embeddings: [[String: Any]]) {
    var embedMap: [Int: [Double]] = [:]
    for item in embeddings {
      if let idx = item["detectionIndex"] as? Int,
         let embed = item["embedding"] as? [Double] {
        embedMap[idx] = embed
      }
    }
    if !embedMap.isEmpty {
      Task { [weak self] in
        await self?.trackingStage?.injectEmbeddings(embedMap)
      }
    }
  }

  // MARK: - Measurement Stage

  func configureMeasureStage(config: [String: Any]) async {
    if let existing = measureStage {
      await existing.stop()
      pipeline.unregister(stageId: existing.stageId)
      measureStage = nil
    }

    let measureConfig = ToolMeasureConfig(
      referenceObject: config["referenceObject"] as? String ?? "auto",
      maxMeasurementError: config["maxMeasurementError"] as? Double ?? 2.0,
      targetFPS: config["targetFPS"] as? Double ?? 1,
      smoothingAlpha: config["smoothingAlpha"] as? Double ?? 0.5,
      confidence: config["confidence"] as? Double ?? 0.6
    )

    let stage = ToolMeasurementStage(config: measureConfig)

    await stage.setOnResult { [weak self] result in
      await self?.relayStage?.sendJson(result.jsonDict())
      await MainActor.run { [weak self] in
        self?.toolMeasureResult = result
      }
    }

    #if DEBUG
    await stage.setPreviewBus(previewBus)
    #endif

    pipeline.register(stage)
    await stage.start()
    measureStage = stage

    NSLog("[PipelineStore] ToolMeasurementStage registered: ref=\(measureConfig.referenceObject) maxError=\(measureConfig.maxMeasurementError)mm")
  }

  func disableMeasureStage() async {
    guard let existing = measureStage else { return }
    await existing.stop()
    pipeline.unregister(stageId: existing.stageId)
    measureStage = nil
    NSLog("[PipelineStore] ToolMeasurementStage disabled")
  }

  // MARK: - Stop All

  func stopAllPipelineStages() async {
    if let existing = visionStage {
      await existing.stop()
      pipeline.unregister(stageId: existing.stageId)
      visionStage = nil
      visionDetections = []
      visionSceneLabel = nil
    }
    pipeline.transformStage = nil
    enhanceStage = nil
    if let audio = audioClassificationStage {
      await audio.stop()
      audioClassificationStage = nil
    }
    if let loc = locationStage {
      await loc.stop()
      locationStage = nil
    }
    if let stt = speechRecognitionStage {
      await stt.stop()
      speechRecognitionStage = nil
    }
    if let vad = voiceActivityStage {
      await vad.stop()
      voiceActivityStage = nil
    }
    overlayTranscription = nil
    if let track = trackingStage {
      await track.stop()
      pipeline.unregister(stageId: track.stageId)
      trackingStage = nil
    }
    trackingTracks = []
    heatMap = nil
    if let m = measureStage {
      await m.stop()
      pipeline.unregister(stageId: m.stageId)
      measureStage = nil
    }
    toolMeasureResult = nil
    if let yolo = yoloStage {
      await yolo.stop()
      pipeline.unregister(stageId: yolo.stageId)
      yoloStage = nil
    }
    yoloDetections = []
    boundingBoxes = []
    NSLog("[PipelineStore] All pipeline stages stopped")
  }

  // MARK: - Memory Pressure

  func handleMemoryPressure(_ actions: MemoryPressureActions) async {
    let footprintMB = MemoryPressureMonitor.currentFootprintMB
    NSLog("[PipelineStore] Memory pressure actions: \(actions), footprint: \(String(format: "%.0f", footprintMB))MB")

    if actions.contains(.flushCaches) {
      enhanceStage?.flushPool()
      PipelineCIContext.shared.clearCaches()
      NSLog("[PipelineStore] Flushed CI caches + buffer pools")
    }

    if actions.contains(.disableYOLO) || actions.contains(.disableAllInference) {
      if let yolo = yoloStage {
        await yolo.stop()
        yoloStage = nil
        yoloDetections = []
        NSLog("[PipelineStore] Disabled YOLO stage (memory pressure)")
      }
    }

    if actions.contains(.disableTracking) || actions.contains(.disableAllInference) {
      if let tracking = trackingStage {
        await tracking.stop()
        trackingStage = nil
        trackingTracks = []
        trackingSnapshot = nil
        heatMap = nil
        NSLog("[PipelineStore] Disabled tracking stage (memory pressure)")
      }
    }

    if actions.contains(.disableMeasurement) || actions.contains(.disableAllInference) {
      if let measure = measureStage {
        await measure.stop()
        measureStage = nil
        NSLog("[PipelineStore] Disabled measurement stage (memory pressure)")
      }
    }

    if actions.contains(.disableAllInference) {
      if let vision = visionStage {
        await vision.stop()
        visionStage = nil
        visionDetections = []
        boundingBoxes = []
        NSLog("[PipelineStore] Disabled vision stage (critical memory)")
      }
      if let speech = speechRecognitionStage {
        await speech.stop()
        speechRecognitionStage = nil
        NSLog("[PipelineStore] Disabled speech stage (critical memory)")
      }
    }
  }
}
