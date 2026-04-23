/**
 * GuidancePanel -- AI Guidance Control Panel & Telemetry Display
 *
 * Renders the AI control panel (app selector, activate/deactivate, gesture triggers),
 * a scrollable color-coded guidance event log, and compact telemetry stats.
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

export interface AppInfo {
  id: string;
  name: string;
  description: string;
  icon: string;
  config: { gestures?: string[]; model?: string; voice?: string };
}

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
  private visionFps = 0.5;
  private showOverlays = true;
  private onBboxEvent: ((boxes: GuidanceEvent["boundingBoxes"]) => void) | null = null;
  private onOverlayToggle: ((show: boolean) => void) | null = null;

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
      this.renderControlSection();
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

  // --- Rendering ---

  render(): void {
    this.container.classList.toggle("collapsed", this.collapsed);
    this.container.innerHTML = `
      <button id="guidanceToggle" class="guidance-toggle" title="AI Guidance">
        <span class="guidance-toggle-label">AI</span>
        <span id="guidanceStatusDot" class="guidance-status-dot" style="background:${STATUS_COLORS[this.status.status]}"></span>
      </button>
      <div id="guidanceContent" class="guidance-content">
        <div id="guidanceControl" class="guidance-section">${this.renderControlInner()}</div>
        <div id="guidanceLog" class="guidance-section guidance-log">${this.renderEventLogInner()}</div>
        <div id="guidanceTelemetry" class="guidance-section">${this.renderTelemetryInner()}</div>
      </div>
    `;
  }

  private renderControlSection(): void {
    const el = document.getElementById("guidanceControl");
    if (el) el.innerHTML = this.renderControlInner();
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

  private renderControlInner(): string {
    const s = this.status;
    const isActive = s.status === "active";
    const isActivating = s.status === "activating";
    const isIdle = s.status === "idle";

    // App selector
    let appSelectHtml: string;
    if (!this.appsLoaded) {
      appSelectHtml = `<span class="guidance-hint">Loading apps...</span>`;
    } else if (this.apps.length === 0) {
      appSelectHtml = `<span class="guidance-hint">No AI apps available</span>`;
    } else {
      const options = this.apps
        .map(
          (a) =>
            `<option value="${esc(a.id)}" ${s.appId === a.id ? "selected" : ""}>${esc(a.name)}</option>`
        )
        .join("");
      appSelectHtml = `<select id="guidanceAppSelect" class="guidance-select">${options}</select>`;
    }

    // Activate / deactivate buttons
    let actionHtml = "";
    if (isIdle || s.status === "error") {
      actionHtml = `<button id="guidanceActivate" class="guidance-btn guidance-btn-activate" ${this.apps.length === 0 ? "disabled" : ""}>Activate</button>`;
    } else if (s.status === "rate_limited") {
      const retryIn = s.retryInSec ?? "?";
      const attempt = s.retryAttempt ?? "?";
      actionHtml = `<button class="guidance-btn guidance-btn-pending" disabled style="background:#fb923c">Rate limited -- retry in ${retryIn}s (${attempt})</button>`;
    } else if (isActivating) {
      actionHtml = `<button class="guidance-btn guidance-btn-pending" disabled>Activating...</button>`;
    } else if (isActive) {
      actionHtml = `<button id="guidanceDeactivate" class="guidance-btn guidance-btn-deactivate">Deactivate</button>`;
    }

    // Gesture trigger pills (only when active)
    let gesturesHtml = "";
    const activeApp = this.apps.find((a) => a.id === s.appId);
    const gestures = activeApp?.config?.gestures ?? s.config?.gestures ?? [];
    if (isActive && gestures.length > 0) {
      const pills = gestures
        .map(
          (g) =>
            `<button class="guidance-pill" data-gesture="${esc(g)}">${esc(g)}</button>`
        )
        .join("");
      gesturesHtml = `<div class="guidance-gestures">${pills}</div>`;
    }

    // App info line (model + voice)
    let infoHtml = "";
    if (s.config?.model) {
      const parts = [`Model: ${esc(s.config.model)}`];
      if (s.config.voice) parts.push(`Voice: ${esc(s.config.voice)}`);
      infoHtml = `<div class="guidance-info">${parts.join(" · ")}</div>`;
    }

    // App description below selector
    let descHtml = "";
    const selectedApp = this.apps.find((a) => a.id === s.appId);
    if (selectedApp?.description) {
      descHtml = `<div class="guidance-app-desc">${esc(selectedApp.description)}</div>`;
    }

    // Vision FPS slider (only when active)
    let fpsHtml = "";
    if (isActive) {
      const fpsLabel = this.visionFps >= 1 ? `${this.visionFps} FPS` : `${this.visionFps} FPS (~1 frame / ${Math.round(1 / this.visionFps)}s)`;
      fpsHtml = `<div class="guidance-fps-row">
        <span class="guidance-fps-label">Vision</span>
        <input id="guidanceFpsSlider" type="range" min="0.1" max="5" step="0.1" value="${this.visionFps}" class="guidance-slider">
        <span id="guidanceFpsValue" class="guidance-fps-value">${fpsLabel}</span>
      </div>`;
    }

    // Overlay toggle (only when active)
    let overlayHtml = "";
    if (isActive) {
      overlayHtml = `<div class="guidance-fps-row">
        <span class="guidance-fps-label">Overlays</span>
        <button id="guidanceOverlayToggle" class="guidance-pill" style="margin-left:auto">${this.showOverlays ? "ON" : "OFF"}</button>
      </div>`;
    }

    // Text input to AI (only when active)
    let textInputHtml = "";
    if (isActive) {
      textInputHtml = `<div class="guidance-text-input-row">
        <input id="guidanceTextInput" type="text" class="guidance-text-input" placeholder="Send text to AI..." maxlength="1000">
        <button id="guidanceTextSend" class="guidance-btn guidance-btn-send">Send</button>
      </div>`;
    }

    return `
      <div class="guidance-control-row">${appSelectHtml} ${actionHtml}</div>
      ${descHtml}
      ${gesturesHtml}
      ${fpsHtml}
      ${overlayHtml}
      ${textInputHtml}
      ${infoHtml}
    `;
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

  // --- Event binding ---

  private bindEvents(): void {
    const toggle = document.getElementById("guidanceToggle");
    if (toggle) {
      toggle.addEventListener("click", () => this.toggle());
    }

    const activate = document.getElementById("guidanceActivate");
    if (activate) {
      activate.addEventListener("click", () => this.handleActivate());
    }

    const deactivate = document.getElementById("guidanceDeactivate");
    if (deactivate) {
      deactivate.addEventListener("click", () => this.handleDeactivate());
    }

    // Gesture pills (delegated)
    const log = document.getElementById("guidanceLog");
    if (log) {
      log.addEventListener("click", (e) => {
        const target = (e.target as HTMLElement).closest("[data-gesture]");
        if (target) {
          this.handleGestureTrigger(
            (target as HTMLElement).dataset.gesture!
          );
        }
      });
    }

    // Gesture pills in control section too
    const control = document.getElementById("guidanceControl");
    if (control) {
      control.addEventListener("click", (e) => {
        const target = (e.target as HTMLElement).closest("[data-gesture]");
        if (target) {
          this.handleGestureTrigger(
            (target as HTMLElement).dataset.gesture!
          );
        }
      });
    }

    // Vision FPS slider
    const fpsSlider = document.getElementById("guidanceFpsSlider") as HTMLInputElement | null;
    if (fpsSlider) {
      fpsSlider.addEventListener("input", () => this.handleFpsChange(parseFloat(fpsSlider.value)));
    }

    // Overlay toggle
    const overlayToggle = document.getElementById("guidanceOverlayToggle");
    if (overlayToggle) {
      overlayToggle.addEventListener("click", () => this.handleOverlayToggle());
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

  private handleActivate(): void {
    const select = document.getElementById(
      "guidanceAppSelect"
    ) as HTMLSelectElement | null;
    const appId = select?.value ?? this.apps[0]?.id;
    if (!appId) return;
    this.sendFn({ type: "activate_app", appId });
  }

  private handleDeactivate(): void {
    this.sendFn({ type: "deactivate_app" });
  }

  private handleGestureTrigger(gesture: string): void {
    this.sendFn({ type: "trigger_gesture", gesture });
  }

  private handleFpsChange(fps: number): void {
    this.visionFps = fps;
    this.sendFn({ type: "set_vision_fps", fps });
    this.updateFpsDisplay();
  }

  private handleOverlayToggle(): void {
    this.showOverlays = !this.showOverlays;
    if (this.onOverlayToggle) this.onOverlayToggle(this.showOverlays);
    this.renderControlSection();
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
