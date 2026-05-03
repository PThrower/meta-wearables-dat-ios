/**
 * ModalJEPAProvider -- V-JEPA 2 encoder via Modal serverless GPU
 *
 * Sends buffered video clips to a Modal function running V-JEPA 2.
 * Modal handles GPU allocation, container lifecycle, and per-second billing.
 *
 * GPU options: T4 ($0.19/hr), A10G ($1.10/hr), A100-80GB ($2.10/hr), H100 ($3.95/hr)
 * Cold start: ~2 seconds. keep_warm recommended for production.
 */

import type {
  JEPAService,
  JEPAServiceConfig,
  JEPAServiceCallbacks,
  JEPAServiceStatus,
  JEPAClipMetadata,
  JEPATaskConfig,
} from "./jepa-service.js";
import { registerJEPAProvider } from "./jepa-service.js";

// --- Frame buffer ---

interface BufferedFrame {
  jpeg: Uint8Array;
  timestampMs: number;
}

// --- Modal HTTP client ---

class ModalClient {
  private apiKey: string;
  private appId: string;
  private baseUrl = "https://api.modal.com/v1";

  constructor(opts: { appId: string; apiKey: string }) {
    this.appId = opts.appId;
    this.apiKey = opts.apiKey;
  }

  async invoke(method: string, args: Record<string, unknown>): Promise<any> {
    const url = `${this.baseUrl}/apps/${this.appId}/functions/${method}/call`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ args }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Modal API error ${res.status}: ${text}`);
    }
    return res.json();
  }
}

// --- Provider ---

export class ModalJEPAProvider implements JEPAService {
  private config: JEPAServiceConfig | null = null;
  private callbacks: JEPAServiceCallbacks | null = null;
  private _status: JEPAServiceStatus = "idle";
  private frameBuffer: BufferedFrame[] = [];
  private clipIndex = 0;
  private modalClient: ModalClient | null = null;
  private baselines = new Map<string, number[]>();
  private processing = false;

  /** FPS throttle state */
  private lastFrameTime = 0;
  private frameIntervalMs = 1000; // default 1 fps

  get status(): JEPAServiceStatus {
    return this._status;
  }

  async connect(config: JEPAServiceConfig, callbacks: JEPAServiceCallbacks): Promise<void> {
    this.config = config;
    this.callbacks = callbacks;
    this.frameIntervalMs = 1000 / config.sampleFps;
    this._status = "loading-model";

    const apiKey = process.env.MODAL_API_KEY;
    if (!apiKey) {
      throw new Error("MODAL_API_KEY environment variable is required for Modal JEPA provider");
    }

    this.modalClient = new ModalClient({
      appId: process.env.MODAL_APP_ID ?? "jepa-vision",
      apiKey,
    });

    // Warm up: trigger container start with a health check
    try {
      await this.modalClient.invoke("health_check", {});
      this._status = "ready";
      callbacks.onStatusChange("ready");
      console.log("[jepa-modal] Connected, model ready");
    } catch (err) {
      this._status = "error";
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
      console.error("[jepa-modal] Connection failed:", err);
    }
  }

  sendFrame(jpeg: Uint8Array, timestampMs: number): void {
    if (!this.config || !this.callbacks) return;

    // Throttle by sampleFps
    if (timestampMs - this.lastFrameTime < this.frameIntervalMs) return;
    this.lastFrameTime = timestampMs;

    this.frameBuffer.push({ jpeg, timestampMs });

    if (this.frameBuffer.length >= this.config.clipLength) {
      const clip = this.frameBuffer.splice(0, this.config.clipLength);
      this.processClip(clip);
    }
  }

  setBaseline(baselineId: string, embedding: number[]): void {
    this.baselines.set(baselineId, embedding);
  }

  disconnect(): void {
    this.frameBuffer = [];
    this._status = "idle";
    this.callbacks?.onStatusChange("idle");
    console.log("[jepa-modal] Disconnected");
  }

  private async processClip(clip: BufferedFrame[]): Promise<void> {
    if (!this.config || !this.callbacks || !this.modalClient || this.processing) {
      // Drop clip if already processing (backpressure)
      return;
    }

    this.processing = true;
    this._status = "processing";
    this.callbacks.onStatusChange("processing");

    const currentClipIndex = this.clipIndex++;

    try {
      // Send JPEG frames as base64 to Modal
      const framesBase64 = clip.map(f =>
        Buffer.from(f.jpeg).toString("base64")
      );

      const result = await this.modalClient.invoke("encode_clip", {
        frames_jpeg: framesBase64,
      });

      const embedding: number[] = result.embedding;
      const metadata: JEPAClipMetadata = {
        sessionId: "", // set by orchestrator
        clipIndex: currentClipIndex,
        timestampMs: clip[0].timestampMs,
        frameCount: clip.length,
      };

      // Emit embedding
      const hasEmbeddingTask = this.config.tasks.some(t => t.type === "embedding-extraction");
      if (hasEmbeddingTask) {
        this.callbacks.onEmbedding(embedding, metadata);
      }

      // Check for anomalies against baselines
      const anomalyTask = this.config.tasks.find(t => t.type === "anomaly-detection");
      if (anomalyTask && this.baselines.size > 0) {
        const threshold = anomalyTask.threshold ?? 0.85;
        for (const [baselineId, baseline] of this.baselines) {
          const distance = cosineDistance(embedding, baseline);
          if (distance > threshold) {
            this.callbacks.onAnomaly({
              score: distance,
              description: `Anomaly detected (score=${distance.toFixed(3)}, threshold=${threshold})`,
              clipIndex: currentClipIndex,
              timestampMs: clip[0].timestampMs,
              embeddingBaseline: baselineId,
            });
          }
        }
      }

      this._status = "ready";
      this.callbacks.onStatusChange("ready");
    } catch (err) {
      this.callbacks.onError(err instanceof Error ? err : new Error(String(err)));
      this._status = "ready"; // recover for next clip
      this.callbacks.onStatusChange("ready");
      console.error("[jepa-modal] Clip processing error:", err);
    } finally {
      this.processing = false;
    }
  }
}

// --- Cosine distance utility ---

function cosineDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) return 1;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 1;
  return 1 - (dot / (Math.sqrt(normA) * Math.sqrt(normB)));
}

// --- Register provider ---

registerJEPAProvider("modal", ModalJEPAProvider);
