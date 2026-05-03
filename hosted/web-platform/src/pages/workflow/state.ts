/**
 * Shared mutable state for the workflow editor.
 *
 * All modules import from here for state access. Module-level `let` variables
 * with exported getters/setters — matches existing page patterns.
 */

import {
  fetchWorkflow, createWorkflow, updateWorkflow,
} from "../../core/api-client.js";
import type { WorkflowDetail } from "../../core/workflow-types.js";

// --- State variables ---

let _container: HTMLElement | null = null;
let _pollTimer: ReturnType<typeof setInterval> | null = null;
let _workflow: WorkflowDetail | null = null;
let _dirty = false;
let _saving = false;
let _autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
let _selectedNodeId: string | null = null;
let _settingsPanelActive = false;
let _viewX = 0;
let _viewY = 0;
let _zoom = 1;

// --- Getters / Setters ---

export function getContainer(): HTMLElement | null { return _container; }
export function setContainer(c: HTMLElement | null): void { _container = c; }

export function getPollTimer() { return _pollTimer; }
export function setPollTimer(t: ReturnType<typeof setInterval> | null): void { _pollTimer = t; }

export function getWorkflow(): WorkflowDetail | null { return _workflow; }
export function setWorkflow(w: WorkflowDetail | null): void { _workflow = w; }

export function isDirty(): boolean { return _dirty; }
export function setDirty(d: boolean): void { _dirty = d; }

export function isSaving(): boolean { return _saving; }

export function getSelectedNodeId(): string | null { return _selectedNodeId; }
export function setSelectedNodeId(id: string | null): void { _selectedNodeId = id; }

export function getViewX(): number { return _viewX; }
export function setViewX(x: number): void { _viewX = x; }

export function getViewY(): number { return _viewY; }
export function setViewY(y: number): void { _viewY = y; }

export function getZoom(): number { return _zoom; }
export function setZoom(z: number): void { _zoom = z; }

/** Check if workflow settings panel is active */
export function isSettingsPanelActive(): boolean { return _settingsPanelActive; }
export function setSettingsPanelActive(active: boolean): void {
  _settingsPanelActive = active;
  if (active) setSelectedNodeId(null);
}

export function getViewBox(): { x: number; y: number; zoom: number } {
  return { x: _viewX, y: _viewY, zoom: _zoom };
}

// --- Helpers ---

export function nanoid(): string {
  return `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function getView(): "list" | "new" | "edit" {
  const hash = location.hash.slice(1);
  if (hash === "/workflows") return "list";
  if (hash === "/workflows/new") return "new";
  return "edit";
}

export function getWorkflowId(): string | null {
  const hash = location.hash.slice(1);
  const m = hash.match(/^\/workflows\/(.+)$/);
  return m ? m[1] : null;
}

// --- Auto-save ---

/** Debounced auto-save: persists workflow 2s after last change. */
export function autoSave(): void {
  if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(() => doSave(), 2000);
}

/** Save workflow to server (create or update). */
export async function doSave(): Promise<void> {
  if (!_workflow || _saving) return;
  _saving = true;
  updateSaveIndicator();
  try {
    _workflow.name = (_container?.querySelector("#wf-name") as HTMLInputElement)?.value ?? _workflow.name;
    _workflow.description = (_container?.querySelector("#wf-desc") as HTMLInputElement)?.value ?? _workflow.description;
    const nodesPayload = _workflow.nodes.map(n => ({ ...n, config: JSON.stringify(n.config) }));

    if (_workflow.id) {
      const result = await updateWorkflow(_workflow.id, {
        name: _workflow.name,
        description: _workflow.description,
        nodes: nodesPayload,
        edges: _workflow.edges,
        canvasViewport: JSON.stringify({ x: _viewX, y: _viewY, zoom: _zoom }),
        flowConfig: _workflow.flowConfig ?? undefined,
        settings: _workflow.settings ?? undefined,
      });
      if (result) {
        _workflow = result;
        _dirty = false;
      } else {
        console.warn("[auto-save] server rejected save — server may need redeploy");
      }
    } else {
      const result = await createWorkflow({
        name: _workflow.name,
        description: _workflow.description,
        nodes: nodesPayload,
        edges: _workflow.edges,
      });
      if (result) {
        const published = await updateWorkflow(result.id, { status: "published" });
        _workflow = published ?? result;
        history.replaceState(null, "", `#/workflows/${_workflow!.id}`);
        _dirty = false;
      } else {
        console.warn("[auto-save] server rejected create — server may need redeploy");
      }
    }
    updateSaveIndicator();
  } catch (err) {
    console.error("[auto-save] failed:", err);
  } finally {
    _saving = false;
  }
}

/** Show save status in toolbar. */
export function updateSaveIndicator(): void {
  const el = _container?.querySelector("#wf-save-status");
  if (!el) return;
  if (_saving) el.textContent = "Saving...";
  else if (_dirty) el.textContent = "Unsaved";
  else el.textContent = "Saved";
}

// --- Palette collapse state ---

let _paletteCollapse: Record<string, boolean> = {};

export function getPaletteCollapseState(): Record<string, boolean> { return _paletteCollapse; }
export function setPaletteCollapseState(state: Record<string, boolean>): void { _paletteCollapse = state; }

export function loadPaletteCollapse(): void {
  try {
    const raw = localStorage.getItem("wf-palette-collapse");
    _paletteCollapse = raw ? JSON.parse(raw) : {};
  } catch { _paletteCollapse = {}; }
}

export function savePaletteCollapse(): void {
  try {
    localStorage.setItem("wf-palette-collapse", JSON.stringify(_paletteCollapse));
  } catch { /* ignore quota */ }
}

// --- Reset (called from page.destroy) ---

export function resetState(): void {
  if (_autoSaveTimer) { clearTimeout(_autoSaveTimer); _autoSaveTimer = null; }
  _container = null;
  _dirty = false;
  _saving = false;
  _workflow = null;
  _selectedNodeId = null;
  _settingsPanelActive = false;
  _viewX = 0;
  _viewY = 0;
  _zoom = 1;
}
