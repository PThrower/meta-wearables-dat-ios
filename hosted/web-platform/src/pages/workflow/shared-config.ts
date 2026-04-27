/**
 * Shared config rendering and event wiring — used by both the full workflow editor
 * config panel and the mini editor config panel. All functions are prefix-parameterized
 * or callback-driven for dependency inversion.
 */

import { esc } from "../../core/api-client.js";
import type { WorkflowNodeDef, ConfigFieldSchema, FlowExecutionConfig, FlowExecutionMode, DetectedFlow } from "../../core/api-client.js";
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

  const flowList = flowOrder.map(fid => {
    const f = flows.find(fl => fl.flowId === fid);
    if (!f) return "";
    return `<div class="wf-flow-order-item" data-flow-id="${f.flowId}" draggable="${mode === "sequential"}">
      <span class="wf-flow-drag-handle">${mode === "sequential" ? "⋮⋮" : "●"}</span>
      <span class="wf-flow-color-dot" style="background:${f.color}"></span>
      <span class="wf-flow-label">${esc(f.label)}</span>
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
    </div>
    <div class="wf-flow-order ${mode === "parallel" ? "disabled" : ""}" id="${prefix}-flow-order">
      ${flowList}
    </div>
    ${opts?.showBack ? `<button class="wf-flow-back" id="wf-flow-back">&larr; Back</button>` : ""}
  </div>`;
}

/* ── Flow config event wiring ── */

/** Wire flow config panel events — mode toggle, drag reorder, hover highlight, back button. */
export function wireFlowConfigEvents(panel: Element, flows: DetectedFlow[], callbacks: FlowConfigCallbacks): void {
  // Mode toggle
  panel.querySelectorAll(".wf-flow-mode-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const mode = (btn as HTMLElement).dataset.mode as FlowExecutionMode;
      const workflow = callbacks.getWorkflow();
      if (!workflow) return;
      const currentConfig = workflow.flowConfig ?? buildDefaultFlowConfig(flows);
      callbacks.setFlowConfig({ mode, flowOrder: currentConfig?.flowOrder ?? flows.map(f => f.flowId) });
      callbacks.setDirty();
      callbacks.autoSave();
      callbacks.rerender();
    });
  });

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
