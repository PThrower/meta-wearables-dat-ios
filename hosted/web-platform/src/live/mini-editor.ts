/**
 * MiniWorkflowEditor — embedded workflow DAG panel inside the live player.
 * Shows the active workflow with live node status indicators.
 * Reuses parameterized svg-renderer for rendering.
 */

import { GuidancePanel, NODE_STATE_COLORS } from "../guidance.js";
import type { NodeState } from "../guidance.js";
import { fetchWorkflow } from "../core/api-client.js";
import type { WorkflowDetail } from "../core/api-client.js";
import { buildSVGFromData, NODE_STATUS_DOT_COLORS } from "../pages/workflow/svg-renderer.js";
import { getNodeDef } from "../pages/workflow/node-defs.js";
import { loadNodeDefs } from "../pages/workflow/node-defs.js";
import { esc } from "../core/api-client.js";

const MINI_SCALE = 0.6;
const PANEL_WIDTH = 380;

export class MiniWorkflowEditor {
  private container: HTMLElement;
  private canvas: HTMLElement;
  private config: HTMLElement;
  private header: HTMLElement;
  private guidancePanel: GuidancePanel;
  private sendFn: (msg: object) => void;
  private workflow: WorkflowDetail | null = null;
  private selectedNodeId: string | null = null;
  private nodeStates = new Map<string, string>();
  private collapsed = true;

  constructor(container: HTMLElement, guidancePanel: GuidancePanel, sendFn: (msg: object) => void) {
    this.container = container;
    this.guidancePanel = guidancePanel;
    this.sendFn = sendFn;
    this.canvas = container.querySelector("#miniEditorCanvas")!;
    this.config = container.querySelector("#miniEditorConfig")!;
    this.header = container.querySelector("#miniEditorHeader")!;
    this.bindEvents();
  }

  toggle(): void {
    this.collapsed = !this.collapsed;
    this.container.classList.toggle("collapsed", this.collapsed);
    if (!this.collapsed) {
      // Collapse guidance panel when opening mini editor
      if (!this.guidancePanel.isCollapsed()) {
        this.guidancePanel.toggle();
      }
      this.loadWorkflow();
    }
  }

  async loadWorkflow(): Promise<void> {
    const workflowId = this.guidancePanel.getActiveWorkflowId();
    if (!workflowId) {
      this.header.innerHTML = '<span class="mini-editor-hint">No active workflow</span>';
      this.canvas.innerHTML = "";
      return;
    }
    this.header.innerHTML = '<span class="mini-editor-hint">Loading...</span>';
    try {
      await loadNodeDefs();
      const wf = await fetchWorkflow(workflowId);
      if (wf) {
        this.workflow = wf;
        this.header.innerHTML = `<span class="mini-editor-title">${esc(wf.name)}</span>`;
        this.syncNodeStates();
        this.render();
      } else {
        this.header.innerHTML = '<span class="mini-editor-hint">Workflow not found</span>';
      }
    } catch {
      this.header.innerHTML = '<span class="mini-editor-hint">Failed to load</span>';
    }
  }

  /** Update node states from guidance panel's node_states messages. */
  updateNodeStates(nodes: NodeState[]): void {
    this.nodeStates.clear();
    for (const n of nodes) {
      this.nodeStates.set(n.nodeId, n.state);
    }
    if (this.workflow && !this.collapsed) {
      this.render();
    }
  }

  /** Sync node states from the guidance panel (on initial load). */
  private syncNodeStates(): void {
    this.nodeStates.clear();
    for (const n of this.guidancePanel.getNodeStates()) {
      this.nodeStates.set(n.nodeId, n.state);
    }
  }

  private render(): void {
    if (!this.workflow) return;
    const svg = buildSVGFromData(
      this.workflow,
      { x: 0, y: 0, zoom: 1 },
      this.selectedNodeId,
      this.nodeStates,
      MINI_SCALE,
    );
    this.canvas.innerHTML = svg;
    this.wireCanvasEvents();
    this.renderConfigPanel();
  }

  private wireCanvasEvents(): void {
    const svg = this.canvas.querySelector(".wf-canvas-svg");
    if (!svg) return;

    // Node click -> select
    svg.querySelectorAll(".wf-node").forEach(g => {
      g.addEventListener("click", (e) => {
        e.stopPropagation();
        const nodeId = (g as Element).getAttribute("data-id")!;
        this.selectedNodeId = this.selectedNodeId === nodeId ? null : nodeId;
        this.render();
      });
    });

    // Click background -> deselect
    svg.addEventListener("click", () => {
      this.selectedNodeId = null;
      this.render();
    });
  }

  private renderConfigPanel(): void {
    if (!this.workflow || !this.selectedNodeId) {
      this.config.innerHTML = '<span class="mini-editor-hint">Click a node to inspect</span>';
      return;
    }

    const node = this.workflow.nodes.find(n => n.id === this.selectedNodeId);
    if (!node) {
      this.config.innerHTML = "";
      return;
    }

    const def = getNodeDef(node.type);
    const state = this.nodeStates.get(node.id) ?? "unknown";
    const stateColor = NODE_STATE_COLORS[state as keyof typeof NODE_STATE_COLORS] ?? "#9ca3af";

    let html = `<div class="mini-config-header" style="border-left: 3px solid ${def?.color.header ?? "#666"}">
      <span class="mini-config-type">${esc(def?.label ?? node.type)}</span>
      <span class="mini-config-state" style="background:${stateColor}30;color:${stateColor}">${state}</span>
    </div>`;

    // Show key config values
    const keys = Object.keys(node.config).slice(0, 4);
    for (const key of keys) {
      const val = node.config[key];
      if (val === undefined || val === "") continue;
      html += `<div class="mini-config-row">
        <span class="mini-config-key">${esc(key)}</span>
        <span class="mini-config-val">${esc(String(val).slice(0, 30))}</span>
      </div>`;
    }

    this.config.innerHTML = html;
  }

  private bindEvents(): void {
    const toggle = this.container.querySelector("#miniEditorToggle");
    if (toggle) {
      toggle.addEventListener("click", () => this.toggle());
    }
  }

  destroy(): void {
    this.workflow = null;
    this.nodeStates.clear();
    this.canvas.innerHTML = "";
    this.config.innerHTML = "";
    this.header.innerHTML = "";
  }
}
