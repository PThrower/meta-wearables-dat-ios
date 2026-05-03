# Tool Identification & Measurement Nodes

## Research Summary

**ARKit without LiDAR**: Cannot reliably measure objects below ~50mm. Minimum focus distance, feature point density, and VIO error make it unsuitable for fastener-scale measurement.

**Homography + Reference Object**: 0.5-2mm accuracy for 1-30mm range using just Vision framework. Requires a known-size reference object (coin, credit card) in the same frame as the target. No depth sensor needed.

**Decision**: Skip ARKit. Use Vision framework contour detection + homography measurement. Add ARKit as an optional layer later for larger objects (pipes, conduit, panels).

---

## Node Architecture

### Node 1: `vision-tool-id` (Fastener Type Classification)

- **activationMode**: `"vision"` (reuses existing dispatch)
- **role**: processor
- **runtime**: mobile
- **binding**: `vision-tool-id`

**What it does**: Classifies fastener TYPE from camera frame.

| Detection | Examples |
|-----------|----------|
| Hex socket | Allen key bolts, set screws |
| Hex head | Hex head cap screws, lag bolts |
| Phillips | PH0, PH1, PH2, PH3 |
| Flathead/Slotted | Flat blade screws |
| Torx | T10, T15, T20, T25, T27, T30, T40 |
| Robertson/Square | #1, #2, #3 |
| Nut | Hex nut, wing nut, lock nut |
| Bolt thread | M4, M5, M6, M8, M10 (by diameter) |

**Implementation**: CoreML image classifier trained on fastener head images. Create ML or custom Turi Create model. Training data from SortScrews dataset (arXiv 2603.13027) + custom augmentation.

**iOS stage**: `ToolIdentificationStage` actor, conforms to `FramePipelineStage`. Uses `VNClassifyImageRequest` or custom `VNCoreMLRequest` on each frame. Returns `ToolIdResult` with classified type + confidence.

**Config** (from workflow):
```typescript
{
  confidence: 0.6,        // minimum confidence threshold
  smoothingAlpha: 0.3,    // EMA smoothing
  fps: 2                  // analysis rate (not every frame)
}
```

**Result payload** (via WS `tool_id_result`):
```typescript
{
  type: "tool_id_result",
  fastenerType: "hex_socket" | "phillips" | "torx" | ...,
  confidence: 0.92,
  boundingBox: { x, y, w, h },  // normalized
  timestamp: 1234567890
}
```

---

### Node 2: `vision-tool-measure` (Size Measurement)

- **activationMode**: `"measure"` (NEW)
- **role**: processor
- **runtime**: mobile
- **binding**: `vision-tool-measure`

**What it does**: Measures fastener SIZE in millimeters using reference object + homography.

**Pipeline**:
```
Camera frame
  → VNDetectRectanglesRequest (find credit card / coin)
  → VNDetectContoursRequest (find fastener outline)
  → Compute homography (4-point DLT)
  → Transform contour to real-world coordinates
  → Extract dimensions in mm
  → Match to standard tool sizes
  → Return measurement + tool suggestion
```

**Reference objects** (auto-detected):
| Object | Size | Detection Method |
|--------|------|-----------------|
| Credit/ID card | 85.60 x 53.98 mm | `VNDetectRectanglesRequest` (ISO 7810) |
| US Quarter | 24.26 mm diameter | `VNDetectContoursRequest` (circular) |
| US Penny | 19.05 mm diameter | `VNDetectContoursRequest` (circular) |
| Euro coin | Various | `VNDetectContoursRequest` (circular) |

**iOS stage**: `ToolMeasurementStage` actor, conforms to `FramePipelineStage`. Runs contour detection + homography on each frame. Uses Accelerate/LAPACK for DLT solve.

**Config** (from workflow):
```typescript
{
  referenceObject: "credit_card" | "us_quarter" | "us_penny" | "auto",
  maxMeasurementError: 1.0,  // mm, reject if error estimate exceeds this
  fps: 1,                     // measurement is expensive, run at 1fps
  smoothingAlpha: 0.5         // EMA on consecutive measurements
}
```

**Result payload** (via WS `tool_measure_result`):
```typescript
{
  type: "tool_measure_result",
  fastenerType?: "hex_socket",     // from tool-id if connected upstream
  dimensionsMm: {
    width: 7.94,                   // measured width
    height: 4.82,                  // measured height (for non-circular)
    diameter?: 7.94,               // for circular fasteners
  },
  measurementError: 0.6,           // estimated error in mm
  referenceObject: "credit_card",
  suggestedTools: [
    { type: "hex_key", size: "8mm", confidence: 0.89 },
    { type: "hex_key", size: "5/16in", confidence: 0.75 }
  ],
  timestamp: 1234567890
}
```

**Standard tool size matching** (hardcoded lookup):
```typescript
const HEX_KEY_SIZES_MM = [1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 10, 12, 14, 17, 19, 22, 24];
const PHILLIPS_SIZES = [
  { size: "PH0", headDiameter: 4.5 },
  { size: "PH1", headDiameter: 5.5 },
  { size: "PH2", headDiameter: 7.0 },
  { size: "PH3", headDiameter: 9.5 },
  { size: "PH4", headDiameter: 13.0 },
];
const TORX_SIZES = [
  { size: "T10", outerDiameter: 4.82 },
  { size: "T15", outerDiameter: 5.56 },
  { size: "T20", outerDiameter: 6.48 },
  { size: "T25", outerDiameter: 7.18 },
  { size: "T27", outerDiameter: 7.94 },
  { size: "T30", outerDiameter: 8.62 },
  { size: "T40", outerDiameter: 10.02 },
];
```

---

### Node 3: `tool-suggest` (Overlay Display)

- **activationMode**: `null` (sink, like overlays)
- **role**: sink
- **runtime**: mobile

**What it does**: Renders the tool suggestion overlay on the glasses display or phone screen.

**Overlay elements**:
- Fastener type label ("Hex Socket")
- Measured size ("8.0mm")
- Suggested tool highlighted ("Use: 8mm hex key")
- Confidence indicator (green/yellow/red)
- Measurement error range ("+/- 0.6mm")
- Optional: tool silhouette overlay for visual comparison

---

## Workflow Connectivity

```
camera-source ──→ vision-tool-id ──→ vision-tool-measure ──→ tool-suggest (overlay)
                                          ↑
                                   [reference object
                                    in frame]
```

**allowedTargets**:

`vision-tool-id`:
- vision-tool-measure
- overlays, tool-suggest, <sink>
- <trigger>
- s2s-live, s2s-rest (AI can narrate the finding)

`vision-tool-measure`:
- tool-suggest
- overlays, <sink>
- <trigger>
- s2s-live, s2s-rest (AI can narrate the measurement)

`tool-suggest`:
- (terminal sink, empty allowedTargets)

---

## File Changes Required

### 1. Server: node-definitions.ts
- Add `ActivationMode` value: `"measure"` (new)
- Add `vision-tool-id` node definition (activationMode: "vision")
- Add `vision-tool-measure` node definition (activationMode: "measure")
- Add `tool-suggest` node definition (activationMode: null, role: sink)

### 2. Server: server.ts (activation dispatch ~line 1682)
- Add `measureIdx` categorization
- Add dispatch block 8: `measure_stage_config` WS message (fire-and-forget)
- Add same in `dispatchWorkflowConfig` for reconnect replay
- Add `tool_measure_result` result ingestion handler

### 3. Frontend: node-defs.ts
- Add all three nodes to FALLBACK_PALETTE with matching allowedTargets

### 4. iOS: New files
- `ToolIdentificationStage.swift` — CoreML classifier stage actor
- `ToolMeasurementStage.swift` — Homography measurement stage actor
- `ToolTypes.swift` — Shared types (ToolIdResult, ToolMeasureResult, ToolSuggestion, size tables)
- `HomographySolver.swift` — DLT homography computation using Accelerate
- Update `StreamSessionViewModel.swift` — handle `measure_stage_config` and `tool_id_result`/`tool_measure_result`
- Update `BoundingBoxOverlayView.swift` — render tool suggestion overlay

### 5. iOS: Pipeline wiring
- `FramePipelineManager` — no changes needed (fan-out handles new stages)
- `VisionStage` — no changes needed (tool-id is a separate stage)

### 6. ML Model (future)
- Train fastener classifier using SortScrews dataset + augmentation
- Export as .mlpackage / .mlmodelc for CoreML
- Bundle with app or download on demand

---

## Implementation Order

1. **ToolTypes.swift** — shared types, size lookup tables
2. **HomographySolver.swift** — DLT solver using Accelerate/LAPACK
3. **ToolMeasurementStage.swift** — reference detection + contour measurement
4. **node-definitions.ts** — add all three node definitions + new activationMode
5. **server.ts** — add measure dispatch + result ingestion
6. **node-defs.ts** — frontend palette entries
7. **StreamSessionViewModel.swift** — iOS wiring
8. **ToolIdentificationStage.swift** — CoreML classifier (needs trained model)
9. **Overlay rendering** — tool suggestion display

Phase 1 (no ML model): Start with `vision-tool-measure` only. User places a reference object + fastener in frame, gets a measurement + tool suggestion. Manual fastener type selection or assume hex as default.

Phase 2: Add `vision-tool-id` with trained CoreML model for automatic type classification.

---

## Limitations & Mitigations

| Limitation | Mitigation |
|-----------|-----------|
| Glasses camera resolution (~720p) | Phone camera mode for close-up measurement |
| Close focus distance (~8-10cm) | Reference object must be similar distance |
| No depth perception in 2D | Homography requires coplanar objects |
| Lighting affects contour detection | Contrast adjustment config param |
| Barrel distortion at edges | Center-of-frame guidance overlay |
| User must place reference object | Credit card in wallet is always available |

## ARKit Future Layer

For LARGER objects (pipes, conduit, panels, equipment housings), add `arkit-measure` node later:
- activationMode: `"arkit"`
- Uses phone camera ARSession with world tracking
- Tap-to-measure interaction (not frame-based)
- 5cm+ accuracy for objects >50mm
- Complements the homography approach for different scales
