/**
 * Config panel — schema-driven form fields for selected workflow nodes.
 * Three-state: empty (with flow link) / node-config / flow-config.
 */

import { esc } from "../../core/api-client.js";
import type { WorkflowNodeDef, ConfigFieldSchema, FlowExecutionConfig, FlowExecutionMode, DetectedFlow } from "../../core/api-client.js";
import { getContainer, getWorkflow, getSelectedNodeId, setSelectedNodeId, setDirty, autoSave } from "./state.js";
import { getNodeDef } from "./node-defs.js";
import { refreshSVG } from "./svg-renderer.js";
import { detectFlows, buildDefaultFlowConfig } from "./flow-detection.js";

/** Track whether flow config panel is active */
let _flowConfigActive = false;

/** Activate/deactivate flow config panel mode */
export function setFlowConfigActive(active: boolean): void {
  _flowConfigActive = active;
  if (active) setSelectedNodeId(null);
  renderConfigPanel();
}

/** Check if flow config panel is active */
export function isFlowConfigActive(): boolean {
  return _flowConfigActive;
}

/** Render a single config field based on its schema kind. */
export function renderConfigField(field: ConfigFieldSchema, node: WorkflowNodeDef): string {
  switch (field.kind) {
    case "text": {
      const val = field.key === "label" ? node.label : String(node.config[field.key] ?? "");
      const dataField = field.key === "label" ? "label" : `config.${field.key}`;
      return `<div class="wf-config-field"><label>${esc(field.label)}</label><input type="text" class="wf-config-input" data-field="${dataField}" value="${esc(val)}" ${field.placeholder ? `placeholder="${esc(field.placeholder)}"` : ""} /></div>`;
    }
    case "textarea": {
      const val = String(node.config[field.key] ?? "");
      return `<div class="wf-config-field"><label>${esc(field.label)}</label><textarea class="wf-config-input wf-config-textarea" data-field="config.${field.key}" rows="${field.rows ?? 4}" ${field.placeholder ? `placeholder="${esc(field.placeholder)}"` : ""}>${esc(val)}</textarea></div>`;
    }
    case "select": {
      const val = String(node.config[field.key] ?? "");
      const options = field.options.map(o => `<option value="${esc(o.value)}" ${val === o.value ? "selected" : ""}>${esc(o.label)}</option>`).join("");
      return `<div class="wf-config-field"><label>${esc(field.label)}</label><select class="wf-config-input" data-field="config.${field.key}">${options}</select></div>`;
    }
    case "range": {
      const val = (node.config[field.key] as number) ?? field.min;
      return `<div class="wf-config-field"><label>${esc(field.label)}: ${val}${field.unit ?? ""}</label><input type="range" min="${field.min}" max="${field.max}" step="${field.step}" data-field="config.${field.key}" value="${val}" /></div>`;
    }
    case "checkbox": {
      const checked = node.config[field.key] === true;
      return `<div class="wf-config-field"><label><input type="checkbox" data-field="config.${field.key}" ${checked ? "checked" : ""} /> ${esc(field.label)}</label></div>`;
    }
    case "checkbox-group": {
      const checks = field.fields.map(f => {
        const checked = node.config[f.key] !== false;
        return `<label><input type="checkbox" data-field="config.${f.key}" ${checked ? "checked" : ""} /> ${esc(f.label)}</label>`;
      }).join("");
      return `<div class="wf-config-field"><label>${esc(field.label)}</label><div class="wf-config-checks">${checks}</div></div>`;
    }
    case "number": {
      const val = (node.config[field.key] as number) ?? 0;
      return `<div class="wf-config-field"><label>${esc(field.label)}</label><input type="number" class="wf-config-input" data-field="config.${field.key}" min="${field.min ?? ""}" max="${field.max ?? ""}" step="${field.step ?? 1}" value="${val}" /></div>`;
    }
    case "section": {
      const inner = field.fields.map(f => renderConfigField(f, node)).join("");
      return `<div class="wf-config-field" style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #333;"><label style="font-weight: 600; margin-bottom: 6px; display: block;">${esc(field.label)}</label>${inner}</div>`;
    }
  }
}

/** Render the full config panel — three-state: empty / node-config / flow-config. */
export function renderConfigPanel(): void {
  const panel = getContainer()?.querySelector("#wf-config-panel");
  const workflow = getWorkflow();
  if (!panel || !workflow) return;

  // State 1: Flow config active
  if (_flowConfigActive) {
    renderFlowConfigPanel(panel, workflow);
    return;
  }

  // State 2: Node selected → node config (existing behavior)
  const selectedId = getSelectedNodeId();
  if (selectedId) {
    renderNodeConfigPanel(panel, workflow, selectedId);
    return;
  }

  // State 3: Empty — show "Select a node" + flow link if multi-flow
  renderEmptyPanel(panel, workflow);
}

/** Render empty state with optional flow link. */
function renderEmptyPanel(panel: Element, workflow: { nodes: Array<{ id: string; type?: string; label?: string }>; edges: Array<{ id: string; sourceNodeId: string; targetNodeId: string }> }): void {
  const flows = detectFlows(workflow.nodes, workflow.edges);
  const multiFlow = flows.length > 1;
  panel.innerHTML = `
    <p class="empty-state">Select a node</p>
    ${multiFlow ? `<span class="wf-flow-link" id="wf-flow-link">${flows.length} flows detected</span>` : ""}
  `;
  panel.querySelector("#wf-flow-link")?.addEventListener("click", () => setFlowConfigActive(true));
}

/** Render node config panel (unchanged behavior, extracted). */
function renderNodeConfigPanel(panel: Element, workflow: { nodes: WorkflowNodeDef[]; edges: Array<{ id: string; sourceNodeId: string; targetNodeId: string }> }, selectedId: string): void {
  const node = workflow.nodes.find(n => n.id === selectedId);
  if (!node) { panel.innerHTML = '<p class="empty-state">Select a node</p>'; return; }

  const def = getNodeDef(node.type);
  if (!def) { panel.innerHTML = '<p class="empty-state">Unknown node type</p>'; return; }

  const c = def.color;
  const fieldsHtml = def.configSchema.map(field => renderConfigField(field, node)).join("");
  panel.innerHTML = `
    <div class="wf-config-header" style="border-left: 3px solid ${c.header}">
      <span class="wf-config-type">${esc(def.label)}</span>
    </div>
    ${fieldsHtml}
    <button class="btn btn-danger btn-sm wf-config-delete" data-id="${node.id}">Delete Node</button>
  `;

  wireConfigInputs(panel);
}

/** Render flow configuration panel with mode toggle and drag-and-drop reorder. */
function renderFlowConfigPanel(
  panel: Element,
  workflow: { nodes: Array<{ id: string; type?: string; label?: string }>; edges: Array<{ id: string; sourceNodeId: string; targetNodeId: string }>; flowConfig?: FlowExecutionConfig | null },
): void {
  const flows = detectFlows(workflow.nodes, workflow.edges);
  const config = workflow.flowConfig ?? buildDefaultFlowConfig(flows);
  const mode: FlowExecutionMode = config?.mode ?? "parallel";
  const flowOrder: string[] = config?.flowOrder ?? flows.map(f => f.flowId);

  const flowList = flowOrder.map(fid => {
    const f = flows.find(fl => fl.flowId === fid);
    if (!f) return "";
    return `<div class="wf-flow-order-item" data-flow-id="${f.flowId}" draggable="${mode === "sequential"}">
      <span class="wf-flow-drag-handle">${mode === "sequential" ? "⋮⋮" : "●"}</span>
      <span class="wf-flow-color-dot" style="background:${f.color}"></span>
      <span class="wf-flow-label">${esc(f.label)}</span>
    </div>`;
  }).join("");

  panel.innerHTML = `
    <div class="wf-flow-config">
      <div class="wf-flow-config-header">
        <span class="wf-flow-config-title">Flows</span>
        <span class="wf-flow-config-count">${flows.length} found</span>
      </div>
      <div class="wf-flow-mode-selector">
        <button class="wf-flow-mode-btn ${mode === "parallel" ? "active" : ""}" data-mode="parallel">Parallel</button>
        <button class="wf-flow-mode-btn ${mode === "sequential" ? "active" : ""}" data-mode="sequential">Sequential</button>
      </div>
      <div class="wf-flow-order ${mode === "parallel" ? "disabled" : ""}" id="wf-flow-order">
        ${flowList}
      </div>
      <button class="wf-flow-back" id="wf-flow-back">&larr; Back</button>
    </div>
  `;

  wireFlowConfigEvents(panel, flows);
}

/** Wire flow config panel events — mode toggle, drag reorder, hover highlight, back button. */
function wireFlowConfigEvents(panel: Element, flows: DetectedFlow[]): void {
  // Mode toggle
  panel.querySelectorAll(".wf-flow-mode-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const mode = (btn as HTMLElement).dataset.mode as FlowExecutionMode;
      const workflow = getWorkflow();
      if (!workflow) return;
      const currentConfig = workflow.flowConfig ?? buildDefaultFlowConfig(flows);
      workflow.flowConfig = { mode, flowOrder: currentConfig?.flowOrder ?? flows.map(f => f.flowId) };
      setDirty(true);
      autoSave();
      renderConfigPanel();
    });
  });

  // Back button
  panel.querySelector("#wf-flow-back")?.addEventListener("click", () => setFlowConfigActive(false));

  // Drag-and-drop reorder
  const orderEl = panel.querySelector("#wf-flow-order");
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
        clearFlowHighlight();
      });

      item.addEventListener("dragover", (e) => {
        e.preventDefault();
        (e as DragEvent).dataTransfer!.dropEffect = "move";
      });

      item.addEventListener("drop", (e) => {
        e.preventDefault();
        const targetId = (item as HTMLElement).dataset.flowId;
        if (!draggedId || !targetId || draggedId === targetId) return;
        const workflow = getWorkflow();
        if (!workflow?.flowConfig) return;
        const order = [...workflow.flowConfig.flowOrder];
        const fromIdx = order.indexOf(draggedId);
        const toIdx = order.indexOf(targetId);
        if (fromIdx < 0 || toIdx < 0) return;
        order.splice(fromIdx, 1);
        order.splice(toIdx, 0, draggedId);
        workflow.flowConfig = { ...workflow.flowConfig, flowOrder: order };
        setDirty(true);
        autoSave();
        renderConfigPanel();
      });

      // Hover highlighting
      item.addEventListener("mouseenter", () => {
        const flowId = (item as HTMLElement).dataset.flowId;
        if (flowId) highlightFlow(flowId, flows);
      });

      item.addEventListener("mouseleave", () => {
        clearFlowHighlight();
      });
    });
  }
}

/** Highlight a flow's nodes/edges on the SVG canvas, dimming everything else. */
function highlightFlow(flowId: string, flows: DetectedFlow[]): void {
  const svgEl = getContainer()?.querySelector("#wf-svg");
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
function clearFlowHighlight(): void {
  const svgEl = getContainer()?.querySelector("#wf-svg");
  if (!svgEl) return;
  svgEl.classList.remove("wf-flow-highlight-active");
  svgEl.querySelectorAll(".wf-node, .wf-edge").forEach(el => {
    (el as HTMLElement).style.opacity = "";
  });
}

/** Wire config field change and delete events (shared by node config panel). */
function wireConfigInputs(panel: Element): void {
  panel.querySelectorAll("[data-field]").forEach(input => {
    input.addEventListener("change", () => {
      const wf = getWorkflow();
      const selId = getSelectedNodeId();
      if (!wf || !selId) return;
      const n = wf.nodes.find(n => n.id === selId);
      if (!n) return;
      const field = (input as HTMLElement).dataset.field!;
      const el = input as HTMLInputElement;
      if (field.startsWith("config.")) {
        const key = field.slice(7);
        if (el.type === "range") n.config[key] = parseFloat(el.value);
        else if (el.type === "checkbox") n.config[key] = el.checked;
        else n.config[key] = el.value;
      } else {
        (n as any)[field] = el.value;
      }
      setDirty(true);
      autoSave();
      refreshSVG();
    });
  });

  panel.querySelector(".wf-config-delete")?.addEventListener("click", () => {
    const wf = getWorkflow();
    if (!wf) return;
    const id = (panel.querySelector(".wf-config-delete") as HTMLElement).dataset.id!;
    wf.nodes = wf.nodes.filter(n => n.id !== id);
    wf.edges = wf.edges.filter(e => e.sourceNodeId !== id && e.targetNodeId !== id);
    setSelectedNodeId(null);
    setDirty(true);
    autoSave();
    refreshSVG();
    renderConfigPanel();
  });
}
