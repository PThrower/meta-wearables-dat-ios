/**
 * flow-config-panel.ts — Flow config panel primitives.
 *
 * Three injectable primitives:
 *   render  — data → HTML string
 *   wire    — HTML → event handlers
 *   inject  — HTML → DOM
 *
 * Style tokens centralized here. No external CSS dependency.
 */

import { esc } from "../../core/api-client.js";
import type { DetectedFlow, FlowExecutionConfig, FlowExecutionMode, FlowTrigger, FlowTriggerType } from "../../core/workflow-types.js";
import { buildDefaultFlowConfig } from "./flow-detection.js";
import type { FlowConfigCallbacks } from "./types.js";

/* ── Style tokens ── */

const S = {
  /** Active mode button — cyan accent */
  btnActive: `flex:1;padding:6px 8px;font-size:11px;border-radius:6px;cursor:pointer;text-align:center;transition:all 0.15s;background:rgba(0,255,255,0.18);border:1px solid rgba(0,255,255,0.5);color:#0ff;font-weight:600;`,
  /** Inactive mode button */
  btnInactive: `flex:1;padding:6px 8px;font-size:11px;border-radius:6px;cursor:pointer;text-align:center;transition:all 0.15s;background:var(--bg-surface-alt);border:1px solid var(--border);color:var(--text-secondary);`,
  /** Flow order item row */
  item: (draggable: boolean) =>
    `display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--bg-surface-alt);border:1px solid var(--border);border-radius:6px;cursor:${draggable ? "grab" : "default"};font-size:13px;color:var(--text-primary);`,
  /** Drag handle icon */
  handle: (draggable: boolean) =>
    `cursor:${draggable ? "grab" : "default"};color:var(--text-tertiary);user-select:none;font-size:14px;`,
  /** Color dot — 12px with subtle glow */
  dot: (color: string) =>
    `width:12px;height:12px;border-radius:50%;background:${color};flex-shrink:0;box-shadow:0 0 6px ${color}40;`,
  /** Section container */
  section: `padding-bottom:14px;margin-bottom:14px;border-bottom:1px solid var(--border);`,
  /** Header row */
  header: `display:flex;align-items:center;justify-content:space-between;padding-bottom:10px;border-bottom:1px solid var(--border);margin-bottom:10px;`,
  /** Mode button row */
  modeRow: `display:flex;gap:4px;width:100%;margin-bottom:10px;`,
  /** Flow list container — dimmed when parallel (no reorder) */
  list: (active: boolean) =>
    `display:flex;flex-direction:column;gap:6px;${active ? "" : "opacity:0.5;pointer-events:none;"}`,
};

/* ── PRIMITIVE 1: render — pure data → HTML ── */

/** Render one mode button. */
export function modeButton(mode: FlowExecutionMode, current: FlowExecutionMode): string {
  const active = mode === current;
  return `<button class="wf-flow-mode-btn ${active ? "active" : ""}" data-mode="${mode}" style="${active ? S.btnActive : S.btnInactive}">${mode === "event-driven" ? "Event-Driven" : mode.charAt(0).toUpperCase() + mode.slice(1)}</button>`;
}

/** Render one flow order item. */
export function flowItem(flow: DetectedFlow, draggable: boolean): string {
  return `<div class="wf-flow-order-item" data-flow-id="${flow.flowId}" draggable="${draggable}" style="${S.item(draggable)}">
  <span class="wf-flow-drag-handle" style="${S.handle(draggable)}">${draggable ? "⋮⋮" : "●"}</span>
  <span class="wf-flow-color-dot" style="${S.dot(flow.color)}"></span>
  <span class="wf-flow-label">${esc(flow.label)}</span>
</div>`;
}

/** Render trigger config for event-driven mode. */
export function triggerField(flowId: string, flows: DetectedFlow[], trigger?: FlowTrigger): string {
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
    const src = otherFlows.map(f =>
      `<option value="${f.flowId}" ${trigger?.sourceFlowId === f.flowId || trigger?.condition?.sourceFlowId === f.flowId ? "selected" : ""}>${esc(f.label)}</option>`
    ).join("");
    subFields += `<select class="wf-trigger-subfield" data-trigger-field="sourceFlowId" data-flow-id="${flowId}">
      <option value="">Select source flow</option>${src}
    </select>`;
  }

  if (triggerType === "on_condition") {
    const cond = trigger?.condition;
    const ops = [
      { value: "gt", label: ">" }, { value: "gte", label: ">=" },
      { value: "lt", label: "<" }, { value: "lte", label: "<=" },
      { value: "eq", label: "==" }, { value: "neq", label: "!=" },
    ].map(o => `<option value="${o.value}" ${cond?.operator === o.value ? "selected" : ""}>${o.label}</option>`).join("");
    subFields += `<input type="text" class="wf-trigger-subfield" data-trigger-field="conditionField" data-flow-id="${flowId}" placeholder="Field name" value="${esc(cond?.field ?? "")}" />`;
    subFields += `<select class="wf-trigger-subfield" data-trigger-field="conditionOperator" data-flow-id="${flowId}">${ops}</select>`;
    subFields += `<input type="number" class="wf-trigger-subfield" data-trigger-field="conditionValue" data-flow-id="${flowId}" placeholder="Value" value="${cond?.value ?? ""}" step="any" />`;
  }

  if (triggerType === "on_timer") {
    subFields += `<input type="number" class="wf-trigger-subfield" data-trigger-field="intervalSec" data-flow-id="${flowId}" placeholder="Interval (seconds)" value="${trigger?.intervalSec ?? ""}" min="1" step="1" />`;
  }

  if (triggerType === "on_jepa_event") {
    const evOpts = [
      { value: "any", label: "Any event" },
      { value: "anomaly", label: "Anomaly" },
      { value: "action", label: "Action" },
    ].map(o => `<option value="${o.value}" ${trigger?.jepaEvent === o.value ? "selected" : ""}>${o.label}</option>`).join("");
    subFields += `<select class="wf-trigger-subfield" data-trigger-field="jepaEvent" data-flow-id="${flowId}">${evOpts}</select>`;
    subFields += `<input type="number" class="wf-trigger-subfield" data-trigger-field="jepaConfidenceThreshold" data-flow-id="${flowId}" placeholder="Min confidence" value="${trigger?.jepaConfidenceThreshold ?? ""}" min="0" max="1" step="0.1" />`;
  }

  return `<div class="wf-flow-trigger-row" data-flow-id="${flowId}">
    <select class="wf-trigger-type" data-flow-id="${flowId}">${typeOptions}</select>
    ${subFields ? `<div class="wf-trigger-subfields">${subFields}</div>` : ""}
  </div>`;
}

/** Render one flow item WITH trigger row (event-driven mode). */
export function flowItemWithTrigger(flow: DetectedFlow, flows: DetectedFlow[], trigger?: FlowTrigger): string {
  const triggerRow = triggerField(flow.flowId, flows, trigger);
  return `<div class="wf-flow-order-item" data-flow-id="${flow.flowId}" draggable="false" style="${S.item(false)}">
  <span class="wf-flow-drag-handle" style="${S.handle(false)}">●</span>
  <span class="wf-flow-color-dot" style="${S.dot(flow.color)}"></span>
  <span class="wf-flow-label">${esc(flow.label)}</span>
  ${triggerRow}
</div>`;
}

/**
 * Render the full flow config panel.
 * Shows flow summary for single-flow, full config for multi-flow.
 */
export function render(flows: DetectedFlow[], config: FlowExecutionConfig | null | undefined, opts?: { showBack?: boolean }): string {
  if (flows.length === 0) return "";

  // Single-flow: show summary
  if (flows.length === 1) {
    const f = flows[0];
    return `<div style="${S.section}">
  <div style="${S.header}">
    <span style="font-size:13px;font-weight:600;color:var(--text-primary);">Flows</span>
    <span style="font-size:11px;color:var(--text-secondary);">1 found</span>
  </div>
  <div style="${S.item(false)}">
    <span style="${S.dot(f.color)}"></span>
    <span class="wf-flow-label">${esc(f.label)}</span>
    <span style="font-size:11px;color:var(--text-tertiary);margin-left:auto">${f.nodeIds.length} nodes</span>
  </div>
</div>`;
  }

  const effectiveConfig = config ?? buildDefaultFlowConfig(flows);
  const mode: FlowExecutionMode = effectiveConfig?.mode ?? "parallel";
  // Flow IDs are derived from node IDs (flow_${lexicographically-smallest-node-id}).
  // When nodes are added/removed/reconnected, detected flow IDs change, but the
  // persisted flowConfig.flowOrder may still contain stale IDs from a previous
  // workflow state. Without this filter, flows.find() fails for every stale ID,
  // producing empty strings instead of flow item cards — header renders, items don't.
  const validFlowIds = new Set(flows.map(f => f.flowId));
  const savedOrder = effectiveConfig?.flowOrder ?? [];
  const flowOrder: string[] = [
    ...savedOrder.filter(id => validFlowIds.has(id)),          // keep valid saved IDs (preserves user reorder)
    ...flows.filter(f => !savedOrder.includes(f.flowId)).map(f => f.flowId),  // append newly detected flows
  ];
  const flowTriggers = effectiveConfig?.flowTriggers ?? {};
  const isDraggable = mode === "sequential";

  const modes: FlowExecutionMode[] = ["parallel", "sequential", "event-driven"];
  const buttons = modes.map(m => modeButton(m, mode)).join("");

  const items = flowOrder.map(fid => {
    const f = flows.find(fl => fl.flowId === fid);
    if (!f) return "";
    if (mode === "event-driven") return flowItemWithTrigger(f, flows, flowTriggers[fid]);
    return flowItem(f, isDraggable);
  }).join("");

  return `<div style="${S.section}">
  <div style="${S.header}">
    <span style="font-size:13px;font-weight:600;color:var(--text-primary);">Flows</span>
    <span style="font-size:11px;color:var(--text-secondary);">${flows.length} found</span>
  </div>
  <div class="wf-flow-mode-selector" style="${S.modeRow}">
    ${buttons}
  </div>
  <div class="wf-flow-order ${mode === "parallel" ? "disabled" : ""}" id="wf-flow-order" style="${S.list(mode !== "parallel")}">
    ${items}
  </div>
  ${opts?.showBack ? `<button class="wf-flow-back" id="wf-flow-back" style="margin-top:8px;width:100%;padding:6px;font-size:12px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:4px;color:var(--text-secondary,rgba(255,255,255,0.6));cursor:pointer;">&larr; Back</button>` : ""}
</div>`;
}

/* ── PRIMITIVE 2: wire — attach event handlers to rendered DOM ── */

/** Wire mode toggle buttons. */
export function wireModeToggle(root: Element, flows: DetectedFlow[], cb: FlowConfigCallbacks): void {
  root.querySelectorAll(".wf-flow-mode-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const mode = (btn as HTMLElement).dataset.mode as FlowExecutionMode;
      const wf = cb.getWorkflow();
      if (!wf) return;
      const current = wf.flowConfig ?? buildDefaultFlowConfig(flows);
      cb.setFlowConfig({
        mode,
        flowOrder: current?.flowOrder ?? flows.map(f => f.flowId),
        flowTriggers: mode === "event-driven" ? (current as any)?.flowTriggers ?? {} : undefined,
      });
      cb.setDirty();
      cb.autoSave();
      cb.rerender();
    });
  });
}

/** Wire drag-and-drop reorder. */
export function wireDragReorder(root: Element, flows: DetectedFlow[], cb: FlowConfigCallbacks): void {
  const orderEl = root.querySelector(".wf-flow-order");
  if (!orderEl) return;

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
      if (cb.getSVGContainer) clearHighlight(cb);
    });

    item.addEventListener("dragover", (e) => {
      e.preventDefault();
      (e as DragEvent).dataTransfer!.dropEffect = "move";
    });

    item.addEventListener("drop", (e) => {
      e.preventDefault();
      const targetId = (item as HTMLElement).dataset.flowId;
      if (!draggedId || !targetId || draggedId === targetId) return;
      const wf = cb.getWorkflow();
      if (!wf?.flowConfig) return;
      const order = [...wf.flowConfig.flowOrder];
      const fromIdx = order.indexOf(draggedId);
      const toIdx = order.indexOf(targetId);
      if (fromIdx < 0 || toIdx < 0) return;
      order.splice(fromIdx, 1);
      order.splice(toIdx, 0, draggedId);
      cb.setFlowConfig({ ...wf.flowConfig, flowOrder: order });
      cb.setDirty();
      cb.autoSave();
      cb.rerender();
    });

    // Hover highlight
    if (cb.getSVGContainer) {
      item.addEventListener("mouseenter", () => {
        const fid = (item as HTMLElement).dataset.flowId;
        if (fid) highlightFlow(fid, flows, cb);
      });
      item.addEventListener("mouseleave", () => clearHighlight(cb));
    }
  });
}

/** Wire trigger type + sub-field changes. */
export function wireTriggers(root: Element, flows: DetectedFlow[], cb: FlowConfigCallbacks): void {
  // Trigger type dropdown
  root.querySelectorAll(".wf-trigger-type").forEach(sel => {
    sel.addEventListener("change", () => {
      const flowId = (sel as HTMLElement).dataset.flowId!;
      const triggerType = (sel as HTMLSelectElement).value as FlowTriggerType | "";
      const wf = cb.getWorkflow();
      if (!wf?.flowConfig) return;
      const triggers = { ...((wf.flowConfig as any).flowTriggers ?? {}) };
      if (!triggerType) delete triggers[flowId];
      else triggers[flowId] = { type: triggerType };
      cb.setFlowConfig({ ...wf.flowConfig, flowTriggers: triggers });
      cb.setDirty();
      cb.autoSave();
      cb.rerender();
    });
  });

  // Sub-fields
  root.querySelectorAll(".wf-trigger-subfield").forEach(input => {
    input.addEventListener("change", () => {
      const el = input as HTMLInputElement | HTMLSelectElement;
      const flowId = el.dataset.flowId!;
      const field = el.dataset.triggerField!;
      const wf = cb.getWorkflow();
      if (!wf?.flowConfig) return;
      const triggers = { ...((wf.flowConfig as any).flowTriggers ?? {}) };
      const t: FlowTrigger = triggers[flowId] ?? { type: "" as FlowTriggerType };
      triggers[flowId] = t;

      switch (field) {
        case "sourceFlowId": t.sourceFlowId = el.value; break;
        case "conditionField":
          if (!t.condition) t.condition = { sourceFlowId: "", field: "", operator: "gt", value: 0 };
          t.condition.field = el.value; break;
        case "conditionOperator":
          if (!t.condition) t.condition = { sourceFlowId: "", field: "", operator: "gt", value: 0 };
          t.condition.operator = el.value as any; break;
        case "conditionValue":
          if (!t.condition) t.condition = { sourceFlowId: "", field: "", operator: "gt", value: 0 };
          t.condition.value = parseFloat(el.value) || 0; break;
        case "intervalSec": t.intervalSec = parseFloat(el.value) || 1; break;
        case "jepaEvent": t.jepaEvent = el.value as "anomaly" | "action" | "any"; break;
        case "jepaConfidenceThreshold": t.jepaConfidenceThreshold = parseFloat(el.value) || 0; break;
      }

      cb.setFlowConfig({ ...wf.flowConfig, flowTriggers: triggers });
      cb.setDirty();
      cb.autoSave();
    });
  });
}

/** Wire hover highlight for flow items. */
export function wireHoverHighlight(root: Element, flows: DetectedFlow[], cb: FlowConfigCallbacks): void {
  if (!cb.getSVGContainer) return;
  root.querySelectorAll(".wf-flow-order-item").forEach(item => {
    item.addEventListener("mouseenter", () => {
      const fid = (item as HTMLElement).dataset.flowId;
      if (fid) highlightFlow(fid, flows, cb);
    });
    item.addEventListener("mouseleave", () => clearHighlight(cb));
  });
}

/** Wire all events at once. */
export function wire(root: Element, flows: DetectedFlow[], cb: FlowConfigCallbacks): void {
  wireModeToggle(root, flows, cb);
  wireDragReorder(root, flows, cb);
  wireTriggers(root, flows, cb);
  // Back button
  root.querySelector("#wf-flow-back")?.addEventListener("click", () => cb.onBack?.());
}

/* ── PRIMITIVE 3: inject — render + wire + insert into DOM ── */

/**
 * Inject flow config panel into a container element.
 * Returns the rendered HTML string (also sets innerHTML + wires events).
 */
export function inject(
  container: Element,
  flows: DetectedFlow[],
  config: FlowExecutionConfig | null | undefined,
  cb: FlowConfigCallbacks,
  opts?: { showBack?: boolean; prepend?: boolean },
): string {
  const html = render(flows, config, opts);
  if (!html) return "";

  if (opts?.prepend) {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = html;
    container.prepend(wrapper.firstElementChild!);
  } else {
    // Append to existing innerHTML — caller controls positioning
    container.insertAdjacentHTML("afterbegin", html);
  }

  wire(container, flows, cb);
  return html;
}

/* ── SVG highlight helpers ── */

function highlightFlow(flowId: string, flows: DetectedFlow[], cb: FlowConfigCallbacks): void {
  const svg = cb.getSVGContainer?.();
  if (!svg) return;
  const flow = flows.find(f => f.flowId === flowId);
  if (!flow) return;
  const nodeIds = new Set(flow.nodeIds);
  const edgeIds = new Set(flow.edgeIds);
  svg.classList.add("wf-flow-highlight-active");
  svg.querySelectorAll(".wf-node[data-flow-id]").forEach(n => {
    if (nodeIds.has((n as HTMLElement).dataset.flowId!)) (n as HTMLElement).style.opacity = "1";
  });
  svg.querySelectorAll(".wf-edge").forEach(e => {
    if (edgeIds.has((e as HTMLElement).dataset.id!)) (e as HTMLElement).style.opacity = "1";
  });
}

function clearHighlight(cb: FlowConfigCallbacks): void {
  const svg = cb.getSVGContainer?.();
  if (!svg) return;
  svg.classList.remove("wf-flow-highlight-active");
  svg.querySelectorAll(".wf-node, .wf-edge").forEach(el => { (el as HTMLElement).style.opacity = ""; });
}
