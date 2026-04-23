/**
 * Workflow Editor — visual DAG builder for AI processing pipelines.
 *
 * Two views driven by hash:
 *   #/workflows       -> list view (cards grid)
 *   #/workflows/new   -> editor with empty canvas
 *   #/workflows/:id   -> editor with loaded workflow
 */

import type { PageModule } from "../router/router.js";
import {
  fetchWorkflows, fetchWorkflow, createWorkflow, updateWorkflow, deleteWorkflow,
  activateWorkflow, fetchSessions, esc, formatDateTime,
} from "../core/api-client.js";
import type { WorkflowSummary, WorkflowDetail, WorkflowNodeDef, WorkflowEdgeDef, SessionInfo } from "../core/api-client.js";

export const page: PageModule = {
  init(container) {
    _container = container;
    renderView();
  },
  destroy() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    document.removeEventListener("keydown", onKeyDown);
    _container = null;
    _dirty = false;
    _workflow = null;
    _selectedNodeId = null;
    _viewX = 0;
    _viewY = 0;
    _zoom = 1;
    _dragState = null;
    _edgeState = null;
    _panState = null;
  },
};

let _container: HTMLElement | null = null;
let _pollTimer: ReturnType<typeof setInterval> | null = null;
let _workflow: WorkflowDetail | null = null;
let _dirty = false;
let _selectedNodeId: string | null = null;

// SVG drag state
let _dragState: { nodeId: string; startX: number; startY: number; nodeStartX: number; nodeStartY: number } | null = null;
let _edgeState: { sourceNodeId: string; tempLine: SVGLineElement } | null = null;
let _panState: { startX: number; startY: number; viewX: number; viewY: number } | null = null;

// SVG viewBox
let _viewX = 0;
let _viewY = 0;
let _zoom = 1;

const NODE_COLORS: Record<string, { fill: string; header: string; stroke: string }> = {
  "camera-source": { fill: "#0d3d38", header: "#14b8a6", stroke: "#14b8a6" },
  "s2s-live": { fill: "#0d3320", header: "#22c55e", stroke: "#22c55e" },
  "s2s-rest": { fill: "#0d2040", header: "#3b82f6", stroke: "#3b82f6" },
  "s2s-e4b": { fill: "#2d1050", header: "#a855f7", stroke: "#a855f7" },
  "output": { fill: "#3d2000", header: "#f97316", stroke: "#f97316" },
};

const NODE_W = 180;
const NODE_H = 80;
const NODE_R = 8;

function nanoid(): string {
  return `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function getView(): "list" | "new" | "edit" {
  const hash = location.hash.slice(1);
  if (hash === "/workflows") return "list";
  if (hash === "/workflows/new") return "new";
  return "edit";
}

function getWorkflowId(): string | null {
  const hash = location.hash.slice(1);
  const m = hash.match(/^\/workflows\/(.+)$/);
  return m ? m[1] : null;
}

function renderView(): void {
  const view = getView();
  if (view === "list") renderList();
  else renderEditor(view === "new");
}

// --- List View ---

async function renderList(): Promise<void> {
  if (!_container) return;
  _container.innerHTML = `
    <div class="page workflow-page">
      <div class="page-header">
        <div class="page-header-row">
          <div>
            <h1 class="page-title">Workflows</h1>
            <span class="page-subtitle">AI pipeline builder</span>
          </div>
          <button class="btn btn-primary" id="wf-new-btn">+ New</button>
        </div>
      </div>
      <div id="wf-list" class="wf-card-grid">
        <p class="empty-state">Loading workflows...</p>
      </div>
    </div>
  `;

  _container.querySelector("#wf-new-btn")?.addEventListener("click", () => {
    location.hash = "/workflows/new";
  });

  await loadList();
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = setInterval(() => loadList(), 15000);
}

async function loadList(): Promise<void> {
  const listEl = _container?.querySelector("#wf-list");
  if (!listEl) return;

  const workflows = await fetchWorkflows();
  if (workflows.length === 0) {
    listEl.innerHTML = '<p class="empty-state">No workflows yet. Click "+ New" to create one.</p>';
    return;
  }

  listEl.innerHTML = workflows.map(w => {
    const statusClass = w.status === "published" ? "wf-status-published" : w.status === "archived" ? "wf-status-archived" : "wf-status-draft";
    return `
      <div class="wf-card" data-id="${esc(w.id)}">
        <div class="wf-card-header">
          <span class="wf-card-name">${esc(w.name)}</span>
          <span class="wf-card-status ${statusClass}">${esc(w.status)}</span>
        </div>
        <p class="wf-card-desc">${esc(w.description || "No description")}</p>
        <div class="wf-card-meta">
          <span>${w.nodeCount} nodes</span>
          <span>${formatDateTime(w.updatedAt)}</span>
        </div>
        <div class="wf-card-actions">
          <button class="btn btn-sm wf-edit-btn" data-id="${esc(w.id)}">Edit</button>
          <button class="btn btn-sm btn-danger wf-delete-btn" data-id="${esc(w.id)}">Delete</button>
        </div>
      </div>
    `;
  }).join("");

  listEl.querySelectorAll(".wf-edit-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      location.hash = `/workflows/${(btn as HTMLElement).dataset.id}`;
    });
  });

  listEl.querySelectorAll(".wf-delete-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this workflow?")) return;
      await deleteWorkflow((btn as HTMLElement).dataset.id!);
      await loadList();
    });
  });
}

// --- Editor View ---

async function renderEditor(isNew: boolean): Promise<void> {
  if (!_container) return;
  _dirty = false;
  _selectedNodeId = null;
  _viewX = 0;
  _viewY = 0;
  _zoom = 1;

  if (isNew) {
    const now = Date.now();
    _workflow = {
      id: "",
      name: "Untitled Workflow",
      description: "",
      status: "draft",
      ownerId: null,
      nodes: [
        { id: `n_src_${now}`, type: "camera-source", label: "Input", config: { video: true, phoneMic: true, glassesMic: false, gestures: true, visionFps: 1 }, positionX: 100, positionY: 150 },
        { id: `n_ai_${now}`, type: "s2s-live", label: "AI Assistant", config: { model: "gemini-2.5-flash-native-audio-latest" }, positionX: 400, positionY: 150 },
        { id: `n_out_${now}`, type: "output", label: "Output", config: { viewers: true, overlays: true, speaker: true, recording: true }, positionX: 700, positionY: 150 },
      ],
      edges: [
        { id: `e_1_${now}`, sourceNodeId: `n_src_${now}`, targetNodeId: `n_ai_${now}` },
        { id: `e_2_${now}`, sourceNodeId: `n_ai_${now}`, targetNodeId: `n_out_${now}` },
      ],
      canvasViewport: { x: 0, y: 0, zoom: 1 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  } else {
    const id = getWorkflowId();
    if (!id) { location.hash = "/workflows"; return; }
    const wf = await fetchWorkflow(id);
    if (!wf) { location.hash = "/workflows"; return; }
    _workflow = wf;
  }

  _container.innerHTML = `
    <div class="page workflow-editor-page">
      <div class="wf-editor-layout">
        <div class="wf-palette">
          <h3 class="wf-palette-title">Nodes</h3>
          ${Object.entries(NODE_COLORS).map(([type, c]) => `
            <button class="wf-palette-item" data-type="${type}">
              <span class="wf-palette-dot" style="background:${c.header}"></span>
              <span class="wf-palette-label">${type.replace("-", " ")}</span>
            </button>
          `).join("")}
        </div>
        <div class="wf-canvas-wrap" id="wf-canvas-wrap">
          ${buildSVG()}
        </div>
        <div class="wf-config-panel" id="wf-config-panel">
          <p class="empty-state">Select a node</p>
        </div>
      </div>
      <div class="wf-toolbar">
        <input type="text" class="wf-toolbar-input" id="wf-name" value="${esc(_workflow.name)}" placeholder="Workflow name" />
        <input type="text" class="wf-toolbar-input wf-toolbar-desc" id="wf-desc" value="${esc(_workflow.description)}" placeholder="Description" />
        <button class="btn btn-primary" id="wf-save-btn">Save</button>
        <button class="btn" id="wf-publish-btn">${_workflow.status === "published" ? "Unpublish" : "Publish"}</button>
        <button class="btn btn-danger" id="wf-del-btn">Delete</button>
        <button class="btn" id="wf-activate-btn">Activate</button>
      </div>
    </div>
  `;

  wireEditorEvents();
}

function buildSVG(): string {
  if (!_workflow) return "";
  const nodes = _workflow.nodes;
  const edges = _workflow.edges;

  const nodeSVGs = nodes.map(n => {
    const c = NODE_COLORS[n.type] ?? NODE_COLORS["output"];
    const configSummary = n.type === "s2s-live" || n.type === "s2s-rest" || n.type === "s2s-e4b"
      ? (n.config.model as string ?? "").slice(0, 20)
      : n.type === "output"
        ? Object.entries({ viewers: "view", overlays: "overlay", speaker: "speaker", recording: "rec" })
            .filter(([, k]) => n.config[k] !== false)
            .map(([l]) => l)
            .join(", ") || "all"
        : n.type === "camera-source"
          ? [n.config.video !== false ? "video" : "", n.config.phoneMic !== false ? "phone-mic" : "", n.config.glassesMic === true ? "glasses-mic" : "", n.config.gestures !== false ? "gestures" : ""].filter(Boolean).join(", ") || "none"
          : "Live feed";
    const selected = _selectedNodeId === n.id;
    return `
      <g class="wf-node" data-id="${n.id}" transform="translate(${n.positionX}, ${n.positionY})">
        <rect class="wf-node-bg" width="${NODE_W}" height="${NODE_H}" rx="${NODE_R}" fill="${c.fill}" stroke="${selected ? "#fff" : c.stroke}" stroke-width="${selected ? 2 : 1}" />
        <rect class="wf-node-header" width="${NODE_W}" height="24" rx="${NODE_R}" fill="${c.header}" />
        <rect x="0" y="${NODE_R}" width="${NODE_W}" height="${24 - NODE_R}" fill="${c.header}" />
        <text x="${NODE_W / 2}" y="16" text-anchor="middle" fill="#fff" font-size="10" font-weight="600">${esc(n.type.replace("-", " "))}</text>
        <text x="12" y="44" fill="#ccc" font-size="11">${esc(n.label || n.type)}</text>
        <text x="12" y="60" fill="#888" font-size="9">${esc(configSummary)}</text>
        <circle class="wf-port wf-port-in" cx="0" cy="${NODE_H / 2}" r="6" fill="${c.stroke}" stroke="#0a0a0a" stroke-width="2" />
        <circle class="wf-port wf-port-out" cx="${NODE_W}" cy="${NODE_H / 2}" r="6" fill="${c.stroke}" stroke="#0a0a0a" stroke-width="2" />
      </g>
    `;
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
    return `<path class="wf-edge" data-id="${e.id}" d="M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ty}, ${tx} ${ty}" fill="none" stroke="#64748b" stroke-width="2" />`;
  }).join("");

  // Grid pattern
  const grid = `
    <defs>
      <pattern id="wf-grid" width="20" height="20" patternUnits="userSpaceOnUse">
        <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(255,255,255,0.04)" stroke-width="0.5" />
      </pattern>
    </defs>
    <rect x="-5000" y="-5000" width="10000" height="10000" fill="url(#wf-grid)" />
  `;

  return `<svg class="wf-canvas-svg" id="wf-svg" viewBox="${_viewX} ${_viewY} ${900 / _zoom} ${600 / _zoom}" xmlns="http://www.w3.org/2000/svg">${grid}${edgeSVGs}${nodeSVGs}</svg>`;
}

function refreshSVG(): void {
  const wrap = _container?.querySelector("#wf-canvas-wrap");
  if (!wrap) return;
  wrap.innerHTML = buildSVG();
  wireSVGEvents();
}

function wireEditorEvents(): void {
  wireSVGEvents();

  // Palette: add node
  _container?.querySelectorAll(".wf-palette-item").forEach(btn => {
    btn.addEventListener("click", () => {
      if (!_workflow) return;
      const type = (btn as HTMLElement).dataset.type as WorkflowNodeDef["type"];
      // Only allow 1 source, 1 output, 1 AI node total
      if (type === "camera-source" && _workflow.nodes.some(n => n.type === "camera-source")) return;
      if (type === "output" && _workflow.nodes.some(n => n.type === "output")) return;
      const isAI = (t: string) => t === "s2s-live" || t === "s2s-rest" || t === "s2s-e4b";
      if (isAI(type) && _workflow.nodes.some(n => isAI(n.type))) return;
      const id = nanoid();
      const offset = _workflow.nodes.length * 30;
      const config = type === "s2s-live" ? { model: "gemini-2.5-flash-native-audio-latest" }
        : type === "s2s-rest" ? { model: "gemma-4-27b" }
        : type === "s2s-e4b" ? { model: "gemma-4-e4b-it" }
        : type === "output" ? { viewers: true, overlays: true, speaker: true, recording: true }
        : {};
      _workflow.nodes.push({
        id,
        type,
        label: type.replace(/-/g, " "),
        config,
        positionX: 200 + offset,
        positionY: 150 + offset,
      });
      _dirty = true;
      refreshSVG();
    });
  });

  // Toolbar: save (auto-publishes draft workflows)
  _container?.querySelector("#wf-save-btn")?.addEventListener("click", async () => {
    if (!_workflow) return;
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
        status: "published",
      });
      if (result) _workflow = result;
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
        history.replaceState(null, "", `#/workflows/${_workflow.id}`);
      }
    }
    _dirty = false;
    renderEditor(false);
  });

  // Toolbar: publish
  _container?.querySelector("#wf-publish-btn")?.addEventListener("click", async () => {
    if (!_workflow?.id) return;
    if (_dirty && !confirm("You have unsaved changes. Save before publishing?")) return;
    const newStatus = _workflow.status === "published" ? "draft" : "published";
    // Include current state if dirty so changes aren't lost
    const payload: Record<string, unknown> = { status: newStatus };
    if (_dirty) {
      _workflow.name = (_container?.querySelector("#wf-name") as HTMLInputElement)?.value ?? _workflow.name;
      _workflow.description = (_container?.querySelector("#wf-desc") as HTMLInputElement)?.value ?? _workflow.description;
      payload.name = _workflow.name;
      payload.description = _workflow.description;
      payload.nodes = _workflow.nodes.map(n => ({ ...n, config: JSON.stringify(n.config) }));
      payload.edges = _workflow.edges;
    }
    const result = await updateWorkflow(_workflow.id, payload);
    if (result) { _workflow = result; _dirty = false; }
    renderEditor(false);
  });

  // Toolbar: delete
  _container?.querySelector("#wf-del-btn")?.addEventListener("click", async () => {
    if (!_workflow?.id) return;
    if (!confirm("Delete this workflow?")) return;
    await deleteWorkflow(_workflow.id);
    location.hash = "/workflows";
  });

  // Toolbar: activate
  _container?.querySelector("#wf-activate-btn")?.addEventListener("click", async () => {
    if (!_workflow?.id) return;
    const sessions = await fetchSessions();
    const liveSessions = sessions.filter(s => s.live);
    if (liveSessions.length === 0) { alert("No live sessions available"); return; }

    const sessionList = liveSessions.map(s => `${s.sessionId.slice(0, 8)} (${s.device?.deviceName ?? "unknown"})`).join("\n");
    const choice = prompt(`Activate against which session?\n${sessionList}`);
    if (!choice) return;
    const match = liveSessions.find(s => s.sessionId.startsWith(choice) || s.sessionId === choice);
    if (!match) { alert("Session not found"); return; }

    const result = await activateWorkflow(_workflow.id, match.sessionId);
    if (result) alert(`Activated! App: ${result.appId}, Status: ${result.status}`);
    else alert("Activation failed");
  });

  // Keyboard: delete selected node
  document.addEventListener("keydown", onKeyDown);
}

function onKeyDown(e: KeyboardEvent): void {
  if ((e.key === "Delete" || e.key === "Backspace") && _selectedNodeId && _workflow) {
    // Don't delete if focus is on an input
    if ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "TEXTAREA") return;
    e.preventDefault();
    const id = _selectedNodeId;
    _workflow.nodes = _workflow.nodes.filter(n => n.id !== id);
    _workflow.edges = _workflow.edges.filter(e => e.sourceNodeId !== id && e.targetNodeId !== id);
    _selectedNodeId = null;
    _dirty = true;
    refreshSVG();
    renderConfigPanel();
  }
}

function wireSVGEvents(): void {
  const svg = _container?.querySelector("#wf-svg") as SVGElement | null;
  if (!svg) return;

  // Node click -> select
  svg.querySelectorAll(".wf-node").forEach(g => {
    g.addEventListener("mousedown", (e: Event) => {
      const me = e as MouseEvent;
      const nodeId = (g as Element).getAttribute("data-id")!;
      const target = me.target as Element;

      // Port drag (edge creation)
      if (target.classList.contains("wf-port-out")) {
        startEdgeDrag(me, nodeId, svg);
        return;
      }

      _selectedNodeId = nodeId;
      renderConfigPanel();
      refreshSVG();

      // Node drag (unless clicking port)
      if (!target.classList.contains("wf-port-in")) {
        startNodeDrag(me, nodeId);
      }
    });
  });

  // Edge click -> delete
  svg.querySelectorAll(".wf-edge").forEach(path => {
    path.addEventListener("click", () => {
      if (!_workflow) return;
      const id = (path as Element).getAttribute("data-id")!;
      _workflow.edges = _workflow.edges.filter(e => e.id !== id);
      _dirty = true;
      refreshSVG();
    });
  });

  // Canvas pan (middle click or ctrl+drag on background)
  svg.addEventListener("mousedown", (e: Event) => {
    const me = e as MouseEvent;
    if (me.target === svg || (me.target as Element).tagName === "rect") {
      if (me.button === 1 || me.ctrlKey || me.metaKey) {
        e.preventDefault();
        _panState = { startX: me.clientX, startY: me.clientY, viewX: _viewX, viewY: _viewY };
      } else {
        // Click on background -> deselect
        _selectedNodeId = null;
        renderConfigPanel();
        refreshSVG();
      }
    }
  });

  // Zoom
  svg.addEventListener("wheel", (e: Event) => {
    e.preventDefault();
    const we = e as WheelEvent;
    const delta = we.deltaY > 0 ? 0.9 : 1.1;
    _zoom = Math.max(0.3, Math.min(3, _zoom * delta));
    svg.setAttribute("viewBox", `${_viewX} ${_viewY} ${900 / _zoom} ${600 / _zoom}`);
  }, { passive: false });
}

/** Update SVG edge paths connected to a moved node without full rebuild */
function updateEdgesForNode(svgEl: Element, node: WorkflowNodeDef, edges: WorkflowEdgeDef[], nodes: WorkflowNodeDef[]): void {
  for (const e of edges) {
    if (e.sourceNodeId !== node.id && e.targetNodeId !== node.id) continue;
    const pathEl = svgEl.querySelector(`[data-id="${e.id}"]`);
    if (!pathEl) continue;
    const src = nodes.find(n => n.id === e.sourceNodeId);
    const tgt = nodes.find(n => n.id === e.targetNodeId);
    if (!src || !tgt) continue;
    const sx = src.positionX + NODE_W;
    const sy = src.positionY + NODE_H / 2;
    const tx = tgt.positionX;
    const ty = tgt.positionY + NODE_H / 2;
    const mx = (sx + tx) / 2;
    pathEl.setAttribute("d", `M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ty}, ${tx} ${ty}`);
  }
}

function startNodeDrag(me: MouseEvent, nodeId: string): void {
  if (!_workflow) return;
  const node = _workflow.nodes.find(n => n.id === nodeId);
  if (!node) return;
  _dragState = {
    nodeId,
    startX: me.clientX,
    startY: me.clientY,
    nodeStartX: node.positionX,
    nodeStartY: node.positionY,
  };

  const onMove = (e: MouseEvent) => {
    if (!_dragState || !_workflow) return;
    const dx = (e.clientX - _dragState.startX) / _zoom;
    const dy = (e.clientY - _dragState.startY) / _zoom;
    const node = _workflow.nodes.find(n => n.id === _dragState!.nodeId);
    if (node) {
      node.positionX = Math.round(_dragState.nodeStartX + dx);
      node.positionY = Math.round(_dragState.nodeStartY + dy);
      _dirty = true;
      // Update node position directly in DOM instead of full rebuild
      const svgEl = _container?.querySelector("#wf-svg");
      const g = svgEl?.querySelector(`[data-id="${_dragState.nodeId}"]`);
      if (g) {
        g.setAttribute("transform", `translate(${node.positionX}, ${node.positionY})`);
        // Update edges connected to this node
        updateEdgesForNode(svgEl!, node, _workflow.edges, _workflow.nodes);
      }
    }
  };

  const onUp = () => {
    _dragState = null;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    refreshSVG();
  };

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function startEdgeDrag(me: MouseEvent, sourceNodeId: string, svg: SVGElement): void {
  const source = _workflow?.nodes.find(n => n.id === sourceNodeId);
  if (!source) return;

  const svgRect = svg.getBoundingClientRect();
  const sx = source.positionX + NODE_W;
  const sy = source.positionY + NODE_H / 2;

  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", String(sx));
  line.setAttribute("y1", String(sy));
  line.setAttribute("x2", String(sx));
  line.setAttribute("y2", String(sy));
  line.setAttribute("stroke", "#94a3b3");
  line.setAttribute("stroke-width", "2");
  line.setAttribute("stroke-dasharray", "4");
  svg.appendChild(line);

  _edgeState = { sourceNodeId, tempLine: line };

  const onMove = (e: MouseEvent) => {
    if (!_edgeState) return;
    const rect = svg.getBoundingClientRect();
    const mx = _viewX + (e.clientX - rect.left) / rect.width * (900 / _zoom);
    const my = _viewY + (e.clientY - rect.top) / rect.height * (600 / _zoom);
    _edgeState.tempLine.setAttribute("x2", String(mx));
    _edgeState.tempLine.setAttribute("y2", String(my));
  };

  const onUp = (e: MouseEvent) => {
    if (_edgeState?.tempLine.parentNode) {
      _edgeState.tempLine.parentNode.removeChild(_edgeState.tempLine);
    }

    // Find target node
    const rect = svg.getBoundingClientRect();
    const mx = _viewX + (e.clientX - rect.left) / rect.width * (900 / _zoom);
    const my = _viewY + (e.clientY - rect.top) / rect.height * (600 / _zoom);
    const target = _workflow?.nodes.find(n =>
      mx >= n.positionX && mx <= n.positionX + NODE_W &&
      my >= n.positionY && my <= n.positionY + NODE_H &&
      n.id !== _edgeState!.sourceNodeId
    );

    if (target && _workflow) {
      const exists = _workflow.edges.some(e =>
        e.sourceNodeId === _edgeState!.sourceNodeId && e.targetNodeId === target.id
      );
      if (!exists) {
        _workflow.edges.push({
          id: nanoid(),
          sourceNodeId: _edgeState!.sourceNodeId,
          targetNodeId: target.id,
        });
        _dirty = true;
        refreshSVG();
      }
    }

    _edgeState = null;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function renderConfigPanel(): void {
  const panel = _container?.querySelector("#wf-config-panel");
  if (!panel || !_workflow) return;

  if (!_selectedNodeId) {
    panel.innerHTML = '<p class="empty-state">Select a node</p>';
    return;
  }

  const node = _workflow.nodes.find(n => n.id === _selectedNodeId);
  if (!node) { panel.innerHTML = '<p class="empty-state">Select a node</p>'; return; }

  const c = NODE_COLORS[node.type] ?? NODE_COLORS["output"];

  if (node.type === "camera-source") {
    const fps = (node.config.visionFps as number) ?? 1;
    const video = node.config.video !== false;
    const phoneMic = node.config.phoneMic !== false;
    const glassesMic = node.config.glassesMic === true;
    const gestures = node.config.gestures !== false;
    panel.innerHTML = `
      <div class="wf-config-header" style="border-left: 3px solid ${c.header}">
        <span class="wf-config-type">Input</span>
      </div>
      <div class="wf-config-field">
        <label>Label</label>
        <input type="text" class="wf-config-input" data-field="label" value="${esc(node.label)}" />
      </div>
      <div class="wf-config-field">
        <label>Modalities</label>
        <div class="wf-config-checks">
          <label><input type="checkbox" data-field="config.video" ${video ? "checked" : ""} /> Video (frames)</label>
          <label><input type="checkbox" data-field="config.phoneMic" ${phoneMic ? "checked" : ""} /> Phone mic (48kHz)</label>
          <label><input type="checkbox" data-field="config.glassesMic" ${glassesMic ? "checked" : ""} /> Glasses HFP mic (8kHz)</label>
          <label><input type="checkbox" data-field="config.gestures" ${gestures ? "checked" : ""} /> Gestures</label>
        </div>
      </div>
      <div class="wf-config-field">
        <label>Vision FPS: ${fps}</label>
        <input type="range" min="0.2" max="2" step="0.1" data-field="config.visionFps" value="${fps}" />
      </div>
      <button class="btn btn-danger btn-sm wf-config-delete" data-id="${node.id}">Delete Node</button>
    `;
  } else if (node.type === "s2s-live") {
    panel.innerHTML = `
      <div class="wf-config-header" style="border-left: 3px solid ${c.header}">
        <span class="wf-config-type">S2S Live (Gemini)</span>
      </div>
      <div class="wf-config-field">
        <label>Label</label>
        <input type="text" class="wf-config-input" data-field="label" value="${esc(node.label)}" />
      </div>
      <div class="wf-config-field">
        <label>Model</label>
        <select class="wf-config-input" data-field="config.model">
          <option value="gemini-2.5-flash-native-audio-latest" ${node.config.model === "gemini-2.5-flash-native-audio-latest" ? "selected" : ""}>gemini-2.5-flash-native-audio</option>
          <option value="gemini-2.0-flash" ${node.config.model === "gemini-2.0-flash" ? "selected" : ""}>gemini-2.0-flash</option>
        </select>
      </div>
      <div class="wf-config-field">
        <label>System Prompt</label>
        <textarea class="wf-config-input wf-config-textarea" data-field="config.systemPrompt" rows="6">${esc((node.config.systemPrompt as string) ?? "")}</textarea>
      </div>
      <div class="wf-config-field">
        <label>Voice</label>
        <select class="wf-config-input" data-field="config.voice">
          <option value="">Default</option>
          <option value="Aoede" ${node.config.voice === "Aoede" ? "selected" : ""}>Aoede</option>
          <option value="Puck" ${node.config.voice === "Puck" ? "selected" : ""}>Puck</option>
          <option value="Charon" ${node.config.voice === "Charon" ? "selected" : ""}>Charon</option>
          <option value="Fenchir" ${node.config.voice === "Fenchir" ? "selected" : ""}>Fenchir</option>
          <option value="Kore" ${node.config.voice === "Kore" ? "selected" : ""}>Kore</option>
          <option value="Leda" ${node.config.voice === "Leda" ? "selected" : ""}>Leda</option>
        </select>
      </div>
      <div class="wf-config-field">
        <label>Vision FPS: ${(node.config.visionFps as number) ?? 1}</label>
        <input type="range" min="0.5" max="2" step="0.5" data-field="config.visionFps" value="${(node.config.visionFps as number) ?? 1}" />
      </div>
      <button class="btn btn-danger btn-sm wf-config-delete" data-id="${node.id}">Delete Node</button>
    `;
  } else if (node.type === "s2s-rest") {
    panel.innerHTML = `
      <div class="wf-config-header" style="border-left: 3px solid ${c.header}">
        <span class="wf-config-type">S2S REST (Gemma)</span>
      </div>
      <div class="wf-config-field">
        <label>Label</label>
        <input type="text" class="wf-config-input" data-field="label" value="${esc(node.label)}" />
      </div>
      <div class="wf-config-field">
        <label>Model</label>
        <select class="wf-config-input" data-field="config.model">
          <option value="gemma-4-27b" ${node.config.model === "gemma-4-27b" ? "selected" : ""}>gemma-4-27b</option>
          <option value="gemma-4-12b" ${node.config.model === "gemma-4-12b" ? "selected" : ""}>gemma-4-12b</option>
        </select>
      </div>
      <div class="wf-config-field">
        <label>System Prompt</label>
        <textarea class="wf-config-input wf-config-textarea" data-field="config.systemPrompt" rows="6">${esc((node.config.systemPrompt as string) ?? "")}</textarea>
      </div>
      <div class="wf-config-field">
        <label>Vision FPS: ${(node.config.visionFps as number) ?? 1}</label>
        <input type="range" min="0.5" max="2" step="0.5" data-field="config.visionFps" value="${(node.config.visionFps as number) ?? 1}" />
      </div>
      <div class="wf-config-field">
        <label>Temperature: ${(node.config.temperature as number) ?? 0.7}</label>
        <input type="range" min="0" max="2" step="0.1" data-field="config.temperature" value="${(node.config.temperature as number) ?? 0.7}" />
      </div>
      <button class="btn btn-danger btn-sm wf-config-delete" data-id="${node.id}">Delete Node</button>
    `;
  } else if (node.type === "s2s-e4b") {
    panel.innerHTML = `
      <div class="wf-config-header" style="border-left: 3px solid ${c.header}">
        <span class="wf-config-type">S2S E4B (Gemma Voice)</span>
      </div>
      <div class="wf-config-field">
        <label>Label</label>
        <input type="text" class="wf-config-input" data-field="label" value="${esc(node.label)}" />
      </div>
      <div class="wf-config-field">
        <label>Model</label>
        <select class="wf-config-input" data-field="config.model">
          <option value="gemma-4-e4b-it" ${node.config.model === "gemma-4-e4b-it" ? "selected" : ""}>gemma-4-e4b-it</option>
        </select>
      </div>
      <div class="wf-config-field">
        <label>System Prompt</label>
        <textarea class="wf-config-input wf-config-textarea" data-field="config.systemPrompt" rows="6">${esc((node.config.systemPrompt as string) ?? "")}</textarea>
      </div>
      <div class="wf-config-field">
        <label>Voice</label>
        <select class="wf-config-input" data-field="config.voice">
          <option value="">Default</option>
          <option value="Aoede" ${node.config.voice === "Aoede" ? "selected" : ""}>Aoede</option>
          <option value="Puck" ${node.config.voice === "Puck" ? "selected" : ""}>Puck</option>
          <option value="Charon" ${node.config.voice === "Charon" ? "selected" : ""}>Charon</option>
          <option value="Kore" ${node.config.voice === "Kore" ? "selected" : ""}>Kore</option>
        </select>
      </div>
      <div class="wf-config-field">
        <label>Vision FPS: ${(node.config.visionFps as number) ?? 1}</label>
        <input type="range" min="0.5" max="2" step="0.5" data-field="config.visionFps" value="${(node.config.visionFps as number) ?? 1}" />
      </div>
      <button class="btn btn-danger btn-sm wf-config-delete" data-id="${node.id}">Delete Node</button>
    `;
  } else if (node.type === "output") {
    const viewers = node.config.viewers !== false;
    const overlays = node.config.overlays !== false;
    const speaker = node.config.speaker !== false;
    const recording = node.config.recording !== false;
    panel.innerHTML = `
      <div class="wf-config-header" style="border-left: 3px solid ${c.header}">
        <span class="wf-config-type">Output</span>
      </div>
      <div class="wf-config-field">
        <label>Label</label>
        <input type="text" class="wf-config-input" data-field="label" value="${esc(node.label)}" />
      </div>
      <div class="wf-config-field">
        <label>Channels</label>
        <div class="wf-config-checks">
          <label><input type="checkbox" data-field="config.viewers" ${viewers ? "checked" : ""} /> Viewers (WS fanout)</label>
          <label><input type="checkbox" data-field="config.overlays" ${overlays ? "checked" : ""} /> Overlays (bbox)</label>
          <label><input type="checkbox" data-field="config.speaker" ${speaker ? "checked" : ""} /> Speaker (HFP)</label>
          <label><input type="checkbox" data-field="config.recording" ${recording ? "checked" : ""} /> Recording (R2)</label>
        </div>
      </div>
      <button class="btn btn-danger btn-sm wf-config-delete" data-id="${node.id}">Delete Node</button>
    `;
  }

  // Wire config inputs
  panel.querySelectorAll("[data-field]").forEach(input => {
    input.addEventListener("change", () => {
      if (!_workflow || !_selectedNodeId) return;
      const node = _workflow.nodes.find(n => n.id === _selectedNodeId);
      if (!node) return;
      const field = (input as HTMLElement).dataset.field!;
      const el = input as HTMLInputElement;
      if (field.startsWith("config.")) {
        const key = field.slice(7);
        if (el.type === "range") node.config[key] = parseFloat(el.value);
        else if (el.type === "checkbox") node.config[key] = el.checked;
        else node.config[key] = el.value;
      } else {
        (node as any)[field] = el.value;
      }
      _dirty = true;
      refreshSVG();
    });
  });

  // Delete node button
  panel.querySelector(".wf-config-delete")?.addEventListener("click", () => {
    if (!_workflow) return;
    const id = (panel.querySelector(".wf-config-delete") as HTMLElement).dataset.id!;
    _workflow.nodes = _workflow.nodes.filter(n => n.id !== id);
    _workflow.edges = _workflow.edges.filter(e => e.sourceNodeId !== id && e.targetNodeId !== id);
    _selectedNodeId = null;
    _dirty = true;
    refreshSVG();
    renderConfigPanel();
  });
}

export default page;
