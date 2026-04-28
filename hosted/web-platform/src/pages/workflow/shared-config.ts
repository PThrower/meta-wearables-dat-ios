/**
 * Shared config rendering and event wiring — used by both the full workflow editor
 * config panel and the mini editor config panel. All functions are prefix-parameterized
 * or callback-driven for dependency inversion.
 */

import { esc } from "../../core/api-client.js";
import type { WorkflowNodeDef, ConfigFieldSchema, FlowExecutionConfig, FlowExecutionMode, FlowTrigger, FlowTriggerType, DetectedFlow, WorkflowSettings } from "../../core/api-client.js";
import { DEFAULT_WORKFLOW_SETTINGS } from "../../core/api-client.js";
import { buildDefaultFlowConfig } from "./flow-detection.js";

/* ── Callback interfaces ── */

/** Minimal workflow shape needed by flow config wiring. */
export interface WorkflowLike {
  flowConfig?: FlowExecutionConfig | null;
  nodes: Array<{ id: string; type?: string; label?: string }>;
  edges: Array<{ id: string; sourceNodeId: string; targetNodeId: string }>;
}

/** Callbacks for flow config panel events — no coupling to either editor's state. */
export interface FlowConfigCallbacks {
  getWorkflow: () => WorkflowLike | null;
  setFlowConfig: (config: FlowExecutionConfig) => void;
  setDirty: () => void;
  autoSave: () => void;
  rerender: () => void;
  onBack?: () => void;
  getSVGContainer?: () => Element | null;
}

/** Callbacks for config field change events. */
export interface ConfigFieldCallbacks {
  getWorkflow: () => { nodes: WorkflowNodeDef[] } | null;
  getSelectedNodeId: () => string | null;
  setDirty: () => void;
  autoSave: () => void;
  refreshSVG: () => void;
}

/* ── Config field rendering ── */

/** Render a single config field based on its schema kind. */
export function renderConfigField(field: ConfigFieldSchema, node: WorkflowNodeDef, prefix: string): string {
  switch (field.kind) {
    case "text": {
      const val = field.key === "label" ? node.label : String(node.config[field.key] ?? "");
      const dataField = field.key === "label" ? "label" : `config.${field.key}`;
      return `<div class="${prefix}-field"><label>${esc(field.label)}</label><input type="text" class="${prefix}-input" data-field="${dataField}" value="${esc(val)}" ${field.placeholder ? `placeholder="${esc(field.placeholder)}"` : ""} /></div>`;
    }
    case "textarea": {
      const val = String(node.config[field.key] ?? "");
      return `<div class="${prefix}-field"><label>${esc(field.label)}</label><textarea class="${prefix}-input ${prefix}-textarea" data-field="config.${field.key}" rows="${field.rows ?? 4}" ${field.placeholder ? `placeholder="${esc(field.placeholder)}"` : ""}>${esc(val)}</textarea></div>`;
    }
    case "select": {
      const val = String(node.config[field.key] ?? "");
      const options = field.options.map(o => `<option value="${esc(o.value)}" ${val === o.value ? "selected" : ""}>${esc(o.label)}</option>`).join("");
      return `<div class="${prefix}-field"><label>${esc(field.label)}</label><select class="${prefix}-input" data-field="config.${field.key}">${options}</select></div>`;
    }
    case "range": {
      const val = (node.config[field.key] as number) ?? field.min;
      return `<div class="${prefix}-field"><label>${esc(field.label)}: ${val}${field.unit ?? ""}</label><input type="range" min="${field.min}" max="${field.max}" step="${field.step}" data-field="config.${field.key}" value="${val}" /></div>`;
    }
    case "checkbox": {
      const checked = node.config[field.key] === true;
      return `<div class="${prefix}-field"><label><input type="checkbox" data-field="config.${field.key}" ${checked ? "checked" : ""} /> ${esc(field.label)}</label></div>`;
    }
    case "checkbox-group": {
      const checks = field.fields.map(f => {
        const checked = node.config[f.key] !== false;
        return `<label><input type="checkbox" data-field="config.${f.key}" ${checked ? "checked" : ""} /> ${esc(f.label)}</label>`;
      }).join("");
      return `<div class="${prefix}-field"><label>${esc(field.label)}</label><div class="${prefix}-checks">${checks}</div></div>`;
    }
    case "number": {
      const val = (node.config[field.key] as number) ?? 0;
      return `<div class="${prefix}-field"><label>${esc(field.label)}</label><input type="number" class="${prefix}-input" data-field="config.${field.key}" min="${field.min ?? ""}" max="${field.max ?? ""}" step="${field.step ?? 1}" value="${val}" /></div>`;
    }
    case "section": {
      const inner = field.fields.map(f => renderConfigField(f, node, prefix)).join("");
      return `<div class="${prefix}-field" style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #333;"><label style="font-weight: 600; margin-bottom: 6px; display: block;">${esc(field.label)}</label>${inner}</div>`;
    }
  }
}

/* ── Workflow settings callbacks ── */

/** Callbacks for workflow settings panel events. */
export interface SettingsCallbacks {
  getWorkflow: () => { settings?: WorkflowSettings | null } | null;
  setSettings: (settings: WorkflowSettings) => void;
  setDirty: () => void;
  autoSave: () => void;
  onBack?: () => void;
}

/* ── Workflow settings schema ── */

const WORKFLOW_SETTINGS_SCHEMA: ConfigFieldSchema[] = [
  {
    kind: "section", label: "Lifecycle Policy", fields: [
      { kind: "select", key: "onDisconnect", label: "On Disconnect", options: [
        { value: "stop", label: "Stop session" },
        { value: "pause", label: "Pause session" },
        { value: "continue", label: "Continue running" },
      ] },
      { kind: "select", key: "onReconnect", label: "On Reconnect", options: [
        { value: "restart", label: "Restart session" },
        { value: "resume", label: "Resume paused" },
        { value: "noop", label: "No action" },
      ] },
      { kind: "number", key: "autoDeactivateMin", label: "Auto-Deactivate (min, 0 = never)", min: 0, max: 480, step: 5 },
    ],
  },
  {
    kind: "section", label: "Session Limits", fields: [
      { kind: "number", key: "maxSessionDuration", label: "Max Duration (min, 0 = unlimited)", min: 0, max: 1440, step: 5 },
    ],
  },
  {
    kind: "section", label: "Access & Privacy", fields: [
      { kind: "select", key: "viewerAccess", label: "Viewer Access", options: [
        { value: "owner", label: "Owner only" },
        { value: "team", label: "Team members" },
        { value: "public", label: "Public" },
      ] },
      { kind: "checkbox", key: "recordingEnabled", label: "Enable Recording" },
    ],
  },
  {
    kind: "section", label: "Telemetry", fields: [
      { kind: "number", key: "telemetryIntervalSec", label: "Interval (seconds)", min: 1, max: 60, step: 1 },
    ],
  },
  {
    kind: "section", label: "Device Wake & Stream", fields: [
      { kind: "checkbox", key: "wakeOnActivate", label: "Push notification on activate (APNs wake)" },
      { kind: "checkbox", key: "autoStartStream", label: "Auto-start stream when publisher connects" },
      { kind: "select", key: "targetDeviceId", label: "Target Device", options: [
        { value: "", label: "Auto-detect" },
      ] },
    ],
  },
];

/** Update the targetDeviceId select options from fleet devices. */
export function updateDeviceOptions(devices: Array<{ id: string; name: string | null; model: string | null }>): void {
  const deviceSection = WORKFLOW_SETTINGS_SCHEMA.find(s => s.kind === "section" && s.label === "Device Wake & Stream");
  if (!deviceSection || deviceSection.kind !== "section") return;
  const field = deviceSection.fields.find(f => f.kind === "select" && "key" in f && f.key === "targetDeviceId");
  if (!field || field.kind !== "select") return;
  field.options = [
    { value: "", label: "Auto-detect" },
    ...devices.map(d => ({
      value: d.id,
      label: `${d.name || d.model || d.id.slice(0, 8)}`,
    })),
  ];
}

/** Render workflow settings HTML using the synthetic-node trick. */
export function renderWorkflowSettingsHTML(settings: WorkflowSettings | null): string {
  const merged = { ...DEFAULT_WORKFLOW_SETTINGS, ...settings };
  // Synthetic node where config = settings object — reuses renderConfigField()
  const syntheticNode: WorkflowNodeDef = {
    id: "__settings__",
    type: "__settings__",
    label: "",
    config: merged as unknown as Record<string, unknown>,
    positionX: 0,
    positionY: 0,
  };
  const fieldsHtml = WORKFLOW_SETTINGS_SCHEMA.map(field => renderConfigField(field, syntheticNode, "wf-settings")).join("");
  return `<div class="wf-settings-panel">
    <div class="wf-flow-config-header">
      <span class="wf-flow-config-title">Workflow Settings</span>
      <span class="wf-flow-config-count">Global</span>
    </div>
    ${fieldsHtml}
    <button class="wf-flow-back" id="wf-settings-back">&larr; Back</button>
  </div>`;
}

/** Wire workflow settings field inputs. */
export function wireSettingsFieldInputs(container: Element, callbacks: SettingsCallbacks): void {
  container.querySelectorAll("[data-field]").forEach(input => {
    input.addEventListener("change", () => {
      const wf = callbacks.getWorkflow();
      if (!wf) return;
      const current = { ...DEFAULT_WORKFLOW_SETTINGS, ...wf.settings };
      const el = input as HTMLInputElement;
      const field = el.dataset.field!;
      if (!field.startsWith("config.")) return;
      const key = field.slice(7);

      if (el.type === "checkbox") (current as any)[key] = el.checked;
      else if (el.type === "number") (current as any)[key] = el.value === "" ? null : parseFloat(el.value);
      else (current as any)[key] = el.value;

      callbacks.setSettings(current);
      callbacks.setDirty();
      callbacks.autoSave();
    });
  });

  // Back button
  container.querySelector("#wf-settings-back")?.addEventListener("click", () => callbacks.onBack?.());
}

/* ── Flow config rendering ── */

/** Render flow config HTML. Both editors share wf-flow-* CSS classes. */
export function renderFlowConfigHTML(
  flows: DetectedFlow[],
  config: FlowExecutionConfig | null,
  prefix: string,
  opts?: { showBack?: boolean },
): string {
  const effectiveConfig = config ?? buildDefaultFlowConfig(flows);
  const mode: FlowExecutionMode = effectiveConfig?.mode ?? "parallel";
  const flowOrder: string[] = effectiveConfig?.flowOrder ?? flows.map(f => f.flowId);
  const flowTriggers = effectiveConfig?.flowTriggers ?? {};

  const flowList = flowOrder.map(fid => {
    const f = flows.find(fl => fl.flowId === fid);
    if (!f) return "";
    const triggerRow = mode === "event-driven"
      ? renderFlowTriggerField(fid, flows, flowTriggers[fid])
      : "";
    return `<div class="wf-flow-order-item" data-flow-id="${f.flowId}" draggable="${mode === "sequential"}">
      <span class="wf-flow-drag-handle">${mode === "sequential" ? "⋮⋮" : "●"}</span>
      <span class="wf-flow-color-dot" style="background:${f.color}"></span>
      <span class="wf-flow-label">${esc(f.label)}</span>
      ${triggerRow}
    </div>`;
  }).join("");

  return `<div class="wf-flow-config">
    <div class="wf-flow-config-header">
      <span class="wf-flow-config-title">Flows</span>
      <span class="wf-flow-config-count">${flows.length} found</span>
    </div>
    <div class="wf-flow-mode-selector">
      <button class="wf-flow-mode-btn ${mode === "parallel" ? "active" : ""}" data-mode="parallel">Parallel</button>
      <button class="wf-flow-mode-btn ${mode === "sequential" ? "active" : ""}" data-mode="sequential">Sequential</button>
      <button class="wf-flow-mode-btn ${mode === "event-driven" ? "active" : ""}" data-mode="event-driven">Event-Driven</button>
    </div>
    <div class="wf-flow-order ${mode === "parallel" ? "disabled" : ""}" id="${prefix}-flow-order">
      ${flowList}
    </div>
    ${opts?.showBack ? `<button class="wf-flow-back" id="wf-flow-back">&larr; Back</button>` : ""}
  </div>`;
}

/** Render trigger config for a single flow in event-driven mode */
function renderFlowTriggerField(flowId: string, flows: DetectedFlow[], trigger?: FlowTrigger): string {
  const triggerType = trigger?.type ?? "";
  const otherFlows = flows.filter(f => f.flowId !== flowId);

  const typeOptions = [
    { value: "", label: "Start immediately" },
    { value: "on_flow_complete", label: "On flow complete" },
    { value: "on_condition", label: "On condition" },
    { value: "on_timer", label: "On timer" },
    { value: "on_jepa_event", label: "On JEPA event" },
  ].map(o => `<option value="${o.value}" ${triggerType === o.value ? "selected" : ""}>${o.label}</option>`).join("");

  let subFields = "";

  if (triggerType === "on_flow_complete" || triggerType === "on_condition") {
    const sourceFlowOptions = otherFlows.map(f =>
      `<option value="${f.flowId}" ${trigger?.sourceFlowId === f.flowId || trigger?.condition?.sourceFlowId === f.flowId ? "selected" : ""}>${esc(f.label)}</option>`
    ).join("");
    subFields += `<select class="wf-trigger-subfield" data-trigger-field="sourceFlowId" data-flow-id="${flowId}">
      <option value="">Select source flow</option>${sourceFlowOptions}
    </select>`;
  }

  if (triggerType === "on_condition") {
    const cond = trigger?.condition;
    const operators = [
      { value: "gt", label: ">" }, { value: "gte", label: ">=" },
      { value: "lt", label: "<" }, { value: "lte", label: "<=" },
      { value: "eq", label: "==" }, { value: "neq", label: "!=" },
    ].map(o => `<option value="${o.value}" ${cond?.operator === o.value ? "selected" : ""}>${o.label}</option>`).join("");

    subFields += `<input type="text" class="wf-trigger-subfield" data-trigger-field="conditionField" data-flow-id="${flowId}" placeholder="Field name" value="${esc(cond?.field ?? "")}" />`;
    subFields += `<select class="wf-trigger-subfield" data-trigger-field="conditionOperator" data-flow-id="${flowId}">${operators}</select>`;
    subFields += `<input type="number" class="wf-trigger-subfield" data-trigger-field="conditionValue" data-flow-id="${flowId}" placeholder="Value" value="${cond?.value ?? ""}" step="any" />`;
  }

  if (triggerType === "on_timer") {
    subFields += `<input type="number" class="wf-trigger-subfield" data-trigger-field="intervalSec" data-flow-id="${flowId}" placeholder="Interval (seconds)" value="${trigger?.intervalSec ?? ""}" min="1" step="1" />`;
  }

  if (triggerType === "on_jepa_event") {
    const eventOptions = [
      { value: "any", label: "Any event" },
      { value: "anomaly", label: "Anomaly" },
      { value: "action", label: "Action" },
    ].map(o => `<option value="${o.value}" ${trigger?.jepaEvent === o.value ? "selected" : ""}>${o.label}</option>`).join("");
    subFields += `<select class="wf-trigger-subfield" data-trigger-field="jepaEvent" data-flow-id="${flowId}">${eventOptions}</select>`;
    subFields += `<input type="number" class="wf-trigger-subfield" data-trigger-field="jepaConfidenceThreshold" data-flow-id="${flowId}" placeholder="Min confidence" value="${trigger?.jepaConfidenceThreshold ?? ""}" min="0" max="1" step="0.1" />`;
  }

  return `<div class="wf-flow-trigger-row" data-flow-id="${flowId}">
    <select class="wf-trigger-type" data-flow-id="${flowId}">${typeOptions}</select>
    ${subFields ? `<div class="wf-trigger-subfields">${subFields}</div>` : ""}
  </div>`;
}

/* ── Flow config event wiring ── */

/** Wire flow config panel events — mode toggle, drag reorder, hover highlight, trigger config, back button. */
export function wireFlowConfigEvents(panel: Element, flows: DetectedFlow[], callbacks: FlowConfigCallbacks): void {
  // Mode toggle
  panel.querySelectorAll(".wf-flow-mode-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const mode = (btn as HTMLElement).dataset.mode as FlowExecutionMode;
      const workflow = callbacks.getWorkflow();
      if (!workflow) return;
      const currentConfig = workflow.flowConfig ?? buildDefaultFlowConfig(flows);
      callbacks.setFlowConfig({
        mode,
        flowOrder: currentConfig?.flowOrder ?? flows.map(f => f.flowId),
        flowTriggers: mode === "event-driven" ? (currentConfig as any)?.flowTriggers ?? {} : undefined,
      });
      callbacks.setDirty();
      callbacks.autoSave();
      callbacks.rerender();
    });
  });

  // Trigger type dropdown change — re-render sub-fields
  wireFlowTriggerEvents(panel, flows, callbacks);

  // Back button (optional — only rendered when showBack is true)
  panel.querySelector("#wf-flow-back")?.addEventListener("click", () => callbacks.onBack?.());

  // Drag-and-drop reorder
  const orderEl = panel.querySelector(".wf-flow-order");
  if (orderEl) {
    let draggedId: string | null = null;

    orderEl.querySelectorAll(".wf-flow-order-item").forEach(item => {
      item.addEventListener("dragstart", (e) => {
        draggedId = (item as HTMLElement).dataset.flowId ?? null;
        item.classList.add("dragging");
        (e as DragEvent).dataTransfer!.effectAllowed = "move";
      });

      item.addEventListener("dragend", () => {
        item.classList.remove("dragging");
        draggedId = null;
        if (callbacks.getSVGContainer) clearFlowHighlight(callbacks);
      });

      item.addEventListener("dragover", (e) => {
        e.preventDefault();
        (e as DragEvent).dataTransfer!.dropEffect = "move";
      });

      item.addEventListener("drop", (e) => {
        e.preventDefault();
        const targetId = (item as HTMLElement).dataset.flowId;
        if (!draggedId || !targetId || draggedId === targetId) return;
        const workflow = callbacks.getWorkflow();
        if (!workflow?.flowConfig) return;
        const order = [...workflow.flowConfig.flowOrder];
        const fromIdx = order.indexOf(draggedId);
        const toIdx = order.indexOf(targetId);
        if (fromIdx < 0 || toIdx < 0) return;
        order.splice(fromIdx, 1);
        order.splice(toIdx, 0, draggedId);
        callbacks.setFlowConfig({ ...workflow.flowConfig, flowOrder: order });
        callbacks.setDirty();
        callbacks.autoSave();
        callbacks.rerender();
      });

      // Hover highlighting (only when SVG container provided)
      if (callbacks.getSVGContainer) {
        item.addEventListener("mouseenter", () => {
          const flowId = (item as HTMLElement).dataset.flowId;
          if (flowId) highlightFlow(flowId, flows, callbacks);
        });

        item.addEventListener("mouseleave", () => {
          clearFlowHighlight(callbacks);
        });
      }
    });
  }
}

/** Highlight a flow's nodes/edges on the SVG canvas, dimming everything else. */
function highlightFlow(flowId: string, flows: DetectedFlow[], callbacks: FlowConfigCallbacks): void {
  const svgEl = callbacks.getSVGContainer?.();
  if (!svgEl) return;
  const flow = flows.find(f => f.flowId === flowId);
  if (!flow) return;
  const nodeIds = new Set(flow.nodeIds);
  const edgeIds = new Set(flow.edgeIds);

  svgEl.classList.add("wf-flow-highlight-active");

  svgEl.querySelectorAll(".wf-node[data-flow-id]").forEach(node => {
    if (nodeIds.has((node as HTMLElement).dataset.flowId!)) {
      (node as HTMLElement).style.opacity = "1";
    }
  });

  svgEl.querySelectorAll(".wf-edge").forEach(edge => {
    if (edgeIds.has((edge as HTMLElement).dataset.id!)) {
      (edge as HTMLElement).style.opacity = "1";
    }
  });
}

/** Clear flow highlight from SVG canvas. */
function clearFlowHighlight(callbacks: FlowConfigCallbacks): void {
  const svgEl = callbacks.getSVGContainer?.();
  if (!svgEl) return;
  svgEl.classList.remove("wf-flow-highlight-active");
  svgEl.querySelectorAll(".wf-node, .wf-edge").forEach(el => {
    (el as HTMLElement).style.opacity = "";
  });
}

/* ── Config field event wiring ── */

/** Wire config field change events. */
export function wireConfigFieldInputs(container: Element, callbacks: ConfigFieldCallbacks): void {
  container.querySelectorAll("[data-field]").forEach(input => {
    input.addEventListener("change", () => {
      const wf = callbacks.getWorkflow();
      const selId = callbacks.getSelectedNodeId();
      if (!wf || !selId) return;
      const n = wf.nodes.find(n => n.id === selId);
      if (!n) return;
      const field = (input as HTMLElement).dataset.field!;
      const el = input as HTMLInputElement;
      if (field.startsWith("config.")) {
        const key = field.slice(7);
        if (el.type === "range") n.config[key] = parseFloat(el.value);
        else if (el.type === "checkbox") n.config[key] = el.checked;
        else if (el.type === "number") n.config[key] = parseFloat(el.value);
        else n.config[key] = el.value;
      } else {
        (n as any)[field] = el.value;
      }
      callbacks.setDirty();
      callbacks.autoSave();
      callbacks.refreshSVG();
    });
  });
}

/* ── Flow trigger event wiring ── */

/** Wire trigger type dropdown and sub-field change events */
function wireFlowTriggerEvents(panel: Element, flows: DetectedFlow[], callbacks: FlowConfigCallbacks): void {
  // Trigger type dropdown
  panel.querySelectorAll(".wf-trigger-type").forEach(sel => {
    sel.addEventListener("change", () => {
      const flowId = (sel as HTMLElement).dataset.flowId!;
      const triggerType = (sel as HTMLSelectElement).value as FlowTriggerType | "";
      const workflow = callbacks.getWorkflow();
      if (!workflow?.flowConfig) return;

      const currentTriggers = { ...(workflow.flowConfig as any).flowTriggers };

      if (!triggerType) {
        delete currentTriggers[flowId];
      } else {
        currentTriggers[flowId] = { type: triggerType };
      }

      callbacks.setFlowConfig({
        ...workflow.flowConfig,
        flowTriggers: currentTriggers,
      });
      callbacks.setDirty();
      callbacks.autoSave();
      callbacks.rerender();
    });
  });

  // Trigger sub-field changes
  panel.querySelectorAll(".wf-trigger-subfield").forEach(input => {
    input.addEventListener("change", () => {
      const el = input as HTMLInputElement | HTMLSelectElement;
      const flowId = el.dataset.flowId!;
      const field = el.dataset.triggerField!;
      const workflow = callbacks.getWorkflow();
      if (!workflow?.flowConfig) return;

      const currentTriggers = { ...((workflow.flowConfig as any).flowTriggers ?? {}) };
      const currentTrigger: FlowTrigger = currentTriggers[flowId] ?? { type: "" as FlowTriggerType };
      currentTriggers[flowId] = currentTrigger;

      switch (field) {
        case "sourceFlowId":
          currentTrigger.sourceFlowId = el.value;
          break;
        case "conditionField":
          if (!currentTrigger.condition) currentTrigger.condition = { sourceFlowId: "", field: "", operator: "gt", value: 0 };
          currentTrigger.condition.field = el.value;
          break;
        case "conditionOperator":
          if (!currentTrigger.condition) currentTrigger.condition = { sourceFlowId: "", field: "", operator: "gt", value: 0 };
          currentTrigger.condition.operator = el.value as FlowTrigger["condition"] extends infer C | undefined ? C extends { operator: infer O } ? O : never : never;
          break;
        case "conditionValue":
          if (!currentTrigger.condition) currentTrigger.condition = { sourceFlowId: "", field: "", operator: "gt", value: 0 };
          currentTrigger.condition.value = parseFloat(el.value) || 0;
          break;
        case "intervalSec":
          currentTrigger.intervalSec = parseFloat(el.value) || 1;
          break;
        case "jepaEvent":
          currentTrigger.jepaEvent = el.value as "anomaly" | "action" | "any";
          break;
        case "jepaConfidenceThreshold":
          currentTrigger.jepaConfidenceThreshold = parseFloat(el.value) || 0;
          break;
      }

      callbacks.setFlowConfig({
        ...workflow.flowConfig,
        flowTriggers: currentTriggers,
      });
      callbacks.setDirty();
      callbacks.autoSave();
    });
  });
}
