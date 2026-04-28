/**
 * Config panel — schema-driven form fields for selected workflow nodes.
 * Four-state: settings / flow-config / node-config / empty.
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
  onBack: () => setFlowConfigActive(false),
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

/** Render the full config panel — four-state: settings / flow-config / node-config / empty. */
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

  // State 1: Flow config active
  if (_flowConfigActive) {
    const flows = detectFlows(workflow.nodes, workflow.edges);
    panel.innerHTML = renderFlowConfigHTML(flows, workflow.flowConfig, "wf", { showBack: true });
    wireFlowConfigEvents(panel, flows, flowCallbacks);
    return;
  }

  // State 2: Node selected → node config
  const selectedId = getSelectedNodeId();
  if (selectedId) {
    renderNodeConfigPanel(panel, workflow, selectedId);
    return;
  }

  // State 3: Empty — show "Select a node" + settings link + flow link
  renderEmptyPanel(panel, workflow);
}

/** Render empty state with settings link + optional flow link. */
function renderEmptyPanel(panel: Element, workflow: { nodes: Array<{ id: string; type?: string; label?: string }>; edges: Array<{ id: string; sourceNodeId: string; targetNodeId: string }> }): void {
  const flows = detectFlows(workflow.nodes, workflow.edges);
  const multiFlow = flows.length > 1;
  panel.innerHTML = `
    <p class="empty-state">Select a node</p>
    <span class="wf-flow-link" id="wf-settings-link">Workflow Settings</span>
    ${multiFlow ? `<span class="wf-flow-link" id="wf-flow-link">${flows.length} flows detected</span>` : ""}
  `;
  panel.querySelector("#wf-settings-link")?.addEventListener("click", () => {
    setSettingsPanelActive(true);
    renderConfigPanel();
  });
  panel.querySelector("#wf-flow-link")?.addEventListener("click", () => setFlowConfigActive(true));
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
