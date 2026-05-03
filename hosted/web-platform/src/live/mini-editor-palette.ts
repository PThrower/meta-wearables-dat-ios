/**
 * Mini editor palette — compact node type palette grouped by role.
 * Pure functions: buildHTML + wireEvents.
 */

import { esc } from "../core/api-client.js";
import { getNodeDefs } from "../pages/workflow/node-defs.js";
import { renderAvailBadge, availCls, lockedAttrs } from "../pages/workflow/node-availability.js";

const ROLE_ORDER: Array<{ role: string; label: string }> = [
  { role: "source", label: "Source" },
  { role: "reference", label: "Reference" },
  { role: "processor", label: "Processor" },
  { role: "trigger", label: "Trigger" },
  { role: "transform", label: "Transform" },
  { role: "sink", label: "Sink" },
];

/** Build palette HTML grouped by role. */
export function buildMiniPaletteHTML(): string {
  const defs = getNodeDefs();
  if (defs.length === 0) return '<div class="mini-editor-hint">No node types loaded</div>';

  return ROLE_ORDER.map(({ role, label }) => {
    const nodes = defs.filter(d => d.role === role);
    if (nodes.length === 0) return "";
    return `
      <div class="mini-editor-palette-group-title">${label}</div>
      ${nodes.map(d => {
        const badges = (d.runtime ?? []).map(r =>
          r === "mobile"
            ? `<span class="mini-editor-rt-badge" style="background:#06b6d4">MOB</span>`
            : `<span class="mini-editor-rt-badge" style="background:#8b5cf6">SRV</span>`
        ).join("");
        const lockBadge = renderAvailBadge(d.type);
        const cls = availCls(d.type, "mini-editor-palette-item");
        return `<button class="${cls}" data-type="${d.type}" ${lockedAttrs(d.type)}>
          <span class="mini-editor-palette-dot" style="background:${d.color.header}"></span>
          <span class="mini-editor-palette-label">${esc(d.label)}</span>
          <span class="mini-editor-palette-badges">${badges}${lockBadge}</span>
        </button>`;
      }).join("")}
    `;
  }).join("");
}

/** Wire delegated click handler for palette items. Returns cleanup fn. */
export function wirePaletteEvents(container: HTMLElement, onAddNode: (type: string) => void): () => void {
  const handler = (e: Event) => {
    const target = (e.target as HTMLElement).closest(".mini-editor-palette-item") as HTMLElement | null;
    if (!target) return;
    const type = target.dataset.type;
    if (type) onAddNode(type);
  };
  container.addEventListener("click", handler);
  return () => container.removeEventListener("click", handler);
}
