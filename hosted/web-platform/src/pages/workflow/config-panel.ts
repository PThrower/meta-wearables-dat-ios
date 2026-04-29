/**
 * Config panel — schema-driven form fields for selected workflow nodes.
 * Three-state: settings / node-config / empty.
 * Flow config always visible at top when multi-flow detected.
 */

import { esc, fetchDevices } from "../../core/api-client.js";
import type { FlowExecutionConfig, WorkflowSettings } from "../../core/api-client.js";
import { DEFAULT_WORKFLOW_SETTINGS } from "../../core/api-client.js";
import { getContainer, getWorkflow, getSelectedNodeId, setSelectedNodeId, setDirty, autoSave, isSettingsPanelActive, setSettingsPanelActive } from "./state.js";
import { getNodeDef } from "./node-defs.js";
import { refreshSVG } from "./svg-renderer.js";
import { detectFlows } from "./flow-detection.js";
import { renderConfigField, renderFlowConfigHTML, wireFlowConfigEvents, wireConfigFieldInputs, renderWorkflowSettingsHTML, wireSettingsFieldInputs, updateDeviceOptions } from "./shared-config.js";
import type { FlowConfigCallbacks, ConfigFieldCallbacks, SettingsCallbacks } from "./shared-config.js";
import { getNodePreview, renderNodePreviewHTML } from "./editor-preview.js";

/** Flow config callbacks for the full editor (wires to state module). */
const flowCallbacks: FlowConfigCallbacks = {
  getWorkflow: () => getWorkflow(),
  setFlowConfig: (config: FlowExecutionConfig) => {
    const wf = getWorkflow();
    if (wf) wf.flowConfig = config;
  },
  setDirty: () => setDirty(true),
  autoSave,
  rerender: () => renderConfigPanel(),
  getSVGContainer: () => getContainer()?.querySelector("#wf-svg") ?? null,
};

/** Config field callbacks for the full editor (wires to state module). */
const configCallbacks: ConfigFieldCallbacks = {
  getWorkflow: () => getWorkflow(),
  getSelectedNodeId: () => getSelectedNodeId(),
  setDirty: () => setDirty(true),
  autoSave,
  refreshSVG,
};

/** Settings callbacks for the full editor. */
const settingsCallbacks: SettingsCallbacks = {
  getWorkflow: () => getWorkflow(),
  setSettings: (settings: WorkflowSettings) => {
    const wf = getWorkflow();
    if (wf) wf.settings = settings;
  },
  setDirty: () => setDirty(true),
  autoSave,
  onBack: () => { setSettingsPanelActive(false); renderConfigPanel(); },
};

/** Detect multi-flow for the current workflow. */
function getMultiFlowInfo(workflow: { nodes: Array<{ id: string; type?: string; label?: string }>; edges: Array<{ id: string; sourceNodeId: string; targetNodeId: string }> }) {
  const flows = detectFlows(workflow.nodes, workflow.edges);
  return { flows, multiFlow: flows.length > 1 };
}

/** Render the full config panel — three-state: settings / node-config / empty. */
export function renderConfigPanel(): void {
  const panel = getContainer()?.querySelector("#wf-config-panel");
  const workflow = getWorkflow();
  if (!panel || !workflow) return;

  // State 0: Workflow settings panel
  if (isSettingsPanelActive()) {
    // Fetch fleet devices to populate target device dropdown
    fetchDevices().then(devices => {
      if (devices.length > 0) {
        updateDeviceOptions(devices.map(d => ({
          id: d.device_id,
          name: d.deviceName ?? null,
          model: d.deviceModel ?? d.device_model ?? null,
        })));
        // Re-render if still on settings panel
        if (isSettingsPanelActive()) {
          const p = getContainer()?.querySelector("#wf-config-panel");
          if (p) { p.innerHTML = renderWorkflowSettingsHTML(workflow.settings); wireSettingsFieldInputs(p, settingsCallbacks); }
        }
      }
    });
    panel.innerHTML = renderWorkflowSettingsHTML(workflow.settings);
    wireSettingsFieldInputs(panel, settingsCallbacks);
    return;
  }

  const { flows, multiFlow } = getMultiFlowInfo(workflow);

  // TEMP DEBUG: show flow detection result + flowHtml length
  const debugBanner = `<div style="background:#300;padding:4px 8px;font-size:10px;color:#f66;border-radius:4px;margin-bottom:8px;">[debug] nodes=${workflow.nodes.length} edges=${workflow.edges.length} flows=${flows.length} multiFlow=${multiFlow} selectedId=${getSelectedNodeId() ?? "null"}</div>`;

  // Flow config section — always visible at top when multi-flow
  let flowHtml = "";
  if (multiFlow) {
    const mode = workflow.flowConfig?.mode ?? "parallel";
    const flowOrder = workflow.flowConfig?.flowOrder ?? flows.map(f => f.flowId);
    const isDraggable = mode === "sequential";

    const flowItems = flowOrder.map(fid => {
      const f = flows.find(fl => fl.flowId === fid);
      if (!f) return "";
      return `<div class="wf-flow-order-item" data-flow-id="${f.flowId}" draggable="${isDraggable}" style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:var(--bg-surface-alt,#1a1a1a);border:1px solid var(--border,rgba(255,255,255,0.08));border-radius:4px;cursor:${isDraggable ? "grab" : "default"};font-size:12px;color:var(--text-primary,#e0e0e0);">
        <span class="wf-flow-drag-handle" style="cursor:${isDraggable ? "grab" : "default"};color:var(--text-tertiary,rgba(255,255,255,0.35));user-select:none;">${isDraggable ? "⋮⋮" : "●"}</span>
        <span class="wf-flow-color-dot" style="width:8px;height:8px;border-radius:50%;background:${f.color};flex-shrink:0;"></span>
        <span class="wf-flow-label">${esc(f.label)}</span>
      </div>`;
    }).join("");

    const btnStyle = (active: boolean) =>
      `flex:1;padding:5px 8px;font-size:11px;border-radius:4px;cursor:pointer;text-align:center;transition:all 0.15s;` +
      (active
        ? `background:rgba(0,255,255,0.15);border:1px solid rgba(0,255,255,0.4);color:#0ff;font-weight:600;`
        : `background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);color:rgba(255,255,255,0.35);`);

    flowHtml = `<div style="padding-bottom:12px;margin-bottom:12px;border-bottom:1px solid var(--border,rgba(255,255,255,0.08));">
      <div style="display:flex;align-items:center;justify-content:space-between;padding-bottom:8px;border-bottom:1px solid var(--border,rgba(255,255,255,0.08));margin-bottom:8px;">
        <span style="font-size:13px;font-weight:600;color:var(--text-primary,#e0e0e0);">Flows</span>
        <span style="font-size:11px;color:var(--text-tertiary,rgba(255,255,255,0.35));">${flows.length} found</span>
      </div>
      <div class="wf-flow-mode-selector" style="display:flex;gap:2px;width:100%;margin-bottom:8px;">
        <button class="wf-flow-mode-btn ${mode === "parallel" ? "active" : ""}" data-mode="parallel" style="${btnStyle(mode === "parallel")}">Parallel</button>
        <button class="wf-flow-mode-btn ${mode === "sequential" ? "active" : ""}" data-mode="sequential" style="${btnStyle(mode === "sequential")}">Sequential</button>
        <button class="wf-flow-mode-btn ${mode === "event-driven" ? "active" : ""}" data-mode="event-driven" style="${btnStyle(mode === "event-driven")}">Event-Driven</button>
      </div>
      <div class="wf-flow-order ${mode === "parallel" ? "disabled" : ""}" id="wf-flow-order" style="display:flex;flex-direction:column;gap:4px;${mode === "parallel" ? "opacity:0.4;pointer-events:none;" : ""}">
        ${flowItems}
      </div>
    </div>`;
  }

  // State 1: Node selected → flow config (if multi) + node config
  const selectedId = getSelectedNodeId();
  if (selectedId) {
    const node = workflow.nodes.find(n => n.id === selectedId);
    if (!node) {
      panel.innerHTML = `${debugBanner}${flowHtml}<p class="empty-state">Select a node</p>`;
      if (multiFlow) wireFlowConfigEvents(panel, flows, flowCallbacks);
      return;
    }
    const def = getNodeDef(node.type);
    if (!def) {
      panel.innerHTML = `${debugBanner}${flowHtml}<p class="empty-state">Unknown node type</p>`;
      if (multiFlow) wireFlowConfigEvents(panel, flows, flowCallbacks);
      return;
    }
    const c = def.color;
    const fieldsHtml = def.configSchema.map(field => renderConfigField(field, node, "wf-config")).join("");
    const previewHtml = renderNodePreviewHTML(selectedId);

    panel.innerHTML = `
      ${debugBanner}
      ${flowHtml}
      <div class="wf-node-config-section">
        <div class="wf-config-header" style="border-left: 3px solid ${c.header}">
          <span class="wf-config-type">${esc(def.label)}</span>
        </div>
        ${previewHtml}
        ${fieldsHtml}
        <button class="btn btn-danger btn-sm wf-config-delete" data-id="${node.id}">Delete Node</button>
      </div>
    `;

    if (multiFlow) wireFlowConfigEvents(panel, flows, flowCallbacks);
    wireConfigFieldInputs(panel, configCallbacks);

    // Delete node button (full-editor-specific)
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
    return;
  }

  // State 2: Empty — flow config (if multi) or "Select a node"
  if (multiFlow) {
    panel.innerHTML = `${debugBanner}${flowHtml}`;
    wireFlowConfigEvents(panel, flows, flowCallbacks);
  } else {
    panel.innerHTML = `${debugBanner}<p class="empty-state">Select a node</p>`;
  }
}
