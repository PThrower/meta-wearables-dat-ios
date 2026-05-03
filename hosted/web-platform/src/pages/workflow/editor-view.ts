/**
 * Workflow editor view — palette, canvas, config panel, toolbar layout,
 * FAB controls, testing mode, mobile drawer toggles.
 */

import {
  fetchWorkflow, updateWorkflow, deleteWorkflow,
  activateWorkflow, fetchSessions, fetchDevices, esc,
  wakeDevice, startStream, stopStream,
} from "../../core/api-client.js";
import {
  getContainer, getWorkflow, setWorkflow,
  isDirty, setDirty, setViewX, setViewY, setZoom,
  getViewX, getViewY, getZoom,
  setSelectedNodeId, getSelectedNodeId, autoSave, doSave, updateSaveIndicator,
  nanoid, getWorkflowId, getViewBox,
  loadPaletteCollapse, savePaletteCollapse, getPaletteCollapseState, setPaletteCollapseState,
} from "./state.js";
import { getNodeDef, getNodeDefs, loadNodeDefs, getSubnodes } from "./node-defs.js";
import type { NodeDefinition } from "../../core/api-client.js";
import { NODE_W, NODE_H } from "./constants.js";
import { isAvailable, getReason, renderAvailBadge, availCls, lockedAttrs } from "./node-availability.js";
import { getDescription } from "./node-descriptions.js";
import { buildSVG, buildSVGFromData, refreshSVG } from "./svg-renderer.js";
import { wireSVGEvents, onKeyDown, isTouchDevice } from "./interactions.js";
import { hideNodeActionPopover } from "./node-actions.js";
import { renderConfigPanel } from "./config-panel.js";
import { isSettingsPanelActive, setSettingsPanelActive } from "./state.js";
import {
  findActiveSession, connectPreview, disconnectPreview,
  startSessionPolling, stopSessionPolling, destroyPreview,
  addPreviewListener, removePreviewListener, getNodePreviews,
  isPreviewConnected, sendPreviewJson, getConnectedSessionId,
} from "./editor-preview.js";

/** Render the editor view — palette + canvas + config panel + toolbar. */
export async function renderEditor(isNew: boolean): Promise<void> {
  const container = getContainer();
  if (!container) return;
  setDirty(false);
  setSelectedNodeId(null);
  setViewX(0);
  setViewY(0);
  setZoom(1);
  loadPaletteCollapse();

  // Fetch node definitions from server (single source of truth)
  await loadNodeDefs();

  if (isNew) {
    const now = Date.now();
    setWorkflow({
      id: "",
      name: "Untitled Workflow",
      description: "",
      status: "draft",
      ownerId: null,
      nodes: [
        { id: `n_cam_${now}`, type: "camera-source", label: "Camera", config: { visionFps: 1, codec: "jpeg" }, positionX: 50, positionY: 160 },
        { id: `n_mic_${now}`, type: "phone-mic-source", label: "Phone Mic", config: {}, positionX: 50, positionY: 280 },
        { id: `n_txt_${now}`, type: "text", label: "Text Content", config: { text: "You are a helpful assistant." }, positionX: 320, positionY: 100 },
        { id: `n_ai_${now}`, type: "s2s-live", label: "AI Assistant", config: { model: "gemini-2.5-flash-native-audio-latest" }, positionX: 320, positionY: 260 },
        { id: `n_ovl_${now}`, type: "overlays", label: "Overlays", config: {}, positionX: 600, positionY: 260 },
      ],
      edges: [
        { id: `e_cam_ai_${now}`, sourceNodeId: `n_cam_${now}`, targetNodeId: `n_ai_${now}` },
        { id: `e_mic_ai_${now}`, sourceNodeId: `n_mic_${now}`, targetNodeId: `n_ai_${now}` },
        { id: `e_txt_ai_${now}`, sourceNodeId: `n_txt_${now}`, targetNodeId: `n_ai_${now}` },
        { id: `e_ai_ovl_${now}`, sourceNodeId: `n_ai_${now}`, targetNodeId: `n_ovl_${now}` },
      ],
      canvasViewport: { x: 0, y: 0, zoom: 1 },
      flowConfig: null,
      settings: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  } else {
    const id = getWorkflowId();
    if (!id) { location.hash = "/workflows"; return; }
    const wf = await fetchWorkflow(id);
    if (!wf) { location.hash = "/workflows"; return; }
    setWorkflow(wf);
  }

  const workflow = getWorkflow()!;

  // Check for live preview session
  const liveSessionId = workflow.id ? await findActiveSession(workflow.id) : null;

  container.innerHTML = `
    <div class="page workflow-editor-page">
      <div class="wf-editor-layout">
        <div class="wf-palette" id="wf-palette">
          ${buildPaletteHTML()}
        </div>
        <div class="wf-scrim" id="wf-scrim"></div>
        <div class="wf-canvas-wrap" id="wf-canvas-wrap">
          ${buildSVG()}
          ${buildFABHTML()}
        </div>
        <div class="wf-config-panel" id="wf-config-panel">
          <p class="empty-state">Select a node</p>
        </div>
      </div>
      <div class="wf-toolbar">
        <input type="text" class="wf-toolbar-input" id="wf-name" value="${esc(workflow.name)}" placeholder="Workflow name" />
        <input type="text" class="wf-toolbar-input wf-toolbar-desc" id="wf-desc" value="${esc(workflow.description)}" placeholder="Description" />
        <button class="btn btn-primary" id="wf-save-btn">Save</button>
        <span id="wf-save-status" style="font-size:11px;color:var(--text-tertiary);margin-left:4px;">Saved</span>
        <button class="btn" id="wf-publish-btn">${workflow.status === "published" ? "Unpublish" : "Publish"}</button>
        <button class="btn btn-danger" id="wf-del-btn">Delete</button>
        <button class="btn" id="wf-settings-btn">Settings</button>
        <span class="wf-toolbar-sep" style="width:1px;height:20px;background:var(--border);margin:0 4px;display:inline-block;vertical-align:middle"></span>
        <button class="btn" id="wf-test-btn" title="Open fleet testing panel">Testing</button>
        <span id="wf-preview-status" style="font-size:11px;margin-left:8px;${liveSessionId ? "" : "display:none"}">
          <span class="wf-live-dot" style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#4ade80;margin-right:3px;vertical-align:middle"></span>
          <span style="color:#4ade80;vertical-align:middle">LIVE</span>
        </span>
        <!-- Mobile toggles -->
        <button class="btn wf-mobile-toggle" id="wf-nodes-toggle" style="display:none">Nodes</button>
        <button class="btn wf-mobile-toggle" id="wf-config-toggle" style="display:none">Config</button>
      </div>
      <div class="wf-testing-panel" id="wf-testing-panel" style="display:none">
        <div class="wf-testing-header">
          <span style="font-weight:600;font-size:13px">Fleet Testing</span>
          <button class="btn" id="wf-testing-close" style="padding:2px 8px;font-size:11px">&times;</button>
        </div>
        <div class="wf-testing-body" id="wf-testing-body">
          <p class="empty-state" style="font-size:11px;color:var(--text-tertiary)">Loading devices...</p>
        </div>
      </div>
    </div>
  `;

  wireEditorEvents();
  wireMobileToggles();
  wireFABEvents();
  wirePreview(liveSessionId, workflow.id);
  detectMobile();

  // Initial config panel render (shows flow summary + "Select a node")
  renderConfigPanel();
}

/** Palette categories — grouped by capability, not DAG role. */
interface PaletteSubcategory { label: string; match: (d: NodeDefinition) => boolean; }
interface PaletteCategory {
  label: string;
  accent: string;
  match: (d: NodeDefinition) => boolean;
  subcategories?: PaletteSubcategory[];
}

const PALETTE_CATEGORIES: PaletteCategory[] = [
  { label: "Inputs",       accent: "#14b8a6", match: d => d.role === "source" && d.type !== "gesture-source" },
  { label: "AI",           accent: "#22c55e", match: d => d.activationMode === "ai" || d.activationMode === "jepa",
    subcategories: [
      { label: "Realtime",  match: d => d.type === "s2s-live" },
      { label: "Inference", match: d => d.type === "s2s-rest" || d.type === "s2s-e4b" },
      { label: "Vision",    match: d => d.type === "jepa-vision" },
      { label: "STT",       match: d => d.type === "deepgram-stt" },
    ] },
  { label: "Vision",       accent: "#8b5cf6", match: d => d.activationMode === "vision",
    subcategories: [
      { label: "Detection",   match: d => ["vision-face-detect", "vision-person-detect", "vision-body-pose"].includes(d.type) },
      { label: "Recognition", match: d => ["vision-barcode-scan", "vision-ocr", "vision-scene-classify"].includes(d.type) },
      { label: "Utility",     match: d => d.type === "vision-thumbnails" },
    ] },
  { label: "Tracking",     accent: "#10b981", match: d => d.activationMode === "tracking" || d.type === "tracking-heatmap" },
  { label: "Gating",       accent: "#06b6d4", match: d => d.role === "gating" || d.type === "cost-iou" },
  { label: "Measurement",  accent: "#a78bfa", match: d => d.activationMode === "measure" },
  { label: "Enhance",      accent: "#84cc16", match: d => d.activationMode === "enhance" },
  { label: "YOLO",         accent: "#65a30d", match: d => d.activationMode === "yolo",
    subcategories: [
      { label: "Detection",    match: d => d.type === "yolo-detect" },
      { label: "Segmentation", match: d => d.type === "yolo-segment" },
      { label: "Pose",         match: d => d.type === "yolo-pose" },
    ] },
  { label: "Audio",        accent: "#06b6d4", match: d => d.activationMode === "speech" || d.activationMode === "stt" },
  { label: "Sensors",      accent: "#06b6d4", match: d => d.activationMode === "sensor",
    subcategories: [
      { label: "Audio",    match: d => d.type === "sensor-sound" },
      { label: "Location", match: d => d.type.startsWith("sensor-location") },
    ] },
  { label: "Triggers",     accent: "#eab308", match: d => d.role === "trigger" || d.type === "gesture-source" },
  { label: "Palantir",     accent: "#6366f1", match: d => d.activationMode === "palantir",
    subcategories: [
      { label: "Ontology", match: d => d.type === "palantir-ontology" },
      { label: "AIP Agent", match: d => d.type === "palantir-aip" },
      { label: "Dataset", match: d => d.type === "palantir-dataset" },
      { label: "LLM Proxy", match: d => d.type === "palantir-llm" },
      { label: "Action", match: d => d.type === "palantir-action" },
    ] },
  { label: "Outputs",      accent: "#f97316", match: d => d.role === "sink" || d.role === "transform",
    subcategories: [
      { label: "Visual", match: d => d.type === "overlays" },
      { label: "Audio",  match: d => ["tones", "phone-speaker", "glasses-speaker"].includes(d.type) },
      { label: "Speech", match: d => d.type === "local-tts" },
      { label: "Debug",  match: d => d.type === "debug-sink" },
    ] },
  { label: "Reference",    accent: "#94a3b8", match: d => d.role === "reference" },
];

/** Build a single palette item button HTML. */
function buildPaletteItem(d: NodeDefinition, cat: PaletteCategory): string {
  const rtBadge = (d.runtime ?? []).map(r => r === "mobile"
    ? `<span class="wf-rt-badge" style="background:#06b6d4">MOB</span>`
    : `<span class="wf-rt-badge" style="background:#8b5cf6">SRV</span>`).join("");
  const lockBadge = renderAvailBadge(d.type);
  const cls = availCls(d.type, "wf-palette-item");
  const tip = esc(getDescription(d.type));
  return `<button class="${cls}" data-type="${d.type}" ${lockedAttrs(d.type)} title="${tip}">
    <span class="wf-palette-dot" style="background:${cat.accent}"></span>
    <span class="wf-palette-label">${esc(d.label)}</span>
    <span class="wf-palette-runtime">${rtBadge}${lockBadge}</span>
  </button>`;
}

/** Build palette sidebar HTML grouped by capability with accordion + search. */
function buildPaletteHTML(): string {
  const all = getNodeDefs();
  const workflow = getWorkflow();
  const workflowTypes = new Set(workflow?.nodes.map(n => n.type) ?? []);

  // Filter out subnodes whose parent is NOT in the workflow
  const filtered = all.filter(d => {
    if (!d.parentType) return true;
    return workflowTypes.has(d.parentType);
  });

  const assigned = new Set<string>();
  const collapseState = getPaletteCollapseState();

  const categoriesHTML = PALETTE_CATEGORIES.map(cat => {
    const nodes = filtered.filter(d => !assigned.has(d.type) && cat.match(d));
    nodes.forEach(d => assigned.add(d.type));
    if (nodes.length === 0) return "";

    const collapsed = collapseState[cat.label] === true;
    const openAttr = collapsed ? "" : " open";

    // Build items with optional subcategory labels
    let itemsHTML: string;
    if (cat.subcategories && cat.subcategories.length > 0) {
      const subAssigned = new Set<string>();
      itemsHTML = cat.subcategories.map(sub => {
        const subNodes = nodes.filter(d => !subAssigned.has(d.type) && sub.match(d));
        subNodes.forEach(d => subAssigned.add(d.type));
        if (subNodes.length === 0) return "";
        return `<div class="wf-palette-sublabel">${sub.label}</div>` +
          subNodes.map(d => buildPaletteItem(d, cat)).join("");
      }).join("");
      // Remaining nodes without a subcategory
      const remaining = nodes.filter(d => !subAssigned.has(d.type));
      if (remaining.length > 0) {
        itemsHTML += remaining.map(d => buildPaletteItem(d, cat)).join("");
      }
    } else {
      itemsHTML = nodes.map(d => buildPaletteItem(d, cat)).join("");
    }

    return `<div class="wf-palette-cat" data-cat="${cat.label}"${openAttr}>
      <button class="wf-palette-cat-header">
        <span class="wf-palette-cat-title" style="border-left:3px solid ${cat.accent};padding-left:6px">${cat.label}</span>
        <span class="wf-palette-cat-count">${nodes.length}</span>
        <span class="info-chevron"></span>
      </button>
      <div class="wf-palette-cat-body">${itemsHTML}</div>
    </div>`;
  }).join("");

  return `<div class="wf-palette-search">
      <input type="text" id="wf-palette-search" placeholder="Search nodes..." autocomplete="off" />
    </div>
    <div class="wf-palette-categories">${categoriesHTML}</div>
    <div class="wf-palette-controls">
      <button class="wf-palette-control-btn" id="wf-collapse-all">Collapse All</button>
      <button class="wf-palette-control-btn" id="wf-expand-all">Expand All</button>
    </div>`;
}

/** Build FAB HTML overlay for canvas. */
function buildFABHTML(): string {
  return `
    <div class="wf-fab-group" id="wf-fab-group">
      <button class="wf-fab wf-fab-primary" id="wf-fab-toggle">&#8230;</button>
    </div>`;
}

/** Wire FAB button events. */
function wireFABEvents(): void {
  const container = getContainer();
  const fabGroup = container?.querySelector("#wf-fab-group");
  if (!fabGroup) return;

  // Toggle FAB (opens testing panel on mobile)
  fabGroup.querySelector("#wf-fab-toggle")?.addEventListener("click", () => {
    const panel = getContainer()?.querySelector("#wf-testing-panel") as HTMLElement;
    if (!panel) return;
    const isOpen = panel.style.display !== "none";
    panel.style.display = isOpen ? "none" : "flex";
    if (!isOpen) refreshTestingPanel();
  });
}

/** Add a node to the workflow from palette (shared by click + drag + search). */
function addNodeFromPalette(type: string, positionX?: number, positionY?: number): void {
  const workflow = getWorkflow();
  if (!workflow) return;
  const def = getNodeDef(type);
  const id = nanoid();
  const config = def ? { ...def.defaultConfig } : {};
  const px = positionX ?? (200 + workflow.nodes.length * 30);
  const py = positionY ?? (150 + workflow.nodes.length * 30);
  workflow.nodes.push({
    id,
    type,
    label: def?.defaultLabel ?? type.replace(/-/g, " "),
    config,
    positionX: px,
    positionY: py,
  });
  setDirty(true);
  autoSave();
  refreshSVG();
  closeMobileDrawers();
}

/** Debounce timer for palette search. */
let _searchDebounce: ReturnType<typeof setTimeout> | null = null;

/** Filter palette items by search query. */
function filterPalette(query: string): void {
  const container = getContainer();
  if (!container) return;
  const categoriesDiv = container.querySelector(".wf-palette-categories");
  const controlsDiv = container.querySelector(".wf-palette-controls");
  const palette = container.querySelector("#wf-palette");
  if (!categoriesDiv || !controlsDiv || !palette) return;

  // Remove previous results
  palette.querySelector(".wf-palette-results")?.remove();

  if (!query) {
    categoriesDiv.removeAttribute("hidden");
    controlsDiv.removeAttribute("hidden");
    // Restore collapse state
    categoriesDiv.querySelectorAll(".wf-palette-cat").forEach(el => {
      const cat = (el as HTMLElement).dataset.cat!;
      const collapsed = getPaletteCollapseState()[cat] === true;
      el.classList.toggle("open", !collapsed);
      if (!collapsed) el.setAttribute("open", "");
      else el.removeAttribute("open");
    });
    return;
  }

  categoriesDiv.setAttribute("hidden", "");
  controlsDiv.setAttribute("hidden", "");

  const q = query.toLowerCase();
  const all = getNodeDefs();
  const matching = all.filter(d =>
    d.label.toLowerCase().includes(q) || d.type.toLowerCase().includes(q)
  );

  if (matching.length === 0) return;

  const cat = PALETTE_CATEGORIES.find(c => c.match(matching[0])) ?? PALETTE_CATEGORIES[0];
  const resultsHTML = matching.map(d => buildPaletteItem(d, cat)).join("");
  const resultsDiv = document.createElement("div");
  resultsDiv.className = "wf-palette-results";
  resultsDiv.innerHTML = resultsHTML;
  palette.appendChild(resultsDiv);

  // Wire click handlers on search results
  resultsDiv.querySelectorAll(".wf-palette-item").forEach(btn => {
    btn.addEventListener("click", () => {
      const type = (btn as HTMLElement).dataset.type as string;
      addNodeFromPalette(type);
    });
  });
}

/** Wire toolbar buttons, palette clicks, accordion, search, drag-drop, and keyboard events. */
function wireEditorEvents(): void {
  wireSVGEvents();

  // Palette: add node on click
  getContainer()?.querySelectorAll(".wf-palette-item").forEach(btn => {
    btn.addEventListener("click", () => {
      const type = (btn as HTMLElement).dataset.type as string;
      addNodeFromPalette(type);
    });

    // Drag start
    btn.addEventListener("dragstart", (e: Event) => {
      const de = e as DragEvent;
      const type = (btn as HTMLElement).dataset.type!;
      de.dataTransfer!.setData("text/plain", type);
      de.dataTransfer!.effectAllowed = "copy";
    });
  });

  // Palette: accordion header clicks
  getContainer()?.querySelectorAll(".wf-palette-cat-header").forEach(header => {
    header.addEventListener("click", () => {
      const catEl = (header as HTMLElement).closest(".wf-palette-cat") as HTMLElement;
      if (!catEl) return;
      const isOpen = catEl.hasAttribute("open");
      if (isOpen) {
        catEl.removeAttribute("open");
      } else {
        catEl.setAttribute("open", "");
      }
      // Persist
      const catLabel = catEl.dataset.cat!;
      const state = { ...getPaletteCollapseState() };
      state[catLabel] = !isOpen;
      setPaletteCollapseState(state);
      savePaletteCollapse();
    });
  });

  // Palette: collapse/expand all
  getContainer()?.querySelector("#wf-collapse-all")?.addEventListener("click", () => {
    const state: Record<string, boolean> = {};
    getContainer()?.querySelectorAll(".wf-palette-cat").forEach(el => {
      (el as HTMLElement).removeAttribute("open");
      state[(el as HTMLElement).dataset.cat!] = true;
    });
    setPaletteCollapseState(state);
    savePaletteCollapse();
  });
  getContainer()?.querySelector("#wf-expand-all")?.addEventListener("click", () => {
    const state: Record<string, boolean> = {};
    getContainer()?.querySelectorAll(".wf-palette-cat").forEach(el => {
      (el as HTMLElement).setAttribute("open", "");
      state[(el as HTMLElement).dataset.cat!] = false;
    });
    setPaletteCollapseState(state);
    savePaletteCollapse();
  });

  // Palette: search
  getContainer()?.querySelector("#wf-palette-search")?.addEventListener("input", (e: Event) => {
    if (_searchDebounce) clearTimeout(_searchDebounce);
    const q = (e.target as HTMLInputElement).value.trim();
    _searchDebounce = setTimeout(() => filterPalette(q), 150);
  });
  getContainer()?.querySelector("#wf-palette-search")?.addEventListener("keydown", ((e: KeyboardEvent) => {
    if (e.key === "Escape") {
      const input = e.target as HTMLInputElement;
      input.value = "";
      filterPalette("");
      input.blur();
    }
  }) as EventListener);

  // Canvas: drop target for drag-from-palette
  const canvasWrap = getContainer()?.querySelector("#wf-canvas-wrap");
  if (canvasWrap) {
    canvasWrap.addEventListener("dragover", (e: Event) => {
      (e as DragEvent).preventDefault();
      (e as DragEvent).dataTransfer!.dropEffect = "copy";
      canvasWrap.classList.add("wf-drop-active");
    });
    canvasWrap.addEventListener("dragleave", () => {
      canvasWrap.classList.remove("wf-drop-active");
    });
    canvasWrap.addEventListener("drop", (e: Event) => {
      (e as DragEvent).preventDefault();
      canvasWrap.classList.remove("wf-drop-active");
      const type = (e as DragEvent).dataTransfer!.getData("text/plain");
      if (!type) return;
      const svg = canvasWrap.querySelector("#wf-svg") as SVGSVGElement | null;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const zoom = getZoom();
      const cx = getViewX() + ((e as DragEvent).clientX - rect.left) / rect.width * (1100 / zoom);
      const cy = getViewY() + ((e as DragEvent).clientY - rect.top) / rect.height * (600 / zoom);
      addNodeFromPalette(type, Math.round(cx - NODE_W / 2), Math.round(cy - NODE_H / 2));
    });
  }

  // Smart connect: listen for edge drag events from interactions.ts
  const palette = getContainer()?.querySelector("#wf-palette");
  if (palette) {
    palette.addEventListener("wf-edge-drag-start", ((e: CustomEvent) => {
      const allowedTargets = e.detail.allowedTargets as string[];
      palette.querySelectorAll(".wf-palette-item").forEach(btn => {
        const nodeType = (btn as HTMLElement).dataset.type!;
        const def = getNodeDef(nodeType);
        if (!def) return;
        const direct = allowedTargets.includes(nodeType);
        const bySink = def.role === "sink" && allowedTargets.includes("<sink>");
        const byTrigger = def.role === "trigger" && allowedTargets.includes("<trigger>");
        const bySource = def.role === "source" && allowedTargets.includes("<source>");
        if (direct || bySink || byTrigger || bySource) {
          btn.classList.add("wf-palette-compatible");
          btn.classList.remove("wf-palette-incompatible");
        } else {
          btn.classList.add("wf-palette-incompatible");
          btn.classList.remove("wf-palette-compatible");
        }
      });
    }) as EventListener);
    palette.addEventListener("wf-edge-drag-end", () => {
      palette.querySelectorAll(".wf-palette-compatible, .wf-palette-incompatible").forEach(btn => {
        btn.classList.remove("wf-palette-compatible", "wf-palette-incompatible");
      });
    });
  }

  // Toolbar: save (manual trigger, also publishes)
  getContainer()?.querySelector("#wf-save-btn")?.addEventListener("click", async () => {
    await doSave();
    // Also publish if draft
    const workflow = getWorkflow();
    if (workflow?.id && workflow.status !== "published") {
      const result = await updateWorkflow(workflow.id, { status: "published" });
      if (result) setWorkflow(result);
    }
    updateSaveIndicator();
  });

  // Toolbar: publish
  getContainer()?.querySelector("#wf-publish-btn")?.addEventListener("click", async () => {
    const workflow = getWorkflow();
    if (!workflow?.id) return;
    if (isDirty() && !confirm("You have unsaved changes. Save before publishing?")) return;
    const newStatus = workflow.status === "published" ? "draft" : "published";
    const payload: Record<string, unknown> = { status: newStatus };
    if (isDirty()) {
      workflow.name = (getContainer()?.querySelector("#wf-name") as HTMLInputElement)?.value ?? workflow.name;
      workflow.description = (getContainer()?.querySelector("#wf-desc") as HTMLInputElement)?.value ?? workflow.description;
      payload.name = workflow.name;
      payload.description = workflow.description;
      payload.nodes = workflow.nodes.map(n => ({ ...n, config: JSON.stringify(n.config) }));
      payload.edges = workflow.edges;
    }
    const result = await updateWorkflow(workflow.id, payload);
    if (result) { setWorkflow(result); setDirty(false); }
    renderEditor(false);
  });

  // Toolbar: delete
  getContainer()?.querySelector("#wf-del-btn")?.addEventListener("click", async () => {
    const workflow = getWorkflow();
    if (!workflow?.id) return;
    if (!confirm("Delete this workflow?")) return;
    await deleteWorkflow(workflow.id);
    location.hash = "/workflows";
  });

  // Toolbar: settings — toggle workflow settings panel
  getContainer()?.querySelector("#wf-settings-btn")?.addEventListener("click", () => {
    const active = isSettingsPanelActive();
    setSettingsPanelActive(!active);
    renderConfigPanel();
  });

  // Toolbar: testing panel toggle
  getContainer()?.querySelector("#wf-test-btn")?.addEventListener("click", () => {
    const panel = getContainer()?.querySelector("#wf-testing-panel") as HTMLElement;
    if (!panel) return;
    const isOpen = panel.style.display !== "none";
    panel.style.display = isOpen ? "none" : "flex";
    if (!isOpen) refreshTestingPanel();
  });

  // Testing panel close button
  getContainer()?.querySelector("#wf-testing-close")?.addEventListener("click", () => {
    const panel = getContainer()?.querySelector("#wf-testing-panel") as HTMLElement;
    if (panel) panel.style.display = "none";
  });

  // Keyboard: delete selected node
  document.addEventListener("keydown", onKeyDown);

  // Flow dot click on SVG canvas — deselect node to show flow controls in side panel
  getContainer()?.addEventListener("click", (e) => {
    const dot = (e.target as HTMLElement).closest(".wf-flow-dot");
    if (dot) {
      e.stopPropagation();
      setSelectedNodeId(null);
      renderConfigPanel();
    }
  });
}

// --- Mobile Drawer Toggles ---

/** Detect mobile viewport and show/hide mobile UI elements. */
function detectMobile(): void {
  const container = getContainer();
  if (!container) return;
  const isMobile = window.innerWidth <= 768;

  // Show/hide mobile toggles
  container.querySelectorAll(".wf-mobile-toggle").forEach(btn => {
    (btn as HTMLElement).style.display = isMobile ? "inline-flex" : "none";
  });

  // Show/hide desktop-only toolbar buttons
  container.querySelectorAll(".wf-toolbar-desktop").forEach(btn => {
    (btn as HTMLElement).style.display = isMobile ? "none" : "inline-flex";
  });

  // Show FAB on mobile
  const fabGroup = container.querySelector("#wf-fab-group");
  if (fabGroup) {
    (fabGroup as HTMLElement).style.display = isMobile ? "flex" : "none";
  }
}

/** Wire mobile drawer toggle buttons. */
function wireMobileToggles(): void {
  const container = getContainer();
  if (!container) return;

  // Nodes toggle
  container.querySelector("#wf-nodes-toggle")?.addEventListener("click", () => {
    const palette = container.querySelector("#wf-palette");
    const scrim = container.querySelector("#wf-scrim");
    if (!palette) return;
    const isOpen = palette.classList.contains("mobile-open");
    closeMobileDrawers();
    if (!isOpen) {
      palette.classList.add("mobile-open");
      scrim?.classList.add("active");
    }
  });

  // Config toggle
  container.querySelector("#wf-config-toggle")?.addEventListener("click", () => {
    const config = container.querySelector("#wf-config-panel");
    const scrim = container.querySelector("#wf-scrim");
    if (!config) return;
    const isOpen = config.classList.contains("mobile-open");
    closeMobileDrawers();
    if (!isOpen) {
      config.classList.add("mobile-open");
      scrim?.classList.add("active");
    }
  });

  // Scrim click closes drawers
  container.querySelector("#wf-scrim")?.addEventListener("click", () => {
    closeMobileDrawers();
  });

  // Auto-open config when node selected on mobile
  const origSetSelected = setSelectedNodeId;
  const observer = new MutationObserver(() => {
    if (window.innerWidth <= 768 && getSelectedNodeId()) {
      const config = container.querySelector("#wf-config-panel");
      if (config && !config.classList.contains("mobile-open")) {
        closeMobileDrawers();
        config.classList.add("mobile-open");
      }
    }
  });
  // Observe SVG for selection changes (refreshSVG swaps innerHTML)
  const canvasWrap = container.querySelector("#wf-canvas-wrap");
  if (canvasWrap) {
    observer.observe(canvasWrap, { childList: true, subtree: true });
  }

  // Responsive listener
  window.addEventListener("resize", () => detectMobile());
}

/** Close all mobile drawers. */
function closeMobileDrawers(): void {
  const container = getContainer();
  if (!container) return;
  container.querySelector("#wf-palette")?.classList.remove("mobile-open");
  container.querySelector("#wf-config-panel")?.classList.remove("mobile-open");
  container.querySelector("#wf-scrim")?.classList.remove("active");
}

// --- Testing Panel ---

let _testingPollTimer: ReturnType<typeof setInterval> | null = null;

/** Refresh the testing panel device list. */
async function refreshTestingPanel(): Promise<void> {
  const body = getContainer()?.querySelector("#wf-testing-body");
  if (!body) return;

  const [devices, sessions] = await Promise.all([fetchDevices(), fetchSessions()]);
  const liveSessions = sessions.filter(s => s.live);
  const workflow = getWorkflow();

  if (devices.length === 0) {
    body.innerHTML = '<p class="empty-state" style="font-size:11px;color:var(--text-tertiary)">No registered devices found. Open the app on a device to register it.</p>';
    return;
  }

  body.innerHTML = devices.map(d => {
    // Match device to live session via metadata.deviceId
    const session = liveSessions.find(s => s.device?.deviceId === d.device_id);
    const isOnline = !!session;
    const isStreaming = isOnline && session!.publisherStandby === false;
    const isStandby = isOnline && session!.publisherStandby !== false;
    const activeWf = session?.activeWorkflowId;
    const isActivated = activeWf === workflow?.id;

    const onlineBadge = isOnline
      ? (isStreaming
        ? '<span class="wf-testing-badge wf-testing-badge-streaming">Streaming</span>'
        : '<span class="wf-testing-badge wf-testing-badge-standby">Standby</span>')
      : '<span class="wf-testing-badge wf-testing-badge-offline">Offline</span>';
    const activatedBadge = isActivated
      ? '<span class="wf-testing-badge wf-testing-badge-activated">Activated</span>'
      : '';

    // Button states: Stream is independent of activation — just needs publisher connected
    const canWake = !isOnline && !!d.apnsToken;
    const canActivate = isOnline && !isActivated;
    const canStartStream = isOnline && !isStreaming;
    const canStopStream = isStreaming;

    return `
      <div class="wf-testing-device-card" data-device-id="${d.device_id}">
        <div class="wf-testing-device-header">
          <div>
            <div class="wf-testing-device-name">${esc(d.deviceName ?? d.device_id.slice(0, 12))}</div>
            <div class="wf-testing-device-model">${esc(d.deviceModel ?? "")}</div>
          </div>
        </div>
        <div class="wf-testing-device-status">
          ${onlineBadge} ${activatedBadge}
        </div>
        <div class="wf-testing-device-actions">
          <button class="btn wf-test-wake" data-device-id="${d.device_id}" ${canWake ? "" : "disabled"}>Wake</button>
          ${isActivated
            ? `<button class="btn wf-test-deactivate" data-session-id="${session!.sessionId}" style="border-color:rgba(248,113,113,0.4)">Stop</button>
               <button class="btn wf-test-rerun" data-session-id="${session!.sessionId}">Re-run</button>`
            : `<button class="btn wf-test-activate" data-session-id="${session?.sessionId ?? ""}" ${canActivate ? "" : "disabled"}>Activate</button>`
          }
          ${canStopStream
            ? `<button class="btn wf-test-stop-stream" data-session-id="${session!.sessionId}" style="border-color:rgba(248,113,113,0.4)">Stop Stream</button>`
            : `<button class="btn wf-test-start-stream" data-session-id="${session?.sessionId ?? ""}" ${canStartStream ? "" : "disabled"}>Stream</button>`
          }
        </div>
      </div>
    `;
  }).join("");

  // Wire per-device Wake buttons
  body.querySelectorAll(".wf-test-wake:not([disabled])").forEach(btn => {
    btn.addEventListener("click", async () => {
      const deviceId = (btn as HTMLElement).dataset.deviceId!;
      const result = await wakeDevice(deviceId);
      if (!result?.ok) { alert(result?.error ?? "Wake failed"); return; }
      // Wake returns { ok, status: "push_sent" | "already_connected" }
      setTimeout(refreshTestingPanel, 3000);
    });
  });

  // Wire per-device Activate buttons
  body.querySelectorAll(".wf-test-activate:not([disabled])").forEach(btn => {
    btn.addEventListener("click", async () => {
      const wf = getWorkflow();
      const sessionId = (btn as HTMLElement).dataset.sessionId!;
      if (!wf?.id || !sessionId) return;

      let result = await activateWorkflow(wf.id, sessionId);
      if (!result) { alert("Activation failed"); return; }
      if (result.status === "conflict" && result.conflict) {
        const ok = confirm("Session has active AI. Override?");
        if (!ok) return;
        result = await activateWorkflow(wf.id, sessionId, { override: true, reason: "Manual override" });
        if (!result) { alert("Override failed"); return; }
      }
      setTimeout(refreshTestingPanel, 1500);
    });
  });

  // Wire per-device Start Stream buttons
  body.querySelectorAll(".wf-test-start-stream:not([disabled])").forEach(btn => {
    btn.addEventListener("click", async () => {
      const sessionId = (btn as HTMLElement).dataset.sessionId!;
      if (!sessionId) return;
      const result = await startStream(sessionId);
      if (!result?.ok) { alert(result?.error ?? "Stream failed"); return; }
      setTimeout(refreshTestingPanel, 2000);
    });
  });

  // Wire per-device Stop Stream buttons
  body.querySelectorAll(".wf-test-stop-stream").forEach(btn => {
    btn.addEventListener("click", async () => {
      const sessionId = (btn as HTMLElement).dataset.sessionId!;
      if (!sessionId) return;
      const result = await stopStream(sessionId);
      if (!result?.ok) { alert(result?.error ?? "Stop failed"); return; }
      setTimeout(refreshTestingPanel, 1500);
    });
  });

  // Wire per-device Deactivate buttons (stop workflow)
  body.querySelectorAll(".wf-test-deactivate").forEach(btn => {
    btn.addEventListener("click", async () => {
      const sessionId = (btn as HTMLElement).dataset.sessionId!;
      if (!sessionId) return;
      // Ensure preview WS is connected to the right session
      const connected = getConnectedSessionId();
      if (connected !== sessionId) {
        connectPreview(sessionId);
        await new Promise(r => setTimeout(r, 500));
      }
      sendPreviewJson({ type: "deactivate_app" });
      setTimeout(refreshTestingPanel, 1500);
    });
  });

  // Wire per-device Re-run buttons (deactivate + reactivate)
  body.querySelectorAll(".wf-test-rerun").forEach(btn => {
    btn.addEventListener("click", async () => {
      const wf = getWorkflow();
      const sessionId = (btn as HTMLElement).dataset.sessionId!;
      if (!wf?.id || !sessionId) return;
      // Deactivate first via WS
      const connected = getConnectedSessionId();
      if (connected !== sessionId) {
        connectPreview(sessionId);
        await new Promise(r => setTimeout(r, 500));
      }
      sendPreviewJson({ type: "deactivate_app" });
      await new Promise(r => setTimeout(r, 1000));
      // Re-activate via REST API
      const result = await activateWorkflow(wf.id, sessionId, { override: true, reason: "Re-run" });
      if (!result) { alert("Re-run failed"); return; }
      setTimeout(refreshTestingPanel, 1500);
    });
  });
}

/** Start auto-refresh polling for the testing panel (every 15s). */
function startTestingPoll(): void {
  stopTestingPoll();
  _testingPollTimer = setInterval(() => {
    const panel = getContainer()?.querySelector("#wf-testing-panel") as HTMLElement;
    if (panel && panel.style.display !== "none") {
      refreshTestingPanel();
    }
  }, 15_000);
}

/** Stop testing panel auto-refresh. */
function stopTestingPoll(): void {
  if (_testingPollTimer) { clearInterval(_testingPollTimer); _testingPollTimer = null; }
}

// --- Preview wiring ---

let _previewListener: (() => void) | null = null;

/** Connect to live preview data and set up re-render listener. */
function wirePreview(liveSessionId: string | null, workflowId: string | null): void {
  // Clean up previous preview connection
  if (_previewListener) {
    removePreviewListener(_previewListener);
    _previewListener = null;
  }
  destroyPreview();

  if (!workflowId) return;

  // If we found a live session, connect immediately
  if (liveSessionId) {
    connectPreview(liveSessionId);
  }

  // Poll for active sessions in case the workflow gets activated while editing
  startSessionPolling(workflowId);

  // Start testing panel auto-refresh
  startTestingPoll();

  // Listen for preview data changes and re-render with full preview data
  _previewListener = () => {
    // Re-render SVG with node states and preview data
    const workflow = getWorkflow();
    const container = getContainer();
    if (!workflow || !container) return;

    const wrap = container.querySelector("#wf-canvas-wrap");
    if (!wrap) return;

    const previews = getNodePreviews();
    const nodeStates = new Map<string, string>();
    for (const [, p] of previews) {
      nodeStates.set(p.nodeId, p.executionState);
    }

    const testingMode = isPreviewConnected();

    // Rebuild SVG with testing mode and preview data
    const fabGroup = wrap.querySelector("#wf-fab-group");
    const fabHTML = fabGroup ? fabGroup.outerHTML : buildFABHTML();

    wrap.innerHTML = buildSVGFromData(
      workflow, getViewBox(), getSelectedNodeId(),
      nodeStates, 1, "wf-svg", undefined, testingMode, previews,
    ) + fabHTML;

    wireSVGEvents();
    wireFABEvents();

    // Update preview status indicator
    const statusEl = container.querySelector("#wf-preview-status");
    if (statusEl) {
      (statusEl as HTMLElement).style.display = isPreviewConnected() ? "" : "none";
    }

    // Re-render testing panel to update device statuses
    renderConfigPanel();
  };
  addPreviewListener(_previewListener);
}

/** Disconnect preview and clean up. Called from page.destroy. */
export function destroyEditorPreview(): void {
  if (_previewListener) {
    removePreviewListener(_previewListener);
    _previewListener = null;
  }
  destroyPreview();
  stopTestingPoll();
  hideNodeActionPopover();
}
