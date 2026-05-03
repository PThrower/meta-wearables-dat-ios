/**
 * Config panel — schema-driven form fields for selected workflow nodes.
 * Three-state: settings / node-config / empty.
 * Flow config always visible at top when multi-flow detected.
 */

import { esc, fetchDevices } from "../../core/api-client.js";
import type { FlowExecutionConfig, WorkflowSettings } from "../../core/api-client.js";
import { getContainer, getWorkflow, getSelectedNodeId, setSelectedNodeId, setDirty, autoSave, isSettingsPanelActive, setSettingsPanelActive } from "./state.js";
import { getNodeDef } from "./node-defs.js";
import { refreshSVG } from "./svg-renderer.js";
import { detectFlows } from "./flow-detection.js";
import { renderConfigField, wireConfigFieldInputs, renderWorkflowSettingsHTML, wireSettingsFieldInputs, updateDeviceOptions, evaluateCondition } from "./shared-config.js";
import type { ConfigFieldCallbacks, SettingsCallbacks, GraphContext } from "./shared-config.js";
import { getNodePreview, renderNodePreviewHTML } from "./editor-preview.js";
import * as FlowPanel from "./flow-config-panel.js";

/** Flow config callbacks for the full editor (wires to state module). */
const flowCallbacks: FlowPanel.FlowConfigCallbacks = {
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

  // Flow config section — rendered by flow-config-panel primitives
  const flowHtml = FlowPanel.render(flows, workflow.flowConfig);

  // State 1: Node selected → flow config (if multi) + node config
  const selectedId = getSelectedNodeId();
  if (selectedId) {
    const node = workflow.nodes.find(n => n.id === selectedId);
    if (!node) {
      panel.innerHTML = `${flowHtml}<p class="empty-state">Select a node</p>`;
      if (multiFlow) FlowPanel.wire(panel, flows, flowCallbacks);
      return;
    }
    const def = getNodeDef(node.type);
    if (!def) {
      panel.innerHTML = `${flowHtml}<p class="empty-state">Unknown node type</p>`;
      if (multiFlow) FlowPanel.wire(panel, flows, flowCallbacks);
      return;
    }
    const c = def.color;
    const graphContext: GraphContext = { edges: workflow.edges, nodes: workflow.nodes };
    const fieldsHtml = def.configSchema.map(field => renderConfigField(field, node, "wf-config", graphContext)).join("");
    // Resolve connection overrides for header display
    let resolvedSubtitle = def.subtitle;
    if (def.connectionOverrides?.length) {
      for (const override of def.connectionOverrides) {
        if (evaluateCondition(override.condition, node.id, graphContext)) {
          if (override.subtitle) resolvedSubtitle = override.subtitle;
        }
      }
    }
    const previewHtml = renderNodePreviewHTML(selectedId);

    panel.innerHTML = `
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

    if (multiFlow) FlowPanel.wire(panel, flows, flowCallbacks);
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

  // State 2: Empty — flow config + "Select a node"
  if (flowHtml) {
    panel.innerHTML = `${flowHtml}<p class="empty-state">Select a node</p>`;
    if (multiFlow) FlowPanel.wire(panel, flows, flowCallbacks);
  } else {
    panel.innerHTML = `<p class="empty-state">Select a node</p>`;
  }
}
