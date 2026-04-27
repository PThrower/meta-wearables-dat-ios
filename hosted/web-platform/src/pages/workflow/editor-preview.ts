/**
 * EditorPreview — lightweight WebSocket client that connects to a session's
 * viewer endpoint to receive node_states, guidance_event, spoken_text, and
 * publisher_telemetry for live preview in the workflow editor.
 *
 * Only processes JSON messages — ignores binary video/audio frames.
 */

import { fetchSessions, esc } from "../../core/api-client.js";
import type { SessionInfo } from "../../core/api-client.js";
import { getWorkflow } from "./state.js";

// --- Types ---

export interface NodePreviewState {
  nodeId: string;
  nodeType: string;
  label: string;
  executionState: string;
  error?: string;
  lastText?: string;
  lastTextTime?: number;
  numerics: Map<string, { value: number; unit: string; time: number }>;
  updated: number;
}

export type PreviewChangeListener = () => void;

// --- Module state ---

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let intentionalClose = false;
let reconnectDelay = 1000;
const RECONNECT_MAX = 15_000;

let nodePreviews = new Map<string, NodePreviewState>();
let listeners: PreviewChangeListener[] = [];
let connectedSessionId: string | null = null;
let _pollTimer: ReturnType<typeof setInterval> | null = null;

// --- Public API ---

/** Find the active session running a specific workflow. Returns sessionId or null. */
export async function findActiveSession(workflowId: string): Promise<string | null> {
  const sessions = await fetchSessions();
  const match = sessions.find(
    (s: SessionInfo & { activeWorkflowId?: string | null }) =>
      s.live && (s as any).activeWorkflowId === workflowId,
  );
  return match?.sessionId ?? null;
}

/** Connect to a session's viewer WebSocket for preview data. */
export function connectPreview(sessionId: string): void {
  disconnectPreview();

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/view?session=${encodeURIComponent(sessionId)}`;

  intentionalClose = false;
  reconnectDelay = 1000;
  connectedSessionId = sessionId;

  ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    reconnectDelay = 1000;
    const token = localStorage.getItem("relay_token") || "";
    ws!.send(JSON.stringify({ type: "hello", token }));
  };

  ws.onmessage = (event) => {
    // Ignore binary frames (video/audio)
    if (typeof event.data !== "string") return;
    try {
      const msg = JSON.parse(event.data);
      handlePreviewMessage(msg);
    } catch { /* ignore malformed JSON */ }
  };

  ws.onclose = () => {
    ws = null;
    if (!intentionalClose) {
      reconnectTimer = setTimeout(() => {
        if (connectedSessionId) connectPreview(connectedSessionId);
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
    }
  };

  ws.onerror = () => { ws?.close(); };
}

/** Disconnect the preview WebSocket. */
export function disconnectPreview(): void {
  intentionalClose = true;
  connectedSessionId = null;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) { ws.close(); ws = null; }
  nodePreviews.clear();
}

/** Get all current node preview states. */
export function getNodePreviews(): Map<string, NodePreviewState> {
  return nodePreviews;
}

/** Get preview state for a specific node. */
export function getNodePreview(nodeId: string): NodePreviewState | undefined {
  return nodePreviews.get(nodeId);
}

/** Whether the preview WebSocket is connected. */
export function isPreviewConnected(): boolean {
  return ws?.readyState === WebSocket.OPEN;
}

/** Register a listener for preview data changes. */
export function addPreviewListener(fn: PreviewChangeListener): void {
  listeners.push(fn);
}

/** Remove a listener. */
export function removePreviewListener(fn: PreviewChangeListener): void {
  listeners = listeners.filter(f => f !== fn);
}

/** Start polling for active session (fallback if WS not connected). */
export function startSessionPolling(workflowId: string, intervalMs = 10_000): void {
  stopSessionPolling();
  const check = async () => {
    if (ws?.readyState === WebSocket.OPEN) return; // already connected
    const sessionId = await findActiveSession(workflowId);
    if (sessionId) {
      connectPreview(sessionId);
    }
  };
  check();
  _pollTimer = setInterval(check, intervalMs);
}

/** Stop session polling. */
export function stopSessionPolling(): void {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

/** Clean up everything. */
export function destroyPreview(): void {
  disconnectPreview();
  stopSessionPolling();
  listeners = [];
  nodePreviews.clear();
}

// --- Internal ---

function notifyListeners(): void {
  for (const fn of listeners) {
    try { fn(); } catch { /* skip */ }
  }
}

function handlePreviewMessage(msg: Record<string, any>): void {
  const now = Date.now();

  if (msg.type === "node_states" && msg.nodes) {
    const workflowId = msg.workflowId;
    const workflow = getWorkflow();
    if (!workflow || workflow.id !== workflowId) return;

    for (const n of msg.nodes) {
      let preview = nodePreviews.get(n.nodeId);
      if (!preview) {
        preview = {
          nodeId: n.nodeId,
          nodeType: n.nodeType,
          label: n.label,
          executionState: n.state,
          numerics: new Map(),
          updated: now,
        };
        nodePreviews.set(n.nodeId, preview);
      }
      preview.executionState = n.state;
      preview.error = n.error;
      preview.updated = now;
    }

    // Remove nodes no longer in the message
    const activeIds = new Set(msg.nodes.map((n: any) => n.nodeId));
    for (const [id] of nodePreviews) {
      if (!activeIds.has(id)) nodePreviews.delete(id);
    }

    notifyListeners();
  }

  if (msg.type === "guidance_event" && msg.event) {
    const evt = msg.event;
    // Map guidance event to source node — events have `source` field matching the appId
    const source = evt.source;
    if (!source) return;

    // Find the node that corresponds to this source
    for (const [, preview] of nodePreviews) {
      if (preview.nodeType.includes("s2s") || preview.nodeType === "jepa-vision" || preview.nodeType === "deepgram-stt") {
        preview.lastText = (evt.content || "").slice(0, 200);
        preview.lastTextTime = now;
        preview.updated = now;
      }
    }
    notifyListeners();
  }

  if (msg.type === "spoken_text" && msg.text) {
    // Spoken text comes from AI — map to running processor nodes
    for (const [, preview] of nodePreviews) {
      if (preview.executionState === "running" && (preview.nodeType.includes("s2s") || preview.nodeType === "local-tts")) {
        preview.lastText = msg.text.slice(0, 200);
        preview.lastTextTime = now;
        preview.updated = now;
      }
    }
    notifyListeners();
  }

  if (msg.type === "publisher_telemetry") {
    // Map telemetry to source nodes
    for (const [, preview] of nodePreviews) {
      if (preview.nodeType === "camera-source") {
        if (msg.fps != null) preview.numerics.set("FPS", { value: msg.fps, unit: "fps", time: now });
        if (msg.encodeMs != null) preview.numerics.set("Encode", { value: msg.encodeMs, unit: "ms", time: now });
        if (msg.frameSize != null) preview.numerics.set("Frame", { value: msg.frameSize, unit: "B", time: now });
        preview.updated = now;
      }
      if (preview.nodeType === "phone-mic-source" || preview.nodeType === "glasses-mic-source") {
        if (msg.audioMode) {
          preview.lastText = `Audio: ${msg.audioMode}`;
          preview.lastTextTime = now;
        }
        preview.updated = now;
      }
    }
    notifyListeners();
  }
}

// --- Preview Rendering ---

/** Render a preview panel section for the selected node. */
export function renderNodePreviewHTML(nodeId: string | null): string {
  if (!nodeId) return "";

  const preview = nodePreviews.get(nodeId);
  if (!preview) return "";

  const stateColor = NODE_STATE_COLORS[preview.executionState] ?? "#9ca3af";
  const stateLabel = STATE_LABELS[preview.executionState] ?? preview.executionState;
  const age = Date.now() - preview.updated;
  const ageLabel = age < 5000 ? "now" : age < 60_000 ? `${Math.round(age / 1000)}s ago` : `${Math.round(age / 60_000)}m ago`;

  let html = `<div class="wf-preview-panel">`;
  html += `<div class="wf-preview-header">
    <span class="wf-preview-dot" style="background:${stateColor}"></span>
    <span class="wf-preview-state" style="color:${stateColor}">${esc(stateLabel)}</span>
    <span class="wf-preview-age">${ageLabel}</span>
  </div>`;

  // Text output
  if (preview.lastText) {
    html += `<div class="wf-preview-text">${esc(preview.lastText)}</div>`;
  }

  // Error
  if (preview.error) {
    html += `<div class="wf-preview-error">${esc(preview.error)}</div>`;
  }

  // Numeric gauges
  if (preview.numerics.size > 0) {
    html += `<div class="wf-preview-numerics">`;
    for (const [label, { value, unit }] of preview.numerics) {
      const formatted = formatNumeric(value, unit);
      const color = gaugeColor(label, value);
      html += `<div class="wf-preview-gauge">
        <span class="wf-preview-gauge-label">${esc(label)}</span>
        <span class="wf-preview-gauge-value" style="color:${color}">${formatted}</span>
      </div>`;
    }
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

// --- Helpers ---

const NODE_STATE_COLORS: Record<string, string> = {
  running: "#50fa7b",
  active: "#50fa7b",
  idle: "#f1fa8c",
  pending: "#f1fa8c",
  waiting: "#38bdf8",
  paused: "#facc15",
  completed: "#60a5fa",
  skipped: "#6b7280",
  errored: "#ff5555",
};

const STATE_LABELS: Record<string, string> = {
  running: "Running",
  active: "Active",
  idle: "Idle",
  pending: "Pending",
  waiting: "Waiting",
  paused: "Paused",
  completed: "Done",
  skipped: "Skipped",
  errored: "Error",
};

function formatNumeric(value: number, unit: string): string {
  const formatted = Math.abs(value) >= 1000
    ? Math.round(value).toString()
    : Math.abs(value) >= 100
      ? value.toFixed(1)
      : value.toFixed(2);
  return unit ? `${formatted} ${unit}` : formatted;
}

function gaugeColor(label: string, value: number): string {
  if (label.includes("CPU")) return value > 80 ? "#f87171" : value > 50 ? "#facc15" : "#4ade80";
  if (label.includes("Encode")) return value > 100 ? "#f87171" : value > 50 ? "#facc15" : "#4ade80";
  if (label.includes("Latency")) return value > 200 ? "#f87171" : value > 100 ? "#facc15" : "#4ade80";
  return "#e2e8f0";
}
