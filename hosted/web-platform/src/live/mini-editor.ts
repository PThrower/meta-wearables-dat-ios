/**
 * MiniWorkflowEditor — embedded interactive workflow DAG panel inside the live player.
 * Supports: auto-fit zoom, node palette, node drag, edge creation/deletion,
 * schema-driven config editing, auto-save, execution controls.
 */

import { GuidancePanel, NODE_STATE_COLORS } from "../guidance.js";
import type { NodeState } from "../guidance.js";
import { fetchWorkflow, updateWorkflow, esc } from "../core/api-client.js";
import type { WorkflowDetail, WorkflowNodeDef } from "../core/api-client.js";
import { buildSVGFromData } from "../pages/workflow/svg-renderer.js";
import { getNodeDef, loadNodeDefs } from "../pages/workflow/node-defs.js";
import { NODE_W, NODE_H } from "../pages/workflow/constants.js";
import { wireMiniInteractions, rewireMiniSVG } from "./mini-editor-interactions.js";
import type { MiniEditorState } from "./mini-editor-interactions.js";
import { buildMiniPaletteHTML, wirePaletteEvents } from "./mini-editor-palette.js";
import { renderMiniConfigPanel } from "./mini-editor-config.js";

const PANEL_WIDTH = 380;
const PANEL_PAD = 20;

export class MiniWorkflowEditor {
  private container: HTMLElement;
  private canvas: HTMLElement;
  private configPanel: HTMLElement;
  private header: HTMLElement;
  private execBar: HTMLElement;
  private palette: HTMLElement;
  private tabBar: HTMLElement;
  private guidancePanel: GuidancePanel;
  private sendFn: (msg: object) => void;
  private workflow: WorkflowDetail | null = null;
  private selectedNodeId: string | null = null;
  private nodeStates = new Map<string, string>();
  private collapsed = true;

  // Pan/zoom state
  private viewBox: { x: number; y: number; zoom: number } = { x: 0, y: 0, zoom: 1 };

  // Auto-save
  private dirty = false;
  private saving = false;
  private autoSaveTimer: ReturnType<typeof setTimeout> | null = null;

  // Tab state
  private activeTab: "canvas" | "palette" = "canvas";

  // Interaction cleanup
  private cleanupInteractions: (() => void) | null = null;
  private cleanupPalette: (() => void) | null = null;

  constructor(container: HTMLElement, guidancePanel: GuidancePanel, sendFn: (msg: object) => void) {
    this.container = container;
    this.guidancePanel = guidancePanel;
    this.sendFn = sendFn;
    this.canvas = container.querySelector("#miniEditorCanvas")!;
    this.configPanel = container.querySelector("#miniEditorConfigPanel")!;
    this.header = container.querySelector("#miniEditorHeader")!;
    this.execBar = container.querySelector("#miniEditorExecBar")!;
    this.palette = container.querySelector("#miniEditorPalette")!;
    this.tabBar = container.querySelector("#miniEditorTabBar")!;
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
      this.header.innerHTML = '<span class="mini-editor-title">No active workflow</span>';
      this.execBar.innerHTML = "";
      this.canvas.innerHTML = "";
      this.configPanel.innerHTML = '<span class="mini-editor-hint">No workflow active</span>';
      return;
    }
    this.header.innerHTML = '<span class="mini-editor-title">Loading...</span>';
    try {
      await loadNodeDefs();
      const wf = await fetchWorkflow(workflowId);
      if (wf) {
        this.workflow = wf;
        this.header.innerHTML = `<span class="mini-editor-title">${esc(wf.name)}</span>`;
        this.syncNodeStates();
        this.computeAutoFit();
        this.renderPalette();
        this.render();
      } else {
        this.header.innerHTML = '<span class="mini-editor-title">Workflow not found</span>';
      }
    } catch {
      this.header.innerHTML = '<span class="mini-editor-title">Failed to load</span>';
    }
  }

  /** Update node states from guidance panel's node_states messages. */
  updateNodeStates(nodes: NodeState[]): void {
    this.nodeStates.clear();
    for (const n of nodes) {
      this.nodeStates.set(n.nodeId, n.state);
    }
    if (this.workflow && !this.collapsed) {
      this.renderExecBar();
      this.render();
      if (this.selectedNodeId) this.renderConfigPanel();
    }
  }

  private syncNodeStates(): void {
    this.nodeStates.clear();
    for (const n of this.guidancePanel.getNodeStates()) {
      this.nodeStates.set(n.nodeId, n.state);
    }
  }

  private computeAutoFit(): void {
    if (!this.workflow || this.workflow.nodes.length === 0) {
      this.viewBox = { x: 0, y: 0, zoom: 1 };
      return;
    }
    const ns = this.workflow.nodes;
    const minX = Math.min(...ns.map(n => n.positionX));
    const maxX = Math.max(...ns.map(n => n.positionX + NODE_W));
    const minY = Math.min(...ns.map(n => n.positionY));
    const maxY = Math.max(...ns.map(n => n.positionY + NODE_H));
    const pad = 60;
    const contentW = maxX - minX + pad * 2;
    const contentH = maxY - minY + pad * 2;
    const panelW = PANEL_WIDTH - PANEL_PAD;
    const panelH = 300; // typical canvas height
    const zoom = Math.min(panelW / contentW, panelH / contentH, 1.5);
    this.viewBox = {
      x: minX - pad,
      y: minY - pad,
      zoom,
    };
  }

  private render(): void {
    if (!this.workflow) return;
    const svg = buildSVGFromData(
      this.workflow,
      this.viewBox,
      this.selectedNodeId,
      this.nodeStates,
      1, // scale=1, auto-fit zoom handles sizing via viewBox
      "mini-wf-svg",
    );
    this.canvas.innerHTML = svg;

    // Override the viewBox computed by buildSVGFromData to use our auto-fit values
    const svgEl = this.canvas.querySelector("#mini-wf-svg") as SVGElement | null;
    if (svgEl) {
      const vbW = 1100 / this.viewBox.zoom;
      const vbH = 700 / this.viewBox.zoom;
      svgEl.setAttribute("viewBox", `${this.viewBox.x} ${this.viewBox.y} ${vbW} ${vbH}`);
    }

    // Wire interactions (initial setup or rewire after render)
    if (!this.cleanupInteractions) {
      this.cleanupInteractions = wireMiniInteractions(this.canvas, this.stateInterface);
    } else {
      rewireMiniSVG(this.canvas);
    }

    this.renderExecBar();
  }

  private renderPalette(): void {
    this.palette.innerHTML = buildMiniPaletteHTML();
    if (this.cleanupPalette) this.cleanupPalette();
    this.cleanupPalette = wirePaletteEvents(this.palette, (type) => this.addNode(type));
  }

  private renderExecBar(): void {
    if (!this.workflow) { this.execBar.innerHTML = ""; return; }
    const hasRunning = Array.from(this.nodeStates.values()).some(s => s === "running");
    const hasPaused = Array.from(this.nodeStates.values()).some(s => s === "paused");
    let html = "";
    if (hasRunning) html += `<button class="exec-warn" data-exec="pause_all">Pause</button>`;
    if (hasPaused) html += `<button class="exec-go" data-exec="resume_all">Resume</button>`;
    if (this.nodeStates.size > 0) html += `<button class="exec-danger" data-exec="stop">Stop</button>`;
    this.execBar.innerHTML = html;
  }

  private renderConfigPanel(): void {
    if (!this.workflow || !this.selectedNodeId) {
      this.configPanel.innerHTML = '<span class="mini-editor-hint">Select a node to edit</span>';
      return;
    }
    const node = this.workflow.nodes.find(n => n.id === this.selectedNodeId);
    if (!node) {
      this.configPanel.innerHTML = "";
      return;
    }
    const def = getNodeDef(node.type);
    const state = this.nodeStates.get(node.id);
    renderMiniConfigPanel(
      this.configPanel,
      node,
      def,
      state,
      (field, value) => this.onConfigChange(field, value),
      (nodeId) => this.deleteNode(nodeId),
      (action, nodeId) => this.onNodeAction(action, nodeId),
    );
  }

  private onConfigChange(field: string, value: unknown): void {
    if (!this.workflow || !this.selectedNodeId) return;
    const node = this.workflow.nodes.find(n => n.id === this.selectedNodeId);
    if (!node) return;
    if (field.startsWith("config.")) {
      const key = field.slice(7);
      node.config[key] = value;
    } else if (field === "label") {
      node.label = String(value);
    }
    this.dirty = true;
    this.autoSave();
    this.render();
  }

  private onNodeAction(action: string, nodeId: string): void {
    const workflowId = this.workflow?.id;
    if (!workflowId) return;
    this.sendFn({ type: "workflow_control", action, workflowId, nodeId });
  }

  private addNode(type: string): void {
    if (!this.workflow) return;
    const def = getNodeDef(type);
    const id = `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const config = def ? { ...def.defaultConfig } : {};
    // Place at viewport center
    const vb = this.viewBox;
    const vbW = 1100 / vb.zoom;
    const vbH = 700 / vb.zoom;
    const cx = vb.x + vbW / 2 - NODE_W / 2;
    const cy = vb.y + vbH / 2 - NODE_H / 2;
    this.workflow.nodes.push({
      id,
      type,
      label: def?.defaultLabel ?? type.replace(/-/g, " "),
      config,
      positionX: Math.round(cx),
      positionY: Math.round(cy),
    });
    this.dirty = true;
    this.autoSave();
    this.selectedNodeId = id;
    // Switch to canvas tab
    this.switchTab("canvas");
    this.render();
    this.renderConfigPanel();
  }

  private deleteNode(nodeId: string): void {
    if (!this.workflow) return;
    this.workflow.nodes = this.workflow.nodes.filter(n => n.id !== nodeId);
    this.workflow.edges = this.workflow.edges.filter(e => e.sourceNodeId !== nodeId && e.targetNodeId !== nodeId);
    if (this.selectedNodeId === nodeId) this.selectedNodeId = null;
    this.dirty = true;
    this.autoSave();
    this.render();
    this.renderConfigPanel();
  }

  private switchTab(tab: "canvas" | "palette"): void {
    this.activeTab = tab;
    this.canvas.classList.toggle("hidden", tab !== "canvas");
    this.palette.classList.toggle("hidden", tab !== "palette");
    this.tabBar.querySelectorAll(".mini-editor-tab").forEach(btn => {
      btn.classList.toggle("active", (btn as HTMLElement).dataset.tab === tab);
    });
  }

  private autoSave(): void {
    if (this.autoSaveTimer) clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = setTimeout(() => this.doSave(), 2000);
  }

  private async doSave(): Promise<void> {
    if (!this.workflow || this.saving) return;
    if (!this.workflow.id) return;
    this.saving = true;
    try {
      const nodesPayload = this.workflow.nodes.map(n => ({ ...n, config: JSON.stringify(n.config) }));
      const result = await updateWorkflow(this.workflow.id, {
        nodes: nodesPayload,
        edges: this.workflow.edges,
        canvasViewport: JSON.stringify(this.viewBox),
      });
      if (result) {
        this.workflow = result;
        this.dirty = false;
      }
    } finally {
      this.saving = false;
    }
  }

  /** State interface for interactions module. */
  private stateInterface: MiniEditorState = {
    getWorkflow: () => this.workflow,
    getSelectedNodeId: () => this.selectedNodeId,
    setSelectedNodeId: (id) => { this.selectedNodeId = id; },
    getViewBox: () => this.viewBox,
    setViewBox: (v) => { this.viewBox = v; },
    markDirty: () => { this.dirty = true; this.autoSave(); },
    render: () => this.render(),
    renderConfig: () => this.renderConfigPanel(),
  };

  private bindEvents(): void {
    // Toggle button
    const toggle = this.container.querySelector("#miniEditorToggle");
    if (toggle) {
      toggle.addEventListener("click", () => this.toggle());
    }

    // Tab bar
    this.tabBar.addEventListener("click", (e) => {
      const target = (e.target as HTMLElement).closest(".mini-editor-tab") as HTMLElement | null;
      if (!target) return;
      const tab = target.dataset.tab as "canvas" | "palette";
      this.switchTab(tab);
    });

    // Exec bar (delegated)
    this.execBar.addEventListener("click", (e) => {
      const target = (e.target as HTMLElement).closest("[data-exec]") as HTMLElement | null;
      if (!target) return;
      const action = target.dataset.exec!;
      const workflowId = this.workflow?.id;
      if (workflowId) {
        this.sendFn({ type: "workflow_control", action, workflowId });
      }
    });
  }

  destroy(): void {
    if (this.autoSaveTimer) { clearTimeout(this.autoSaveTimer); this.autoSaveTimer = null; }
    if (this.cleanupInteractions) { this.cleanupInteractions(); this.cleanupInteractions = null; }
    if (this.cleanupPalette) { this.cleanupPalette(); this.cleanupPalette = null; }
    // Save any pending changes
    if (this.dirty && this.workflow?.id) {
      this.doSave();
    }
    this.workflow = null;
    this.nodeStates.clear();
    this.selectedNodeId = null;
    this.canvas.innerHTML = "";
    this.configPanel.innerHTML = "";
    this.execBar.innerHTML = "";
    this.palette.innerHTML = "";
    this.header.innerHTML = "";
  }
}
