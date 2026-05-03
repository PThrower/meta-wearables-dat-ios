# OC-SORT Correlation Engine — Technical Specification

**Product**: com.mwdat-ios (MWDAT)
**Feature**: Visual Accounting — persistent multi-object tracking for smart glasses
**Paper**: Observation-Centric SORT (CVPR 2023, arXiv:2203.14360)
**Authors**: Jinkun Cao, Xinshuo Weng, Rawal Khirodkar, Jiangmiao Pang, Kris Kitani
**Reference Implementation**: https://github.com/noahcao/OC_SORT

---

## 1. What OC-SORT Does

OC-SORT is a **tracking-by-detection** algorithm. It takes bounding box detections from any detector (YOLOX in the paper, Apple Vision in our case) and assigns **persistent integer IDs** that survive occlusion. Given detections as input, association runs at 700+ FPS on a single CPU.

The paper identifies a specific failure mode in SORT-family trackers: when objects are occluded, the Kalman filter prediction drifts. Standard SORT trusts KF predictions during occlusion — error compounds quadratically. OC-SORT fixes this by being **observation-centric**: it uses actual detector measurements (not predictions) to reconstruct trajectories and correct filter state.

### Three Innovations Over SORT

1. **ORU (Observation-Centric Re-Update)**: When a track reappears after occlusion, build a virtual trajectory between last observation and current observation, then replay it through the Kalman filter. This fixes accumulated drift.

2. **OCM (Observation-Centric Momentum)**: Add a direction-consistency cost to the IoU association matrix. Velocity direction is computed from actual observations `delta_t` steps apart, not from noisy KF state estimates. Penalizes matches where detection is inconsistent with track's observed motion direction.

3. **OCR (Observation-Centric Recovery)**: After first-round association fails, do a second pass matching unmatched detections against the **last observations** (not KF predictions) of unmatched tracks. Recovers tracks lost to short occlusion or objects stopping.

---

## 2. Current Implementation Audit

### Files Created

| File | Lines | Purpose |
|------|-------|---------|
| `Pipeline/TrackingTypes.swift` | 230 | Type definitions: Track, TrackDetection, TrackingStageConfig, zones |
| `Pipeline/OCSORT.swift` | 356 | Matrix8x8, KalmanFilter8, InternalTrack, OCSORT main |
| `Pipeline/HungarianAlgorithm.swift` | 105 | Munkres assignment (O(n^3)) |
| `Pipeline/ItemRegistry.swift` | 124 | Zone accounting: containment, transitions, running totals |
| `Pipeline/Stages/ObjectTrackingStage.swift` | 100 | Pipeline stage actor, detection-driven (feedDetections) |

### Files Modified

| File | Changes |
|------|---------|
| `hosted/server/src/node-definitions.ts` | Added `tracking-ocsort` node, `tracking` activation mode |
| `hosted/server/src/server.ts` | Tracking dispatch, reconnect replay, result handling |
| `hosted/web-platform/src/pages/workflow/node-defs.ts` | Frontend palette entry |
| `hosted/web-platform/src/pages/workflow/editor-view.ts` | Tracking palette category |
| `hosted/web-platform/src/pages/workflow/node-descriptions.ts` | Hover tooltip |
| `CameraAccess/ViewModels/StreamSessionViewModel.swift` | tracking_stage_config handler, vision→tracking routing |
| `CameraAccess/Views/BoundingBoxOverlayView.swift` | Tracked items rendering (emerald green) |
| `CameraAccess/Views/StreamView.swift` | Pass trackingTracks to overlay |
| `CameraAccess.xcodeproj/project.pbxproj` | Build file references |

### What Works

- Server dispatch: `tracking_stage_config` WS message to iOS publisher
- Server result handling: `tracking_result` fanned out to viewers + AI trigger injection
- Frontend palette: tracking-ocsort node appears in "Tracking" category
- Frontend edge validation: bidirectional allowedTargets with vision nodes
- iOS pipeline registration: ObjectTrackingStage registered in FramePipelineManager
- Detection-driven architecture: VisionStage feeds detections to tracker via `feedDetections()`
- Overlay suppression: raw vision boxes hidden when tracking active
- Reconnect replay: tracking config replayed on publisher reconnect

---

## 3. What's Wrong (Gap Analysis vs Paper)

### 3.1 Kalman Filter State Representation

**Paper (7-state)**: `[x, y, s, r, vx, vy, vs]`
- x, y = bounding box center
- s = scale (area = width * height)
- r = aspect ratio (width / height)
- vx, vy, vs = velocities

**Ours (8-state)**: `[x, y, w, h, vx, vy, vw, vh]`

The paper uses the original SORT representation from Bewley 2016. The 7-state model is used because:
- Aspect ratio is approximately constant for most objects (strong prior)
- Area changes more smoothly than individual width/height
- The observation vector is 4D `[x, y, s, r]` which maps cleanly from bbox
- Standard across SORT, DeepSORT, ByteTrack, and all derivatives

**Impact**: Our 8-state model doesn't match the paper's F/H/R/Q matrices. The Kalman filter tuning (noise parameters) from the paper won't transfer. Predictions may be less stable.

### 3.2 ORU — Observation-Centric Re-Update (MISSING)

This is the **core innovation** of the paper. Currently not implemented at all.

When a track loses its detection (occluded) and later reappears:
1. Build virtual trajectory: linear interpolation from `last_observation` to current detection
2. Replay each step through `kf.update()` to correct the filter state
3. This gives the KF "fake" observations during the gap, preventing error accumulation

Without ORU, our tracker is just SORT — KF predictions drift during occlusion and ID switches increase.

### 3.3 OCM — Observation-Centric Momentum (MISSING)

The paper adds direction consistency to the association cost:
```
cost = IoU_cost - inertia * direction_consistency
```

Where:
- `direction_consistency` = cosine similarity between observed velocity and candidate match direction
- `velocity` computed from `k_previous_obs()` — observations `delta_t` steps apart
- `inertia` = 0.2 default weight
- This penalizes matches where the detection is inconsistent with track's observed motion

Without OCM, association relies purely on IoU — fails when objects move fast (low IoU between frames) or when nearby objects swap positions.

### 3.4 OCR — Observation-Centric Recovery (MISSING)

Second-round association after first-round matching fails:
1. Take unmatched detections and unmatched tracks
2. Compute IoU between unmatched detections and **last_observations** of unmatched tracks
3. Match with threshold, recover lost tracks

This is distinct from the first round which uses KF predictions. Using last observations is better because KF predictions may have drifted.

### 3.5 ByteTrack-style Two-Pass Association (MISSING, optional)

Paper optionally supports `use_byte` flag for ByteTrack-style matching:
1. High-confidence detections (`score > det_thresh`) matched first
2. Low-confidence detections (`0.1 < score < det_thresh`) matched second against remaining tracks

Helpful for partially occluded objects producing low-confidence detections.

### 3.6 Observation History and Velocity

**Paper**: Each `KalmanBoxTracker` stores:
- `observations: dict[int, ndarray]` — keyed by age, value is bbox
- `last_observation: ndarray` — most recent detection bbox
- `velocity: ndarray` — computed from `speed_direction(prev_obs, current_obs)`
- `history_observations: list` — all observations in order

**Ours**: `InternalTrack` stores:
- `observationHistory: [Double]` — flat array, unclear structure
- No velocity from observations

### 3.7 Visualization

**Industry standard (Ultralytics, BoxMOT, Roboflow)**:
- Per-track unique colors (HSV colormap, distinct per ID)
- Trajectory trails: polylines connecting bbox centers over last N frames
- Trail thickness increases toward present, fades toward past
- Show last observation bbox (not KF prediction) when available
- Optional: dashed KF prediction box when track is lost

**Ours**:
- All tracks same emerald green color
- No trajectory trails
- No motion history visualization
- Confirmed=solid, tentative/lost=dashed (correct concept, but no unique colors)

---

## 4. Specification for Correct Implementation

### 4.1 OCSORT.swift Rewrite

Replace 8-state with 7-state Kalman filter matching paper:

```
State vector: [x, y, s, r, vx, vy, vs]  (7 dimensions)
Observation:  [x, y, s, r]               (4 dimensions)

F (transition): 7x7 constant velocity
H (observation): 4x7 identity + zeros
R (measurement noise): diag with s,r scaled 10x
P (initial covariance): diag(10), velocities scaled 1000x
Q (process noise): velocities scaled 0.01x
```

Bbox conversion:
```swift
func bboxToZ(bbox: [x1,y1,x2,y2]) -> [x,y,s,r]:
    w = x2 - x1; h = y2 - y1
    x = x1 + w/2; y = y1 + h/2
    s = w * h; r = w / h
    return [x, y, s, r]

func zToBbox(z: [x,y,s,r]) -> [x1,y1,x2,y2]:
    w = sqrt(s * r); h = s / w
    return [x-w/2, y-h/2, x+w/2, y+h/2]
```

### 4.2 InternalTrack

Each track must store:
```swift
struct InternalTrack {
    var kf: KalmanFilter7           // 7-state KF
    var id: Int                      // persistent ID
    var age: Int                     // total frames since creation
    var hits: Int                    // total detections matched
    var hitStreak: Int               // consecutive frames with detection
    var timeSinceUpdate: Int         // frames since last detection
    var observations: [Int: [Double]] // age -> [x1,y1,x2,y2,score]
    var lastObservation: [Double]?   // most recent detection bbox
    var velocity: [Double]?          // direction from observations
    var state: TrackState            // tentative/confirmed/lost
}
```

### 4.3 OCSORT.update() Algorithm

```
Input: detections [(bbox, confidence, classLabel)], timestamp

1. Increment frame_count
2. Split detections: high_conf (> det_thresh) and low_conf (0.1..det_thresh)

3. Predict all existing tracks forward (KF.predict)
4. Extract: predicted bboxes, velocities, last_observations, k_observations

5. First association (high_conf detections vs KF predictions):
   - Cost = IoU_cost - inertia * direction_consistency(OCM)
   - Hungarian assignment with gate threshold
   - Update matched tracks with detections

6. Second association — OCR (unmatched detections vs unmatched tracks' last_obs):
   - Cost = IoU(unmatched_dets, last_observations[unmatched_tracks])
   - Match with threshold
   - Update recovered tracks with detections

7. Optional: ByteTrack second pass (low_conf vs remaining tracks)

8. Update unmatched tracks: kf.update(None) — mark as missing
   - Apply ORU: if track has observations before and after gap,
     replay virtual trajectory to fix KF state

9. Create new tracks for remaining unmatched detections

10. Delete tracks where time_since_update > max_age

11. Collect output: tracks where (time_since_update < 1) AND
    (hit_streak >= min_hits OR frame_count <= min_hits)
    - Use last_observation bbox (not KF prediction) when available
```

### 4.4 ORU Implementation

```swift
func observationCentricReUpdate(track: inout InternalTrack, newDetection: [Double]) {
    guard let lastObs = track.lastObservation else { return }
    let gapFrames = track.timeSinceUpdate

    // Virtual trajectory: linear interpolation from lastObs to newDetection
    for i in 0..<gapFrames {
        let alpha = Double(i + 1) / Double(gapFrames + 1)
        let virtualObs = interpolate(lastObs, newDetection, alpha)
        track.kf.update(z: bboxToZ(virtualObs))
    }
}
```

### 4.5 OCM Implementation

```swift
func directionConsistency(detBbox: [Double], trackVelocity: [Double], kObservation: [Double]) -> Double {
    let detCenter = center(detBbox)
    let kObsCenter = center(kObservation)
    let detDirection = normalize(detCenter - kObsCenter)
    return cosineSimilarity(detDirection, trackVelocity)
}
```

### 4.6 Visualization Spec

**BoundingBoxOverlayView changes**:
```swift
// Per-track unique color (HSV-based, golden angle distribution)
func colorForTrackId(_ id: Int) -> Color {
    let hue = Double((id * 137) % 360) / 360.0  // golden angle
    return Color(hue: hue, saturation: 0.7, brightness: 0.9)
}

// Trajectory trail: polyline connecting bbox centers over last N frames
// Store in Track type: var trail: [CGPoint]  // last 30 center points
// Render: thickness increases toward present, alpha fades toward past

// Bbox: show last_observation when available, KF prediction otherwise
// Confirmed: solid border, 2pt
// Tentative: dashed border, 1pt
// Lost: dotted border, 0.5pt, fading alpha
```

**Track type update**:
```swift
struct Track {
    let trackId: Int
    let bbox: NormalizedBoundingBox
    let confidence: Double
    let classLabel: String
    let state: TrackState
    let age: Int
    let hits: Int
    let displayLabel: String
    var trail: [CGPoint]  // center points, last 30 frames
}
```

---

## 5. Implementation Plan

### Phase 1: Algorithm Rewrite (OCSORT.swift)
- Replace Matrix8x8/KalmanFilter8 with Matrix7x7/KalmanFilter7
- Implement 7-state model: [x,y,s,r,vx,vy,vs]
- Add observation storage per track (dict keyed by age)
- Implement velocity from observations (speed_direction)
- Implement OCM: direction consistency cost in association
- Implement OCR: second-round recovery with last observations
- Implement ORU: virtual trajectory re-update on rediscovery
- Optional: ByteTrack two-pass with low-confidence detections

### Phase 2: Type Updates
- TrackDetection: unchanged (bbox, confidence, classLabel)
- Track: add `trail: [CGPoint]` for trajectory visualization
- TrackingFrameResult: include trails in output
- TrackingStageConfig: add `delta_t`, `inertia`, `detThresh` params

### Phase 3: Visualization
- BoundingBoxOverlayView: per-ID colors (golden angle HSV)
- BoundingBoxOverlayView: trajectory trails (polylines, last 30 frames)
- BoundingBoxOverlayView: fading alpha for old trail points
- Track.displayLabel: include confidence percentage

### Phase 4: Server Config
- node-definitions.ts: add delta_t, inertia, detThresh to configSchema
- server.ts dispatch: pass new params in tracking_stage_config
- server.ts result: include trail data in tracking_result

### Phase 5: Testing
- Unit: feed synthetic detections (moving bbox, occlusion gap)
  - Verify persistent IDs through 10-frame occlusion
  - Verify ORU corrects KF state after rediscovery
  - Verify OCM rejects matches in wrong direction
- Integration: activate tracking-ocsort in workflow editor
  - Connect camera-source -> vision-person-detect -> tracking-ocsort -> overlays
  - Verify tracks appear with unique colors and trajectory trails
  - Verify ID persists when person walks behind obstacle and reappears

---

## 6. Reference Parameter Defaults (from paper)

| Parameter | Default | Description |
|-----------|---------|-------------|
| det_thresh | 0.5 | Detection confidence threshold |
| max_age | 30 | Frames before track deletion |
| min_hits | 3 | Consecutive detections to confirm track |
| iou_threshold | 0.3 | IoU gate for association |
| delta_t | 3 | Steps back for velocity estimation |
| inertia | 0.2 | Weight for direction consistency (OCM) |
| use_byte | false | Enable ByteTrack two-pass |
| asso_func | "iou" | Association cost (iou/giou/ciou/diou) |

## 7. References

- Paper: https://arxiv.org/abs/2203.14360
- Official repo: https://github.com/noahcao/OC_SORT
- Roboflow tracker docs: https://trackers.roboflow.com/develop/trackers/ocsort/
- BoxMOT (reference visualization): https://github.com/mikel-brostrom/boxmot
- Ultralytics tracking: https://docs.ultralytics.com/modes/track/
- Deep OC-SORT (appearance extension): arXiv:2302.11813
- SORT (original): Bewley et al., 2016
- ByteTrack: Zhu et al., ECCV 2022
