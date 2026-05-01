/**
 * ReIDOrchestrator -- manages ReID (person re-identification) lifecycle
 *
 * Mirrors jepa-orchestrator.ts pattern: session-scoped state, provider management,
 * and async embedding extraction from person crops sent by iOS.
 *
 * Flow:
 *   iOS detects persons → crops patches to JPEG → sends reid_crops WS message
 *   Server batch-extracts embeddings via OSNet → sends reid_embeddings back
 *   iOS injects embeddings into track galleries for ReIDGate
 */

import type {
  ReIDService,
  ReIDServiceConfig,
  ReIDServiceCallbacks,
  ReIDServiceStatus,
} from "./reid-service.js";
import { createReIDService } from "./reid-service.js";
// Import to register providers (when available)
// import "./reid-modal-provider.js";

// --- Types ---

type WsLike = { send: (data: string) => void; readyState: number };

// --- Types ---

export interface ReIDActivationConfig {
  /** ReID provider name (e.g., "modal") */
  provider: string;
  /** Model variant */
  model: string;
  /** GPU type */
  gpu: string;
  /** Session ID this ReID node belongs to */
  sessionId: string;
}

export interface ReIDNodeStatus {
  provider: string;
  model: string;
  gpu: string;
  status: ReIDServiceStatus;
  cropsProcessed: number;
  embeddingsReturned: number;
  lastCropAt: number | null;
}

interface SessionReIDState {
  service: ReIDService;
  config: ReIDActivationConfig;
  publisherWs: WsLike | null;
  cropsProcessed: number;
  embeddingsReturned: number;
  lastCropAt: number | null;
}

// --- Orchestrator ---

export class ReIDOrchestrator {
  private reidState = new Map<string, SessionReIDState>(); // sessionId -> state

  // --- Lifecycle ---

  /** Activate a ReID node for a session */
  async activate(
    sessionId: string,
    config: ReIDActivationConfig,
    publisherWs: WsLike | null
  ): Promise<void> {
    // Deactivate existing if any
    this.deactivate(sessionId);

    const service = createReIDService(config.provider);
    if (!service) {
      throw new Error(`Unknown ReID provider: ${config.provider}`);
    }

    const serviceConfig: ReIDServiceConfig = {
      model: config.model,
      gpu: config.gpu,
      embeddingDim: 512,
    };

    const callbacks: ReIDServiceCallbacks = {
      onStatusChange: (status) => {
        console.log(`[reid-orchestrator] Session ${sessionId} status: ${status}`);
      },
      onError: (error) => {
        console.error(`[reid-orchestrator] Session ${sessionId} error:`, error.message);
      },
    };

    await service.connect(serviceConfig, callbacks);

    this.reidState.set(sessionId, {
      service,
      config,
      publisherWs,
      cropsProcessed: 0,
      embeddingsReturned: 0,
      lastCropAt: null,
    });

    console.log(
      `[reid-orchestrator] Activated ReID for session ${sessionId} (model=${config.model}, gpu=${config.gpu})`
    );
  }

  /** Deactivate ReID node for a session */
  deactivate(sessionId: string): void {
    const state = this.reidState.get(sessionId);
    if (state) {
      state.service.disconnect();
      this.reidState.delete(sessionId);
      console.log(`[reid-orchestrator] Deactivated ReID for session ${sessionId}`);
    }
  }

  /** Check if a session has an active ReID node */
  isActive(sessionId: string): boolean {
    const state = this.reidState.get(sessionId);
    return state !== undefined && state.service.status !== "idle";
  }

  /** Update publisher WS connection (for reconnect) */
  updatePublisherWs(sessionId: string, ws: WsLike | null): void {
    const state = this.reidState.get(sessionId);
    if (state) {
      state.publisherWs = ws;
    }
  }

  /** Get status for a session's ReID node */
  getStatus(sessionId: string): ReIDNodeStatus | null {
    const state = this.reidState.get(sessionId);
    if (!state) return null;
    return {
      provider: state.config.provider,
      model: state.config.model,
      gpu: state.config.gpu,
      status: state.service.status,
      cropsProcessed: state.cropsProcessed,
      embeddingsReturned: state.embeddingsReturned,
      lastCropAt: state.lastCropAt,
    };
  }

  // --- Crop processing ---

  /** Process person crops from iOS. Extracts embeddings and sends back. */
  async sendCrops(
    sessionId: string,
    crops: Array<{ detectionIndex: number; data: string }>
  ): Promise<void> {
    const state = this.reidState.get(sessionId);
    if (!state || state.service.status === "idle" || state.service.status === "error") return;

    state.cropsProcessed += crops.length;
    state.lastCropAt = Date.now();

    try {
      // Decode base64 JPEG crops to Buffers
      const buffers = crops.map((c) => Buffer.from(c.data, "base64"));

      // Batch extract embeddings
      const embeddings = await state.service.extractBatch(buffers);

      state.embeddingsReturned += embeddings.length;

      // Send embeddings back to iOS via publisher WS
      const response = {
        type: "reid_embeddings",
        embeddings: crops.map((c, i) => ({
          detectionIndex: c.detectionIndex,
          embedding: embeddings[i] ?? [],
        })),
      };

      if (state.publisherWs?.readyState === 1) { // OPEN
        state.publisherWs.send(JSON.stringify(response));
      }
    } catch (err) {
      console.error(`[reid-orchestrator] Error processing crops for ${sessionId}:`, err);
    }
  }

  /** Clean up all sessions */
  cleanup(): void {
    for (const [sessionId] of this.reidState) {
      this.deactivate(sessionId);
    }
  }
}
