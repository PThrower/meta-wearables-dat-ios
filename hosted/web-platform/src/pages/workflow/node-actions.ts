/**
 * Node action popover — tap-to-reveal overlay with per-node actions and live output.
 * Positioned over the SVG node using getBoundingClientRect.
 */

import { esc } from "../../core/api-client.js";
import {
  getContainer, getWorkflow, getSelectedNodeId,
  setSelectedNodeId, setDirty, autoSave, nanoid,
} from "./state.js";
import { getNodeDef } from "./node-defs.js";
import { renderConfigPanel } from "./config-panel.js";
import { refreshSVG } from "./svg-renderer.js";
import { NODE_STATUS_DOT_COLORS } from "./svg-renderer.js";
import {
  getNodePreview, isPreviewConnected, sendPreviewJson, getPublisherStatus,
} from "./editor-preview.js";

let _popoverEl: HTMLDivElement | null = null;

/** Show the node action popover anchored to a specific node. */
export function showNodeActionPopover(nodeId: string): void {
  hideNodeActionPopover();

  const container = getContainer();
  const svg = container?.querySelector("#wf-svg");
  const nodeG = svg?.querySelector(`[data-id="${nodeId}"]`) as SVGGElement | null;
  if (!container || !svg || !nodeG) return;

  const workflow = getWorkflow();
  const node = workflow?.nodes.find(n => n.id === nodeId);
  if (!node || !workflow) return;

  const def = getNodeDef(node.type);
  const preview = getNodePreview(nodeId);
  const connected = isPreviewConnected();
  const pubStatus = getPublisherStatus();
  const role = def?.role ?? "unknown";

  // Position from SVG element bounding rect
  const rect = nodeG.getBoundingClientRect();
  const canvasWrap = container.querySelector("#wf-canvas-wrap");
  const wrapRect = canvasWrap?.getBoundingClientRect();

  // Build popover content based on node role
  let bodyHTML = "";

  // State indicator
  const stateStr = preview?.executionState;
  const stateColor = stateStr ? (NODE_STATUS_DOT_COLORS[stateStr] ?? "#9ca3af") : "#9ca3af";
  const stateLabel = stateStr ?? "idle";
  bodyHTML += `<div class="wf-popover-state">
    <span class="wf-popover-dot" style="background:${stateColor}"></span>
    <span style="color:${stateColor};font-weight:600;font-size:10px;text-transform:uppercase">${esc(stateLabel)}</span>
  </div>`;

  // Live output (if available)
  if (preview?.lastText) {
    bodyHTML += `<div class="wf-popover-output">${esc(preview.lastText.slice(0, 150))}</div>`;
  }

  // Numeric gauges
  if (preview && preview.numerics.size > 0) {
    bodyHTML += `<div class="wf-popover-numerics">`;
    for (const [label, { value, unit }] of preview.numerics) {
      bodyHTML += `<div class="wf-popover-gauge">
        <span class="wf-popover-gauge-label">${esc(label)}</span>
        <span class="wf-popover-gauge-value">${value.toFixed(1)} ${esc(unit)}</span>
      </div>`;
    }
    bodyHTML += `</div>`;
  }

  // Actions based on role
  bodyHTML += `<div class="wf-popover-actions">`;

  // Source nodes — stream controls
  if (role === "source" && (node.type === "camera-source" || node.type.includes("mic-source"))) {
    if (connected) {
      const isLive = pubStatus === "live";
      bodyHTML += `<button class="wf-popover-btn ${isLive ? "wf-popover-btn-stop" : "wf-popover-btn-go"}" data-action="${isLive ? "stop-stream" : "start-stream"}">
        ${isLive ? "Stop Stream" : "Start Stream"}
      </button>`;
    }
  }

  // Configure button (all nodes)
  bodyHTML += `<button class="wf-popover-btn" data-action="configure">Configure</button>`;

  // Delete button (all nodes)
  bodyHTML += `<button class="wf-popover-btn wf-popover-btn-danger" data-action="delete">Delete</button>`;
  bodyHTML += `</div>`;

  // Create popover element
  const popover = document.createElement("div");
  popover.className = "wf-node-popover";
  popover.id = "wf-node-popover";
  popover.innerHTML = `
    <div class="wf-popover-header">
      <span class="wf-popover-type">${esc(node.type.replace(/-/g, " "))}</span>
      <span class="wf-popover-label">${esc(node.label || node.type)}</span>
    </div>
    <div class="wf-popover-body">${bodyHTML}</div>
  `;

  // Position popover — prefer below the node, centered
  const popoverWidth = 220;
  let left = rect.left + rect.width / 2 - popoverWidth / 2;
  let top = rect.bottom + 6;

  // Keep within viewport
  if (left < 8) left = 8;
  if (left + popoverWidth > window.innerWidth - 8) left = window.innerWidth - popoverWidth - 8;
  if (top + 300 > window.innerHeight) {
    top = rect.top - 6;
    popover.classList.add("wf-popover-above");
  }

  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;

  container.querySelector(".workflow-editor-page")?.appendChild(popover);
  _popoverEl = popover;

  // Wire actions
  popover.querySelectorAll(".wf-popover-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const action = (btn as HTMLElement).dataset.action;
      handlePopoverAction(action, nodeId);
    });
  });

  // Dismiss on outside click
  const dismiss = (ev: PointerEvent) => {
    if (!popover.contains(ev.target as Node)) {
      hideNodeActionPopover();
      document.removeEventListener("pointerdown", dismiss);
    }
  };
  setTimeout(() => document.addEventListener("pointerdown", dismiss), 0);
}

/** Hide and remove the popover. */
export function hideNodeActionPopover(): void {
  if (_popoverEl) {
    _popoverEl.remove();
    _popoverEl = null;
  }
}

/** Handle a popover button action. */
function handlePopoverAction(action: string | undefined, nodeId: string): void {
  if (!action) return;
  const workflow = getWorkflow();
  if (!workflow) return;

  switch (action) {
    case "start-stream":
      sendPreviewJson({ type: "start_stream" });
      hideNodeActionPopover();
      break;

    case "stop-stream":
      sendPreviewJson({ type: "stop_stream" });
      hideNodeActionPopover();
      break;

    case "configure":
      setSelectedNodeId(nodeId);
      renderConfigPanel();
      hideNodeActionPopover();
      refreshSVG();
      break;

    case "delete": {
      workflow.nodes = workflow.nodes.filter(n => n.id !== nodeId);
      workflow.edges = workflow.edges.filter(e => e.sourceNodeId !== nodeId && e.targetNodeId !== nodeId);
      setSelectedNodeId(null);
      setDirty(true);
      autoSave();
      hideNodeActionPopover();
      refreshSVG();
      renderConfigPanel();
      break;
    }
  }
}
