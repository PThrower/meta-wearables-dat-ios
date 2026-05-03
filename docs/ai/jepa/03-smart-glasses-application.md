# JEPA for Smart Glasses: Application Analysis

## Why JEPA is the Right Architecture for Wearables

Smart glasses have hard constraints that generative AI cannot satisfy:

| Constraint | Generative AI | JEPA |
|-----------|--------------|------|
| Battery (~150mAh) | Cloud-required, drains fast | On-device inference possible |
| Latency (real-time) | 100ms-1s for cloud round-trip | <50ms local inference |
| Privacy | Video sent to cloud | Embeddings stay on-device |
| Camera shake | Confuses pixel-level models | Abstract representations are stable |
| Bandwidth | Requires uploading video | Embeddings are compact (1KB vs 1MB) |
| Thermal envelope | GPU inference overheats | NPU-friendly integer ops |

## The Current State of Smart Glasses AI

Today's smart glasses (Meta Ray-Ban, Snap Spectacles) work like this:

```
1. User triggers AI (voice command or tap)
2. Glasses take a single photo
3. Photo uploaded to cloud
4. Cloud VLM (GPT-4V / Llama) analyzes
5. Text response sent back
6. ~2-5 second total latency
```

Problems:
- No continuous awareness (only triggered on demand)
- No temporal understanding (single snapshot, no video context)
- Privacy concerns (every query sends camera feed to cloud)
- Battery drain from continuous cloud communication
- No predictive capability (only reactive description)

## What JEPA Enables: Continuous World Understanding

```
1. Glasses camera streams continuously (already happening for video recording)
2. Frame buffer maintained locally (16-64 frames)
3. JEPA encoder processes frames into embeddings (on-device)
4. Lightweight task heads classify/anticipate/predict
5. Audio cue delivered via HFP when needed
6. ~20-50ms latency, fully on-device
```

## Application 1: Action Anticipation

**Validated by:** V-JEPA 2's 39.7 recall-at-5 on Epic-Kitchens-100

The most directly proven application. Epic-Kitchens is an egocentric (first-person) video dataset -- exactly the perspective of smart glasses.

```
Glasses camera feed (egocentric video)
  -> V-JEPA 2 encoder (frozen)
  -> 1024-dim embedding per clip
  -> Lightweight anticipation head
  -> "Person is about to open the fridge" (1 second before it happens)
```

Use cases:
- Proactive cooking assistance ("you're about to add salt, you already added it")
- Safety warnings ("you're reaching for a hot pan without a mitt")
- Workflow guidance ("next step is to tighten the screw")

## Application 2: Object Permanence and Tracking

JEPA's embedding space naturally maintains object permanence because the model was trained to predict hidden (masked) content. When you look away from your keys, the embedding still encodes "keys on table at position X."

```
Frame 1: Keys visible on table -> embedding contains "keys at (x,y)"
Frame 2: Head turns, keys out of frame -> embedding still encodes prior state
User asks: "Where are my keys?" -> Lightweight QA head -> "On the table, behind you"
```

No cloud query needed. No re-scanning the room.

## Application 3: Anomaly / Danger Detection

LeWorldModel demonstrated detection of "physically implausible events" -- its surprise evaluation reliably flagged scenes that violated learned physics.

```
Live video stream -> LeWM encoder -> latent state prediction
  -> Compare predicted state vs actual next frame embedding
  -> Large divergence = anomaly / dangerous situation
  -> Audio alert via HFP
```

Examples:
- "Glass about to fall off table" (unstable object detected)
- "Person approaching from behind vehicle" (occluded trajectory prediction)
- "Stove left on unattended" (state change without actor)

## Application 4: On-Device Personalization

Both EB-JEPA and LeWorldModel can train on a single GPU. With mobile NPUs approaching desktop GPU performance, on-device fine-tuning becomes feasible:

```
Week 1: Base JEPA model understands general physics
Week 2: Fine-tuned on your kitchen layout
Week 3: Knows where you keep everything
Week 4: Anticipates your routines
```

This is the long-term vision. LeWorldModel's single-GPU, 15M parameter architecture makes it the most realistic candidate for on-device learning.

## Audio Integration via HFP

Per the MWDAT HFP documentation (`.claude/rules/dat-audio-hfp.md`):

- HFP provides bidirectional audio at 8kHz mono through glasses speakers
- Audio session must be configured BEFORE starting stream session
- Audio alerts from JEPA inference can be delivered as TTS or pre-recorded cues

Integration pattern:
```swift
// Existing MWDAT pattern
func startStreamSessionWithAudio() async {
    // 1. HFP audio session first
    startAudioSession()
    try? await Task.sleep(nanoseconds: 2 * NSEC_PER_SEC)

    // 2. Start camera stream
    await streamSession.start()

    // 3. NEW: Start JEPA inference pipeline
    await jepaPipeline.start(frameSource: streamSession)
}

// JEPA pipeline delivers audio cues through HFP
func onJEPAPrediction(_ event: JEPAPrediction) {
    audioStage.playTTS(event.description)  // Uses HFP speaker
}
```

## Privacy Architecture

JEPA enables a fundamentally different privacy model for smart glasses:

| Data Type | Size | Identifiable? | Leaves Device? |
|-----------|------|--------------|----------------|
| Raw video frame | ~1MB | Yes, contains faces/text/locations | Only if user explicitly sends |
| JEPA embedding | ~4KB (1024 floats) | No, abstract representation | Safe to send for complex queries |
| Task head output | ~100 bytes | Only the specific prediction | Minimal privacy surface |

The embedding is a lossy, abstract representation. You cannot reconstruct the original video from a 1024-dim embedding. This means:
- Local processing: 90% of queries handled on-device via embeddings
- Cloud fallback: Only for complex language queries, send embedding (not video) to cloud
- Zero raw video uploads unless user explicitly triggers a photo

## Real-World Scenarios

### Cooking Assistance (Validated by Epic-Kitchens-100)

```
Current state: JEPA embedding shows "chopping onions on cutting board"
Prediction: Anticipation head predicts "about to add to pan"
Alert: "The oil isn't hot yet, wait 30 seconds" (based on pan state embedding)
```

### Navigation Assistance

```
Current state: JEPA tracks "walking toward intersection"
Prediction: LeWM predicts trajectory of approaching cyclist (occluded by van)
Alert: HFP audio cue: "Cyclist approaching from right"
```

### Procedural Guidance

```
Current state: JEPA recognizes "assembling furniture, step 3 of 8"
Prediction: Next step embedding matches expected pattern
Deviation: "That bolt goes in hole B, not hole A"
```

## What's Missing (Research Gaps)

1. **Language bridge** -- JEPA outputs embeddings, not text. Need a lightweight decoder to translate predictions to speech. V-JEPA 2's LLM alignment demonstrates this but is too heavy for edge.

2. **Real-world LeWorldModel** -- Only tested in simulation. Needs adaptation to real camera noise, lighting changes, occlusion patterns from head movement.

3. **Mobile-friendly backbones** -- V-JEPA 2 uses full ViT which is heavy. Need efficient architectures (MobileViT, EfficientFormer) as JEPA encoders.

4. **IMU fusion** -- Smart glasses have accelerometers and gyroscopes. Fusing IMU data with visual embeddings for better motion prediction is unexplored.

5. **Continuous learning without catastrophic forgetting** -- On-device fine-tuning must not degrade general capabilities.
