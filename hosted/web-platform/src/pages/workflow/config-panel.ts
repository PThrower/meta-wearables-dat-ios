/**
 * Config panel — schema-driven form fields for selected workflow nodes.
 */

import { esc } from "../../core/api-client.js";
import type { WorkflowNodeDef, ConfigFieldSchema } from "../../core/api-client.js";
import { getContainer, getWorkflow, getSelectedNodeId, setSelectedNodeId, setDirty, autoSave } from "./state.js";
import { getNodeDef } from "./node-defs.js";
import { refreshSVG } from "./svg-renderer.js";

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

/** Render the full config panel for the currently selected node. */
export function renderConfigPanel(): void {
  const panel = getContainer()?.querySelector("#wf-config-panel");
  const workflow = getWorkflow();
  if (!panel || !workflow) return;

  const selectedId = getSelectedNodeId();
  if (!selectedId) {
    panel.innerHTML = '<p class="empty-state">Select a node</p>';
    return;
  }

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

  // Wire config inputs
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

  // Delete node button
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
