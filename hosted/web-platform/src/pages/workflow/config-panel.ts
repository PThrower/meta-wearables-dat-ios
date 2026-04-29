/**
 * Config panel — schema-driven form fields for selected workflow nodes.
 * Three-state: settings / node-config / empty (with inline flow controls).
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

/** Render the full config panel — three-state: settings / node-config / empty-with-flows. */
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

  // State 1: Node selected → node config
  const selectedId = getSelectedNodeId();
  if (selectedId) {
    renderNodeConfigPanel(panel, workflow, selectedId);
    return;
  }

  // State 2: Empty — show "Select a node" + inline flow controls
  renderEmptyPanel(panel, workflow);
}

/** Render empty state with inline flow controls when multi-flow. */
function renderEmptyPanel(panel: Element, workflow: { nodes: Array<{ id: string; type?: string; label?: string }>; edges: Array<{ id: string; sourceNodeId: string; targetNodeId: string }>; flowConfig?: import("../../core/api-client.js").FlowExecutionConfig | null }): void {
  const flows = detectFlows(workflow.nodes, workflow.edges);
  console.log("[flow-debug] nodes:", workflow.nodes.length, "edges:", workflow.edges.length, "flows:", flows.length, flows.map(f => ({ id: f.flowId, nodes: f.nodeIds, label: f.label })));
  console.log("[flow-debug] edges:", workflow.edges.map(e => `${e.sourceNodeId} → ${e.targetNodeId}`));
  const multiFlow = flows.length > 1;

  let flowHtml = "";
  if (multiFlow) {
    flowHtml = renderFlowConfigHTML(flows, workflow.flowConfig ?? null, "wf");
  }

  panel.innerHTML = `
    <p class="empty-state">Select a node</p>
    ${flowHtml}
  `;

  if (multiFlow) {
    wireFlowConfigEvents(panel, flows, flowCallbacks);
  }
}

/** Render node config panel with schema-driven form fields. */
function renderNodeConfigPanel(panel: Element, workflow: { nodes: import("../../core/api-client.js").WorkflowNodeDef[]; edges: Array<{ id: string; sourceNodeId: string; targetNodeId: string }> }, selectedId: string): void {
  const node = workflow.nodes.find(n => n.id === selectedId);
  if (!node) { panel.innerHTML = '<p class="empty-state">Select a node</p>'; return; }

  const def = getNodeDef(node.type);
  if (!def) { panel.innerHTML = '<p class="empty-state">Unknown node type</p>'; return; }

  const c = def.color;
  const fieldsHtml = def.configSchema.map(field => renderConfigField(field, node, "wf-config")).join("");

  // Live preview section (only when preview data exists for this node)
  const previewHtml = renderNodePreviewHTML(selectedId);

  panel.innerHTML = `
    <div class="wf-config-header" style="border-left: 3px solid ${c.header}">
      <span class="wf-config-type">${esc(def.label)}</span>
    </div>
    ${previewHtml}
    ${fieldsHtml}
    <button class="btn btn-danger btn-sm wf-config-delete" data-id="${node.id}">Delete Node</button>
  `;

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
}
