/**
 * GuidanceOrchestrator -- AI Guidance event routing and state management
 *
 * Core of PRD-008. Subscribes to ControlEventBus, resolves apps via
 * AppRegistry, manages per-session activation state, and broadcasts
 * GuidanceEvent objects to session viewers.
 *
 * Uses AIService provider (e.g., GeminiLiveService) for real AI inference.
 * When an app is activated, the orchestrator:
 * 1. Creates an AIService instance via the provider factory
 * 2. Connects to the AI provider with the app's system prompt + voice
 * 3. Forwards frames and audio from the relay session
 * 4. Receives spoken guidance audio + text from the AI
 * 5. Broadcasts GuidanceEvent to viewers and pushes audio to /audio-in
 */

import type { ControlEvent, AppConfig, AppPipeline } from "./app-types.js";
import type { ControlEventBus } from "./control-event-bus.js";
import type { AppRegistry } from "./app-registry.js";
import type { AIService, AIServiceCallbacks } from "./ai-service.js";
import { createAIService } from "./ai-service.js";
// Import to register the gemini provider
import "./gemini-live-service.js";

// --- Types ---

export type GuidanceEventType =
  | "guidance.step"
  | "guidance.alert"
  | "guidance.correction"
  | "guidance.identification"
  | "guidance.acknowledgment"
  | "guidance.transcript";

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

/** Callback for pushing audio back to the relay's /audio-in path */
export type AudioPushFn = (sessionId: string, pcm: Uint8Array) => void;

// --- Constants ---

const MAX_EVENT_HISTORY = 100;

// --- Per-session AI state ---

interface SessionAIState {
  service: AIService;
  appId: string;
  lastAudioAt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

// --- Orchestrator ---

export class GuidanceOrchestrator {
  private controlBus: ControlEventBus;
  private appRegistry: AppRegistry;

  private status = new Map<string, AIStatus>();
  private telemetry = new Map<string, AITelemetry>();
  private eventHistory = new Map<string, GuidanceEvent[]>();
  private subscribers = new Map<string, Set<(msg: any) => void>>();
  private aiState = new Map<string, SessionAIState>();

  /** Callback to push AI audio response to relay's audio-in path */
  private audioPushFn: AudioPushFn | null = null;

  private startedAt: number = 0;
  private unsubControlBus: (() => void) | null = null;

  // Latency tracking for telemetry averages
  private latencySum = new Map<string, number>();
  private latencyCount = new Map<string, number>();

  constructor(controlBus: ControlEventBus, appRegistry: AppRegistry) {
    this.controlBus = controlBus;
    this.appRegistry = appRegistry;
  }

  /** Set the callback for pushing AI audio back to the relay session */
  setAudioPushFn(fn: AudioPushFn): void {
    this.audioPushFn = fn;
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
    // Disconnect existing AI service for this session if any
    this.disconnectAI(sessionId);

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

    // Resolve the AI provider from the primitive binding
    // Default to gemini-live if no explicit provider hint
    const provider = this.resolveProvider(pipeline.primitiveId);
    const service = createAIService(provider);

    if (!service) {
      console.error(`[orchestrator] No AI provider "${provider}" registered`);
      this.setStatus(sessionId, {
        appId,
        status: "error",
        config: app.config,
        activatedAt: this.getStatus(sessionId).activatedAt,
        triggerCount: this.getStatus(sessionId).triggerCount,
        lastResponseMs: undefined,
      });
      this.broadcastStatus(sessionId);
      return;
    }

    const state: SessionAIState = {
      service,
      appId,
      lastAudioAt: 0,
      reconnectTimer: null,
    };
    this.aiState.set(sessionId, state);

    // Wire AI service callbacks
    const callbacks: AIServiceCallbacks = {
      onAudio: (pcm) => {
        this.handleAIAudio(sessionId, pcm);
      },
      onText: (text) => {
        this.handleAIText(sessionId, appId, text);
      },
      onToolCall: (toolCall) => {
        this.handleToolCall(sessionId, appId, toolCall);
      },
      onStatusChange: (aiStatus) => {
        this.handleAIStatusChange(sessionId, appId, aiStatus);
      },
      onUsage: (usage) => {
        // Could track token usage per session in telemetry
        console.log(`[orchestrator] Token usage: prompt=${usage.promptTokens} response=${usage.responseTokens} session=${sessionId}`);
      },
      onError: (error) => {
        console.error(`[orchestrator] AI error: ${error.message} session=${sessionId}`);
        this.emitGuidanceEvent(sessionId, {
          type: "guidance.alert",
          content: `AI error: ${error.message}`,
          confidence: 1.0,
          source: appId,
          trigger: "ai_error",
          timestampMs: Date.now(),
          metadata: { severity: "warning" },
        });
      },
    };

    try {
      await service.connect(
        {
          model: app.config.model ?? "gemini-2.5-flash-native-audio-latest",
          systemPrompt: app.systemPrompt,
          voice: app.config.voice,
          visionFps: app.config.visionFps,
          extra: app.config,
        },
        callbacks,
      );

      // Successfully connected
      this.setStatus(sessionId, {
        appId,
        status: "active",
        config: app.config,
        activatedAt: this.getStatus(sessionId).activatedAt,
        triggerCount: this.getStatus(sessionId).triggerCount,
        lastResponseMs: Date.now() - (this.getStatus(sessionId).activatedAt ?? Date.now()),
      });
      this.addLatency(sessionId, this.getStatus(sessionId).lastResponseMs ?? 0);

      this.emitGuidanceEvent(sessionId, {
        type: "guidance.acknowledgment",
        content: `App "${app.name}" activated. AI guidance is live.`,
        confidence: 1.0,
        source: appId,
        trigger: "activate_app",
        timestampMs: Date.now(),
        metadata: { severity: "info" },
      });
      this.broadcastStatus(sessionId);

      console.log(`[orchestrator] App activated: ${appId} provider=${provider} model=${app.config.model} session=${sessionId}`);
    } catch (err) {
      console.error(`[orchestrator] AI connect failed:`, err);
      this.aiState.delete(sessionId);
      this.setStatus(sessionId, {
        appId,
        status: "error",
        config: app.config,
        activatedAt: this.getStatus(sessionId).activatedAt,
        triggerCount: this.getStatus(sessionId).triggerCount,
        lastResponseMs: undefined,
      });
      this.broadcastStatus(sessionId);

      this.emitGuidanceEvent(sessionId, {
        type: "guidance.alert",
        content: `Failed to activate AI: ${err instanceof Error ? err.message : String(err)}`,
        confidence: 1.0,
        source: appId,
        trigger: "activate_app_error",
        timestampMs: Date.now(),
        metadata: { severity: "critical" },
      });
    }
  }

  /** Deactivate current app for a session. */
  async deactivateApp(sessionId: string): Promise<void> {
    const current = this.getStatus(sessionId);
    this.disconnectAI(sessionId);
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

  // --- Frame / audio forwarding ---

  /** Forward a JPEG frame from the relay to the active AI service for this session */
  sendVideoFrame(sessionId: string, jpeg: Uint8Array): void {
    const state = this.aiState.get(sessionId);
    if (!state || state.service.status !== "connected") return;
    state.service.sendVideoFrame(jpeg);
  }

  /** Forward PCM audio from the relay to the active AI service for this session */
  sendAudio(sessionId: string, pcm: Uint8Array): void {
    const state = this.aiState.get(sessionId);
    if (!state || state.service.status !== "connected") return;
    state.service.sendAudio(pcm);
  }

  /** Send a text trigger (e.g., gesture description) to the active AI service */
  sendTrigger(sessionId: string, text: string): void {
    const state = this.aiState.get(sessionId);
    if (!state || state.service.status !== "connected") return;
    state.service.sendText(text);
  }

  /** Update vision FPS for the active AI service at runtime */
  setVisionFps(sessionId: string, fps: number): void {
    const state = this.aiState.get(sessionId);
    if (!state) return;
    state.service.setVisionFps?.(fps);
  }

  // --- Status / telemetry ---

  getStatus(sessionId: string): AIStatus {
    return this.status.get(sessionId) ?? {
      appId: null,
      status: "idle",
      triggerCount: 0,
    };
  }

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

  getEventHistory(sessionId: string): GuidanceEvent[] {
    return this.eventHistory.get(sessionId) ?? [];
  }

  // --- Lifecycle ---

  start(): void {
    this.startedAt = Date.now();
    this.unsubControlBus = this.controlBus.onEvent((event) => {
      console.log(`[orchestrator] Received control event: type=${event.type}`);
    });
    console.log("[orchestrator] Started");
  }

  stop(): void {
    if (this.unsubControlBus) {
      this.unsubControlBus();
      this.unsubControlBus = null;
    }
    // Disconnect all AI services
    for (const [sessionId] of this.aiState) {
      this.disconnectAI(sessionId);
    }
    console.log("[orchestrator] Stopped");
  }

  // --- Private ---

  private resolveProvider(primitiveId: string): string {
    // Map primitive IDs to AI provider names
    if (primitiveId.includes("gemini")) return "gemini-live";
    if (primitiveId.includes("openai")) return "openai";
    // Default to gemini-live
    return "gemini-live";
  }

  private disconnectAI(sessionId: string): void {
    const state = this.aiState.get(sessionId);
    if (state) {
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      try {
        state.service.disconnect();
      } catch {}
      this.aiState.delete(sessionId);
    }
  }

  private handleAIAudio(sessionId: string, pcm: Uint8Array): void {
    const state = this.aiState.get(sessionId);
    if (!state) return;

    state.lastAudioAt = Date.now();
    const t = this.getOrCreateTelemetry(sessionId);
    t.triggers++;

    // Push audio to relay's audio-in path (which fans out to publisher + viewers)
    if (this.audioPushFn && pcm.length > 0) {
      this.audioPushFn(sessionId, pcm);
    }

    this.broadcastTelemetry(sessionId);
  }

  private handleAIText(sessionId: string, appId: string, text: string): void {
    // Text parts are the AI's thinking/transcript — emit as plain transcript
    this.emitGuidanceEvent(sessionId, {
      type: "guidance.transcript",
      content: text,
      confidence: 1.0,
      source: appId,
      trigger: "ai_thinking",
      timestampMs: Date.now(),
    });

    const t = this.getOrCreateTelemetry(sessionId);
    t.triggers++;
    this.broadcastTelemetry(sessionId);
  }

  private handleToolCall(sessionId: string, appId: string, toolCall: { name: string; args: Record<string, unknown> }): void {
    if (toolCall.name === "emit_guidance_event") {
      const eventType = `guidance.${toolCall.args.eventType ?? "step"}` as GuidanceEventType;
      this.emitGuidanceEvent(sessionId, {
        type: eventType,
        content: (toolCall.args.content as string) ?? "",
        confidence: (toolCall.args.confidence as number) ?? 0.9,
        source: appId,
        trigger: "ai_tool_call",
        timestampMs: Date.now(),
        metadata: {
          severity: (toolCall.args.severity as "info" | "warning" | "critical") ?? "info",
        },
      });

      const t = this.getOrCreateTelemetry(sessionId);
      t.guidanceEvents++;
      this.broadcastTelemetry(sessionId);
    }
  }

  private handleAIStatusChange(sessionId: string, appId: string, aiStatus: string): void {
    const current = this.getStatus(sessionId);
    if (current.appId !== appId) return; // stale

    if (aiStatus === "error") {
      this.setStatus(sessionId, {
        ...current,
        status: "error",
      });
      // Auto-reconnect on error (e.g. Gemini session deadline)
      this.scheduleReconnect(sessionId, appId);
    } else if (aiStatus === "disconnected" && current.status === "active") {
      // Auto-reconnect — Gemini Live sessions expire after ~60s, this is normal
      console.log(`[orchestrator] AI disconnected (session expiry), auto-reconnecting session=${sessionId}`);
      this.scheduleReconnect(sessionId, appId);
    }
    this.broadcastStatus(sessionId);
  }

  private scheduleReconnect(sessionId: string, appId: string): void {
    const state = this.aiState.get(sessionId);
    if (!state) return;

    // Clear any existing timer
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);

    console.log(`[orchestrator] Reconnecting in 1s session=${sessionId} app=${appId}`);
    state.reconnectTimer = setTimeout(() => {
      // Only reconnect if still the active app
      const current = this.getStatus(sessionId);
      if (current.appId === appId) {
        console.log(`[orchestrator] Auto-reconnecting session=${sessionId}`);
        this.activateApp(sessionId, appId).catch((err) => {
          console.error(`[orchestrator] Auto-reconnect failed: ${err}`);
          // Retry again
          this.scheduleReconnect(sessionId, appId);
        });
      }
    }, 1000);
  }

  /** Simple heuristic to classify AI text responses into guidance event types */
  private classifyText(text: string): GuidanceEventType {
    const lower = text.toLowerCase();
    if (lower.includes("warning") || lower.includes("danger") || lower.includes("stop") || lower.includes("hazard")) {
      return "guidance.alert";
    }
    if (lower.includes("correction") || lower.includes("wrong") || lower.includes("instead") || lower.includes("not quite")) {
      return "guidance.correction";
    }
    if (lower.includes("step") || lower.includes("next") || lower.includes("then") || lower.includes("now")) {
      return "guidance.step";
    }
    if (lower.includes("this is") || lower.includes("that is") || lower.includes("i see") || lower.includes("recognized")) {
      return "guidance.identification";
    }
    return "guidance.step";
  }

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
    let history = this.eventHistory.get(sessionId);
    if (!history) {
      history = [];
      this.eventHistory.set(sessionId, history);
    }
    if (history.length >= MAX_EVENT_HISTORY) {
      history.shift();
    }
    history.push(event);

    const t = this.getOrCreateTelemetry(sessionId);
    t.guidanceEvents++;

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
