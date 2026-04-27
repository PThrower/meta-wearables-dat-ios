/**
 * Mini editor config panel — schema-driven form fields, per-node exec controls, delete node.
 * Pure functions that render into a container and wire events.
 */

import { esc } from "../core/api-client.js";
import type { WorkflowNodeDef, NodeDefinition } from "../core/api-client.js";
import { NODE_STATE_COLORS } from "../guidance.js";
import type { NodeExecutionState } from "../guidance.js";
import { detectFlows } from "../pages/workflow/flow-detection.js";
import { renderConfigField, wireConfigFieldInputs } from "../pages/workflow/shared-config.js";
import type { ConfigFieldCallbacks } from "../pages/workflow/shared-config.js";

/** Render config panel with schema-driven form + exec controls + delete button. */
export function renderMiniConfigPanel(
  panel: HTMLElement,
  node: WorkflowNodeDef,
  nodeDef: NodeDefinition | undefined,
  nodeState: string | undefined,
  callbacks: ConfigFieldCallbacks,
  onDelete: (nodeId: string) => void,
  onNodeAction: (action: string, nodeId: string) => void,
  allNodes?: Array<{ id: string; type?: string; label?: string }>,
  allEdges?: Array<{ id: string; sourceNodeId: string; targetNodeId: string }>,
): void {
  const def = nodeDef;
  const color = def?.color.header ?? "#666";
  const stateColor = nodeState ? (NODE_STATE_COLORS as Record<string, string>)[nodeState] ?? "#9ca3af" : "#9ca3af";

  // Flow badge for multi-flow workflows
  let flowBadge = "";
  if (allNodes && allEdges) {
    const flows = detectFlows(allNodes, allEdges);
    if (flows.length > 1) {
      const flow = flows.find(f => f.nodeIds.includes(node.id));
      if (flow) {
        flowBadge = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${flow.color};margin-right:4px;vertical-align:middle;"></span>`;
      }
    }
  }

  let html = `<div class="mini-config-header" style="border-left:3px solid ${color}">
    ${flowBadge}<span class="mini-config-type">${esc(def?.label ?? node.type)}</span>
    ${nodeState ? `<span class="mini-config-state" style="background:${stateColor}30;color:${stateColor}">${nodeState}</span>` : ""}
  </div>`;

  // Schema-driven form fields (shared rendering with mini-config prefix)
  if (def?.configSchema?.length) {
    html += def.configSchema.map(field => renderConfigField(field, node, "mini-config")).join("");
  } else {
    // Fallback: show config keys as text inputs
    for (const [key, val] of Object.entries(node.config)) {
      if (val === undefined) continue;
      html += `<div class="mini-config-field"><label>${esc(key)}</label><input type="text" class="mini-config-input" data-field="config.${key}" value="${esc(String(val))}" /></div>`;
    }
  }

  // Per-node execution actions (mini-only feature)
  const state = (nodeState ?? "unknown") as NodeExecutionState;
  const actions: string[] = [];
  if (state === "running") actions.push(`<button class="btn-warn" data-node-action="skip_node" data-node-id="${node.id}">Skip</button>`);
  if (state === "skipped" || state === "errored" || state === "completed") {
    actions.push(`<button class="btn-go" data-node-action="redo_node" data-node-id="${node.id}">Redo</button>`);
  }
  if (state === "pending" || state === "waiting" || state === "skipped" || state === "completed") {
    actions.push(`<button class="btn-go" data-node-action="start_node" data-node-id="${node.id}">Start</button>`);
  }
  actions.push(`<button class="btn-danger" data-delete-node="${node.id}">Delete</button>`);

  html += `<div class="mini-editor-node-actions">${actions.join("")}</div>`;
  panel.innerHTML = html;

  // Wire field change events (shared wiring)
  wireConfigFieldInputs(panel, callbacks);

  // Wire per-node exec action buttons (mini-only)
  panel.querySelectorAll("[data-node-action]").forEach(btn => {
    btn.addEventListener("click", () => {
      const action = (btn as HTMLElement).dataset.nodeAction!;
      const nodeId = (btn as HTMLElement).dataset.nodeId!;
      onNodeAction(action, nodeId);
    });
  });

  // Wire delete button
  panel.querySelector("[data-delete-node]")?.addEventListener("click", () => {
    const nodeId = (panel.querySelector("[data-delete-node]") as HTMLElement).dataset.deleteNode!;
    onDelete(nodeId);
  });
}
