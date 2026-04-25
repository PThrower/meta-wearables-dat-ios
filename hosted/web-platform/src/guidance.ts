/**
 * GuidancePanel -- AI Guidance Control Panel & Telemetry Display
 *
 * Renders a tabbed panel where each published workflow/app gets its own tab
 * showing full configuration (model, voice, inputs, outputs, system prompt).
 * Receives guidance events and status updates via handleMessage callback.
 * Sends control messages via the injected sendFn.
 */

export interface GuidanceEvent {
  type:
    | "guidance.step"
    | "guidance.alert"
    | "guidance.correction"
    | "guidance.identification"
    | "guidance.acknowledgment"
    | "guidance.transcript"
    | "guidance.bbox";
  content: string;
  confidence: number;
  source: string;
  trigger: string;
  timestampMs: number;
  metadata?: {
    stepNumber?: number;
    severity?: "info" | "warning" | "critical";
    objectLabel?: string;
  };
  boundingBoxes?: Array<{
    y1: number; x1: number; y2: number; x2: number;
    label: string; confidence: number;
  }>;
}

export interface AIStatus {
  appId: string | null;
  status: "idle" | "activating" | "active" | "error" | "rate_limited";
  config?: {
    model?: string;
    voice?: string;
    visionFps?: number;
    gestures?: string[];
  };
  activatedAt?: number;
  triggerCount: number;
  lastResponseMs?: number;
  retryInSec?: number;
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

export interface InputConfig {
  video: boolean;
  phoneMic: boolean;
  glassesMic: boolean;
  gestures: boolean;
  visionFps: number;
}

export interface OutputConfig {
  viewers: boolean;
  overlays: boolean;
  speaker: boolean;
  recording: boolean;
}

export interface JepaConfig {
  provider: string;
  tier: string;
  gpu: string;
  clipLength: number;
  sampleFps: number;
  resolution: number;
  tasks: Array<{ type: string; labels?: string[]; threshold?: number }>;
}

export interface AppInfo {
  id: string;
  name: string;
  description: string;
  icon: string;
  binding: string;
  systemPrompt: string;
  config: {
    gestures?: string[];
    model?: string;
    voice?: string;
    visionFps?: number;
    temperature?: number;
    analysisIntervalSec?: number;
    input?: InputConfig;
    output?: OutputConfig;
    lifecycle?: {
      onDisconnect: string;
      onReconnect: string;
      autoDeactivateMin: number | null;
    };
    jepa?: JepaConfig;
  };
}

// --- Workflow Execution Controls ---

export type NodeExecutionState = "pending" | "running" | "paused" | "completed" | "skipped" | "errored" | "waiting";

export interface NodeState {
  nodeId: string;
  appId: string;
  nodeType: string;
  label: string;
  state: NodeExecutionState;
  startedAt: number | null;
  completedAt: number | null;
  error?: string;
}

export const NODE_STATE_COLORS: Record<NodeExecutionState, string> = {
  pending: "#9ca3af",
  running: "#4ade80",
  paused: "#facc15",
  completed: "#60a5fa",
  skipped: "#6b7280",
  errored: "#f87171",
  waiting: "#38bdf8",
};

const NODE_STATE_LABELS: Record<NodeExecutionState, string> = {
  pending: "Pending",
  running: "Running",
  paused: "Paused",
  completed: "Done",
  skipped: "Skipped",
  errored: "Error",
  waiting: "Waiting",
};

const MAX_EVENTS = 50;

export const SOURCE_BADGES: Record<string, string> = {
  vision: "source-vision",
  camera: "source-vision",
  gesture: "source-gesture",
  hand: "source-gesture",
  voice: "source-voice",
  audio: "source-voice",
  speech: "source-voice",
  auto_timer: "source-timer",
  timer: "source-timer",
  manual: "source-manual",
};

export function sourceBadgeClass(source: string): string {
  const lower = source.toLowerCase();
  for (const [key, cls] of Object.entries(SOURCE_BADGES)) {
    if (lower.includes(key)) return cls;
  }
  return "source-auto";
}

const STATUS_COLORS: Record<AIStatus["status"], string> = {
  idle: "rgba(255,255,255,0.25)",
  activating: "#facc15",
  active: "#4ade80",
  error: "#f87171",
  rate_limited: "#fb923c",
};

export const EVENT_COLORS: Record<GuidanceEvent["type"], string> = {
  "guidance.step": "#60a5fa",
  "guidance.alert": "#fb923c",
  "guidance.correction": "#facc15",
  "guidance.identification": "#4ade80",
  "guidance.acknowledgment": "rgba(255,255,255,0.45)",
  "guidance.transcript": "rgba(255,255,255,0.15)",
  "guidance.bbox": "#a78bfa",
};

export const EVENT_LABELS: Record<GuidanceEvent["type"], string> = {
  "guidance.step": "STEP",
  "guidance.alert": "ALERT",
  "guidance.correction": "CORR",
  "guidance.identification": "ID",
  "guidance.acknowledgment": "ACK",
  "guidance.transcript": "",
  "guidance.bbox": "BBOX",
};

export class GuidancePanel {
  private container: HTMLElement;
  private sendFn: (msg: object) => void;
  private apps: AppInfo[] = [];
  private status: AIStatus = {
    appId: null,
    status: "idle",
    triggerCount: 0,
  };
  private telemetry: AITelemetry = {
    triggers: 0,
    guidanceEvents: 0,
    avgLatencyMs: 0,
    lastLatencyMs: null,
    queueDepth: 0,
    uptimeMs: 0,
  };
  private events: GuidanceEvent[] = [];
  private collapsed = true;
  private appsLoaded = false;
  private _appRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private activeTabId: string | null = null;
  private expandedPrompts = new Set<string>();
  private visionFps = 0.5;
  private showOverlays = true;
  private onBboxEvent: ((boxes: GuidanceEvent["boundingBoxes"]) => void) | null = null;
  private onOverlayToggle: ((show: boolean) => void) | null = null;
  private nodeStates: NodeState[] = [];
  private activeWorkflowId: string | null = null;

  constructor(container: HTMLElement, sendFn: (msg: object) => void) {
    this.container = container;
    this.sendFn = sendFn;
    this.render();
    this.bindEvents();
  }

  async loadApps(): Promise<void> {
    try {
      const res = await fetch("/apps");
      if (!res.ok) {
        this.apps = [];
        this.appsLoaded = true;
        this.render();
        return;
      }
      const data = await res.json();
      this.apps = Array.isArray(data) ? data : data.apps ?? [];
      this.appsLoaded = true;
      // Auto-select first tab
      if (!this.activeTabId && this.apps.length > 0) {
        this.activeTabId = this.apps[0].id;
      }
      this.render();
      this.bindEvents();
    } catch {
      this.apps = [];
      this.appsLoaded = true;
      this.render();
    }

    // Refresh app list every 15s to pick up newly published workflows
    if (!this._appRefreshTimer) {
      this._appRefreshTimer = setInterval(async () => {
        try {
          const res = await fetch("/apps");
          if (!res.ok) return;
          const data = await res.json();
          const updated = Array.isArray(data) ? data : data.apps ?? [];
          if (JSON.stringify(updated.map((a: any) => a.id)) !== JSON.stringify(this.apps.map(a => a.id))) {
            this.apps = updated;
            // Keep activeTabId if still valid, else select first
            if (this.activeTabId && !updated.some((a: any) => a.id === this.activeTabId)) {
              this.activeTabId = updated[0]?.id ?? null;
            } else if (!this.activeTabId && updated.length > 0) {
              this.activeTabId = updated[0].id;
            }
            this.render();
            this.bindEvents();
          }
        } catch { /* ignore */ }
      }, 15_000);
    }
  }

  destroy(): void {
    if (this._appRefreshTimer) { clearInterval(this._appRefreshTimer); this._appRefreshTimer = null; }
  }

  handleMessage(msg: Record<string, unknown>): void {
    if (msg.type === "ai_status") {
      this.status = msg as unknown as AIStatus;
      // Auto-switch tab to active app
      if (this.status.status === "active" && this.status.appId && this.activeTabId !== this.status.appId) {
        this.activeTabId = this.status.appId;
      }
      this.renderTabBar();
      this.renderTabBody();
      this.updateStatusDot();
    } else if (msg.type === "guidance_event") {
      const evt = (msg as { event: GuidanceEvent }).event;
      if (evt) {
        this.events.push(evt);
        if (this.events.length > MAX_EVENTS) {
          this.events = this.events.slice(-MAX_EVENTS);
        }
        // Forward bbox events to relay player overlay
        if (evt.type === "guidance.bbox" && evt.boundingBoxes && this.onBboxEvent) {
          this.onBboxEvent(evt.boundingBoxes);
        }
        this.renderEventLog();
      }
    } else if (msg.type === "ai_telemetry") {
      const data = (msg as { telemetry?: AITelemetry }).telemetry;
      if (data) {
        this.telemetry = {
          triggers: data.triggers ?? 0,
          guidanceEvents: data.guidanceEvents ?? 0,
          avgLatencyMs: data.avgLatencyMs ?? 0,
          lastLatencyMs: data.lastLatencyMs ?? null,
          queueDepth: data.queueDepth ?? 0,
          uptimeMs: data.uptimeMs ?? 0,
        };
      }
      this.renderTelemetry();
    } else if (msg.type === "vision_fps") {
      this.visionFps = (msg as { fps: number }).fps;
      this.updateFpsDisplay();
    } else if (msg.type === "node_states") {
      const data = msg as { workflowId: string; nodes: NodeState[] };
      this.activeWorkflowId = data.workflowId;
      this.nodeStates = data.nodes;
      if (data.nodes.length === 0) {
        this.activeWorkflowId = null;
      }
      this.renderWorkflowPipeline();
    }
  }

  toggle(): void {
    this.collapsed = !this.collapsed;
    this.container.classList.toggle("collapsed", this.collapsed);
  }

  /** Set callback to forward bbox events to the relay player overlay */
  setBboxCallback(fn: (boxes: GuidanceEvent["boundingBoxes"]) => void): void {
    this.onBboxEvent = fn;
  }

  /** Set callback to toggle overlay visibility */
  setOverlayToggleCallback(fn: (show: boolean) => void): void {
    this.onOverlayToggle = fn;
  }

  /** Get the active workflow ID (for mini editor). */
  getActiveWorkflowId(): string | null { return this.activeWorkflowId; }

  /** Get current node execution states (for mini editor). */
  getNodeStates(): NodeState[] { return this.nodeStates; }

  /** Whether the panel is collapsed (for mini editor coordination). */
  isCollapsed(): boolean { return this.collapsed; }

  // --- Rendering ---

  render(): void {
    this.container.classList.toggle("collapsed", this.collapsed);
    this.container.innerHTML = `
      <button id="guidanceToggle" class="guidance-toggle" title="AI Guidance">
        <span class="guidance-toggle-label">AI</span>
        <span id="guidanceStatusDot" class="guidance-status-dot" style="background:${STATUS_COLORS[this.status.status]}"></span>
      </button>
      <div id="guidanceContent" class="guidance-content">
        <div id="guidanceTabBar" class="guidance-tab-bar">${this.renderTabBarInner()}</div>
        <div id="guidanceTabBody" class="guidance-tab-body">${this.renderTabBodyInner()}</div>
      </div>
    `;
  }

  private renderTabBar(): void {
    const el = document.getElementById("guidanceTabBar");
    if (el) el.innerHTML = this.renderTabBarInner();
  }

  private renderTabBody(): void {
    const el = document.getElementById("guidanceTabBody");
    if (el) {
      el.innerHTML = this.renderTabBodyInner();
      // Re-bind controls inside tab body
      this.bindTabBodyEvents();
    }
  }

  private renderTabBarInner(): string {
    if (!this.appsLoaded || this.apps.length === 0) return "";

    return this.apps.map(app => {
      const isSelected = this.activeTabId === app.id;
      const isRunning = this.status.status === "active" && this.status.appId === app.id;
      const isActivating = this.status.status === "activating" && this.status.appId === app.id;
      const isRateLimited = this.status.status === "rate_limited" && this.status.appId === app.id;

      let cls = "guidance-tab";
      if (isSelected) cls += " selected";
      if (isRunning) cls += " guidance-tab-running";
      else if (isActivating) cls += " guidance-tab-activating";
      else if (isRateLimited) cls += " guidance-tab-rate-limited";

      return `<button class="${cls}" data-tab-id="${esc(app.id)}">${esc(app.name)}</button>`;
    }).join("");
  }

  private renderTabBodyInner(): string {
    if (!this.appsLoaded) {
      return `<div class="guidance-section"><div class="guidance-hint">Loading apps...</div></div>`;
    }
    if (this.apps.length === 0) {
      return `<div class="guidance-section"><div class="guidance-hint">No AI apps available</div></div>`;
    }

    const app = this.apps.find(a => a.id === this.activeTabId);
    if (!app) {
      return `<div class="guidance-section"><div class="guidance-hint">Select an app tab</div></div>`;
    }

    const isThisActive = this.status.status === "active" && this.status.appId === app.id;
    const isThisActivating = this.status.status === "activating" && this.status.appId === app.id;
    const isThisRateLimited = this.status.status === "rate_limited" && this.status.appId === app.id;

    let html = "";

    // Config summary
    html += `<div class="guidance-section">${this.renderAppConfig(app)}</div>`;

    // Status line (activating / rate-limited)
    if (isThisActivating) {
      html += `<div class="guidance-section"><div class="guidance-tab-status guidance-tab-status-activating">Activating...</div></div>`;
    } else if (isThisRateLimited) {
      const retryIn = this.status.retryInSec ?? "?";
      const attempt = this.status.retryAttempt ?? "?";
      html += `<div class="guidance-section"><div class="guidance-tab-status guidance-tab-status-rate-limited">Rate limited -- retry in ${retryIn}s (${attempt})</div></div>`;
    }

    // Action button
    html += `<div class="guidance-section">${this.renderActionButton(app)}</div>`;

    // Active controls (only when this app is active)
    if (isThisActive) {
      html += `<div class="guidance-section">${this.renderActiveControls(app)}</div>`;
    }

    // Workflow execution pipeline (only when multi-node workflow is active)
    if (isThisActive && this.activeWorkflowId && this.nodeStates.length > 1) {
      html += `<div id="workflowPipeline" class="guidance-section workflow-pipeline">${this.renderWorkflowPipelineInner()}</div>`;
    }

    // Event log (only when active)
    if (isThisActive) {
      html += `<div id="guidanceLog" class="guidance-section guidance-log">${this.renderEventLogInner()}</div>`;
    }

    // Telemetry (only when active)
    if (isThisActive) {
      html += `<div id="guidanceTelemetry" class="guidance-section">${this.renderTelemetryInner()}</div>`;
    }

    return html;
  }

  private renderAppConfig(app: AppInfo): string {
    const config = app.config;
    const input = config.input;
    const output = config.output;
    const isJepa = app.binding?.includes("jepa") || !!config.jepa;

    const rows: string[] = [];

    // Model
    rows.push(configRow("Model", config.model ?? "default"));

    // Voice
    if (config.voice) {
      rows.push(configRow("Voice", config.voice));
    }

    // Vision FPS
    const fps = config.visionFps ?? 1;
    rows.push(configRow("Vision", `${fps} FPS`));

    // Temperature
    if (config.temperature != null) {
      rows.push(configRow("Temp", `${config.temperature}`));
    }

    // Analysis interval (for JEPA)
    if (config.analysisIntervalSec != null) {
      rows.push(configRow("Interval", `${config.analysisIntervalSec}s`));
    }

    // Input modalities
    if (input) {
      const pills: string[] = [];
      if (input.video) pills.push(pillBadge("Video", "#60a5fa"));
      if (input.phoneMic) pills.push(pillBadge("Phone Mic", "#a78bfa"));
      if (input.glassesMic) pills.push(pillBadge("Glasses Mic", "#facc15"));
      if (input.gestures) pills.push(pillBadge("Gestures", "#fb923c"));
      if (pills.length > 0) {
        rows.push(`<div class="guidance-config-row"><span class="guidance-config-key">Input</span><span class="guidance-config-val">${pills.join("")}</span></div>`);
      }
    }

    // Output channels
    if (output) {
      const pills: string[] = [];
      if (output.viewers) pills.push(pillBadge("Viewers", "#60a5fa"));
      if (output.overlays) pills.push(pillBadge("Overlays", "#4ade80"));
      if (output.speaker) pills.push(pillBadge("Speaker", "#a78bfa"));
      if (output.recording) pills.push(pillBadge("Recording", "#fb923c"));
      if (pills.length > 0) {
        rows.push(`<div class="guidance-config-row"><span class="guidance-config-key">Output</span><span class="guidance-config-val">${pills.join("")}</span></div>`);
      }
    }

    // JEPA details
    if (isJepa && config.jepa) {
      const j = config.jepa;
      rows.push(configRow("Provider", `${j.provider} / ${j.tier}`));
      rows.push(configRow("JEPA", `${j.clipLength} frames @ ${j.sampleFps} FPS, ${j.resolution}px`));
      rows.push(configRow("GPU", j.gpu));
      if (j.tasks?.length) {
        const taskStr = j.tasks.map(t => t.type).join(", ");
        rows.push(configRow("Tasks", taskStr));
      }
    }

    // System prompt preview
    if (app.systemPrompt && app.systemPrompt !== "jepa-vision") {
      const promptId = app.id;
      const isExpanded = this.expandedPrompts.has(promptId);
      const maxLen = 120;
      const truncated = app.systemPrompt.length > maxLen && !isExpanded;
      const displayText = truncated ? app.systemPrompt.slice(0, maxLen) + "..." : app.systemPrompt;
      const toggleLabel = isExpanded ? "Show less" : `Show all (${app.systemPrompt.length} chars)`;

      rows.push(`<div class="guidance-prompt-preview ${isExpanded ? "expanded" : ""}" data-prompt-id="${esc(promptId)}">
        <div class="guidance-config-key">System Prompt</div>
        <div class="guidance-prompt-text">${esc(displayText)}</div>
        ${app.systemPrompt.length > maxLen ? `<button class="guidance-prompt-toggle" data-prompt-toggle="${esc(promptId)}">${toggleLabel}</button>` : ""}
      </div>`);
    }

    return `<div class="guidance-config-grid">${rows.join("")}</div>`;
  }

  private renderActionButton(app: AppInfo): string {
    const s = this.status;
    const isThisActive = s.status === "active" && s.appId === app.id;
    const otherActive = s.status === "active" && s.appId !== app.id;

    if (isThisActive) {
      return `<button id="guidanceDeactivate" class="guidance-btn guidance-btn-deactivate" data-app-id="${esc(app.id)}">Deactivate</button>`;
    }
    if (otherActive) {
      return `<button id="guidanceActivate" class="guidance-btn guidance-btn-activate" data-app-id="${esc(app.id)}">Activate (override)</button>`;
    }
    // Idle or error
    return `<button id="guidanceActivate" class="guidance-btn guidance-btn-activate" data-app-id="${esc(app.id)}">Activate</button>`;
  }

  private renderActiveControls(app: AppInfo): string {
    const gestures = app.config?.gestures ?? this.status.config?.gestures ?? [];

    let html = "";

    // Gesture trigger pills
    if (gestures.length > 0) {
      const pills = gestures
        .map(g => `<button class="guidance-pill" data-gesture="${esc(g)}">${esc(g)}</button>`)
        .join("");
      html += `<div class="guidance-gestures">${pills}</div>`;
    }

    // Vision FPS slider
    const fpsLabel = this.visionFps >= 1
      ? `${this.visionFps} FPS`
      : `${this.visionFps} FPS (~1 frame / ${Math.round(1 / this.visionFps)}s)`;
    html += `<div class="guidance-fps-row">
      <span class="guidance-fps-label">Vision</span>
      <input id="guidanceFpsSlider" type="range" min="0.1" max="5" step="0.1" value="${this.visionFps}" class="guidance-slider">
      <span id="guidanceFpsValue" class="guidance-fps-value">${fpsLabel}</span>
    </div>`;

    // Overlay toggle
    html += `<div class="guidance-fps-row">
      <span class="guidance-fps-label">Overlays</span>
      <button id="guidanceOverlayToggle" class="guidance-pill" style="margin-left:auto">${this.showOverlays ? "ON" : "OFF"}</button>
    </div>`;

    // Text input to AI
    html += `<div class="guidance-text-input-row">
      <input id="guidanceTextInput" type="text" class="guidance-text-input" placeholder="Send text to AI..." maxlength="1000">
      <button id="guidanceTextSend" class="guidance-btn guidance-btn-send">Send</button>
    </div>`;

    return html;
  }

  private renderEventLog(): void {
    const el = document.getElementById("guidanceLog");
    if (el) {
      el.innerHTML = this.renderEventLogInner();
      el.scrollTop = el.scrollHeight;
    }
  }

  private renderTelemetry(): void {
    const el = document.getElementById("guidanceTelemetry");
    if (el) el.innerHTML = this.renderTelemetryInner();
  }

  private updateStatusDot(): void {
    const dot = document.getElementById("guidanceStatusDot");
    if (dot) dot.style.background = STATUS_COLORS[this.status.status];
  }

  private renderEventLogInner(): string {
    if (this.events.length === 0) {
      return `<div class="guidance-hint">No guidance events</div>`;
    }
    return this.events
      .map((e) => {
        const color = EVENT_COLORS[e.type] || "#fff";
        const label = EVENT_LABELS[e.type] || "???";
        const time = new Date(e.timestampMs).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });

        // Transcript entries: compact, unstyled, no badge
        if (e.type === "guidance.transcript") {
          return `<div class="guidance-event guidance-transcript">
            <span class="guidance-transcript-time">${time}</span>
            <span class="guidance-transcript-text">${esc(e.content)}</span>
          </div>`;
        }

        const confidence = Math.round(e.confidence * 100);
        const stepMeta =
          e.metadata?.stepNumber != null
            ? ` <span class="guidance-step-num">#${e.metadata.stepNumber}</span>`
            : "";
        const severityMeta = e.metadata?.severity
          ? ` <span class="guidance-severity guidance-severity-${e.metadata.severity}">${e.metadata.severity}</span>`
          : "";
        const objectMeta = e.metadata?.objectLabel
          ? ` <span class="guidance-object">${esc(e.metadata.objectLabel)}</span>`
          : "";

        // TTS indicator for tool-call events (not transcripts)
        const ttsIcon = e.trigger === "ai_tool_call" ? ` <span class="guidance-tts-badge" title="Spoken via TTS">TTS</span>` : "";

        // Source badge (vision/gesture/voice)
        const srcBadge = e.source
          ? `<span class="guidance-source-badge ${sourceBadgeClass(e.source)}">${esc(e.source)}</span>`
          : "";

        // Trigger badge (when distinct from source)
        const triggerBadge = (e.trigger && e.trigger !== e.source && e.trigger !== "ai_tool_call")
          ? `<span class="guidance-trigger-badge">${esc(e.trigger)}</span>`
          : "";

        // BBOX event: show object count and labels
        if (e.type === "guidance.bbox" && e.boundingBoxes) {
          const objectTags = e.boundingBoxes
            .map((b) => `<span class="guidance-object">${esc(b.label)} ${Math.round(b.confidence * 100)}%</span>`)
            .join(" ");
          return `<div class="guidance-event" style="border-left-color:${color}">
            <div class="guidance-event-header">
              <span class="guidance-event-type" style="color:${color}">${label}</span>${srcBadge}${triggerBadge}
              <span class="guidance-event-confidence">${confidence}%</span>
              <span class="guidance-event-time">${time}</span>
            </div>
            <div class="guidance-event-body">${esc(e.content)} ${objectTags}</div>
          </div>`;
        }

        return `<div class="guidance-event" style="border-left-color:${color}">
          <div class="guidance-event-header">
            <span class="guidance-event-type" style="color:${color}">${label}</span>${ttsIcon}${srcBadge}${triggerBadge}
            <span class="guidance-event-confidence">${confidence}%</span>
            <span class="guidance-event-time">${time}</span>
          </div>
          <div class="guidance-event-body">${esc(e.content)}${stepMeta}${severityMeta}${objectMeta}</div>
        </div>`;
      })
      .join("");
  }

  private renderTelemetryInner(): string {
    const t = this.telemetry;
    const uptime = formatUptime(t.uptimeMs);
    // Active duration from AI status activatedAt
    const activeDuration = this.status.activatedAt
      ? formatUptime(Date.now() - this.status.activatedAt)
      : "--";
    return `
      <div class="guidance-telemetry-row">
        <span class="guidance-tstat"><span class="guidance-tstat-val">${t.triggers}</span><span class="guidance-tstat-label">Triggers</span></span>
        <span class="guidance-tstat"><span class="guidance-tstat-val">${t.guidanceEvents}</span><span class="guidance-tstat-label">Events</span></span>
        <span class="guidance-tstat"><span class="guidance-tstat-val">${Math.round(t.avgLatencyMs)}</span><span class="guidance-tstat-label">Avg ms</span></span>
        <span class="guidance-tstat"><span class="guidance-tstat-val">${t.lastLatencyMs != null ? Math.round(t.lastLatencyMs) : "--"}</span><span class="guidance-tstat-label">Last ms</span></span>
        <span class="guidance-tstat"><span class="guidance-tstat-val">${t.queueDepth}</span><span class="guidance-tstat-label">Queue</span></span>
        <span class="guidance-tstat"><span class="guidance-tstat-val">${activeDuration}</span><span class="guidance-tstat-label">Active</span></span>
        <span class="guidance-tstat"><span class="guidance-tstat-val">${uptime}</span><span class="guidance-tstat-label">Uptime</span></span>
      </div>
    `;
  }

  // --- Workflow Pipeline Rendering ---

  private renderWorkflowPipeline(): void {
    const el = document.getElementById("workflowPipeline");
    if (!el) return;
    if (!this.activeWorkflowId || this.nodeStates.length === 0) {
      el.innerHTML = "";
      return;
    }
    el.innerHTML = this.renderWorkflowPipelineInner();
    this.bindWorkflowControlEvents();
  }

  private renderWorkflowPipelineInner(): string {
    const hasRunning = this.nodeStates.some(n => n.state === "running");
    const hasPaused = this.nodeStates.some(n => n.state === "paused");
    const hasWaiting = this.nodeStates.some(n => n.state === "waiting");

    let html = '<div class="workflow-controls-bar">';
    if (hasRunning) {
      html += `<button class="guidance-btn guidance-btn-sm" data-workflow-action="pause_workflow" data-workflow-id="${esc(this.activeWorkflowId)}">Pause All</button>`;
    }
    if (hasPaused) {
      html += `<button class="guidance-btn guidance-btn-sm guidance-btn-activate" data-workflow-action="resume_workflow" data-workflow-id="${esc(this.activeWorkflowId)}">Resume All</button>`;
    }
    html += `<button class="guidance-btn guidance-btn-sm guidance-btn-deactivate" data-workflow-action="stop_workflow" data-workflow-id="${esc(this.activeWorkflowId)}">Stop</button>`;
    html += "</div>";

    // Node pipeline cards
    html += '<div class="workflow-node-pipeline">';
    for (const node of this.nodeStates) {
      const color = NODE_STATE_COLORS[node.state] || "#9ca3af";
      const label = NODE_STATE_LABELS[node.state] || node.state;
      const errorText = node.error ? `<div class="workflow-node-error">${esc(node.error)}</div>` : "";

      html += `<div class="workflow-node-card" style="border-left-color:${color}" data-node-state="${node.state}">
        <div class="workflow-node-header">
          <span class="workflow-node-label">${esc(node.label)}</span>
          <span class="workflow-node-badge" style="background:${color}30;color:${color}">${label}</span>
        </div>
        <div class="workflow-node-type">${esc(node.nodeType)}</div>
        ${errorText}
        <div class="workflow-node-actions">`;

      // Per-node actions based on state
      if (node.state === "running") {
        html += `<button class="guidance-btn guidance-btn-xs" data-node-action="skip_node" data-node-id="${esc(node.nodeId)}" data-workflow-id="${esc(this.activeWorkflowId!)}">Skip</button>`;
      }
      if (node.state === "skipped" || node.state === "errored") {
        html += `<button class="guidance-btn guidance-btn-xs guidance-btn-activate" data-node-action="redo_node" data-node-id="${esc(node.nodeId)}" data-workflow-id="${esc(this.activeWorkflowId!)}">Redo</button>`;
      }
      if (node.state === "waiting") {
        html += `<button class="guidance-btn guidance-btn-xs guidance-btn-activate" data-node-action="continue_node" data-node-id="${esc(node.nodeId)}" data-workflow-id="${esc(this.activeWorkflowId!)}">Start</button>`;
      }

      html += `</div></div>`;
    }
    html += "</div>";

    return html;
  }

  private bindWorkflowControlEvents(): void {
    const pipeline = document.getElementById("workflowPipeline");
    if (!pipeline) return;

    pipeline.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;

      // Workflow-level actions (Pause All, Resume All, Stop)
      const wfAction = target.closest("[data-workflow-action]") as HTMLElement | null;
      if (wfAction && !wfAction.dataset.nodeId) {
        const action = wfAction.dataset.workflowAction!;
        const workflowId = wfAction.dataset.workflowId!;
        this.sendFn({ type: "workflow_control", action, workflowId });
        return;
      }

      // Per-node actions (Skip, Redo, Start)
      const nodeAction = target.closest("[data-node-action]") as HTMLElement | null;
      if (nodeAction) {
        const action = nodeAction.dataset.nodeAction!;
        const nodeId = nodeAction.dataset.nodeId!;
        const workflowId = nodeAction.dataset.workflowId!;
        this.sendFn({ type: "workflow_control", action, workflowId, nodeId });
        return;
      }
    });
  }

  // --- End Workflow Pipeline Rendering ---

  // --- Event binding ---

  private bindEvents(): void {
    const toggle = document.getElementById("guidanceToggle");
    if (toggle) {
      toggle.addEventListener("click", () => this.toggle());
    }

    // Tab bar: delegated click on [data-tab-id]
    const tabBar = document.getElementById("guidanceTabBar");
    if (tabBar) {
      tabBar.addEventListener("click", (e) => {
        const target = (e.target as HTMLElement).closest("[data-tab-id]") as HTMLElement | null;
        if (target) {
          this.activeTabId = target.dataset.tabId ?? null;
          this.renderTabBar();
          this.renderTabBody();
        }
      });
    }

    // Tab body: delegated events
    this.bindTabBodyEvents();
  }

  /** Bind events inside the tab body (called on initial render and each tab body re-render) */
  private bindTabBodyEvents(): void {
    const tabBody = document.getElementById("guidanceTabBody");
    if (!tabBody) return;

    tabBody.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;

      // Activate button
      const activate = target.closest("#guidanceActivate") as HTMLElement | null;
      if (activate) {
        const appId = activate.dataset.appId;
        if (appId) this.sendFn({ type: "activate_app", appId });
        return;
      }

      // Deactivate button
      const deactivate = target.closest("#guidanceDeactivate") as HTMLElement | null;
      if (deactivate) {
        this.sendFn({ type: "deactivate_app" });
        return;
      }

      // Gesture pills
      const gesture = target.closest("[data-gesture]") as HTMLElement | null;
      if (gesture) {
        this.sendFn({ type: "trigger_gesture", gesture: gesture.dataset.gesture! });
        return;
      }

      // Prompt toggle
      const promptToggle = target.closest("[data-prompt-toggle]") as HTMLElement | null;
      if (promptToggle) {
        const promptId = promptToggle.dataset.promptToggle!;
        if (this.expandedPrompts.has(promptId)) {
          this.expandedPrompts.delete(promptId);
        } else {
          this.expandedPrompts.add(promptId);
        }
        this.renderTabBody();
        return;
      }

      // Overlay toggle
      const overlayToggle = target.closest("#guidanceOverlayToggle") as HTMLElement | null;
      if (overlayToggle) {
        this.showOverlays = !this.showOverlays;
        if (this.onOverlayToggle) this.onOverlayToggle(this.showOverlays);
        this.renderTabBody();
        return;
      }
    });

    // Vision FPS slider
    const fpsSlider = document.getElementById("guidanceFpsSlider") as HTMLInputElement | null;
    if (fpsSlider) {
      fpsSlider.addEventListener("input", () => this.handleFpsChange(parseFloat(fpsSlider.value)));
    }

    // Text input to AI
    const textInput = document.getElementById("guidanceTextInput") as HTMLInputElement | null;
    const textSend = document.getElementById("guidanceTextSend");
    if (textInput && textSend) {
      textSend.addEventListener("click", () => this.handleSendText(textInput));
      textInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.handleSendText(textInput);
        }
      });
    }
  }

  private handleFpsChange(fps: number): void {
    this.visionFps = fps;
    this.sendFn({ type: "set_vision_fps", fps });
    this.updateFpsDisplay();
  }

  private handleSendText(input: HTMLInputElement): void {
    const text = input.value.trim();
    if (!text) return;
    this.sendFn({ type: "send_text", text });
    input.value = "";
  }

  private updateFpsDisplay(): void {
    const val = document.getElementById("guidanceFpsValue");
    if (val) {
      val.textContent = this.visionFps >= 1
        ? `${this.visionFps} FPS`
        : `${this.visionFps} FPS (~1 frame / ${Math.round(1 / this.visionFps)}s)`;
    }
  }
}

// --- Utilities ---

export function esc(str: string): string {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function formatUptime(ms: number): string {
  if (ms <= 0) return "--";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function configRow(key: string, value: string): string {
  return `<div class="guidance-config-row"><span class="guidance-config-key">${esc(key)}</span><span class="guidance-config-val">${esc(value)}</span></div>`;
}

function pillBadge(label: string, color: string): string {
  return `<span class="guidance-pill-static" style="border-color:${color}40;color:${color}">${esc(label)}</span>`;
}
