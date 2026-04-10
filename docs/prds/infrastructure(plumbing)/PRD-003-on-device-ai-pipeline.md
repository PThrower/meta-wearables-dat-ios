# PRD-003: On-Device AI Pipeline

**Product:** com.mwdat-ios / AIStage  
**Owner:** @ebowwa  
**Status:** Draft  
**Last Updated:** 2026-04-06  
**Depends On:** PRD-001 (FramePipelineManager, FramePipelineStage protocol)

---

## Problem

The glasses camera stream provides continuous visual context about the operator's environment. Without local inference, this context is only useful to remote viewers watching the raw feed. On-device AI can extract structured understanding (people present, text visible, motion patterns) in real-time without sending data off the device -- preserving privacy and eliminating server round-trip latency.

The `FramePipelineManager` already supports registering arbitrary stages. An `AIStage` that receives `FramePacket` at a reduced FPS and runs Apple Vision/CoreML inference is a zero-refactoring addition.

---

## Users

| Persona | Description | Primary Need |
|---------|-------------|--------------|
| **Operator** | Wearing glasses, running the app | Contextual alerts (person nearby, text detected) without relay dependency |
| **CaringMind System** | The broader assistive platform | Structured detection events to feed timeline, notifications, or cloud analysis |
| **Developer** | Building on the pipeline | Composable stage that doesn't block other stages or degrade stream FPS |

---

## Current State

- `FramePipelineStage` protocol exists with `processFrame(_ packet: FramePacket) async`
- `FrameStageConfig` supports `targetFPS` for per-stage throttling
- `FramePipelineManager` dispatches to all registered stages via `Task.detached`
- `ThrottledStage` base actor exists for FPS-limited processing
- **No AI stage is registered.** The architecture supports it; the implementation doesn't exist.
- `ai-integration-architecture.md` documents the design in detail (written against commit `33ea802`)

---

## Requirements

### P0 -- Must Have

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| P0-1 | `AIStage` actor conforming to `FramePipelineStage` | Registers on `FramePipelineManager`; receives `FramePacket`; does not block other stages |
| P0-2 | Configurable inference FPS (default 4fps) | `FrameStageConfig(targetFPS: 4)`; drops frames exceeding target; camera stream unaffected |
| P0-3 | Person detection via `VNDetectHumanRectanglesRequest` | Returns count of detected persons per frame; bounding boxes available |
| P0-4 | Face detection via `VNDetectFaceRectanglesRequest` | Returns count of detected faces per frame; face landmarks available |
| P0-5 | Text recognition via `VNRecognizeTextRequest` | Returns recognized text strings from frame (signs, documents, screens) |
| P0-6 | Detection callback (`onDetection: (AIDetection) -> Void`) | Structured `AIDetection` event emitted per inference; consumers decide what to do |
| P0-7 | Zero impact on relay/display FPS | AI stage runs at 4fps in detached task; relay and display continue at full camera FPS |

### P1 -- Should Have

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| P1-1 | Detection events forwarded to `TelemetryService` | AI detections appear in telemetry HUD (DEBUG builds) |
| P1-2 | Detection events forwarded over relay WebSocket | JSON control message alongside FRLY binary; viewer can render overlays |
| P1-3 | Barcode/QR code scanning via `VNDetectBarcodesRequest` | Returns decoded barcode/QR string and symbology type |
| P1-4 | CoreML custom model support | Load `.mlmodel` from app bundle; run inference on `CVPixelBuffer` from `FramePacket` |
| P1-5 | Detection throttling (deduplicate rapid-fire events) | Don't emit "person detected" every 250ms; debounce to once per second while continuously detected |

### P2 -- Could Have

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| P2-1 | Object tracking across frames (`VNTrackObjectRequest`) | Track detected objects between frames; assign stable IDs |
| P2-2 | Hand pose detection (`VNDetectHumanHandPoseRequest`) | Detect hand gestures for interaction |
| P2-3 | On-device fall detection (motion anomaly from frame deltas) | Alert when rapid visual field change suggests a fall |
| P2-4 | Scene classification (CoreML `MobileNetV2` or similar) | Classify environment: indoor, outdoor, kitchen, office, etc. |
| P2-5 | Detection event persistence to local Core Data | Historical detection log queryable by type, time, count |

---

## Technical Design

### AIDetection Type

```swift
struct AIDetection: Sendable {
    let timestamp: TimeInterval
    let persons: Int
    let faces: Int
    let text: String?
    let barcodes: [String]
    let personBounds: [CGRect]
    let faceBounds: [CGRect]
}
```

### AIStage Actor

```swift
actor AIStage: @preconcurrency FramePipelineStage {
    nonisolated let stageId = "ai"
    var config: FrameStageConfig
    
    private let personRequest = VNDetectHumanRectanglesRequest()
    private let faceRequest = VNDetectFaceRectanglesRequest()
    private let textRequest = VNRecognizeTextRequest()
    private let onDetection: @Sendable (AIDetection) async -> Void
    
    nonisolated func processFrame(_ packet: FramePacket) async {
        await analyzeFrame(packet)
    }
    
    private func analyzeFrame(_ packet: FramePacket) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(packet.sampleBuffer) else { return }
        let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, options: [:])
        do {
            try handler.perform([personRequest, faceRequest, textRequest])
            let detection = AIDetection(
                timestamp: packet.timestamp,
                persons: personRequest.results?.count ?? 0,
                faces: faceRequest.results?.count ?? 0,
                text: textRequest.results?.first?.topCandidates(1).first?.string,
                barcodes: [],
                personBounds: personRequest.results?.map(\.boundingBox) ?? [],
                faceBounds: faceRequest.results?.map(\.boundingBox) ?? []
            )
            Task { await onDetection(detection) }
        } catch {
            // Vision request failure is non-fatal; log and skip frame
        }
    }
}
```

### Registration

```swift
let aiStage = AIStage(
    config: FrameStageConfig(targetFPS: 4),
    onDetection: { detection in
        // Route to telemetry, UI, relay, or local storage
    }
)
pipelineManager.register(aiStage)
```

### Performance Budget

| Resource | Budget | Rationale |
|----------|--------|-----------|
| CPU per inference | < 50ms on A16+ | Vision framework is hardware-accelerated |
| Memory | < 30MB additional | VNRequest instances are lightweight |
| Battery delta | < 3% additional per hour | 4fps inference is ~960 inferences/hour |
| Frame pipeline impact | 0ms added to relay/display path | Detached task isolation |

---

## Data Flow

```
FramePipelineManager
       |
       +---> DisplayStage (30fps)       -> UIImage
       +---> RelayStage (30fps)         -> FRLY -> WebSocket
       +---> RecordingStage (30fps)     -> .mov
       +---> AIStage (4fps, throttled)  -> Vision inference
                    |
                    v
              AIDetection event
                    |
              +---> TelemetryService (HUD display)
              +---> RelayStage control channel (JSON -> viewer overlay)
              +---> Local Core Data (P2-5)
              +---> Notification/alert (CaringMind system)
```

---

## Success Metrics

| Metric | Target | Method |
|--------|--------|--------|
| Inference latency (per frame) | < 50ms on iPhone 14+ | Instrument profiling |
| Person detection accuracy | > 90% (Vision framework baseline) | Test with MockDeviceKit video feed |
| False positive rate | < 5% | Evaluate against labeled test set |
| Impact on relay FPS | 0 FPS degradation | Telemetry comparison: with/without AIStage |
| Battery impact | < 3% additional per hour | Energy gauge profiling |

---

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Vision framework accuracy varies by lighting/angle | Medium | Glasses camera is forward-facing; test with real-world video |
| 4fps may miss fast events (someone walking through quickly) | Low | Increase to 8fps if budget allows; object tracking (P2-1) fills gaps |
| CoreML model size bloats app binary | Low | Use Apple-provided Vision requests first; custom models are P1-4 |
| Rapid detection events flood consumers | Medium | Debounce/dedup (P1-5) before emitting |
| Privacy concerns with face detection data | Medium | All inference is on-device; detections are counts/bounds, not identity |
