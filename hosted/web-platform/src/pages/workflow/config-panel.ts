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

  // TEMP DEBUG: show flow detection result visibly
  const debugBanner = `<div style="background:#300;padding:4px 8px;font-size:10px;color:#f66;border-radius:4px;margin-bottom:8px;">[debug] nodes=${workflow.nodes.length} edges=${workflow.edges.length} flows=${flows.length} multiFlow=${multiFlow}</div>`;

  // Flow config section — always visible at top when multi-flow
  let flowHtml = "";
  if (multiFlow) {
    flowHtml = `<div class="wf-flow-section">${renderFlowConfigHTML(flows, workflow.flowConfig ?? null, "wf")}</div>`;
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
