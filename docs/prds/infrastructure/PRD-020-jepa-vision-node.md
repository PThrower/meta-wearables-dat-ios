# PRD-020: JEPA Vision Node

**Product:** com.mwdat-ios / Relay Server
**Owner:** @ebowwa
**Status:** Draft
**Last Updated:** 2026-04-23
**Depends On:** PRD-002 (Relay Platform), PRD-014 (Telemetry)

---

## Problem

The relay server processes glasses video through two paths today: **viewer fan-out** (real-time) and **conversational AI** (Gemini/Gemma, reactive). Neither path provides **continuous, predictive stream understanding**. The AI only activates when prompted. No component watches every frame to answer: "what is happening, what's about to happen, and is anything abnormal?"

This matters for the field worker use cases the platform targets. A worker won't ask "am I about to skip step 4?" -- the system should tell them. A safety violation won't be caught by someone asking "is this dangerous?" -- the system should detect it passively.

---

## Proposal

Add a **JEPA Vision Node** as a new workflow node type (`jepa-vision`) that runs parallel to existing AI nodes. It receives video frames from the same fan-out path, runs a V-JEPA 2 encoder on a remote GPU (Modal), and streams back predictions, anomaly scores, and action classifications.

The node is:
- **Always-on** when active (no prompting needed)
- **Parallel** to conversational AI (both run simultaneously)
- **Provider-abstracted** (Modal today, any GPU provider tomorrow)
- **Model-abstracted** (V-JEPA 2 today, LeWorldModel or custom models tomorrow)

---

## Users

| Persona | Description | Primary Need |
|---------|-------------|--------------|
| **Field Worker** | Wearing glasses, performing procedures | Passive safety alerts, step tracking via HFP audio |
| **Remote Expert** | Watching stream in browser | JEPA predictions overlay (action timeline, anomaly flags) |
| **Compliance Officer** | Reviewing recorded sessions | JEPA-annotated audit trail in R2 recordings |
| **Platform Operator** | Managing fleet and workflows | Cost control, GPU utilization, per-stream metrics |

---

## Architecture

### Data Flow (Integration Point)

The JEPA node plugs into the existing video fan-out at `server.ts:1516-1544`:

```
Publisher WS (FRLY video frame)
  |
  [1] registry.fanout()           --> viewers          (existing)
  [2] recorder.appendVideo()      --> R2/S3            (existing)
  [3] orchestrator.sendVideo()    --> AI (Gemini/Gemma) (existing)
  [4] jepaNode.sendFrame()        --> JEPA encoder     (NEW)
        |
        v
     Modal GPU (V-JEPA 2 encoder)
        |
        +-- action embeddings
        +-- anomaly scores
        +-- prediction embeddings
        |
        v
     JEPA Event Bus
        |
        +-- guidance.jepa.prediction  --> viewer overlay
        +-- guidance.jepa.anomaly     --> viewer + publisher audio
        +-- guidance.jepa.compliance  --> R2 recording
        +-- embedding store           --> vector DB (post-session search)
```

### Provider Abstraction

Following the existing `AIService` pattern (`ai-service.ts`), the JEPA node uses a **provider-abstracted interface**:

```typescript
// New file: jepa-service.ts

export interface JEPAServiceConfig {
  /** Provider-specific model ID (e.g., "vjepa2-vitl-fpc16-384") */
  model: string;
  /** Frames per clip sent to encoder (16 or 64) */
  clipLength: number;
  /** Frames per second sampled from stream */
  sampleFps: number;
  /** Resolution for encoder input (256 or 384) */
  resolution: number;
  /** Task heads to enable */
  tasks: JEPATaskConfig[];
  /** Provider-specific extra config */
  extra?: Record<string, unknown>;
}

export interface JEPATaskConfig {
  type: "action-classification" | "anomaly-detection" | "prediction" | "embedding-extraction";
  /** Custom labels for classification (e.g., procedure step names) */
  labels?: string[];
  /** Anomaly threshold (0-1, default 0.85) */
  threshold?: number;
}

export interface JEPAServiceCallbacks {
  /** Embedding vector for a processed clip */
  onEmbedding: (embedding: Float32Array, metadata: JEPAClipMetadata) => void;
  /** Action classification result */
  onAction: (action: JEPAction) => void;
  /** Anomaly detected (embedding divergence from baseline) */
  onAnomaly: (anomaly: JEPAomaly) => void;
  /** Prediction for next N frames */
  onPrediction: (prediction: JEPAPrediction) => void;
  /** Provider status */
  onStatusChange: (status: JEPAServiceStatus) => void;
  /** Recoverable error */
  onError: (error: Error) => void;
}

export interface JEPAClipMetadata {
  sessionId: string;
  clipIndex: number;
  timestampMs: number;
  frameCount: number;
}

export interface JEPAction {
  label: string;
  confidence: number;
  clipIndex: number;
  timestampMs: number;
}

export interface JEPAomaly {
  score: number;           // 0-1, higher = more anomalous
  description: string;     // e.g., "unexpected action sequence" or "physical implausibility"
  clipIndex: number;
  timestampMs: number;
  embeddingBaseline: string; // ID of the baseline embedding this diverged from
}

export interface JEPAPrediction {
  /** Predicted action for the next clip */
  predictedAction: string;
  confidence: number;
  /** Predicted embedding for next clip (for trajectory tracking) */
  predictedEmbedding: Float32Array;
  clipIndex: number;
  timestampMs: number;
}

export type JEPAServiceStatus =
  | "idle"
  | "loading-model"
  | "ready"
  | "processing"
  | "error";

// --- Interface ---

export interface JEPAService {
  /** Initialize the model and warm up. Resolves when ready. */
  connect(config: JEPAServiceConfig, callbacks: JEPAServiceCallbacks): Promise<void>;

  /** Send a JPEG frame to be buffered. Encoder runs when clip buffer is full. */
  sendFrame(jpeg: Uint8Array, timestampMs: number): void;

  /** Set a baseline embedding for anomaly comparison (e.g., "normal procedure" embedding) */
  setBaseline(baselineId: string, embedding: Float32Array): void;

  /** Gracefully shut down. */
  disconnect(): void;

  /** Current status */
  readonly status: JEPAServiceStatus;
}

// --- Factory registry (mirrors ai-service.ts pattern) ---

type JEPAServiceConstructor = new () => JEPAService;

const providers = new Map<string, JEPAServiceConstructor>();

export function registerJEPAProvider(name: string, ctor: JEPAServiceConstructor): void {
  providers.set(name, ctor);
}

export function createJEPAService(provider: string): JEPAService | null {
  const ctor = providers.get(provider);
  return ctor ? new ctor() : null;
}

export function listJEPAProviders(): string[] {
  return [...providers.keys()];
}
```

### Primitive Definition

Add to `config/apps.json` primitives:

```json
{
  "id": "jepa-vjepa2",
  "inputs": [
    { "format": "jpeg-image" }
  ],
  "outputs": [
    { "format": "jepa-embedding" },
    { "format": "jepa-action" },
    { "format": "jepa-anomaly" },
    { "format": "jepa-prediction" }
  ]
}
```

### Workflow Node Type

Add `"jepa-vision"` to `WorkflowNodeType` in `app-types.ts`:

```typescript
export type WorkflowNodeType =
  | "stream-input"
  | "text"
  | "s2s-live"
  | "s2s-rest"
  | "s2s-e4b"
  | "jepa-vision"    // NEW
  | "output";
```

Update `resolveWorkflowToPipeline()` in `app-registry.ts` to handle `jepa-vision` nodes alongside AI nodes:

```typescript
// In resolveWorkflowToPipeline, the jepa-vision node creates a parallel JEPA app
// alongside any s2s-live/s2s-rest/s2s-e4b nodes

const jepaNodes = nodes.filter(n => n.type === "jepa-vision");
// ... resolve each jepa node to a jepa-vjepa2 primitive binding
```

---

## Modal Provider Implementation

### Why Modal

| Property | Modal | Alternative (RunPod Serverless) | Alternative (Baseten) |
|----------|-------|--------------------------------|----------------------|
| Cold start | ~2 sec | 3-5 min | 1-3 min |
| Billing | Per-second | Per-minute | Per-second |
| A100 80GB | $2.10/hr | $2.17/hr | $4.00/hr |
| H100 80GB | $3.95/hr | $3.35/hr | $6.50/hr |
| Free tier | $30/month | None | None |
| Keep-warm | ~$16/month (A10G) | N/A | N/A |
| Python-native | Yes (decorators) | Docker-based | Truss-based |
| Autoscaling | Zero-to-hundreds in seconds | Slower | Slower |

Modal wins on: DX, cold start, per-second billing, and the $30/month free tier covers prototyping entirely.

### Modal App Structure

```python
# jepa_provider.py -- deployed to Modal

import modal
import numpy as np
import torch
from transformers import AutoModel, AutoProcessor

app = modal.App("jepa-vision")

# Container image with CUDA + PyTorch + transformers
image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "torch==2.4.0",
        "torchvision",
        "transformers",
        "Pillow",
    )
    .apt_install("ffmpeg")
)

# GPU models available per tier
GPU_CONFIGS = {
    "light":  {"gpu": "A10G",    "model": "facebook/vjepa2-vitl-fpc16-384", "clip_len": 16},
    "medium": {"gpu": "A100-80GB", "model": "facebook/vjepa2-vitl-fpc16-384", "clip_len": 16},
    "heavy":  {"gpu": "A100-80GB", "model": "facebook/vjepa2-vitg-fpc64-384", "clip_len": 64},
    "fast":   {"gpu": "H100",    "model": "facebook/vjepa2-vitl-fpc16-384", "clip_len": 16},
}


@app.cls(
    image=image,
    gpu=modal.gpu.A10080GB(),    # Default, configurable per deployment
    container_idle_timeout=120,   # Stay warm 2 min after last request
    timeout=300,                  # Max 5 min per batch
    allow_concurrent_inputs=10,   # Handle 10 concurrent streams
)
class JEPAModel:
    @modal.enter()
    def load_model(self):
        """Load V-JEPA 2 model once per container lifecycle."""
        model_name = "facebook/vjepa2-vitl-fpc16-384"
        self.processor = AutoProcessor.from_pretrained(model_name)
        self.model = AutoModel.from_pretrained(model_name, trust_remote_code=True)
        self.model.eval()
        if torch.cuda.is_available():
            self.model = self.model.cuda()

    @modal.method()
    def encode_clip(self, frames_jpeg: list[bytes]) -> dict:
        """
        Encode a video clip into embeddings.

        Args:
            frames_jpeg: List of JPEG bytes (16 frames for fpc16 models)

        Returns:
            {
                "embedding": float32 array (1024-dim for ViT-L),
                "clip_index": int,
                "frame_count": int,
            }
        """
        from PIL import Image
        import io

        images = [Image.open(io.BytesIO(jpeg)).convert("RGB") for jpeg in frames_jpeg]
        inputs = self.processor(videos=[images], return_tensors="pt")

        if torch.cuda.is_available():
            inputs = {k: v.cuda() for k, v in inputs.items()}

        with torch.no_grad():
            outputs = self.model(**inputs)
            # Pool over spatial dimensions -> single vector per clip
            embedding = outputs.last_hidden_state.mean(dim=1).squeeze().cpu().numpy()

        return {
            "embedding": embedding.tolist(),
            "frame_count": len(frames_jpeg),
        }

    @modal.method()
    def encode_batch(self, clips: list[list[bytes]]) -> list[dict]:
        """Batch encode multiple clips (for throughput optimization)."""
        results = []
        for clip_frames in clips:
            results.append(self.encode_clip(clip_frames))
        return results


@app.function(image=image, secrets=[modal.Secret.from_name("jepa-config")])
def health_check() -> dict:
    return {"status": "ok", "model": "vjepa2-vitl-fpc16-384"}
```

### Relay Server Side: Modal Client

```typescript
// jepa-modal-provider.ts -- runs on relay server, calls Modal

import type { JEPAService, JEPAServiceConfig, JEPAServiceCallbacks, JEPAServiceStatus } from "./jepa-service.js";

export class ModalJEPAProvider implements JEPAService {
  private config: JEPAServiceConfig | null = null;
  private callbacks: JEPAServiceCallbacks | null = null;
  private _status: JEPAServiceStatus = "idle";
  private frameBuffer: { jpeg: Uint8Array; timestampMs: number }[] = [];
  private clipIndex = 0;
  private modalClient: ModalClient | null = null;

  readonly status: JEPAServiceStatus = "idle";

  async connect(config: JEPAServiceConfig, callbacks: JEPAServiceCallbacks): Promise<void> {
    this.config = config;
    this.callbacks = callbacks;
    this._status = "loading-model";

    this.modalClient = new ModalClient({
      appId: "jepa-vision",
      apiKey: process.env.MODAL_API_KEY!,
    });

    // Warm up: send a dummy frame to trigger container start
    try {
      await this.modalClient.invoke("health_check", {});
      this._status = "ready";
      callbacks.onStatusChange("ready");
    } catch (err) {
      this._status = "error";
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  sendFrame(jpeg: Uint8Array, timestampMs: number): void {
    if (!this.config || !this.callbacks) return;

    this.frameBuffer.push({ jpeg, timestampMs });

    if (this.frameBuffer.length >= this.config.clipLength) {
      const clip = this.frameBuffer.splice(0, this.config.clipLength);
      this.processClip(clip);
    }
  }

  private async processClip(clip: { jpeg: Uint8Array; timestampMs: number }[]): Promise<void> {
    if (!this.config || !this.callbacks || !this.modalClient) return;

    this._status = "processing";
    this.callbacks.onStatusChange("processing");

    try {
      const result = await this.modalClient.invoke("encode_clip", {
        frames_jpeg: clip.map(f => Buffer.from(f.jpeg).toString("base64")),
      });

      const embedding = new Float32Array(result.embedding);
      const metadata = {
        sessionId: "", // set by orchestrator
        clipIndex: this.clipIndex++,
        timestampMs: clip[0].timestampMs,
        frameCount: clip.length,
      };

      this.callbacks.onEmbedding(embedding, metadata);
      this._status = "ready";
      this.callbacks.onStatusChange("ready");
    } catch (err) {
      this.callbacks.onError(err instanceof Error ? err : new Error(String(err)));
      this._status = "ready"; // recover
      this.callbacks.onStatusChange("ready");
    }
  }

  disconnect(): void {
    this.frameBuffer = [];
    this._status = "idle";
    this.callbacks?.onStatusChange("idle");
  }
}
```

---

## GPU & Resource Specifications

### Model Sizes and GPU Requirements

| Model | Params | GPU Memory (inference) | Modal GPU | Modal Cost/hr | Clip Latency |
|-------|--------|----------------------|-----------|--------------|-------------|
| V-JEPA 2 ViT-L (fpc16, 256px) | ~300M | ~4 GB | A10G (24GB) | $1.10/hr | ~20ms |
| V-JEPA 2 ViT-L (fpc16, 384px) | ~300M | ~6 GB | A10G (24GB) | $1.10/hr | ~30ms |
| V-JEPA 2 ViT-G (fpc64, 384px) | ~1.2B | ~12 GB | A100 (80GB) | $2.10/hr | ~50ms |
| LeWorldModel (future) | ~15M | ~0.5 GB | T4 (16GB) | $0.19/hr | ~5ms |

### Throughput per GPU

| GPU | Model | Concurrent Streams | Streams/$/hr |
|-----|-------|-------------------|-------------|
| A10G ($1.10/hr) | ViT-L fpc16 | 8-12 | 7-11 |
| A100 80GB ($2.10/hr) | ViT-L fpc16 | 20-30 | 10-14 |
| A100 80GB ($2.10/hr) | ViT-G fpc64 | 8-12 | 4-6 |
| H100 ($3.95/hr) | ViT-G fpc64 | 15-25 | 4-6 |

### Cost Per Stream (Estimates)

Assuming 1 fps sampling, 16-frame clips (one inference per 16 seconds):

| Config | GPU | Streams/GPU | Cost/Stream/Hour |
|--------|-----|------------|-----------------|
| Light (ViT-L, A10G) | A10G | 10 | $0.11 |
| Medium (ViT-L, A100) | A100 | 25 | $0.08 |
| Heavy (ViT-G, A100) | A100 | 10 | $0.21 |
| Fast (ViT-G, H100) | H100 | 20 | $0.20 |

### Resource Planning

| Scale | Streams | GPU Config | Monthly Cost (24/7) | Monthly Cost (8hr/day) |
|-------|---------|-----------|--------------------|-----------------------|
| Prototype | 1-5 | 1x A10G + keep_warm | ~$50 | ~$15 |
| Small team | 5-20 | 1x A100-80GB | ~$320 | ~$110 |
| Fleet | 20-100 | 4x A100-80GB | ~$1,280 | ~$440 |
| Enterprise | 100+ | Modal autoscale | Variable | Variable |

Modal's `container_idle_timeout=120` keeps containers warm for 2 minutes after the last request. With keep_warm=1 on A10G, that's ~$16/month for an always-warm slot.

---

## Output Events (Fan-out)

JEPA node output maps to the existing guidance event system:

```typescript
// New event types added to guidance event system

interface JEPAGuidanceEvents {
  /** Continuous prediction stream -- overlays on viewer timeline */
  "guidance.jepa.prediction": {
    action: string;
    confidence: number;
    clipIndex: number;
    timestampMs: number;
  };

  /** Anomaly alert -- pushed to viewers AND publisher audio */
  "guidance.jepa.anomaly": {
    score: number;
    description: string;
    clipIndex: number;
    timestampMs: number;
    severity: "info" | "warning" | "critical";
  };

  /** Procedural step tracking -- persisted to R2 for compliance */
  "guidance.jepa.compliance": {
    stepIndex: number;
    stepLabel: string;
    completedAt: number;
    deviationDetected: boolean;
    deviationDescription?: string;
  };

  /** Raw embedding -- stored in vector DB for post-session analytics */
  "guidance.jepa.embedding": {
    clipIndex: number;
    vector: number[];  // 1024 floats for ViT-L
    timestampMs: number;
  };
}
```

### Routing per Event Type

| Event | Viewer WebSocket | Publisher Audio | R2 Recording | Vector Store |
|-------|-----------------|----------------|-------------|-------------|
| `jepa.prediction` | Yes (overlay) | No | Yes | No |
| `jepa.anomaly` (warning+) | Yes (badge) | Yes (TTS via HFP) | Yes | No |
| `jepa.compliance` | Yes (step tracker) | No | Yes (audit trail) | No |
| `jepa.embedding` | No | No | No | Yes |

---

## Configuration

### Environment Variables

```bash
# Modal provider
MODAL_API_KEY=                    # Modal API key (from Doppler)
MODAL_APP_ID=jepa-vision          # Modal app name
MODAL_GPU=A100-80GB               # GPU type: T4, A10G, A100-80GB, H100

# JEPA model
JEPA_MODEL=vjepa2-vitl-fpc16-384  # Model variant
JEPA_CLIP_LENGTH=16               # Frames per clip (16 or 64)
JEPA_SAMPLE_FPS=1                 # Frames per second from stream
JEPA_RESOLUTION=384               # Encoder input resolution

# Task heads
JEPA_ENABLE_ACTIONS=true          # Action classification
JEPA_ENABLE_ANOMALY=true          # Anomaly detection
JEPA_ENABLE_PREDICTIONS=true      # Next-clip prediction
JEPA_ENABLE_EMBEDDINGS=true       # Raw embedding extraction

# Anomaly detection
JEPA_ANOMALY_THRESHOLD=0.85       # Score threshold for alerts
JEPA_ANOMALY_BASELINE=            # Baseline embedding ID (procedure-specific)
```

### Workflow Node Config (UI)

```json
{
  "id": "jepa-1",
  "type": "jepa-vision",
  "label": "Safety Monitor",
  "config": {
    "gpu": "A10G",
    "model": "vjepa2-vitl-fpc16-384",
    "sampleFps": 1,
    "tasks": [
      { "type": "action-classification", "labels": ["walking", "reaching", "lifting", "idle"] },
      { "type": "anomaly-detection", "threshold": 0.85 }
    ],
    "output": {
      "viewers": true,
      "overlays": true,
      "speaker": false,
      "recording": true
    }
  }
}
```

---

## Phased Implementation

### P1: Core Infrastructure (Week 1-2)

- Add `JEPAService` interface to `jepa-service.ts`
- Add `jepa-vision` workflow node type to `app-types.ts`
- Add `jepa-vjepa2` primitive to `config/apps.json`
- Build `ModalJEPAProvider` with encode_clip method
- Deploy Modal app with V-JEPA 2 ViT-L
- Wire frame forwarding in `server.ts` alongside existing AI forwarding
- Basic `guidance.jepa.embedding` events to viewer

### P2: Action Classification + Anomaly (Week 3-4)

- Train lightweight action classifier head on V-JEPA 2 embeddings
- Implement anomaly detection via embedding distance from baseline
- Add `guidance.jepa.prediction` and `guidance.jepa.anomaly` events
- Wire anomaly alerts to publisher audio (TTS via HFP)
- Add anomaly badge overlay on viewer

### P3: Compliance Tracking (Week 5-6)

- Implement procedural step tracking from action stream
- Add `guidance.jepa.compliance` events with step-level detail
- Persist compliance audit trail to R2
- Build compliance timeline in viewer dashboard

### P4: Embedding Analytics (Week 7-8)

- Set up vector store (pgvector or Qdrant) for embedding persistence
- Post-session similarity search ("find sessions like this one")
- Session clustering and analytics dashboard
- Cross-session anomaly patterns

---

## Monitoring & Metrics

Add to existing telemetry (`PRD-014`):

| Metric | Type | Description |
|--------|------|-------------|
| `jepa.clips_processed` | Counter | Total clips encoded |
| `jepa.inference_latency_ms` | Histogram | Time from clip submission to embedding response |
| `jepa.anomalies_detected` | Counter | Anomaly events above threshold |
| `jepa.gpu_utilization_pct` | Gauge | Modal GPU utilization |
| `jepa.cost_usd` | Counter | Estimated cost based on GPU-seconds |
| `jepa.clip_buffer_dropped` | Counter | Clips dropped due to backpressure |
| `jepa.modal_cold_starts` | Counter | Container cold start events |

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Modal cold start adds latency on first clip | Medium | Low | `keep_warm=1` on A10G ($16/month), or warm on session start |
| V-JEPA 2 embeddings not discriminative enough for custom actions | Medium | Medium | Start with anomaly detection (unsupervised), add supervised heads later |
| Modal pricing changes | Low | Medium | Provider abstraction allows switching to RunPod/Baseten |
| GPU cost exceeds value at scale | Medium | High | LeWorldModel (15M params) on T4 ($0.19/hr) for future cost reduction |
| Privacy concerns with sending frames to cloud | Low | Medium | Frames already travel to relay server; Modal is same trust boundary. Future: on-device LeWorldModel eliminates this |

---

## Future Providers

The `JEPAService` interface enables swapping the GPU backend without changing the node logic:

| Provider | Status | Best For |
|----------|--------|----------|
| **Modal** (initial) | Implementing | Prototyping, low-volume production, per-second billing |
| RunPod Serverless | Future | High-volume, spot pricing, longer-running jobs |
| Baseten | Future | Enterprise deployments, model packaging |
| On-device (CoreML/ANE) | Future | Privacy-sensitive deployments, LeWorldModel (15M params) |
| Hetzner GPU (local) | Future | Dedicated hardware, predictable costs at scale |

Model swapping is also abstracted:

| Model | Provider | Best For |
|-------|----------|----------|
| V-JEPA 2 ViT-L | Modal A10G | Default, good balance of quality and cost |
| V-JEPA 2 ViT-G | Modal A100 | Maximum quality, research |
| LeWorldModel | Modal T4 / on-device | Ultra-lightweight, future production |
| Custom fine-tuned | Any | Domain-specific procedures |
