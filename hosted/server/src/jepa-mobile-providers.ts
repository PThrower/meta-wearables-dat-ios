/**
 * JEPA mobile provider -- placeholder for on-device inference
 *
 * Two mobile targets:
 *   - "coreml": Apple Silicon (iPhone/iPad) via CoreML + ANE
 *   - "onnx": Android via ONNX Runtime + NNAPI
 *
 * Mobile JEPA runs smaller models (LeWorldModel ~15M params, or quantized V-JEPA 2 ViT-S).
 * No network round-trip needed -- inference happens on the phone.
 * Trade-off: smaller model, limited by phone thermal envelope, but zero latency and full privacy.
 *
 * This file defines the interface. Actual implementations live in the iOS app (Swift/CoreML)
 * and would be called from the relay server only for cloud-mobile hybrid scenarios.
 */

import type {
  JEPAService,
  JEPAServiceConfig,
  JEPAServiceCallbacks,
  JEPAServiceStatus,
} from "./jepa-service.js";
import { registerJEPAProvider } from "./jepa-service.js";

// --- Apple CoreML provider (iOS on-device) ---

export class CoreMLJEPAProvider implements JEPAService {
  private _status: JEPAServiceStatus = "idle";
  private config: JEPAServiceConfig | null = null;
  private callbacks: JEPAServiceCallbacks | null = null;
  private frameBuffer: { jpeg: Uint8Array; timestampMs: number }[] = [];
  private clipIndex = 0;
  private lastFrameTime = 0;
  private frameIntervalMs = 1000;

  get status(): JEPAServiceStatus { return this._status; }

  async connect(config: JEPAServiceConfig, callbacks: JEPAServiceCallbacks): Promise<void> {
    this.config = config;
    this.callbacks = callbacks;
    this.frameIntervalMs = 1000 / config.sampleFps;

    // TODO: Call native Swift CoreML bridge via Bun FFI or local HTTP
    // For now, log that this is a mobile provider
    console.log("[jepa-coreml] CoreML provider requested -- requires iOS native bridge");
    console.log(`[jepa-coreml] Model: ${config.model}, resolution: ${config.resolution}`);

    this._status = "ready";
    callbacks.onStatusChange("ready");
  }

  sendFrame(jpeg: Uint8Array, timestampMs: number): void {
    if (!this.config || !this.callbacks) return;
    if (timestampMs - this.lastFrameTime < this.frameIntervalMs) return;
    this.lastFrameTime = timestampMs;

    this.frameBuffer.push({ jpeg, timestampMs });

    if (this.frameBuffer.length >= this.config.clipLength) {
      const clip = this.frameBuffer.splice(0, this.config.clipLength);
      // TODO: Call native CoreML inference
      console.log(`[jepa-coreml] Clip ${this.clipIndex++} buffered (${clip.length} frames) -- native bridge not yet implemented`);
    }
  }

  setBaseline(baselineId: string, embedding: number[]): void {
    console.log(`[jepa-coreml] Baseline set: ${baselineId}`);
  }

  disconnect(): void {
    this.frameBuffer = [];
    this._status = "idle";
    this.callbacks?.onStatusChange("idle");
  }
}

// --- ONNX Runtime provider (Android on-device) ---

export class ONNXJEPAProvider implements JEPAService {
  private _status: JEPAServiceStatus = "idle";
  private config: JEPAServiceConfig | null = null;
  private callbacks: JEPAServiceCallbacks | null = null;
  private frameBuffer: { jpeg: Uint8Array; timestampMs: number }[] = [];
  private clipIndex = 0;
  private lastFrameTime = 0;
  private frameIntervalMs = 1000;

  get status(): JEPAServiceStatus { return this._status; }

  async connect(config: JEPAServiceConfig, callbacks: JEPAServiceCallbacks): Promise<void> {
    this.config = config;
    this.callbacks = callbacks;
    this.frameIntervalMs = 1000 / config.sampleFps;

    console.log("[jepa-onnx] ONNX Runtime provider requested -- requires Android native bridge");
    console.log(`[jepa-onnx] Model: ${config.model}, resolution: ${config.resolution}`);

    this._status = "ready";
    callbacks.onStatusChange("ready");
  }

  sendFrame(jpeg: Uint8Array, timestampMs: number): void {
    if (!this.config || !this.callbacks) return;
    if (timestampMs - this.lastFrameTime < this.frameIntervalMs) return;
    this.lastFrameTime = timestampMs;

    this.frameBuffer.push({ jpeg, timestampMs });

    if (this.frameBuffer.length >= this.config.clipLength) {
      const clip = this.frameBuffer.splice(0, this.config.clipLength);
      console.log(`[jepa-onnx] Clip ${this.clipIndex++} buffered (${clip.length} frames) -- native bridge not yet implemented`);
    }
  }

  setBaseline(baselineId: string, embedding: number[]): void {
    console.log(`[jepa-onnx] Baseline set: ${baselineId}`);
  }

  disconnect(): void {
    this.frameBuffer = [];
    this._status = "idle";
    this.callbacks?.onStatusChange("idle");
  }
}

// --- Register mobile providers ---

registerJEPAProvider("coreml", CoreMLJEPAProvider);
registerJEPAProvider("onnx", ONNXJEPAProvider);
