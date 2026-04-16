/**
 * GuidanceOrchestrator — AI Guidance event routing and state management
 *
 * Core of PRD-008. Subscribes to ControlEventBus, resolves apps via
 * AppRegistry, manages per-session activation state, and broadcasts
 * GuidanceEvent objects to session viewers.
 *
 * The TTS/AI model integration is STUBBED. When an app is activated,
 * a test GuidanceEvent is emitted. The orchestrator:
 * 1. Tracks activation state per session
 * 2. Routes events to the right subscribers
 * 3. Provides telemetry/status
 * 4. Has a clean interface for wiring real AI/TTS later
 */

import type { ControlEvent, AppConfig, AppPipeline } from "./app-types.js";
import type { ControlEventBus } from "./control-event-bus.js";
import type { AppRegistry } from "./app-registry.js";
import type { TTSService } from "./tts-service.js";
import { StubTTSService } from "./tts-service.js";

// --- Types ---

export type GuidanceEventType =
  | "guidance.step"
  | "guidance.alert"
  | "guidance.correction"
  | "guidance.identification"
  | "guidance.acknowledgment";

export interface GuidanceEvent {
  type: GuidanceEventType;
  content: string;
  confidence: number;
  source: string;        // appId
  trigger: string;       // what triggered this
  timestampMs: number;
  metadata?: {
    stepNumber?: number;
    severity?: "info" | "warning" | "critical";
    objectLabel?: string;
  };
}

export interface AIStatus {
  appId: string | null;
  status: "idle" | "activating" | "active" | "error";
  config?: AppConfig;
  activatedAt?: number;
  triggerCount: number;
  lastResponseMs?: number;
}

export interface AITelemetry {
  triggers: number;
  guidanceEvents: number;
  avgLatencyMs: number;
  lastLatencyMs: number | null;
  queueDepth: number;
  uptimeMs: number;
}

// --- Constants ---

const MAX_EVENT_HISTORY = 100;

// --- Orchestrator ---

export class GuidanceOrchestrator {
  private controlBus: ControlEventBus;
  private appRegistry: AppRegistry;
  private tts: TTSService;

  private status = new Map<string, AIStatus>();
  private telemetry = new Map<string, AITelemetry>();
  private eventHistory = new Map<string, GuidanceEvent[]>();
  private subscribers = new Map<string, Set<(msg: any) => void>>();

  private startedAt: number = 0;
  private unsubControlBus: (() => void) | null = null;

  // Latency tracking for telemetry averages
  private latencySum = new Map<string, number>();
  private latencyCount = new Map<string, number>();

  constructor(controlBus: ControlEventBus, appRegistry: AppRegistry, tts?: TTSService) {
    this.controlBus = controlBus;
    this.appRegistry = appRegistry;
    this.tts = tts ?? new StubTTSService();
  }

  // --- Public API ---

  /** Subscribe a viewer to guidance events for a session. Returns unsubscribe fn. */
  subscribeViewer(sessionId: string, callback: (msg: any) => void): () => void {
    let subs = this.subscribers.get(sessionId);
    if (!subs) {
      subs = new Set();
      this.subscribers.set(sessionId, subs);
    }
    subs.add(callback);
    return () => { subs!.delete(callback); };
  }

  /** Activate an app for a session (from viewer or publisher gesture). */
  async activateApp(sessionId: string, appId: string): Promise<void> {
    const pipeline = this.appRegistry.resolvePipeline(appId);
    const app = this.appRegistry.getApp(appId);
    if (!pipeline || !app) {
      this.setStatus(sessionId, {
        appId,
        status: "error",
        config: undefined,
        activatedAt: undefined,
        triggerCount: this.getStatus(sessionId).triggerCount,
        lastResponseMs: undefined,
      });
      this.broadcastStatus(sessionId);
      return;
    }

    this.setStatus(sessionId, {
      appId,
      status: "activating",
      config: app.config,
      activatedAt: Date.now(),
      triggerCount: this.getStatus(sessionId).triggerCount,
      lastResponseMs: undefined,
    });
    this.broadcastStatus(sessionId);

    // STUB: Emit a test guidance event to confirm activation
    const now = Date.now();
    const testEvent: GuidanceEvent = {
      type: "guidance.acknowledgment",
      content: `App "${app.name}" activated. AI guidance is ready.`,
      confidence: 1.0,
      source: appId,
      trigger: "activate_app",
      timestampMs: now,
      metadata: {
        severity: "info",
      },
    };

    // Track latency
    const latency = Date.now() - now;
    this.addLatency(sessionId, latency);

    // Transition to active
    this.setStatus(sessionId, {
      appId,
      status: "active",
      config: app.config,
      activatedAt: this.getStatus(sessionId).activatedAt,
      triggerCount: this.getStatus(sessionId).triggerCount,
      lastResponseMs: latency,
    });

    this.emitGuidanceEvent(sessionId, testEvent);
    this.broadcastStatus(sessionId);

    // STUB: TTS synthesis (returns silence for now)
    // Real implementation would synthesize the text, wrap as FRAU codecType 3,
    // and post to /audio-in endpoint.
    try {
      await this.tts.synthesize(testEvent.content, { voice: app.config.voice });
    } catch {
      // TTS failure is non-critical for activation
    }
  }

  /** Deactivate current app for a session. */
  async deactivateApp(sessionId: string): Promise<void> {
    const current = this.getStatus(sessionId);
    this.setStatus(sessionId, {
      appId: null,
      status: "idle",
      config: undefined,
      activatedAt: undefined,
      triggerCount: current.triggerCount,
      lastResponseMs: undefined,
    });
    this.broadcastStatus(sessionId);

    if (current.appId) {
      this.emitGuidanceEvent(sessionId, {
        type: "guidance.acknowledgment",
        content: `App deactivated.`,
        confidence: 1.0,
        source: current.appId,
        trigger: "deactivate_app",
        timestampMs: Date.now(),
        metadata: { severity: "info" },
      });
    }
  }

  /** Get current AI status for a session. */
  getStatus(sessionId: string): AIStatus {
    return this.status.get(sessionId) ?? {
      appId: null,
      status: "idle",
      triggerCount: 0,
    };
  }

  /** Get telemetry for a session. */
  getTelemetry(sessionId: string): AITelemetry {
    return this.telemetry.get(sessionId) ?? {
      triggers: 0,
      guidanceEvents: 0,
      avgLatencyMs: 0,
      lastLatencyMs: null,
      queueDepth: 0,
      uptimeMs: this.startedAt > 0 ? Date.now() - this.startedAt : 0,
    };
  }

  /** Get event history for a session (last 100 events). */
  getEventHistory(sessionId: string): GuidanceEvent[] {
    return this.eventHistory.get(sessionId) ?? [];
  }

  /** Start the orchestrator — subscribe to ControlEventBus. */
  start(): void {
    this.startedAt = Date.now();
    this.unsubControlBus = this.controlBus.onEvent((event) => {
      // We need to know which session this event came from.
      // The ControlEventBus currently doesn't carry sessionId.
      // For gesture events, we handle this in server.ts by calling
      // activateApp directly with the known sessionId.
      // Here we handle only events that don't need session routing.
      console.log(`[orchestrator] Received control event: type=${event.type}`);
    });
    console.log("[orchestrator] Started");
  }

  /** Stop the orchestrator. */
  stop(): void {
    if (this.unsubControlBus) {
      this.unsubControlBus();
      this.unsubControlBus = null;
    }
    console.log("[orchestrator] Stopped");
  }

  // --- Private ---

  private setStatus(sessionId: string, s: AIStatus): void {
    this.status.set(sessionId, s);
  }

  private getOrCreateTelemetry(sessionId: string): AITelemetry {
    let t = this.telemetry.get(sessionId);
    if (!t) {
      t = {
        triggers: 0,
        guidanceEvents: 0,
        avgLatencyMs: 0,
        lastLatencyMs: null,
        queueDepth: 0,
        uptimeMs: this.startedAt > 0 ? Date.now() - this.startedAt : 0,
      };
      this.telemetry.set(sessionId, t);
    }
    return t;
  }

  private addLatency(sessionId: string, ms: number): void {
    let sum = this.latencySum.get(sessionId) ?? 0;
    let count = this.latencyCount.get(sessionId) ?? 0;
    sum += ms;
    count++;
    this.latencySum.set(sessionId, sum);
    this.latencyCount.set(sessionId, count);

    const t = this.getOrCreateTelemetry(sessionId);
    t.lastLatencyMs = ms;
    t.avgLatencyMs = Math.round(sum / count);
  }

  private emitGuidanceEvent(sessionId: string, event: GuidanceEvent): void {
    // Append to history (cap at MAX_EVENT_HISTORY)
    let history = this.eventHistory.get(sessionId);
    if (!history) {
      history = [];
      this.eventHistory.set(sessionId, history);
    }
    if (history.length >= MAX_EVENT_HISTORY) {
      history.shift();
    }
    history.push(event);

    // Update telemetry
    const t = this.getOrCreateTelemetry(sessionId);
    t.guidanceEvents++;

    // Broadcast to subscribers
    const subs = this.subscribers.get(sessionId);
    if (subs) {
      const msg = { type: "guidance_event", event };
      for (const cb of subs) {
        try { cb(msg); } catch { /* subscriber error, skip */ }
      }
    }
  }

  private broadcastStatus(sessionId: string): void {
    const subs = this.subscribers.get(sessionId);
    if (!subs) return;

    const msg = { type: "ai_status", status: this.getStatus(sessionId) };
    for (const cb of subs) {
      try { cb(msg); } catch { /* subscriber error, skip */ }
    }
  }

  private broadcastTelemetry(sessionId: string): void {
    const subs = this.subscribers.get(sessionId);
    if (!subs) return;

    const msg = { type: "ai_telemetry", telemetry: this.getTelemetry(sessionId) };
    for (const cb of subs) {
      try { cb(msg); } catch { /* subscriber error, skip */ }
    }
  }
}
