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
  activateWorkflow, fetchSessions, fetchNodeDefinitions, esc, formatDateTime,
} from "../core/api-client.js";
import type { WorkflowSummary, WorkflowDetail, WorkflowNodeDef, WorkflowEdgeDef, SessionInfo, NodeDefinition, ConfigFieldSchema } from "../core/api-client.js";

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

// Node definitions (fetched from server, single source of truth)
let _nodeDefs: NodeDefinition[] = [];
let _nodeDefMap = new Map<string, NodeDefinition>();

// SVG drag state
let _dragState: { nodeId: string; startX: number; startY: number; nodeStartX: number; nodeStartY: number } | null = null;
let _edgeState: { sourceNodeId: string; tempLine: SVGLineElement } | null = null;
let _panState: { startX: number; startY: number; viewX: number; viewY: number } | null = null;

// SVG viewBox
let _viewX = 0;
let _viewY = 0;
let _zoom = 1;

const NODE_W = 180;
const NODE_H = 80;
const NODE_R = 8;

/** Render runtime badge SVG for a node definition */
function runtimeBadgeSVG(def: NodeDefinition | undefined): string {
  const rt = def?.runtime;
  if (!rt || rt.length === 0) return "";
  const hasMobile = rt.includes("mobile");
  const hasServer = rt.includes("server");
  const mobileColor = "#06b6d4"; // cyan-500
  const serverColor = "#8b5cf6"; // violet-500
  if (hasMobile && hasServer) {
    return `
      <rect x="${NODE_W - 70}" y="${NODE_H - 15}" width="30" height="11" rx="2" fill="${mobileColor}" opacity="0.9"/>
      <text x="${NODE_W - 55}" y="${NODE_H - 7}" text-anchor="middle" fill="#fff" font-size="7" font-weight="600">MOB</text>
      <rect x="${NODE_W - 37}" y="${NODE_H - 15}" width="28" height="11" rx="2" fill="${serverColor}" opacity="0.9"/>
      <text x="${NODE_W - 23}" y="${NODE_H - 7}" text-anchor="middle" fill="#fff" font-size="7" font-weight="600">SRV</text>`;
  }
  if (hasMobile) {
    return `
      <rect x="${NODE_W - 40}" y="${NODE_H - 15}" width="30" height="11" rx="2" fill="${mobileColor}" opacity="0.9"/>
      <text x="${NODE_W - 25}" y="${NODE_H - 7}" text-anchor="middle" fill="#fff" font-size="7" font-weight="600">MOB</text>`;
  }
  return `
    <rect x="${NODE_W - 36}" y="${NODE_H - 15}" width="28" height="11" rx="2" fill="${serverColor}" opacity="0.9"/>
    <text x="${NODE_W - 22}" y="${NODE_H - 7}" text-anchor="middle" fill="#fff" font-size="7" font-weight="600">SRV</text>`;
}

/** Fallback colors for unknown node types */
const FALLBACK_COLOR = { fill: "#1a1a1a", header: "#666", stroke: "#666" };

/** Static fallback palette — used when the /api/node-definitions fetch fails */
const FALLBACK_PALETTE: NodeDefinition[] = [
  { type: "stream-input", label: "Stream Input", subtitle: "${_modalities}", color: { fill: "#0d3d38", header: "#14b8a6", stroke: "#14b8a6" }, allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "<sink>"], role: "source", activationMode: null, binding: null, defaultModel: null, configSchema: [], defaultConfig: { video: true, phoneMic: true, glassesMic: false, gestures: true, visionFps: 1 }, defaultLabel: "Stream Input", runtime: ["mobile"] },
  { type: "text", label: "Text", subtitle: "${text}", color: { fill: "#1a1a2e", header: "#e2e8f0", stroke: "#94a3b8" }, allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b"], role: "reference", activationMode: null, binding: null, defaultModel: null, configSchema: [], defaultConfig: { text: "" }, defaultLabel: "Text", runtime: ["server"] },
  { type: "s2s-live", label: "S2S Live", subtitle: "${model}", color: { fill: "#0d3320", header: "#22c55e", stroke: "#22c55e" }, allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "<sink>"], role: "processor", activationMode: "ai", binding: "s2s-gemini-live", defaultModel: "gemini-2.5-flash-native-audio-latest", configSchema: [], defaultConfig: { model: "gemini-2.5-flash-native-audio-latest" }, defaultLabel: "S2S Live", runtime: ["server"] },
  { type: "s2s-rest", label: "S2S REST", subtitle: "${model}", color: { fill: "#0d2040", header: "#3b82f6", stroke: "#3b82f6" }, allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "<sink>"], role: "processor", activationMode: "ai", binding: "s2s-gemma4-rest", defaultModel: "gemma-4-27b", configSchema: [], defaultConfig: { model: "gemma-4-27b" }, defaultLabel: "S2S REST", runtime: ["server"] },
  { type: "s2s-e4b", label: "S2S E4B", subtitle: "${model}", color: { fill: "#2d1050", header: "#a855f7", stroke: "#a855f7" }, allowedTargets: ["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "<sink>"], role: "processor", activationMode: "ai", binding: "s2s-gemma4-e4b-rest", defaultModel: "gemma-4-e4b-it", configSchema: [], defaultConfig: { model: "gemma-4-e4b-it" }, defaultLabel: "S2S E4B", runtime: ["server"] },
  { type: "jepa-vision", label: "JEPA Vision", subtitle: "${model} | ${provider}", color: { fill: "#3d1a00", header: "#ef4444", stroke: "#ef4444" }, allowedTargets: ["<sink>"], role: "processor", activationMode: "jepa", binding: "jepa-vjepa2", defaultModel: "vjepa2-vit-l", configSchema: [], defaultConfig: { provider: "modal", tier: "cloud", model: "vjepa2-vit-l", gpu: "A100-80GB", clipLength: 16, sampleFps: 2, resolution: 224, tasks: [{ type: "anomaly" }, { type: "action" }] }, defaultLabel: "JEPA Vision", runtime: ["server", "mobile"] },
  { type: "output", label: "Output", subtitle: "hub", color: { fill: "#3d2000", header: "#f97316", stroke: "#f97316" }, allowedTargets: ["local-tts", "tones", "phone-speaker", "glasses-speaker", "viewers", "overlays", "recording"], role: "sink", activationMode: null, binding: null, defaultModel: null, configSchema: [], defaultConfig: {}, defaultLabel: "Output", runtime: ["server", "mobile"] },
  { type: "local-tts", label: "Local TTS", subtitle: "on-device speech", color: { fill: "#3d2000", header: "#f97316", stroke: "#f97316" }, allowedTargets: ["phone-speaker", "glasses-speaker"], role: "transform" as const, activationMode: null, binding: null, defaultModel: null, configSchema: [], defaultConfig: {}, defaultLabel: "Local TTS", runtime: ["mobile"] },
  { type: "tones", label: "Tones", subtitle: "alert sounds", color: { fill: "#3d2000", header: "#f97316", stroke: "#f97316" }, allowedTargets: [], role: "sink" as const, activationMode: null, binding: null, defaultModel: null, configSchema: [], defaultConfig: {}, defaultLabel: "Tones", runtime: ["mobile"] },
  { type: "phone-speaker", label: "Phone Speaker", subtitle: "phone audio out", color: { fill: "#3d2000", header: "#f97316", stroke: "#f97316" }, allowedTargets: [], role: "sink" as const, activationMode: null, binding: null, defaultModel: null, configSchema: [], defaultConfig: {}, defaultLabel: "Phone Speaker", runtime: ["mobile"] },
  { type: "glasses-speaker", label: "Glasses Speaker", subtitle: "HFP/A2DP audio", color: { fill: "#3d2000", header: "#f97316", stroke: "#f97316" }, allowedTargets: [], role: "sink" as const, activationMode: null, binding: null, defaultModel: null, configSchema: [], defaultConfig: {}, defaultLabel: "Glasses Speaker", runtime: ["mobile"] },
  { type: "viewers", label: "Viewers", subtitle: "WS fanout", color: { fill: "#3d2000", header: "#f97316", stroke: "#f97316" }, allowedTargets: [], role: "sink" as const, activationMode: null, binding: null, defaultModel: null, configSchema: [], defaultConfig: {}, defaultLabel: "Viewers", runtime: ["server"] },
  { type: "overlays", label: "Overlays", subtitle: "bbox annotations", color: { fill: "#3d2000", header: "#f97316", stroke: "#f97316" }, allowedTargets: [], role: "sink" as const, activationMode: null, binding: null, defaultModel: null, configSchema: [], defaultConfig: {}, defaultLabel: "Overlays", runtime: ["mobile"] },
  { type: "recording", label: "Recording", subtitle: "R2 persist", color: { fill: "#3d2000", header: "#f97316", stroke: "#f97316" }, allowedTargets: [], role: "sink" as const, activationMode: null, binding: null, defaultModel: null, configSchema: [], defaultConfig: {}, defaultLabel: "Recording", runtime: ["server"] },
];

/** Map old node type names to their current equivalents */
const TYPE_ALIASES: Record<string, string> = {
  "camera-source": "stream-input",
  "output-full": "output",
  "output-viewers": "output",
  "output-speaker": "output",
  "output-recording": "output",
  "output-overlays": "output",
};

/** Resolve a node type, mapping old names to current definitions */
function resolveNodeType(type: string): string {
  return TYPE_ALIASES[type] ?? type;
}

/** Get node definition, resolving old type aliases */
function getNodeDef(type: string): NodeDefinition | undefined {
  return _nodeDefMap.get(resolveNodeType(type));
}

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

  // Fetch node definitions from server (single source of truth)
  if (_nodeDefs.length === 0) {
    _nodeDefs = await fetchNodeDefinitions();
    if (_nodeDefs.length === 0) _nodeDefs = FALLBACK_PALETTE;
    _nodeDefMap = new Map(_nodeDefs.map(d => [d.type, d]));
  }

  if (isNew) {
    const now = Date.now();
    _workflow = {
      id: "",
      name: "Untitled Workflow",
      description: "",
      status: "draft",
      ownerId: null,
      nodes: [
        { id: `n_src_${now}`, type: "stream-input", label: "Input", config: { video: true, phoneMic: true, glassesMic: false, gestures: true, visionFps: 1 }, positionX: 50, positionY: 220 },
        { id: `n_txt_${now}`, type: "text", label: "Prompt", config: { text: "" }, positionX: 320, positionY: 100 },
        { id: `n_ai_${now}`, type: "s2s-live", label: "AI Assistant", config: { model: "gemini-2.5-flash-native-audio-latest" }, positionX: 320, positionY: 260 },
        { id: `n_out_${now}`, type: "output", label: "Output", config: {}, positionX: 590, positionY: 260 },
        { id: `n_local-tts_${now}`, type: "local-tts", label: "Local TTS", config: {}, positionX: 830, positionY: 50 },
        { id: `n_ton_${now}`, type: "tones", label: "Tones", config: {}, positionX: 830, positionY: 120 },
        { id: `n_psp_${now}`, type: "phone-speaker", label: "Phone Speaker", config: {}, positionX: 830, positionY: 190 },
        { id: `n_gsp_${now}`, type: "glasses-speaker", label: "Glasses Speaker", config: { profile: "hfp" }, positionX: 830, positionY: 260 },
        { id: `n_viw_${now}`, type: "viewers", label: "Viewers", config: {}, positionX: 830, positionY: 330 },
        { id: `n_ovl_${now}`, type: "overlays", label: "Overlays", config: {}, positionX: 830, positionY: 400 },
        { id: `n_rec_${now}`, type: "recording", label: "Recording", config: {}, positionX: 830, positionY: 470 },
      ],
      edges: [
        { id: `e_1_${now}`, sourceNodeId: `n_src_${now}`, targetNodeId: `n_ai_${now}` },
        { id: `e_2_${now}`, sourceNodeId: `n_txt_${now}`, targetNodeId: `n_ai_${now}` },
        { id: `e_3_${now}`, sourceNodeId: `n_ai_${now}`, targetNodeId: `n_out_${now}` },
        { id: `e_4_${now}`, sourceNodeId: `n_out_${now}`, targetNodeId: `n_local-tts_${now}` },
        { id: `e_5_${now}`, sourceNodeId: `n_out_${now}`, targetNodeId: `n_ton_${now}` },
        { id: `e_6_${now}`, sourceNodeId: `n_out_${now}`, targetNodeId: `n_psp_${now}` },
        { id: `e_7_${now}`, sourceNodeId: `n_out_${now}`, targetNodeId: `n_gsp_${now}` },
        { id: `e_8_${now}`, sourceNodeId: `n_out_${now}`, targetNodeId: `n_viw_${now}` },
        { id: `e_9_${now}`, sourceNodeId: `n_out_${now}`, targetNodeId: `n_ovl_${now}` },
        { id: `e_10_${now}`, sourceNodeId: `n_out_${now}`, targetNodeId: `n_rec_${now}` },
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
          ${_nodeDefs.map(d => {
            const rtBadge = (d.runtime ?? []).map(r => r === "mobile"
              ? `<span class="wf-rt-badge" style="background:#06b6d4">MOB</span>`
              : `<span class="wf-rt-badge" style="background:#8b5cf6">SRV</span>`).join("");
            return `
            <button class="wf-palette-item" data-type="${d.type}">
              <span class="wf-palette-dot" style="background:${d.color.header}"></span>
              <span class="wf-palette-label">${esc(d.label)}</span>
              <span class="wf-palette-runtime">${rtBadge}</span>
            </button>`;
          }).join("")}
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
    const def = getNodeDef(n.type);
    const c = def?.color ?? FALLBACK_COLOR;
    const configSummary = def ? resolveSubtitle(def.subtitle, n.config) : "";
    const selected = _selectedNodeId === n.id;
    return `
      <g class="wf-node" data-id="${n.id}" transform="translate(${n.positionX}, ${n.positionY})">
        <rect class="wf-node-bg" width="${NODE_W}" height="${NODE_H}" rx="${NODE_R}" fill="${c.fill}" stroke="${selected ? "#fff" : c.stroke}" stroke-width="${selected ? 2 : 1}" />
        <rect class="wf-node-header" width="${NODE_W}" height="24" rx="${NODE_R}" fill="${c.header}" />
        <rect x="0" y="${NODE_R}" width="${NODE_W}" height="${24 - NODE_R}" fill="${c.header}" />
        <text x="${NODE_W / 2}" y="16" text-anchor="middle" fill="#fff" font-size="10" font-weight="600">${esc(n.type.replace("-", " "))}</text>
        <text x="12" y="44" fill="#ccc" font-size="11">${esc(n.label || n.type)}</text>
        <text x="12" y="60" fill="#888" font-size="9">${esc(configSummary)}</text>
        ${runtimeBadgeSVG(def)}
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

  return `<svg class="wf-canvas-svg" id="wf-svg" viewBox="${_viewX} ${_viewY} ${1100 / _zoom} ${600 / _zoom}" xmlns="http://www.w3.org/2000/svg">${grid}${edgeSVGs}${nodeSVGs}</svg>`;
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
      const type = (btn as HTMLElement).dataset.type as string;
      const def = getNodeDef(type);
      const id = nanoid();
      const offset = _workflow.nodes.length * 30;
      const config = def ? { ...def.defaultConfig } : {};
      _workflow.nodes.push({
        id,
        type,
        label: def?.defaultLabel ?? type.replace(/-/g, " "),
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

  // Toolbar: activate — inline session dropdown
  _container?.querySelector("#wf-activate-btn")?.addEventListener("click", async () => {
    if (!_workflow?.id) return;
    // Remove existing dropdown if open
    const existing = _container?.querySelector(".wf-activate-dropdown");
    if (existing) { existing.remove(); return; }

    const sessions = await fetchSessions();
    const liveSessions = sessions.filter(s => s.live);
    if (liveSessions.length === 0) { alert("No live sessions available"); return; }

    const dd = document.createElement("div");
    dd.className = "wf-activate-dropdown";
    dd.innerHTML = `
      <select class="wf-activate-select">
        ${liveSessions.map(s => `<option value="${s.sessionId}">${s.device?.deviceName ?? "unknown"} (${s.sessionId.slice(0, 8)})</option>`).join("")}
      </select>
      <button class="wf-activate-go">Go</button>
    `;
    (_container?.querySelector("#wf-activate-btn") as HTMLElement)?.after(dd);

    dd.querySelector(".wf-activate-go")?.addEventListener("click", async () => {
      const sessionId = (dd.querySelector(".wf-activate-select") as HTMLSelectElement)?.value;
      if (!sessionId) return;
      dd.remove();

      // First attempt — may return 409 conflict
      let result = await activateWorkflow(_workflow!.id, sessionId);
      if (!result) { alert("Activation failed"); return; }

      // Handle conflict: prompt user for override
      if (result.status === "conflict" && result.conflict) {
        const c = result.conflict;
        const activeApp = c.activeAppId ?? "unknown";
        const activeSince = c.activatedAt ? new Date(c.activatedAt).toLocaleTimeString() : "unknown";
        const ok = confirm(
          `Session already has active AI:\n` +
          `  App: ${activeApp}\n` +
          `  Active since: ${activeSince}\n\n` +
          `Override and activate this workflow instead?`
        );
        if (!ok) return;

        // Second attempt with override=true
        result = await activateWorkflow(_workflow!.id, sessionId, { override: true, reason: "Manual override" });
        if (!result) { alert("Override failed"); return; }
      }

      if (result.appId) alert(`Activated! App: ${result.appId}, Status: ${result.status}`);
      else alert("Activation failed");
    });

    // Dismiss on click outside
    const dismiss = (ev: MouseEvent) => {
      if (!dd.contains(ev.target as Node)) { dd.remove(); document.removeEventListener("click", dismiss); }
    };
    setTimeout(() => document.addEventListener("click", dismiss), 0);
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
      // Validate edge compatibility
      const sourceNode = _workflow.nodes.find(n => n.id === _edgeState!.sourceNodeId);
      const sourceDef = sourceNode ? getNodeDef(sourceNode.type) : null;
      const targetDef = getNodeDef(target.type);
      const allowedDirect = sourceDef ? sourceDef.allowedTargets.includes(target.type) : false;
      const allowedBySinkRole = sourceDef && targetDef && targetDef.role === "sink" && sourceDef.allowedTargets.includes("<sink>");
      if (!allowedDirect && !allowedBySinkRole) { _edgeState = null; return; }

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

// --- Subtitle resolver ---

function resolveSubtitle(template: string, config: Record<string, unknown>): string {
  if (template === "${_channels}") {
    // Count connected channel nodes for the output hub
    if (!_workflow) return "";
    const channelTypes = ["speaker", "viewers", "overlays", "recording"];
    const currentNodeId = Object.keys(config).length === 0 ? null : null; // output hub has no channel config
    // Just show "hub" for the output node — channels are visible as connected nodes
    return "hub";
  }
  if (template === "${_modalities}") {
    return [
      config.video !== false ? "video" : "",
      config.phoneMic !== false ? "phone-mic" : "",
      config.glassesMic === true ? "glasses-mic" : "",
      config.gestures !== false ? "gestures" : "",
    ].filter(Boolean).join(", ") || "none";
  }
  return template.replace(/\$\{(\w+)\}/g, (_, key) => {
    const val = config[key];
    if (val === undefined || val === "") return "";
    return String(val).slice(0, 22);
  });
}

// --- Generic config field renderer ---

function renderConfigField(field: ConfigFieldSchema, node: WorkflowNodeDef): string {
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

// --- Config panel (schema-driven) ---

function renderConfigPanel(): void {
  const panel = _container?.querySelector("#wf-config-panel");
  if (!panel || !_workflow) return;

  if (!_selectedNodeId) {
    panel.innerHTML = '<p class="empty-state">Select a node</p>';
    return;
  }

  const node = _workflow.nodes.find(n => n.id === _selectedNodeId);
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
