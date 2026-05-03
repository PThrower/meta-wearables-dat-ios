/**
 * ModalReIDProvider -- OSNet person re-identification via Modal serverless GPU
 *
 * Sends person crop JPEGs to a Modal function running OSNet.
 * Modal handles GPU allocation, container lifecycle, and per-second billing.
 *
 * GPU options: T4 ($0.19/hr), A10G ($1.10/hr), A100-80GB ($2.10/hr), H100 ($3.95/hr)
 * Cold start: ~2 seconds. keep_warm recommended for production.
 *
 * Models:
 *   osnet-x025: 0.25x width, fastest, ~1M params, 512-dim embedding
 *   osnet-x05:  0.5x width, balanced, ~2.2M params, 512-dim embedding (default)
 *   osnet-x10:  1.0x width, most accurate, ~7.7M params, 512-dim embedding
 *
 * Input: 256x128 RGB person crop (JPEG)
 * Output: 512-dim L2-normalized embedding vector
 *
 * Ref: arXiv:1905.00953 — OSNet: Omni-Scale Feature Learning for Person Re-Identification
 */

import type {
  ReIDService,
  ReIDServiceConfig,
  ReIDServiceCallbacks,
  ReIDServiceStatus,
} from "./reid-service.js";
import { registerReIDProvider } from "./reid-service.js";

// --- Modal HTTP client (shared pattern with jepa-modal-provider.ts) ---

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

export class ModalReIDProvider implements ReIDService {
  private config: ReIDServiceConfig | null = null;
  private callbacks: ReIDServiceCallbacks | null = null;
  private _status: ReIDServiceStatus = "idle";
  private modalClient: ModalClient | null = null;

  get status(): ReIDServiceStatus {
    return this._status;
  }

  async connect(config: ReIDServiceConfig, callbacks: ReIDServiceCallbacks): Promise<void> {
    this.config = config;
    this.callbacks = callbacks;
    this._status = "loading-model";

    const apiKey = process.env.MODAL_API_KEY;
    if (!apiKey) {
      throw new Error("MODAL_API_KEY environment variable is required for Modal ReID provider");
    }

    this.modalClient = new ModalClient({
      appId: process.env.MODAL_REID_APP_ID ?? "reid-osnet",
      apiKey,
    });

    // Warm up: trigger container start with a health check
    try {
      await this.modalClient.invoke("health_check", {
        model: config.model,
      });
      this._status = "ready";
      callbacks.onStatusChange("ready");
      console.log(`[reid-modal] Connected, OSNet model ready (${config.model})`);
    } catch (err) {
      this._status = "error";
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
      console.error("[reid-modal] Connection failed:", err);
    }
  }

  async extractEmbedding(crop: Buffer): Promise<number[]> {
    const results = await this.extractBatch([crop]);
    return results[0] ?? [];
  }

  async extractBatch(crops: Buffer[]): Promise<number[][]> {
    if (!this.modalClient || !this.config) {
      throw new Error("ReID provider not connected");
    }

    this._status = "processing";
    this.callbacks?.onStatusChange("processing");

    try {
      // Send JPEG crops as base64 to Modal OSNet function
      const cropsBase64 = crops.map(c => c.toString("base64"));

      const result = await this.modalClient.invoke("extract_embeddings", {
        crops_jpeg: cropsBase64,
        model: this.config.model,
      });

      const embeddings: number[][] = result.embeddings;
      this._status = "ready";
      this.callbacks?.onStatusChange("ready");
      return embeddings;
    } catch (err) {
      this.callbacks?.onError(err instanceof Error ? err : new Error(String(err)));
      this._status = "ready";
      this.callbacks?.onStatusChange("ready");
      console.error("[reid-modal] Embedding extraction error:", err);
      // Return empty embeddings on failure -- gate will pass through
      return crops.map(() => []);
    }
  }

  disconnect(): void {
    this._status = "idle";
    this.callbacks?.onStatusChange("idle");
    console.log("[reid-modal] Disconnected");
  }
}

// --- Register provider ---

registerReIDProvider("modal", ModalReIDProvider);
