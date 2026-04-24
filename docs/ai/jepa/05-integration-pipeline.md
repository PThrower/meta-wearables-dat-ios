# JEPA Integration Pipeline for MWDAT iOS

## Architecture Overview

Integration of JEPA inference into the existing MWDAT iOS app, which uses Meta's Wearables DAT SDK for camera streaming from Ray-Ban Meta smart glasses.

```
Meta Ray-Ban Glasses
  |  (BLE/WiFi)
  v
MWDAT iOS App
  |
  +-- StreamSession (DAT SDK, existing)
  |     -> VideoFrame stream
  |
  +-- JEPA Pipeline (NEW)
  |     -> FrameBuffer (16-64 frames, rolling)
  |     -> JEPA Encoder (quantized V-JEPA 2 or LeWM)
  |     -> Task Heads
  |       |-- ActionAnticipationHead
  |       |-- AnomalyDetectionHead
  |       |-- ObjectTrackingHead
  |
  +-- AudioStage (existing, HFP)
        -> TTS alerts via glasses speakers
```

## Phase 1: V-JEPA 2 Encoder as Feature Extractor

The simplest integration: use V-JEPA 2's frozen encoder to produce embeddings, then train lightweight task-specific heads.

### Data Flow

```swift
// StreamSession provides VideoFrame stream (existing)
// VideoFrame -> UIImage -> CVPixelBuffer -> JEPA input

class JEPAipeline {
    private let encoder: JEPAEncoder          // Quantized V-JEPA 2
    private let frameBuffer: RollingFrameBuffer
    private let actionHead: ActionAnticipationHead

    func processFrame(_ frame: VideoFrame) async {
        frameBuffer.add(frame)

        guard frameBuffer.isReady else { return }  // Wait for 16 frames

        let embedding = await encoder.encode(frameBuffer.frames)
        let prediction = actionHead.predict(from: embedding)

        if prediction.confidence > 0.8 {
            await audioStage.playAlert(prediction.description)
        }
    }
}
```

### Frame Buffer Management

```swift
struct RollingFrameBuffer {
    private var frames: [CVPixelBuffer] = []
    private let maxFrames: Int = 16
    private let targetSize = CGSize(width: 256, height: 256)

    mutating func add(_ frame: VideoFrame) {
        guard let pixelBuffer = frame.makePixelBuffer() else { return }
        let resized = resize(pixelBuffer, to: targetSize)
        frames.append(resized)
        if frames.count > maxFrames {
            frames.removeFirst()
        }
    }

    var isReady: Bool { frames.count >= maxFrames }
}
```

### Encoder Inference

The encoder runs on every Nth frame batch (configurable, default every 500ms):

```swift
actor JEPAEncoder {
    private let model: VNCoreMLModel  // CoreML compiled model

    func encode(_ frames: [CVPixelBuffer]) async -> [Float] {
        // Stack frames into video tensor: [1, 16, 3, 256, 256]
        // Run through CoreML model
        // Return 1024-dim embedding
        let input = preprocess(frames)
        let output = try await model.prediction(from: input)
        return output.featureValue(for: "embedding")!.multiArrayValue
            .toArray(of: Float.self)
    }
}
```

### Task Heads

Lightweight classifiers (1-3 layer MLP) trained on JEPA embeddings:

```swift
struct ActionAnticipationHead {
    private let classifier: MLPClassifier  // ~100K params

    func predict(from embedding: [Float]) -> Prediction {
        // Input: 1024-dim embedding
        // Output: action label + confidence + time-to-action
        classifier.predict(embedding)
    }
}
```

### Training Pipeline for Task Heads

```python
# Offline, on server
# 1. Extract V-JEPA 2 embeddings from your labeled dataset
# 2. Train lightweight head on embeddings

import torch
from transformers import AutoModel

encoder = AutoModel.from_pretrained("facebook/vjepa2-vitl-fpc16-384")
encoder.eval()

# Extract embeddings for all training clips
for clip, label in dataset:
    with torch.no_grad():
        embedding = encoder(clip).last_hidden_state.mean(dim=1)
    save(embedding, label)

# Train head
head = torch.nn.Sequential(
    torch.nn.Linear(1024, 256),
    torch.nn.ReLU(),
    torch.nn.Linear(256, num_classes)
)
# ... standard classification training ...
```

Export head as CoreML model separately from encoder. On device, run encoder then head.

---

## Phase 2: LeWorldModel for On-Device World Modeling

More speculative but aligned with the edge architecture.

### Why LeWM Instead of V-JEPA 2 for Phase 2

| Property | V-JEPA 2 | LeWorldModel |
|----------|----------|-------------|
| Parameters | 300M-1.2B | 15M |
| On-device size | 200-300MB | 15-60MB |
| Planning capable | Yes (V-JEPA 2-AC) | Yes (native) |
| Anomaly detection | Via task head | Native (surprise evaluation) |
| Trainable on-device | No | Yes (single GPU) |
| Real-world validated | Yes | No |

### Integration Pattern

```swift
class WorldModelPipeline {
    private let encoder: LeWMEncoder        // ~15MB quantized
    private let predictor: LeWMPredictor
    private let surpriseThreshold: Float = 0.7

    func processFrame(_ frame: CVPixelBuffer) async -> WorldState {
        let currentEmbedding = await encoder.encode(frame)

        if let predictedEmbedding = lastPrediction {
            let surprise = cosineDistance(currentEmbedding, predictedEmbedding)

            if surprise > surpriseThreshold {
                // Physically implausible event detected
                await audioStage.playAlert("Warning: unexpected situation detected")
            }
        }

        // Predict next state
        lastPrediction = await predictor.predictNext(from: currentEmbedding)

        return WorldState(embedding: currentEmbedding, surprise: surprise)
    }
}
```

---

## Audio Integration

Leveraging the existing MWDAT audio pipeline per `.claude/rules/dat-audio-hfp.md`:

```swift
// JEPA alerts go through the same HFP audio path
class JEPAAudioFeedback {
    private let audioStage: AudioStage  // Existing

    func playAlert(_ message: String) async {
        // Uses TTS through HFP glasses speakers
        // codecType 2 path (22050Hz PCM via AVSpeechSynthesizer.write())
        await audioStage.playTTS(message)
    }

    func playUrgentAlert(_ message: String) async {
        // Short pre-recorded audio cue for time-critical warnings
        // Lower latency than TTS
        await audioStage.playPreRecorded(.warning)
        await audioStage.playTTS(message)
    }
}
```

### Audio Session Coordination

Per HFP docs, audio session must be configured BEFORE stream session:

```swift
func startFullPipeline() async {
    // 1. Audio session first (HFP for glasses speaker output)
    startAudioSession()

    // 2. Wait for HFP handshake
    try? await Task.sleep(nanoseconds: 2 * NSEC_PER_SEC)

    // 3. Start camera stream
    await streamSession.start()

    // 4. Start JEPA processing on video frames
    jepaPipeline.start()
}
```

---

## Compute Budget on iPhone

Assuming iPhone 15 Pro (A17 Pro, 6-core CPU, 5-core GPU, 16-core Neural Engine):

| Component | Compute | Time | Frequency |
|-----------|---------|------|-----------|
| Frame resize/normalize | CPU/GPU | ~2ms | Every frame (30fps) |
| Frame buffer management | CPU | ~0.1ms | Every frame |
| V-JEPA 2 encoder (ViT-L, INT8) | Neural Engine | ~50ms | Every 500ms |
| Task head inference | Neural Engine | ~1ms | Every 500ms |
| TTS synthesis | CPU | ~20ms | On demand |
| **Total per inference cycle** | | **~73ms** | **2 Hz** |

Battery impact: Estimated 5-8% per hour of continuous JEPA processing (vs ~15-20% for cloud-based VLM queries at the same frequency).

---

## Deployment Checklist

- [ ] Select model variant (V-JEPA 2 ViT-L recommended for Phase 1)
- [ ] Apply ST-A2 attention optimization (drop-in, zero retraining)
- [ ] Quantize to INT8 via PyTorch dynamic quantization
- [ ] Export to ONNX and optimize
- [ ] Convert to CoreML (mlpackage)
- [ ] Validate accuracy on target task
- [ ] Profile inference time on target device
- [ ] Integrate with StreamSession frame pipeline
- [ ] Train task-specific heads on labeled data
- [ ] Export heads as separate CoreML models
- [ ] Wire audio feedback through HFP
- [ ] Test thermal performance during sustained inference
- [ ] Measure battery impact over 1-hour session

---

## Dependencies

| Dependency | Purpose | Version |
|-----------|---------|---------|
| CoreML | On-device inference | iOS 16+ |
| MWDATCore | Device discovery, permissions | DAT SDK 0.5+ |
| MWDATCamera | StreamSession, VideoFrame | DAT SDK 0.5+ |
| AVFoundation | Audio session, TTS | iOS 16+ |
| HuggingFace Hub | Model weight download | N/A (pre-bundled) |
