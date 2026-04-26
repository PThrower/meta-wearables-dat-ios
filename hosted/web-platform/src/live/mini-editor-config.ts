/**
 * Mini editor config panel — schema-driven form fields, per-node exec controls, delete node.
 * Pure functions that render into a container and wire events.
 */

import { esc } from "../core/api-client.js";
import type { WorkflowNodeDef, ConfigFieldSchema, NodeDefinition, DetectedFlow } from "../core/api-client.js";
import { NODE_STATE_COLORS } from "../guidance.js";
import type { NodeExecutionState } from "../guidance.js";
import { detectFlows } from "../pages/workflow/flow-detection.js";

/** Render a single config field based on its schema kind. */
function renderField(field: ConfigFieldSchema, node: WorkflowNodeDef): string {
  switch (field.kind) {
    case "text": {
      const val = field.key === "label" ? node.label : String(node.config[field.key] ?? "");
      const dataField = field.key === "label" ? "label" : `config.${field.key}`;
      return `<div class="mini-config-field"><label>${esc(field.label)}</label><input type="text" class="mini-config-input" data-field="${dataField}" value="${esc(val)}" ${field.placeholder ? `placeholder="${esc(field.placeholder)}"` : ""} /></div>`;
    }
    case "textarea": {
      const val = String(node.config[field.key] ?? "");
      return `<div class="mini-config-field"><label>${esc(field.label)}</label><textarea class="mini-config-input" data-field="config.${field.key}" rows="${field.rows ?? 3}" ${field.placeholder ? `placeholder="${esc(field.placeholder)}"` : ""}>${esc(val)}</textarea></div>`;
    }
    case "select": {
      const val = String(node.config[field.key] ?? "");
      const options = field.options.map(o => `<option value="${esc(o.value)}" ${val === o.value ? "selected" : ""}>${esc(o.label)}</option>`).join("");
      return `<div class="mini-config-field"><label>${esc(field.label)}</label><select class="mini-config-input" data-field="config.${field.key}">${options}</select></div>`;
    }
    case "range": {
      const val = (node.config[field.key] as number) ?? field.min;
      return `<div class="mini-config-field"><label>${esc(field.label)}: ${val}${field.unit ?? ""}</label><input type="range" min="${field.min}" max="${field.max}" step="${field.step}" data-field="config.${field.key}" value="${val}" /></div>`;
    }
    case "checkbox": {
      const checked = node.config[field.key] === true;
      return `<div class="mini-config-field"><label><input type="checkbox" data-field="config.${field.key}" ${checked ? "checked" : ""} /> ${esc(field.label)}</label></div>`;
    }
    case "checkbox-group": {
      const checks = field.fields.map(f => {
        const checked = node.config[f.key] !== false;
        return `<label><input type="checkbox" data-field="config.${f.key}" ${checked ? "checked" : ""} /> ${esc(f.label)}</label>`;
      }).join("");
      return `<div class="mini-config-field"><label>${esc(field.label)}</label><div class="mini-config-checks">${checks}</div></div>`;
    }
    case "number": {
      const val = (node.config[field.key] as number) ?? 0;
      return `<div class="mini-config-field"><label>${esc(field.label)}</label><input type="number" class="mini-config-input" data-field="config.${field.key}" min="${field.min ?? ""}" max="${field.max ?? ""}" step="${field.step ?? 1}" value="${val}" /></div>`;
    }
    case "section": {
      const inner = field.fields.map(f => renderField(f, node)).join("");
      return `<div class="mini-config-field" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--player-border)"><label style="font-weight:600;margin-bottom:4px;display:block">${esc(field.label)}</label>${inner}</div>`;
    }
  }
}

/** Render config panel with schema-driven form + exec controls + delete button. */
export function renderMiniConfigPanel(
  panel: HTMLElement,
  node: WorkflowNodeDef,
  nodeDef: NodeDefinition | undefined,
  nodeState: string | undefined,
  onChange: (field: string, value: unknown) => void,
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

  // Schema-driven form fields
  if (def?.configSchema?.length) {
    html += def.configSchema.map(field => renderField(field, node)).join("");
  } else {
    // Fallback: show config keys as text inputs
    for (const [key, val] of Object.entries(node.config)) {
      if (val === undefined) continue;
      html += `<div class="mini-config-field"><label>${esc(key)}</label><input type="text" class="mini-config-input" data-field="config.${key}" value="${esc(String(val))}" /></div>`;
    }
  }

  // Per-node execution actions
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

  // Wire field change events
  panel.querySelectorAll("[data-field]").forEach(input => {
    input.addEventListener("change", () => {
      const field = (input as HTMLElement).dataset.field!;
      const el = input as HTMLInputElement;
      let value: unknown;
      if (el.type === "range") value = parseFloat(el.value);
      else if (el.type === "checkbox") value = el.checked;
      else if (el.type === "number") value = parseFloat(el.value);
      else value = el.value;
      onChange(field, value);
    });
  });

  // Wire per-node exec action buttons
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
