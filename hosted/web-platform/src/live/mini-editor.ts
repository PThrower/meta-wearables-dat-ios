/**
 * MiniWorkflowEditor — embedded interactive workflow DAG panel inside the live player.
 * Supports: auto-fit zoom, node palette, node drag, edge creation/deletion,
 * schema-driven config editing, auto-save, execution controls.
 */

import { GuidancePanel, NODE_STATE_COLORS } from "../guidance.js";
import type { NodeState } from "../guidance.js";
import { fetchWorkflow, updateWorkflow, esc } from "../core/api-client.js";
import type { WorkflowDetail } from "../core/api-client.js";
import { NODE_STATE_VISUALS, resolveSubtitle } from "../pages/workflow/svg-renderer.js";
import { getNodeDef, loadNodeDefs } from "../pages/workflow/node-defs.js";
import { NODE_W, NODE_H, NODE_R, FALLBACK_COLOR } from "../pages/workflow/constants.js";
import { detectFlows, DEFAULT_EDGE_COLOR } from "../pages/workflow/flow-detection.js";
import { renderFlowConfigHTML, wireFlowConfigEvents } from "../pages/workflow/shared-config.js";
import type { FlowConfigCallbacks, ConfigFieldCallbacks } from "../pages/workflow/shared-config.js";
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

  // Debug output: last text received per source appId
  private debugOutput = new Map<string, string>();

  // Tab state
  private activeTab: "canvas" | "palette" | "flows" = "canvas";

  // Interaction cleanup
  private cleanupInteractions: (() => void) | null = null;
  private cleanupPalette: (() => void) | null = null;

  // Shared flow config callbacks
  private _flowCallbacks: FlowConfigCallbacks = {
    getWorkflow: () => this.workflow,
    setFlowConfig: (config) => { if (this.workflow) this.workflow.flowConfig = config; },
    setDirty: () => { this.dirty = true; },
    autoSave: () => this.autoSave(),
    rerender: () => this.renderFlowConfig(),
  };

  // Shared config field callbacks
  private _configCallbacks: ConfigFieldCallbacks = {
    getWorkflow: () => this.workflow,
    getSelectedNodeId: () => this.selectedNodeId,
    setDirty: () => { this.dirty = true; },
    autoSave: () => this.autoSave(),
    refreshSVG: () => this.render(),
  };

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
        this.updateFlowTabVisibility();
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

  /** Push live text to debug-sink nodes connected downstream from the source. */
  pushDebugOutput(sourceAppId: string, text: string): void {
    if (!this.workflow || this.collapsed) return;
    // Find debug-sink nodes that receive edges from the source or its processors
    const debugNodes = this.workflow.nodes.filter(n => n.type === "debug-sink");
    for (const dn of debugNodes) {
      // Check if there's any path from sourceAppId to this debug node
      // Simple approach: if the debug node has any incoming edge, update it
      const hasIncoming = this.workflow.edges.some(e => e.targetNodeId === dn.id);
      if (hasIncoming) {
        this.debugOutput.set(dn.id, text);
        // Update the SVG text element directly — no full re-render
        const svg = this.canvas.querySelector("#mini-wf-svg");
        if (!svg) return;
        const g = svg.querySelector(`g[data-id="${dn.id}"]`);
        if (!g) return;
        const txt = g.querySelector(".wf-debug-text");
        if (txt) txt.textContent = text.slice(0, 30);
      }
    }
  }

  /** Compute auto-fit viewBox from node bounding box. Returns actual viewBox dimensions. */
  private computeAutoFit(): { vbX: number; vbY: number; vbW: number; vbH: number } {
    if (!this.workflow || this.workflow.nodes.length === 0) {
      this.viewBox = { x: 0, y: 0, zoom: 1 };
      return { vbX: 0, vbY: 0, vbW: 900, vbH: 600 };
    }
    const ns = this.workflow.nodes;
    const minX = Math.min(...ns.map(n => n.positionX));
    const maxX = Math.max(...ns.map(n => n.positionX + NODE_W));
    const minY = Math.min(...ns.map(n => n.positionY));
    const maxY = Math.max(...ns.map(n => n.positionY + NODE_H));
    const pad = 40;
    const contentW = maxX - minX + pad * 2;
    const contentH = maxY - minY + pad * 2;
    // zoom=1 means viewBox matches content exactly — the SVG element fills its container
    this.viewBox = { x: minX - pad, y: minY - pad, zoom: 1 };
    return {
      vbX: minX - pad,
      vbY: minY - pad,
      vbW: contentW,
      vbH: contentH,
    };
  }

  private render(): void {
    if (!this.workflow) return;
    const { vbX, vbY, vbW, vbH } = this.computeAutoFit();

    // Build SVG directly with correct viewBox — avoids buildSVGFromData's
    // hardcoded 1100x600 viewBox and giant grid rect that cause rendering issues
    const nodes = this.workflow.nodes;
    const edges = this.workflow.edges;

    // Detect flows for coloring
    const flows = detectFlows(nodes, edges);
    const multiFlow = flows.length > 1;
    const nodeFlowColor = new Map<string, string>();
    const edgeFlowColor = new Map<string, string>();
    if (multiFlow) {
      for (const f of flows) {
        for (const nid of f.nodeIds) nodeFlowColor.set(nid, f.color);
        for (const eid of f.edgeIds) edgeFlowColor.set(eid, f.color);
      }
    }

    const nodeSVGs = nodes.map(n => {
      const def = getNodeDef(n.type);
      const c = def?.color ?? FALLBACK_COLOR;
      const configSummary = def ? resolveSubtitle(def.subtitle, n.config) : "";
      const selected = this.selectedNodeId === n.id;
      const stateColor = this.nodeStates.get(n.id);
      const statusDot = stateColor
        ? `<circle cx="8" cy="8" r="5" fill="${NODE_STATE_VISUALS[stateColor]?.color ?? "#9ca3af"}" />`
        : "";
      // Flow indicator badge (small colored dot in top-left, only when multi-flow)
      const flowDot = multiFlow && nodeFlowColor.has(n.id)
        ? `<circle cx="22" cy="8" r="4" fill="${nodeFlowColor.get(n.id)}" stroke="#0a0a0a" stroke-width="1" />`
        : "";
      // Debug output text for debug-sink nodes
      const isDebug = n.type === "debug-sink";
      const debugText = isDebug ? (this.debugOutput.get(n.id) ?? "waiting...") : "";
      const debugLine = isDebug
        ? `<text class="wf-debug-text" x="12" y="60" fill="#4ade80" font-size="8" font-family="monospace">${esc(debugText.slice(0, 30))}</text>`
        : (configSummary ? `<text x="12" y="60" fill="#888" font-size="9">${esc(configSummary)}</text>` : "");
      return `<g class="wf-node" data-id="${n.id}" transform="translate(${n.positionX}, ${n.positionY})">
        ${statusDot}
        ${flowDot}
        <rect class="wf-node-bg" width="${NODE_W}" height="${NODE_H}" rx="${NODE_R}" fill="${c.fill}" stroke="${selected ? "#fff" : c.stroke}" stroke-width="${selected ? 2 : 1}" />
        <rect class="wf-node-header" width="${NODE_W}" height="24" rx="${NODE_R}" fill="${c.header}" />
        <rect x="0" y="${NODE_R}" width="${NODE_W}" height="${24 - NODE_R}" fill="${c.header}" />
        <text x="${NODE_W / 2}" y="16" text-anchor="middle" fill="#fff" font-size="10" font-weight="600">${esc(n.type.replace(/-/g, " "))}</text>
        <text x="12" y="44" fill="#ccc" font-size="11">${esc(n.label || n.type)}</text>
        ${debugLine}
        <circle class="wf-port wf-port-in" cx="0" cy="${NODE_H / 2}" r="6" fill="${c.stroke}" stroke="#0a0a0a" stroke-width="2" />
        <circle class="wf-port wf-port-out" cx="${NODE_W}" cy="${NODE_H / 2}" r="6" fill="${c.stroke}" stroke="#0a0a0a" stroke-width="2" />
      </g>`;
    }).join("");

    const edgeSVGs = edges.map(e => {
      const src = nodes.find(n => n.id === e.sourceNodeId);
      const tgt = nodes.find(n => n.id === e.targetNodeId);
      if (!src || !tgt) return "";
      const sx = src.positionX + NODE_W;
      const sy = src.positionY + NODE_H / 2;
      const tx = tgt.positionX;
      const ty = tgt.positionY + NODE_H / 2;
      const mx = (sx + tx) / 2;
      const edgeColor = multiFlow ? (edgeFlowColor.get(e.id) ?? DEFAULT_EDGE_COLOR) : DEFAULT_EDGE_COLOR;
      return `<path class="wf-edge" data-id="${e.id}" d="M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ty}, ${tx} ${ty}" fill="none" stroke="${edgeColor}" stroke-width="2" />`;
    }).join("");

    const svg = `<svg class="wf-canvas-svg" id="mini-wf-svg" viewBox="${vbX} ${vbY} ${vbW} ${vbH}" xmlns="http://www.w3.org/2000/svg">${edgeSVGs}${nodeSVGs}</svg>`;
    this.canvas.innerHTML = svg;

    // Store initial viewBox width for zoom ratio tracking
    (this.canvas as any).__initialVbW = vbW;

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

    // Detect flows for label
    const flows = detectFlows(this.workflow.nodes, this.workflow.edges);
    const multiFlow = flows.length > 1;

    let html = "";

    // Show flow label when executing with multiple flows
    if (multiFlow && this.nodeStates.size > 0) {
      const flowConfig = this.workflow.flowConfig;
      const mode = flowConfig?.mode ?? "parallel";
      const currentFlowLabel = mode === "sequential" && flowConfig?.flowOrder?.[0]
        ? (flows.find(f => f.flowId === flowConfig.flowOrder[0])?.label ?? "Flow 1")
        : `${flows.length} flows (parallel)`;
      html += `<span style="font-size:10px;color:var(--text-tertiary);margin-right:6px;">${esc(currentFlowLabel)}</span>`;
    }

    if (hasRunning) html += `<button class="exec-warn" data-exec="pause_all">Pause</button>`;
    if (hasPaused) html += `<button class="exec-go" data-exec="resume_all">Resume</button>`;
    if (this.nodeStates.size > 0) html += `<button class="exec-danger" data-exec="stop">Stop</button>`;
    this.execBar.innerHTML = html;
  }

  private renderConfigPanel(): void {
    // Flows tab: render flow config into config panel area
    if (this.activeTab === "flows") {
      this.renderFlowConfig();
      return;
    }
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
      this._configCallbacks,
      (nodeId) => this.deleteNode(nodeId),
      (action, nodeId) => this.onNodeAction(action, nodeId),
      this.workflow.nodes,
      this.workflow.edges,
    );
  }

  /** Render flow config panel in the mini-editor config area. */
  private renderFlowConfig(): void {
    if (!this.workflow) {
      this.configPanel.innerHTML = '<span class="mini-editor-hint">No workflow loaded</span>';
      return;
    }
    const flows = detectFlows(this.workflow.nodes, this.workflow.edges);
    if (flows.length <= 1) {
      this.configPanel.innerHTML = '<span class="mini-editor-hint">Only one flow — nothing to configure</span>';
      return;
    }
    this.configPanel.innerHTML = renderFlowConfigHTML(flows, this.workflow.flowConfig, "mini-wf");
    wireFlowConfigEvents(this.configPanel, flows, this._flowCallbacks);
  }

  /** Show or hide the flows tab based on flow count. */
  private updateFlowTabVisibility(): void {
    const flowsTab = this.tabBar.querySelector('[data-tab="flows"]');
    if (!flowsTab) return;
    if (!this.workflow) {
      flowsTab.classList.add("hidden");
      return;
    }
    const flows = detectFlows(this.workflow.nodes, this.workflow.edges);
    flowsTab.classList.toggle("hidden", flows.length <= 1);
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
    // Place near center of existing nodes, offset slightly
    const ns = this.workflow.nodes;
    const cx = ns.length > 0
      ? Math.round(ns.reduce((s, n) => s + n.positionX, 0) / ns.length)
      : 200;
    const cy = ns.length > 0
      ? Math.round(ns.reduce((s, n) => s + n.positionY, 0) / ns.length)
      : 150;
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

  private switchTab(tab: "canvas" | "palette" | "flows"): void {
    this.activeTab = tab;
    this.canvas.classList.toggle("hidden", tab !== "canvas");
    this.palette.classList.toggle("hidden", tab !== "palette");
    this.tabBar.querySelectorAll(".mini-editor-tab").forEach(btn => {
      btn.classList.toggle("active", (btn as HTMLElement).dataset.tab === tab);
    });
    if (tab === "flows") {
      this.selectedNodeId = null;
      this.renderConfigPanel();
    } else if (tab === "canvas") {
      this.configPanel.innerHTML = '<span class="mini-editor-hint">Select a node to edit</span>';
    }
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
      const tab = target.dataset.tab as "canvas" | "palette" | "flows";
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
