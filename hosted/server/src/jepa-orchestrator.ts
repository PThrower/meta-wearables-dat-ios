/**
 * JEPAOrchestrator -- manages JEPA vision node lifecycle and event routing
 *
 * Mirrors GuidanceOrchestrator pattern but for JEPA services.
 * Runs parallel to AI guidance -- JEPA watches passively, AI reacts to prompts.
 *
 * Plugs into server.ts video fan-out alongside:
 *   [1] registry.fanout()          -> viewers
 *   [2] recorder.appendVideo()     -> R2
 *   [3] orchestrator.sendVideo()   -> AI
 *   [4] jepaOrchestrator.sendFrame() -> JEPA encoder (this)
 */

import type {
  JEPAService,
  JEPAServiceConfig,
  JEPAServiceCallbacks,
  JEPAServiceStatus,
  JEPAClipMetadata,
  JEPAction,
  JEPAomaly,
  JEPAPrediction,
} from "./jepa-service.js";
import { createJEPAService } from "./jepa-service.js";
// Import to register providers
import "./jepa-modal-provider.js";
import "./jepa-mobile-providers.js";

import type { GuidanceEvent } from "./guidance-orchestrator.js";

// --- Types ---

export interface JEPAActivationConfig {
  /** JEPA provider name (e.g., "modal") */
  provider: string;
  /** Model variant */
  model: string;
  /** GPU type */
  gpu: string;
  /** Frames per clip */
  clipLength: number;
  /** Sampling FPS from stream */
  sampleFps: number;
  /** Encoder input resolution */
  resolution: number;
  /** Task heads */
  tasks: { type: string; labels?: string[]; threshold?: number }[];
  /** Session ID this JEPA node belongs to */
  sessionId: string;
}

export interface JEPANodeStatus {
  provider: string;
  model: string;
  gpu: string;
  status: JEPAServiceStatus;
  clipsProcessed: number;
  lastClipAt: number | null;
  anomaliesDetected: number;
}

interface SessionJEPAState {
  service: JEPAService;
  config: JEPAActivationConfig;
  clipsProcessed: number;
  lastClipAt: number | null;
  anomaliesDetected: number;
}

// --- Callback types for event routing ---

export type JEPAEventFanoutFn = (sessionId: string, event: GuidanceEvent) => void;
export type JEPAGuidancePushFn = (sessionId: string, event: GuidanceEvent) => void;
export type JEPAPersistFn = (sessionId: string, event: GuidanceEvent) => void;
export type JEPAFlowTriggerFn = (sessionId: string, event: GuidanceEvent) => void;

// --- Orchestrator ---

export class JEPAOrchestrator {
  private jepaState = new Map<string, SessionJEPAState>(); // sessionId -> state

  /** Fan out JEPA events to viewer WebSockets */
  private eventFanoutFn: JEPAEventFanoutFn | null = null;

  /** Push JEPA anomaly alerts to publisher (for audio cues) */
  private guidancePushFn: JEPAGuidancePushFn | null = null;

  /** Persist JEPA events to R2 */
  private persistFn: JEPAPersistFn | null = null;

  /** Push JEPA events to flow trigger evaluation engine */
  private flowTriggerFn: JEPAFlowTriggerFn | null = null;

  // --- Setters for wiring ---

  setEventFanoutFn(fn: JEPAEventFanoutFn): void {
    this.eventFanoutFn = fn;
  }

  setGuidancePushFn(fn: JEPAGuidancePushFn): void {
    this.guidancePushFn = fn;
  }

  setPersistFn(fn: JEPAPersistFn): void {
    this.persistFn = fn;
  }

  setFlowTriggerFn(fn: JEPAFlowTriggerFn): void {
    this.flowTriggerFn = fn;
  }

  // --- Lifecycle ---

  /** Activate a JEPA node for a session */
  async activate(sessionId: string, config: JEPAActivationConfig): Promise<void> {
    // Deactivate existing if any
    this.deactivate(sessionId);

    const service = createJEPAService(config.provider);
    if (!service) {
      throw new Error(`Unknown JEPA provider: ${config.provider}`);
    }

    const serviceConfig: JEPAServiceConfig = {
      model: config.model,
      clipLength: config.clipLength,
      sampleFps: config.sampleFps,
      resolution: config.resolution,
      tasks: config.tasks.map(t => ({
        type: t.type as any,
        labels: t.labels,
        threshold: t.threshold,
      })),
      gpu: config.gpu,
    };

    const callbacks: JEPAServiceCallbacks = {
      onEmbedding: (embedding, metadata) => {
        this.handleEmbedding(sessionId, embedding, metadata);
      },
      onAction: (action) => {
        this.handleAction(sessionId, action);
      },
      onAnomaly: (anomaly) => {
        this.handleAnomaly(sessionId, anomaly);
      },
      onPrediction: (prediction) => {
        this.handlePrediction(sessionId, prediction);
      },
      onStatusChange: (status) => {
        console.log(`[jepa-orchestrator] Session ${sessionId} status: ${status}`);
      },
      onError: (error) => {
        console.error(`[jepa-orchestrator] Session ${sessionId} error:`, error.message);
      },
    };

    await service.connect(serviceConfig, callbacks);

    this.jepaState.set(sessionId, {
      service,
      config,
      clipsProcessed: 0,
      lastClipAt: null,
      anomaliesDetected: 0,
    });

    console.log(`[jepa-orchestrator] Activated JEPA node for session ${sessionId} (model=${config.model}, gpu=${config.gpu})`);
  }

  /** Deactivate JEPA node for a session */
  deactivate(sessionId: string): void {
    const state = this.jepaState.get(sessionId);
    if (state) {
      state.service.disconnect();
      this.jepaState.delete(sessionId);
      console.log(`[jepa-orchestrator] Deactivated JEPA node for session ${sessionId}`);
    }
  }

  /** Check if a session has an active JEPA node */
  isActive(sessionId: string): boolean {
    const state = this.jepaState.get(sessionId);
    return state !== undefined && state.service.status !== "idle";
  }

  /** Get status for a session's JEPA node */
  getStatus(sessionId: string): JEPANodeStatus | null {
    const state = this.jepaState.get(sessionId);
    if (!state) return null;
    return {
      provider: state.config.provider,
      model: state.config.model,
      gpu: state.config.gpu,
      status: state.service.status,
      clipsProcessed: state.clipsProcessed,
      lastClipAt: state.lastClipAt,
      anomaliesDetected: state.anomaliesDetected,
    };
  }

  // --- Frame forwarding ---

  /** Forward a JPEG frame to the JEPA encoder (if active) */
  sendFrame(sessionId: string, jpeg: Uint8Array, timestampMs: number): void {
    const state = this.jepaState.get(sessionId);
    if (!state || state.service.status === "idle" || state.service.status === "error") return;
    state.service.sendFrame(jpeg, timestampMs);
  }

  /** Set an anomaly baseline for a session */
  setBaseline(sessionId: string, baselineId: string, embedding: number[]): void {
    const state = this.jepaState.get(sessionId);
    if (state) {
      state.service.setBaseline(baselineId, embedding);
    }
  }

  // --- Event handlers ---

  private handleEmbedding(sessionId: string, embedding: number[], metadata: JEPAClipMetadata): void {
    const state = this.jepaState.get(sessionId);
    if (!state) return;

    state.clipsProcessed++;
    state.lastClipAt = Date.now();

    const event: GuidanceEvent = {
      type: "guidance.jepa.embedding",
      content: `Clip ${metadata.clipIndex} encoded (${metadata.frameCount} frames)`,
      confidence: 1.0,
      source: "jepa-vision",
      trigger: "clip-encoded",
      timestampMs: metadata.timestampMs,
      metadata: {
        severity: "info",
        objectLabel: `clip-${metadata.clipIndex}`,
      },
    };

    this.emitEvent(sessionId, event);
  }

  private handleAction(sessionId: string, action: JEPAction): void {
    const event: GuidanceEvent = {
      type: "guidance.jepa.prediction",
      content: `Action: ${action.label} (${(action.confidence * 100).toFixed(1)}%)`,
      confidence: action.confidence,
      source: "jepa-vision",
      trigger: "action-classification",
      timestampMs: action.timestampMs,
      metadata: {
        severity: "info",
        objectLabel: action.label,
      },
    };

    this.emitEvent(sessionId, event);

    // Notify flow trigger engine
    if (this.flowTriggerFn) {
      this.flowTriggerFn(sessionId, event);
    }
  }

  private handleAnomaly(sessionId: string, anomaly: JEPAomaly): void {
    const state = this.jepaState.get(sessionId);
    if (state) state.anomaliesDetected++;

    const severity = anomaly.score > 0.95 ? "critical" : anomaly.score > 0.9 ? "warning" : "info";

    const event: GuidanceEvent = {
      type: "guidance.jepa.anomaly",
      content: anomaly.description,
      confidence: anomaly.score,
      source: "jepa-vision",
      trigger: "anomaly-detection",
      timestampMs: anomaly.timestampMs,
      metadata: {
        severity: severity as "info" | "warning" | "critical",
        objectLabel: anomaly.embeddingBaseline,
      },
    };

    // Fan out to viewers
    this.emitEvent(sessionId, event);

    // Push anomaly alert to publisher (for audio cue) if warning or critical
    if (severity !== "info" && this.guidancePushFn) {
      this.guidancePushFn(sessionId, event);
    }

    // Notify flow trigger engine
    if (this.flowTriggerFn) {
      this.flowTriggerFn(sessionId, event);
    }
  }

  private handlePrediction(sessionId: string, prediction: JEPAPrediction): void {
    const event: GuidanceEvent = {
      type: "guidance.jepa.prediction",
      content: `Predicted next: ${prediction.predictedAction} (${(prediction.confidence * 100).toFixed(1)}%)`,
      confidence: prediction.confidence,
      source: "jepa-vision",
      trigger: "prediction",
      timestampMs: prediction.timestampMs,
      metadata: {
        severity: "info",
        objectLabel: prediction.predictedAction,
      },
    };

    this.emitEvent(sessionId, event);
  }

  private emitEvent(sessionId: string, event: GuidanceEvent): void {
    // Persist to R2
    if (this.persistFn) {
      this.persistFn(sessionId, event);
    }

    // Fan out to viewer WebSockets
    if (this.eventFanoutFn) {
      this.eventFanoutFn(sessionId, event);
    }
  }

  /** Clean up all sessions */
  cleanup(): void {
    for (const [sessionId] of this.jepaState) {
      this.deactivate(sessionId);
    }
  }
}
