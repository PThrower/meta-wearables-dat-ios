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

import type { ControlEvent, AppConfig, AppPipeline, AppDefinition, InputConfig, OutputConfig, NodeExecutionState, NodeExecutionInfo, WorkflowInstanceState, WorkflowControlAction, WorkflowNodeType, NodeStatesMessage, FlowExecutionConfig } from "./app-types.js";
import type { ControlEventBus } from "./control-event-bus.js";
import type { AppRegistry } from "./app-registry.js";
import type { AIService, AIServiceCallbacks, AIServiceStatusContext } from "./ai-service.js";
import { createAIService } from "./ai-service.js";
import { dbWriter } from "./db/db-writer.js";
import * as q from "./db/queries.js";
// Import to register the AI providers
import "./gemini-live-service.js";
import "./gemma4-service.js";
import "./deepgram-stt-service.js";

// --- Types ---

export type GuidanceEventType =
  | "guidance.step"
  | "guidance.alert"
  | "guidance.correction"
  | "guidance.identification"
  | "guidance.acknowledgment"
  | "guidance.transcript"
  | "guidance.transcription"
  | "guidance.bbox"
  | "guidance.jepa.embedding"
  | "guidance.jepa.prediction"
  | "guidance.jepa.anomaly";

export interface BoundingBox {
  y1: number;
  x1: number;
  y2: number;
  x2: number;
  label: string;
  confidence: number;
}

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
  boundingBoxes?: BoundingBox[];
}

export interface AIStatus {
  appId: string | null;
  status: "idle" | "activating" | "active" | "error" | "rate_limited";
  config?: AppConfig;
  activatedAt?: number;
  triggerCount: number;
  lastResponseMs?: number;
  /** Seconds until next rate-limit retry attempt */
  retryInSec?: number;
  /** Current retry attempt number (1-based) */
  retryAttempt?: number;
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
export type AudioPushFn = (sessionId: string, pcm: Uint8Array, preferGlasses: boolean) => void;

/** Callback for pushing guidance text to the publisher for client-side TTS */
export type GuidanceTextPushFn = (sessionId: string, text: string, preferGlasses: boolean) => void;

/** Callback for recording bbox annotations to session JSONL */
export type BboxAnnotationFn = (sessionId: string, annotation: import("./session-recorder.js").BboxAnnotation) => void;

/** Callback for pushing full guidance events to publisher WebSocket */
export type GuidanceEventPushFn = (sessionId: string, event: GuidanceEvent) => void;

/** Callback for persisting guidance events to R2 JSONL */
export type GuidancePersistFn = (sessionId: string, event: GuidanceEvent) => void;

// --- Constants ---

const MAX_EVENT_HISTORY = 100;

// --- Per-session AI state ---

/** Result of an activation attempt — includes conflict info if blocked */
export interface ActivationAttemptResult {
  success: boolean;
  conflict?: {
    appId: string;
    status: string;
    activatedAt: number | undefined;
  };
  error?: string;
}

interface SessionAIState {
  service: AIService;
  appId: string;
  input: InputConfig;
  output: OutputConfig;
  lastAudioAt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  consecutiveReconnects: number;
  /** If set, this app's activation is deferred until the upstream app produces its first output */
  dependsOn?: string;
  /** Whether this app has emitted its first output (used to unblock dependents) */
  hasProducedOutput: boolean;
}

// --- Orchestrator ---

export class GuidanceOrchestrator {
  private controlBus: ControlEventBus;
  private appRegistry: AppRegistry;

  private status = new Map<string, AIStatus>();
  private telemetry = new Map<string, AITelemetry>();
  private eventHistory = new Map<string, GuidanceEvent[]>();
  private subscribers = new Map<string, Set<(msg: any) => void>>();
  private aiState = new Map<string, Map<string, SessionAIState>>();  // sessionId -> appId -> state
  /** Pending activations waiting for upstream processor to produce first output */
  private pendingActivations = new Map<string, Map<string, AppDefinition>>(); // sessionId -> upstreamAppId -> deferred app
  private workflowInstances = new Map<string, WorkflowInstanceState>(); // "sessionId:workflowId" -> state

  /** Pending flows for sequential execution: sessionId -> flow schedule */
  private pendingFlows = new Map<string, {
    flows: Array<{ flowId: string; apps: AppDefinition[] }>;
    config: FlowExecutionConfig;
    currentFlowIndex: number;
    sessionId: string;
    workflowId: string;
  }>();

  /** Callback to push AI audio response to relay's audio-in path */
  private audioPushFn: AudioPushFn | null = null;

  /** Callback to push guidance text to publisher for client-side TTS */
  private guidanceTextPushFn: GuidanceTextPushFn | null = null;

  /** Callback to record bbox annotations to session JSONL */
  private bboxAnnotationFn: BboxAnnotationFn | null = null;

  /** Callback to push full guidance events (with bounding boxes) to publisher WebSocket */
  private guidanceEventPushFn: GuidanceEventPushFn | null = null;

  /** Callback to persist guidance events to R2 JSONL sidecar */
  private guidancePersistFn: GuidancePersistFn | null = null;

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

  /** Set the callback for pushing guidance text to the publisher (client-side TTS) */
  setGuidanceTextPushFn(fn: GuidanceTextPushFn): void {
    this.guidanceTextPushFn = fn;
  }

  /** Set the callback for recording bbox annotations to session JSONL */
  setBboxAnnotationFn(fn: BboxAnnotationFn): void {
    this.bboxAnnotationFn = fn;
  }

  /** Set the callback for pushing full guidance events to publisher WebSocket */
  setGuidanceEventPushFn(fn: GuidanceEventPushFn): void {
    this.guidanceEventPushFn = fn;
  }

  /** Set the callback for persisting guidance events to R2 JSONL */
  setGuidancePersistFn(fn: GuidancePersistFn): void {
    this.guidancePersistFn = fn;
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
    await this.activateWithConfig(sessionId, app);
  }

  /** Check if a session has an active AI that would conflict with a new activation. */
  checkConflict(sessionId: string): { hasConflict: boolean; appId: string | null; status: string; activatedAt: number | undefined } {
    const current = this.getStatus(sessionId);
    return {
      hasConflict: current.status === "active" || current.status === "activating" || current.status === "rate_limited",
      appId: current.appId,
      status: current.status,
      activatedAt: current.activatedAt,
    };
  }

  /** Force-deactivate any running AI for a session (used during override flow). */
  forceDeactivate(sessionId: string): void {
    this.disconnectAI(sessionId);
  }

  /** Activate with a pre-resolved AppDefinition (used by workflow activation). Supports multi-app. */
  async activateWithConfig(sessionId: string, app: AppDefinition): Promise<void> {
    const appId = app.id;

    // Disconnect only this specific app if it's already running (re-activation)
    this.disconnectApp(sessionId, appId);

    const pipeline = this.appRegistry.resolvePipeline(appId);

    // Use primary app for the session-level status display
    const currentStatus = this.getStatus(sessionId);
    if (currentStatus.status === "idle" || currentStatus.status === "error") {
      this.setStatus(sessionId, {
        appId,
        status: "activating",
        config: app.config,
        activatedAt: Date.now(),
        triggerCount: currentStatus.triggerCount,
        lastResponseMs: undefined,
      });
      this.broadcastStatus(sessionId);
    }

    // Resolve the AI provider from the primitive binding
    // Default to gemini-live if no explicit provider hint
    const provider = this.resolveProvider(pipeline?.primitiveId ?? app.binding);
    const service = createAIService(provider);

    if (!service) {
      console.error(`[orchestrator] No AI provider "${provider}" registered`);
      this.setStatus(sessionId, {
        appId: currentStatus.appId,
        status: "error",
        config: app.config,
        activatedAt: currentStatus.activatedAt,
        triggerCount: currentStatus.triggerCount,
        lastResponseMs: undefined,
      });
      this.broadcastStatus(sessionId);
      return;
    }

    // STT services produce text (not audio) — default speaker=false to prevent
    // transcription text from being pushed back to the publisher for TTS playback,
    // which would create a feedback loop (mic picks up TTS → Deepgram → TTS → …).
    const isSTT = provider === "deepgram";
    const defaultSpeaker = isSTT ? false : true;
    const output: OutputConfig = (app.config.output as OutputConfig) ?? { viewers: true, overlays: true, speaker: defaultSpeaker, recording: true };
    const input: InputConfig = (app.config.input as InputConfig) ?? { video: true, phoneMic: true, glassesMic: true, gestures: true, visionFps: app.config.visionFps ?? 1 };
    const dependsOn = app.config.dependsOn as string | undefined;
    console.log(`[orchestrator] activateWithConfig appId=${appId} speakerTarget=${output.speakerTarget} speaker=${output.speaker} dependsOn=${dependsOn ?? "none"}`);
    const state: SessionAIState = {
      service,
      appId,
      input,
      output,
      lastAudioAt: 0,
      reconnectTimer: null,
      consecutiveReconnects: 0,
      dependsOn,
      hasProducedOutput: false,
    };

    // Store in multi-map: sessionId -> appId -> state
    let sessionApps = this.aiState.get(sessionId);
    if (!sessionApps) {
      sessionApps = new Map();
      this.aiState.set(sessionId, sessionApps);
    }
    sessionApps.set(appId, state);

    // Check if this app should be deferred until its upstream processor produces output
    if (dependsOn) {
      const upstreamState = sessionApps.get(dependsOn);
      if (upstreamState && !upstreamState.hasProducedOutput) {
        // Upstream hasn't produced output yet -- defer activation
        console.log(`[orchestrator] Deferring ${appId} until upstream ${dependsOn} produces output`);
        this.updateNodeState(sessionId, appId, "waiting");
        let pending = this.pendingActivations.get(sessionId);
        if (!pending) {
          pending = new Map();
          this.pendingActivations.set(sessionId, pending);
        }
        pending.set(dependsOn, app);
        return;
      }
      // Upstream already produced output -- activate immediately
      console.log(`[orchestrator] Upstream ${dependsOn} already active, activating ${appId} immediately`);
    }

    // Wire AI service callbacks
    const callbacks: AIServiceCallbacks = {
      onAudio: (pcm) => {
        this.handleAIAudio(sessionId, appId, pcm);
      },
      onText: (text) => {
        this.handleAIText(sessionId, appId, text);
      },
      onToolCall: (toolCall) => {
        this.handleToolCall(sessionId, appId, toolCall);
      },
      onStatusChange: (aiStatus, context) => {
        this.handleAIStatusChange(sessionId, appId, aiStatus, context);
      },
      onUsage: (usage) => {
        console.log(`[orchestrator] Token usage: prompt=${usage.promptTokens} response=${usage.responseTokens} session=${sessionId} app=${appId}`);
      },
      onError: (error) => {
        console.error(`[orchestrator] AI error: ${error.message} session=${sessionId} app=${appId}`);
        this.emitGuidanceEvent(sessionId, {
          type: "guidance.alert",
          content: `AI error (${app.name}): ${error.message}`,
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
        appId: currentStatus.appId ?? appId,
        status: "active",
        config: currentStatus.config ?? app.config,
        activatedAt: currentStatus.activatedAt ?? Date.now(),
        triggerCount: currentStatus.triggerCount,
        lastResponseMs: Date.now() - (currentStatus.activatedAt ?? Date.now()),
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
      state.consecutiveReconnects = 0;
      // Update workflow node state if this app is part of an active workflow
      this.updateNodeState(sessionId, appId, "running");
    } catch (err) {
      console.error(`[orchestrator] AI connect failed:`, err);
      sessionApps.delete(appId);
      if (sessionApps.size === 0) this.aiState.delete(sessionId);
      this.setStatus(sessionId, {
        appId: currentStatus.appId ?? appId,
        status: "error",
        config: app.config,
        activatedAt: currentStatus.activatedAt,
        triggerCount: currentStatus.triggerCount,
        lastResponseMs: undefined,
      });
      this.broadcastStatus(sessionId);

      this.emitGuidanceEvent(sessionId, {
        type: "guidance.alert",
        content: `Failed to activate AI (${app.name}): ${err instanceof Error ? err.message : String(err)}`,
        confidence: 1.0,
        source: appId,
        trigger: "activate_app_error",
        timestampMs: Date.now(),
        metadata: { severity: "critical" },
      });
      // Update workflow node state to errored
      this.updateNodeState(sessionId, appId, "errored", err instanceof Error ? err.message : String(err));
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

  // --- Workflow Execution Controls ---

  private workflowInstanceKey(sessionId: string, workflowId: string): string {
    return `${sessionId}:${workflowId}`;
  }

  /** Register a workflow instance when it's activated. Called from server.ts after resolveWorkflowToPipeline. */
  activateWorkflow(
    sessionId: string,
    workflowId: string,
    workflowName: string,
    nodeEntries: Array<{ nodeId: string; appId: string; nodeType: WorkflowNodeType; label: string; triggerChained?: boolean }>,
  ): void {
    const key = this.workflowInstanceKey(sessionId, workflowId);
    const nodes = new Map<string, NodeExecutionInfo>();
    for (const n of nodeEntries) {
      nodes.set(n.nodeId, {
        nodeId: n.nodeId,
        appId: n.appId,
        nodeType: n.nodeType,
        label: n.label,
        state: n.triggerChained ? "waiting" : "pending",
        startedAt: null,
        completedAt: null,
      });
    }
    this.workflowInstances.set(key, {
      workflowId,
      workflowName,
      sessionId,
      nodes,
      activatedAt: Date.now(),
    });
    this.broadcastNodeStates(sessionId, workflowId);
    console.log(`[orchestrator] Workflow instance created: ${key} (${nodes.size} nodes)`);
  }

  /**
   * Register pending flows for sequential execution.
   * Called from server.ts after resolveWorkflowToPipeline when mode is "sequential".
   * The first flow is already activated; remaining flows are queued here.
   */
  registerPendingFlows(
    sessionId: string,
    workflowId: string,
    flows: Array<{ flowId: string; apps: AppDefinition[] }>,
    config: FlowExecutionConfig,
  ): void {
    if (flows.length <= 1) return;
    this.pendingFlows.set(sessionId, {
      flows,
      config,
      currentFlowIndex: 0,
      sessionId,
      workflowId,
    });
    console.log(`[orchestrator] Sequential flows registered: session=${sessionId} flows=${flows.length} order=${config.flowOrder.join(",")}`);
  }

  /**
   * Activate the next pending flow when sequential mode is active.
   * Called from updateNodeState when all apps in the current flow reach terminal state.
   * Returns true if a new flow was activated, false if no more flows.
   */
  async activateNextFlow(sessionId: string): Promise<boolean> {
    const pending = this.pendingFlows.get(sessionId);
    if (!pending) return false;

    const nextIndex = pending.currentFlowIndex + 1;
    if (nextIndex >= pending.flows.length) {
      this.pendingFlows.delete(sessionId);
      console.log(`[orchestrator] All sequential flows completed: session=${sessionId}`);
      return false;
    }

    const nextFlow = pending.flows[nextIndex];
    pending.currentFlowIndex = nextIndex;

    console.log(`[orchestrator] Activating next sequential flow: session=${sessionId} flowId=${nextFlow.flowId} index=${nextIndex}`);

    for (const app of nextFlow.apps) {
      this.appRegistry.registerTransientApp(app);
      const pDef = (app.config as any);
      if (pDef?.jepa) {
        // JEPA apps handled by JEPAOrchestrator externally — skip here
      } else {
        await this.activateWithConfig(sessionId, app);
      }
    }

    this.broadcastNodeStates(sessionId, pending.workflowId);
    return true;
  }

  /** Check if a session has pending sequential flows */
  hasPendingFlows(sessionId: string): boolean {
    return this.pendingFlows.has(sessionId);
  }

  /** Clean up pending flows for a session */
  clearPendingFlows(sessionId: string): void {
    this.pendingFlows.delete(sessionId);
  }

  /** Update a node's execution state. Called from activateWithConfig on success/error. */
  updateNodeState(sessionId: string, appId: string, state: NodeExecutionState, error?: string): void {
    for (const [, instance] of this.workflowInstances) {
      if (instance.sessionId !== sessionId) continue;
      for (const [, node] of instance.nodes) {
        if (node.appId !== appId) continue;
        const prevState = node.state;
        node.state = state;
        if (state === "running" && node.startedAt === null) node.startedAt = Date.now();
        if (state === "completed" || state === "skipped" || state === "errored") node.completedAt = Date.now();
        if (error) node.error = error;
        if (prevState !== state) {
          this.logNodeExecution(sessionId, instance.workflowId, node, state, error);
          this.broadcastNodeStates(sessionId, instance.workflowId);
        }

        // Check if sequential flow should advance after a terminal state
        if ((state === "completed" || state === "skipped" || state === "errored") && this.hasPendingFlows(sessionId)) {
          this.checkSequentialFlowCompletion(sessionId, instance);
        }

        return;
      }
    }
  }

  /** Check if all apps in the current sequential flow have reached terminal state */
  private async checkSequentialFlowCompletion(sessionId: string, instance: WorkflowInstanceState): Promise<void> {
    const pending = this.pendingFlows.get(sessionId);
    if (!pending) return;

    const currentFlow = pending.flows[pending.currentFlowIndex];
    if (!currentFlow) return;

    // Check if all apps in the current flow are terminal
    const flowAppIds = new Set(currentFlow.apps.map(a => a.id));
    const terminalStates: NodeExecutionState[] = ["completed", "skipped", "errored"];

    let allTerminal = true;
    for (const [nodeId, node] of instance.nodes) {
      if (flowAppIds.has(node.appId) && !terminalStates.includes(node.state)) {
        allTerminal = false;
        break;
      }
    }

    if (allTerminal) {
      console.log(`[orchestrator] Flow ${currentFlow.flowId} completed (all terminal), activating next flow`);
      await this.activateNextFlow(sessionId);
    }
  }

  /** Handle a workflow control action from viewer or publisher. */
  async handleWorkflowControl(sessionId: string, action: WorkflowControlAction, workflowId: string, nodeId?: string, triggeredBy?: string): Promise<void> {
    const key = this.workflowInstanceKey(sessionId, workflowId);
    const instance = this.workflowInstances.get(key);
    if (!instance) {
      console.warn(`[orchestrator] workflow_control: no instance for ${key}`);
      return;
    }

    console.log(`[orchestrator] workflow_control: action=${action} workflow=${workflowId} node=${nodeId ?? "all"} session=${sessionId}`);

    switch (action) {
      case "pause_workflow":
        this.pauseWorkflow(instance, triggeredBy);
        break;
      case "resume_workflow":
        await this.resumeWorkflow(instance, triggeredBy);
        break;
      case "stop_workflow":
        this.stopWorkflow(instance, triggeredBy);
        break;
      case "skip_node":
        if (nodeId) this.skipNode(instance, nodeId, triggeredBy);
        break;
      case "redo_node":
        if (nodeId) await this.redoNode(instance, nodeId, triggeredBy);
        break;
      case "continue_node":
        if (nodeId) await this.continueNode(instance, nodeId, triggeredBy);
        break;
    }
  }

  private pauseWorkflow(instance: WorkflowInstanceState, triggeredBy?: string): void {
    for (const [nodeId, node] of instance.nodes) {
      if (node.state === "running") {
        node.state = "paused";
        this.disconnectApp(instance.sessionId, node.appId);
        this.logNodeExecution(instance.sessionId, instance.workflowId, node, "paused", undefined, triggeredBy);
      }
    }
    this.broadcastNodeStates(instance.sessionId, instance.workflowId);
  }

  private async resumeWorkflow(instance: WorkflowInstanceState, triggeredBy?: string): Promise<void> {
    for (const [nodeId, node] of instance.nodes) {
      if (node.state === "paused") {
        node.state = "running";
        const app = this.appRegistry.getApp(node.appId);
        if (app) {
          await this.activateWithConfig(instance.sessionId, app);
        }
        this.logNodeExecution(instance.sessionId, instance.workflowId, node, "running", undefined, triggeredBy);
      }
    }
    this.broadcastNodeStates(instance.sessionId, instance.workflowId);
  }

  private stopWorkflow(instance: WorkflowInstanceState, triggeredBy?: string): void {
    for (const [nodeId, node] of instance.nodes) {
      if (node.state === "running" || node.state === "paused" || node.state === "waiting") {
        node.state = "completed";
        node.completedAt = Date.now();
        this.disconnectApp(instance.sessionId, node.appId);
        this.logNodeExecution(instance.sessionId, instance.workflowId, node, "completed", undefined, triggeredBy);
      }
    }
    this.disconnectAI(instance.sessionId);
    const key = this.workflowInstanceKey(instance.sessionId, instance.workflowId);
    this.workflowInstances.delete(key);
    this.broadcastNodeStates(instance.sessionId, instance.workflowId);
  }

  private skipNode(instance: WorkflowInstanceState, nodeId: string, triggeredBy?: string): void {
    const node = instance.nodes.get(nodeId);
    if (!node || (node.state !== "running" && node.state !== "waiting" && node.state !== "paused")) return;
    node.state = "skipped";
    node.completedAt = Date.now();
    this.disconnectApp(instance.sessionId, node.appId);
    this.logNodeExecution(instance.sessionId, instance.workflowId, node, "skipped", undefined, triggeredBy);
    this.broadcastNodeStates(instance.sessionId, instance.workflowId);
  }

  private async redoNode(instance: WorkflowInstanceState, nodeId: string, triggeredBy?: string): Promise<void> {
    const node = instance.nodes.get(nodeId);
    if (!node || (node.state !== "skipped" && node.state !== "errored" && node.state !== "completed")) return;
    // Disconnect then reconnect with same config
    this.disconnectApp(instance.sessionId, node.appId);
    node.state = "running";
    node.startedAt = Date.now();
    node.completedAt = null;
    node.error = undefined;
    const app = this.appRegistry.getApp(node.appId);
    if (app) {
      await this.activateWithConfig(instance.sessionId, app);
    }
    this.logNodeExecution(instance.sessionId, instance.workflowId, node, "running", undefined, triggeredBy);
    this.broadcastNodeStates(instance.sessionId, instance.workflowId);
  }

  private async continueNode(instance: WorkflowInstanceState, nodeId: string, triggeredBy?: string): Promise<void> {
    const node = instance.nodes.get(nodeId);
    if (!node || node.state !== "waiting") return;
    node.state = "running";
    node.startedAt = Date.now();
    const app = this.appRegistry.getApp(node.appId);
    if (app) {
      await this.activateWithConfig(instance.sessionId, app);
    }
    this.logNodeExecution(instance.sessionId, instance.workflowId, node, "running", undefined, triggeredBy);
    this.broadcastNodeStates(instance.sessionId, instance.workflowId);
  }

  /** Broadcast current node states to all viewer subscribers for a session. */
  broadcastNodeStates(sessionId: string, workflowId: string): void {
    const key = this.workflowInstanceKey(sessionId, workflowId);
    const instance = this.workflowInstances.get(key);
    const subs = this.subscribers.get(sessionId);
    if (!subs || !instance) return;

    const msg: NodeStatesMessage = {
      type: "node_states",
      workflowId,
      nodes: [...instance.nodes.values()].map(n => ({
        nodeId: n.nodeId,
        appId: n.appId,
        nodeType: n.nodeType,
        label: n.label,
        state: n.state,
        startedAt: n.startedAt,
        completedAt: n.completedAt,
        error: n.error,
      })),
    };
    for (const cb of subs) {
      try { cb(msg); } catch { /* skip */ }
    }
  }

  /** Get the active workflow instance for a session (if any). */
  getActiveWorkflow(sessionId: string): WorkflowInstanceState | null {
    for (const [, instance] of this.workflowInstances) {
      if (instance.sessionId === sessionId) return instance;
    }
    return null;
  }

  /** Log a node state transition to the DB audit trail. */
  private logNodeExecution(sessionId: string, workflowId: string, node: NodeExecutionInfo, state: string, error?: string, triggeredBy?: string): void {
    const id = `nel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    dbWriter.enqueue(q.insertNodeExecutionLog({
      id,
      sessionId,
      workflowId,
      nodeId: node.nodeId,
      appId: node.appId,
      nodeType: node.nodeType,
      state,
      action: state, // The action IS the new state
      error,
      triggeredBy,
    }));
  }

  // --- End Workflow Execution Controls ---

  /** Forward a JPEG frame from the relay to all active AI services for this session */
  sendVideoFrame(sessionId: string, jpeg: Uint8Array): void {
    const sessionApps = this.aiState.get(sessionId);
    if (!sessionApps) return;
    for (const state of sessionApps.values()) {
      if (state.service.status !== "connected") continue;
      if (!state.input.video) continue;
      state.service.sendVideoFrame(jpeg);
    }
  }

  /** Forward PCM audio from the relay to all active AI services for this session */
  sendAudio(sessionId: string, pcm: Uint8Array, codecType?: number): void {
    const sessionApps = this.aiState.get(sessionId);
    if (!sessionApps) return;
    for (const state of sessionApps.values()) {
      if (state.service.status !== "connected") continue;
      if (codecType === 0 && !state.input.phoneMic) continue;
      if (codecType === 1 && !state.input.glassesMic) continue;
      state.service.sendAudio(pcm);
    }
  }

  /** Send a text trigger (e.g., gesture description) to all active AI services */
  sendTrigger(sessionId: string, text: string): void {
    const sessionApps = this.aiState.get(sessionId);
    if (!sessionApps) return;
    for (const state of sessionApps.values()) {
      if (state.service.status !== "connected") continue;
      if (text.startsWith("[Gesture detected:") && !state.input.gestures) continue;
      state.service.sendText(text);
    }
  }

  /** Update vision FPS for all active AI services at runtime */
  setVisionFps(sessionId: string, fps: number): void {
    const sessionApps = this.aiState.get(sessionId);
    if (!sessionApps) return;
    for (const state of sessionApps.values()) {
      state.service.setVisionFps?.(fps);
    }
  }

  // --- Status / telemetry ---

  /** Get the input config for an active session (returns primary app's config) */
  getInputConfig(sessionId: string): InputConfig | null {
    const sessionApps = this.aiState.get(sessionId);
    if (!sessionApps || sessionApps.size === 0) return null;
    // Return primary app's input config (first entry)
    return sessionApps.values().next().value?.input ?? null;
  }

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

  /** List all session IDs that have any AI state (status, telemetry, or events). */
  listSessions(): string[] {
    const ids = new Set<string>();
    for (const id of this.status.keys()) ids.add(id);
    for (const id of this.telemetry.keys()) ids.add(id);
    for (const id of this.eventHistory.keys()) ids.add(id);
    return [...ids];
  }

  /** Remove all state for an expired session. */
  cleanup(sessionId: string): void {
    this.disconnectAI(sessionId);
    this.status.delete(sessionId);
    this.telemetry.delete(sessionId);
    this.eventHistory.delete(sessionId);
    this.subscribers.delete(sessionId);
    this.latencySum.delete(sessionId);
    this.latencyCount.delete(sessionId);
    // Clear workflow instances for this session
    for (const [key, instance] of this.workflowInstances) {
      if (instance.sessionId === sessionId) {
        this.workflowInstances.delete(key);
      }
    }
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
    // Order matters: "gemma" before "gemini" to avoid false match
    if (primitiveId.includes("gemma")) return "gemma4";
    if (primitiveId.includes("gemini")) return "gemini-live";
    if (primitiveId.includes("deepgram")) return "deepgram";
    if (primitiveId.includes("openai")) return "openai";
    // Default to gemini-live
    return "gemini-live";
  }

  /** Disconnect a specific app for a session */
  private disconnectApp(sessionId: string, appId: string): void {
    const sessionApps = this.aiState.get(sessionId);
    if (!sessionApps) return;
    const state = sessionApps.get(appId);
    if (state) {
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      try {
        state.service.disconnect();
      } catch {}
      sessionApps.delete(appId);
      if (sessionApps.size === 0) this.aiState.delete(sessionId);
    }
  }

  /** Disconnect all AI services for a session */
  private disconnectAI(sessionId: string): void {
    const sessionApps = this.aiState.get(sessionId);
    if (!sessionApps) return;
    for (const state of sessionApps.values()) {
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      try {
        state.service.disconnect();
      } catch {}
    }
    sessionApps.clear();
    this.aiState.delete(sessionId);
    // Clear any pending activations for this session
    this.pendingActivations.delete(sessionId);
  }

  private handleAIAudio(sessionId: string, appId: string, pcm: Uint8Array): void {
    const sessionApps = this.aiState.get(sessionId);
    const state = sessionApps?.get(appId);
    if (!state) return;

    state.lastAudioAt = Date.now();
    const t = this.getOrCreateTelemetry(sessionId);
    t.triggers++;

    // Push audio to relay's audio-in path (which fans out to publisher + viewers)
    if (this.audioPushFn && pcm.length > 0 && state.output.speaker) {
      const preferGlasses = state.output.speakerTarget === "glasses";
      this.audioPushFn(sessionId, pcm, preferGlasses);
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
      const content = (toolCall.args.content as string) ?? "";
      this.emitGuidanceEvent(sessionId, {
        type: eventType,
        content,
        confidence: (toolCall.args.confidence as number) ?? 0.9,
        source: appId,
        trigger: "ai_tool_call",
        timestampMs: Date.now(),
        metadata: {
          severity: (toolCall.args.severity as "info" | "warning" | "critical") ?? "info",
        },
      });

      // Push guidance text to publisher for client-side TTS
      const state = this.aiState.get(sessionId)?.get(appId);
      if (this.guidanceTextPushFn && content && state?.output.speaker) {
        const preferGlasses = state.output.speakerTarget === "glasses";
        this.guidanceTextPushFn(sessionId, content, preferGlasses);
      }

      const t = this.getOrCreateTelemetry(sessionId);
      t.guidanceEvents++;
      this.broadcastTelemetry(sessionId);
    } else if (toolCall.name === "annotate_scene") {
      const objects = (toolCall.args.objects as Array<{ box_2d: number[]; label: string; confidence?: number }>) ?? [];
      if (objects.length === 0) return;

      const boundingBoxes: BoundingBox[] = objects.map((o) => ({
        y1: o.box_2d[0] ?? 0,
        x1: o.box_2d[1] ?? 0,
        y2: o.box_2d[2] ?? 0,
        x2: o.box_2d[3] ?? 0,
        label: o.label,
        confidence: o.confidence ?? 0.8,
      }));

      const labels = [...new Set(boundingBoxes.map((b) => b.label))].join(", ");
      this.emitGuidanceEvent(sessionId, {
        type: "guidance.bbox",
        content: `Detected ${objects.length} object${objects.length > 1 ? "s" : ""}: ${labels}`,
        confidence: 0.9,
        source: appId,
        trigger: "ai_tool_call",
        timestampMs: Date.now(),
        boundingBoxes,
      });

      // Record bbox annotation to session JSONL
      const bState = this.aiState.get(sessionId)?.get(appId);
      if (this.bboxAnnotationFn && bState?.output.recording) {
        this.bboxAnnotationFn(sessionId, {
          timestampMs: Date.now(),
          sessionId,
          objects: boundingBoxes,
        });
      }

      // Push full event to publisher WebSocket (for iOS client bounding box overlay)
      if (this.guidanceEventPushFn && bState?.output.overlays) {
        this.guidanceEventPushFn(sessionId, {
          type: "guidance.bbox",
          content: `Detected ${objects.length} object${objects.length > 1 ? "s" : ""}: ${labels}`,
          confidence: 0.9,
          source: appId,
          trigger: "ai_tool_call",
          timestampMs: Date.now(),
          boundingBoxes,
        });
      }

      const t = this.getOrCreateTelemetry(sessionId);
      t.guidanceEvents++;
      this.broadcastTelemetry(sessionId);
    }
  }

  private handleAIStatusChange(sessionId: string, appId: string, aiStatus: string, context?: AIServiceStatusContext): void {
    const current = this.getStatus(sessionId);
    if (current.appId !== appId) return; // stale

    if (aiStatus === "error") {
      this.setStatus(sessionId, {
        ...current,
        status: "error",
        retryInSec: undefined,
        retryAttempt: undefined,
      });
      this.broadcastStatus(sessionId);
      return;
    }

    if (aiStatus === "disconnected" && (current.status === "active" || current.status === "rate_limited")) {
      const code = context?.closeCode ?? 0;
      const reason = context?.closeReason ?? "";

      // --- Fatal: auth failures only ---
      // 1007 = policy violation -- but Gemini also uses it for bad request args,
      // so only treat as fatal when the reason explicitly mentions auth/key issues.
      const isAuthFatal = /invalid api key|not valid|unauthorized|forbidden|permission denied/i.test(reason);

      if (isAuthFatal) {
        console.error(`[orchestrator] AI auth fatal: code=${code} reason="${reason}" — NOT reconnecting session=${sessionId}`);
        this.setStatus(sessionId, {
          ...current,
          status: "error",
          retryInSec: undefined,
          retryAttempt: undefined,
        });
        this.emitGuidanceEvent(sessionId, {
          type: "guidance.alert",
          content: `AI auth failed: ${reason || `code ${code}`}. Check API key.`,
          confidence: 1.0,
          source: appId,
          trigger: "ai_fatal_error",
          timestampMs: Date.now(),
          metadata: { severity: "critical" },
        });
        this.broadcastStatus(sessionId);
        this.disconnectAI(sessionId);
        return;
      }

      // --- Config error: bad model name, invalid argument, etc. (non-retryable, better message) ---
      const isConfigError = code === 1007 || /invalid argument|not found|not supported/i.test(reason);

      if (isConfigError) {
        console.error(`[orchestrator] AI config error: code=${code} reason="${reason}" — NOT reconnecting session=${sessionId}`);
        this.setStatus(sessionId, {
          ...current,
          status: "error",
          retryInSec: undefined,
          retryAttempt: undefined,
        });
        this.emitGuidanceEvent(sessionId, {
          type: "guidance.alert",
          content: `AI config error: ${reason || `code ${code}`}. Check model name and app config.`,
          confidence: 1.0,
          source: appId,
          trigger: "ai_config_error",
          timestampMs: Date.now(),
          metadata: { severity: "critical" },
        });
        this.broadcastStatus(sessionId);
        this.disconnectAI(sessionId);
        return;
      }

      // --- Rate-limit: transient quota exhaustion ---
      if (context?.rateLimited) {
        this.handleRateLimitDisconnect(sessionId, appId, code, reason);
        return;
      }

      // --- Transient: everything else (network blip, session deadline) ---
      const state = this.aiState.get(sessionId)?.get(appId);
      const retries = state ? state.consecutiveReconnects : 0;
      const maxRetries = 10;

      if (retries >= maxRetries) {
        console.error(`[orchestrator] Max reconnect retries (${maxRetries}) reached — stopping session=${sessionId}`);
        this.setStatus(sessionId, {
          ...current,
          status: "error",
          retryInSec: undefined,
          retryAttempt: undefined,
        });
        this.emitGuidanceEvent(sessionId, {
          type: "guidance.alert",
          content: `AI reconnect failed after ${maxRetries} attempts. Deactivating.`,
          confidence: 1.0,
          source: appId,
          trigger: "ai_max_retries",
          timestampMs: Date.now(),
          metadata: { severity: "critical" },
        });
        this.broadcastStatus(sessionId);
        this.disconnectAI(sessionId);
        return;
      }

      console.log(`[orchestrator] AI disconnected (recoverable), reconnecting ${retries + 1}/${maxRetries} session=${sessionId}`);
      this.scheduleReconnect(sessionId, appId);
    }
  }

  /** Handle a rate-limit disconnect with longer backoff (5s * 3^n, cap 120s, max 15 retries). */
  private handleRateLimitDisconnect(sessionId: string, appId: string, code: number, reason: string): void {
    const state = this.aiState.get(sessionId)?.get(appId);
    if (!state) return;

    const maxRateLimitRetries = 15;
    const attempt = state.consecutiveReconnects + 1;

    if (attempt > maxRateLimitRetries) {
      console.error(`[orchestrator] Rate-limit retry limit (${maxRateLimitRetries}) reached — stopping session=${sessionId}`);
      this.setStatus(sessionId, {
        ...this.getStatus(sessionId),
        status: "error",
        retryInSec: undefined,
        retryAttempt: undefined,
      });
      this.emitGuidanceEvent(sessionId, {
        type: "guidance.alert",
        content: `AI rate-limited for too long (${maxRateLimitRetries} retries). Deactivating.`,
        confidence: 1.0,
        source: appId,
        trigger: "ai_rate_limit_exhausted",
        timestampMs: Date.now(),
        metadata: { severity: "critical" },
      });
      this.broadcastStatus(sessionId);
      this.disconnectAI(sessionId);
      return;
    }

    // Exponential backoff: 5s * 3^(attempt-1), capped at 120s
    const delaySec = Math.min(5 * Math.pow(3, attempt - 1), 120);
    const delayMs = delaySec * 1000;

    console.warn(`[orchestrator] AI rate-limited (attempt ${attempt}/${maxRateLimitRetries}), retry in ${delaySec}s session=${sessionId} code=${code} reason="${reason}"`);

    this.emitGuidanceEvent(sessionId, {
      type: "guidance.alert",
      content: `Rate limited — retrying in ${delaySec}s (attempt ${attempt}/${maxRateLimitRetries})`,
      confidence: 1.0,
      source: appId,
      trigger: "ai_rate_limited",
      timestampMs: Date.now(),
      metadata: { severity: "warning" },
    });

    this.scheduleReconnectWithDelay(sessionId, appId, delayMs, attempt, "rate_limited");
  }

  /** Schedule a reconnect after `delayMs` milliseconds. Shared by transient and rate-limit paths. */
  private scheduleReconnectWithDelay(sessionId: string, appId: string, delayMs: number, attempt: number, interimStatus: "rate_limited" | "activating"): void {
    const state = this.aiState.get(sessionId)?.get(appId);
    if (!state) return;

    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);

    state.consecutiveReconnects = attempt;

    const delaySec = Math.round(delayMs / 1000);
    this.setStatus(sessionId, {
      ...this.getStatus(sessionId),
      status: interimStatus,
      retryInSec: delaySec,
      retryAttempt: attempt,
    });
    this.broadcastStatus(sessionId);

    state.reconnectTimer = setTimeout(() => {
      const current = this.getStatus(sessionId);
      if (current.appId === appId) {
        console.log(`[orchestrator] Auto-reconnecting session=${sessionId} (attempt ${attempt})`);
        this.activateApp(sessionId, appId).catch((err) => {
          console.error(`[orchestrator] Auto-reconnect failed: ${err}`);
          // activateApp already handles failure; scheduleReconnect will be called again via handleAIStatusChange
        });
      }
    }, delayMs);
  }

  private scheduleReconnect(sessionId: string, appId: string): void {
    const state = this.aiState.get(sessionId)?.get(appId);
    if (!state) return;

    const attempt = state.consecutiveReconnects + 1;
    // Exponential backoff: 1s, 2s, 4s, 8s, ... up to 30s
    const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 30_000);

    console.log(`[orchestrator] Reconnecting in ${delayMs / 1000}s (attempt ${attempt}) session=${sessionId} app=${appId}`);
    this.scheduleReconnectWithDelay(sessionId, appId, delayMs, attempt, "activating");
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

    // Mark the source app as having produced output (unblocks dependent processors)
    const sourceAppId = event.source;
    const evtSession = this.aiState.get(sessionId);
    if (evtSession) {
      const sourceState = evtSession.get(sourceAppId);
      if (sourceState && !sourceState.hasProducedOutput) {
        sourceState.hasProducedOutput = true;
        console.log(`[orchestrator] App ${sourceAppId} produced first output, checking pending dependents`);
        this.activatePendingDependents(sessionId, sourceAppId);
      }
    }

    // Persist to R2 via callback (buffered by session-recorder)
    // Check if any app has recording enabled
    const anyRecording = evtSession && [...evtSession.values()].some(s => s.output.recording);
    if (this.guidancePersistFn && anyRecording) {
      this.guidancePersistFn(sessionId, event);
    }

    const t = this.getOrCreateTelemetry(sessionId);
    t.guidanceEvents++;

    // Fan out to viewer WebSockets
    const anyViewers = evtSession && [...evtSession.values()].some(s => s.output.viewers);
    if (!anyViewers) return;
    const subs = this.subscribers.get(sessionId);
    if (subs) {
      const msg = { type: "guidance_event", event };
      for (const cb of subs) {
        try { cb(msg); } catch { /* subscriber error, skip */ }
      }
    }
  }

  /** Activate any processors that were waiting for the given upstream app to produce output */
  private activatePendingDependents(sessionId: string, upstreamAppId: string): void {
    const pending = this.pendingActivations.get(sessionId);
    if (!pending) return;
    const deferredApp = pending.get(upstreamAppId);
    if (!deferredApp) return;
    pending.delete(upstreamAppId);
    if (pending.size === 0) this.pendingActivations.delete(sessionId);
    console.log(`[orchestrator] Activating deferred app ${deferredApp.id} now that upstream ${upstreamAppId} has output`);
    // Fire-and-forget -- errors logged inside activateWithConfig
    this.activateWithConfig(sessionId, deferredApp).catch(err => {
      console.error(`[orchestrator] Failed to activate deferred app ${deferredApp.id}:`, err);
    });
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

  /** Expose subscriber set for a session (used by JEPA orchestrator to reuse viewer fan-out) */
  getSubscriberSet(sessionId: string): Set<(msg: any) => void> | undefined {
    return this.subscribers.get(sessionId);
  }
}
