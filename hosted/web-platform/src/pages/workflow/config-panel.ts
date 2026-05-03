/**
 * Config panel — schema-driven form fields for selected workflow nodes.
 * Three-state: settings / node-config / empty.
 * Flow config always visible at top when multi-flow detected.
 */

import { esc, fetchDevices } from "../../core/api-client.js";
import type { DetectedFlow, FlowExecutionConfig, WorkflowSettings } from "../../core/workflow-types.js";
import { getContainer, getWorkflow, getSelectedNodeId, setSelectedNodeId, setDirty, autoSave, isSettingsPanelActive, setSettingsPanelActive } from "./state.js";
import { getNodeDef } from "./node-defs.js";
import { refreshSVG } from "./svg-renderer.js";
import { detectFlows } from "./flow-detection.js";
import { renderConfigField, wireConfigFieldInputs, renderWorkflowSettingsHTML, wireSettingsFieldInputs, updateDeviceOptions, evaluateCondition } from "./shared-config.js";
import type { ConfigFieldCallbacks, SettingsCallbacks, GraphContext, FlowConfigCallbacks } from "./types.js";
import { getNodePreview, renderNodePreviewHTML } from "./editor-preview.js";
import * as FlowPanel from "./flow-config-panel.js";

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

// ── Flows floating popup ──

let _flowPopup: HTMLElement | null = null;
let _flowPopupCollapsed = false;

function getOrCreateFlowPopup(): HTMLElement {
  if (_flowPopup && document.body.contains(_flowPopup)) return _flowPopup;

  const popup = document.createElement("div");
  popup.id = "wf-flows-popup";
  popup.innerHTML = `
    <div class="wf-flows-popup-header">
      <span class="wf-flows-popup-title">Flows</span>
      <span class="wf-flows-popup-count"></span>
      <button class="wf-flows-popup-chevron" title="Toggle">▾</button>
    </div>
    <div class="wf-flows-popup-body"></div>
  `;
  document.body.appendChild(popup);
  _flowPopup = popup;

  if (_flowPopupCollapsed) popup.classList.add("collapsed");

  popup.querySelector(".wf-flows-popup-chevron")!.addEventListener("click", (e) => {
    e.stopPropagation();
    _flowPopupCollapsed = !_flowPopupCollapsed;
    popup.classList.toggle("collapsed", _flowPopupCollapsed);
  });

  wirePopupDrag(popup, popup.querySelector(".wf-flows-popup-header") as HTMLElement);
  return popup;
}

function wirePopupDrag(popup: HTMLElement, handle: HTMLElement): void {
  let active = false;
  let startX = 0, startY = 0, originLeft = 0, originTop = 0;

  handle.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest(".wf-flows-popup-chevron")) return;
    active = true;
    handle.setPointerCapture(e.pointerId);
    const rect = popup.getBoundingClientRect();
    // Convert right-anchored CSS to left-anchored so drag math is consistent
    popup.style.right = "auto";
    popup.style.left = `${rect.left}px`;
    popup.style.top = `${rect.top}px`;
    startX = e.clientX;
    startY = e.clientY;
    originLeft = rect.left;
    originTop = rect.top;
    e.preventDefault();
  });

  handle.addEventListener("pointermove", (e) => {
    if (!active) return;
    const newLeft = Math.max(0, Math.min(originLeft + (e.clientX - startX), window.innerWidth - popup.offsetWidth));
    const newTop = Math.max(0, Math.min(originTop + (e.clientY - startY), window.innerHeight - popup.offsetHeight));
    popup.style.left = `${newLeft}px`;
    popup.style.top = `${newTop}px`;
  });

  handle.addEventListener("pointerup", () => { active = false; });
  handle.addEventListener("pointercancel", () => { active = false; });
}

function updateFlowPopup(flows: DetectedFlow[], config: FlowExecutionConfig | null | undefined): void {
  if (flows.length < 2) {
    if (_flowPopup) _flowPopup.style.display = "none";
    return;
  }
  const popup = getOrCreateFlowPopup();
  popup.style.display = "";

  const countEl = popup.querySelector(".wf-flows-popup-count");
  if (countEl) countEl.textContent = `${flows.length} found`;

  const body = popup.querySelector(".wf-flows-popup-body") as HTMLElement;
  body.innerHTML = FlowPanel.render(flows, config);
  FlowPanel.wire(body, flows, flowCallbacks);
}

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

  const { flows } = getMultiFlowInfo(workflow);

  // Flow popup — always updated separately, never part of #wf-config-panel
  updateFlowPopup(flows, workflow.flowConfig);

  // State 1: Node selected → node config
  const selectedId = getSelectedNodeId();
  if (selectedId) {
    const node = workflow.nodes.find(n => n.id === selectedId);
    if (!node) {
      panel.innerHTML = `<p class="empty-state">Select a node</p>`;
      return;
    }
    const def = getNodeDef(node.type);
    if (!def) {
      panel.innerHTML = `<p class="empty-state">Unknown node type</p>`;
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
      <div class="wf-node-config-section">
        <div class="wf-config-header" style="border-left: 3px solid ${c.header}">
          <span class="wf-config-type">${esc(def.label)}</span>
        </div>
        ${previewHtml}
        ${fieldsHtml}
        <button class="btn btn-danger btn-sm wf-config-delete" data-id="${node.id}">Delete Node</button>
      </div>
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
    return;
  }

  // State 2: Empty
  panel.innerHTML = `<p class="empty-state">Select a node</p>`;
}

/** Clean up flow popup DOM element. Called from page.destroy. */
export function destroyConfigPanel(): void {
  if (_flowPopup) {
    _flowPopup.remove();
    _flowPopup = null;
  }
}
