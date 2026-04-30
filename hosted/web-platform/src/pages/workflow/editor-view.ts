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
  setSelectedNodeId, getSelectedNodeId, autoSave, doSave, updateSaveIndicator,
  nanoid, getWorkflowId, getViewBox,
} from "./state.js";
import { getNodeDef, getNodeDefs, loadNodeDefs } from "./node-defs.js";
import { buildSVG, buildSVGFromData, refreshSVG } from "./svg-renderer.js";
import { wireSVGEvents, onKeyDown, isTouchDevice } from "./interactions.js";
import { hideNodeActionPopover } from "./node-actions.js";
import { renderConfigPanel } from "./config-panel.js";
import { isSettingsPanelActive, setSettingsPanelActive } from "./state.js";
import {
  findActiveSession, connectPreview, disconnectPreview,
  startSessionPolling, stopSessionPolling, destroyPreview,
  addPreviewListener, removePreviewListener, getNodePreviews,
  isPreviewConnected, getConnectedSessionId,
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
        <button class="btn wf-toolbar-desktop" id="wf-test-btn" title="Open fleet testing panel">Testing</button>
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
}

/** Build palette sidebar HTML from node definitions grouped by role. */
function buildPaletteHTML(): string {
  const roleOrder: Array<{ role: string; label: string }> = [
    { role: "source", label: "Source" },
    { role: "reference", label: "Reference" },
    { role: "processor", label: "Processor" },
    { role: "trigger", label: "Trigger" },
    { role: "transform", label: "Transform" },
    { role: "sink", label: "Sink" },
  ];
  return roleOrder.map(({ role, label }) => {
    const nodes = getNodeDefs().filter(d => d.role === role);
    if (nodes.length === 0) return "";
    return `
        <h3 class="wf-palette-title">${label}</h3>
        ${nodes.map(d => {
      const rtBadge = (d.runtime ?? []).map(r => r === "mobile"
        ? `<span class="wf-rt-badge" style="background:#06b6d4">MOB</span>`
        : `<span class="wf-rt-badge" style="background:#8b5cf6">SRV</span>`).join("");
      return `
                  <button class="wf-palette-item" data-type="${d.type}">
                    <span class="wf-palette-dot" style="background:${d.color.header}"></span>
                    <span class="wf-palette-label">${esc(d.label)}</span>
                    <span class="wf-palette-runtime">${rtBadge}</span>
                  </button>`;
    }).join("")}`;
  }).join("");
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

/** Wire toolbar buttons, palette clicks, and keyboard events. */
function wireEditorEvents(): void {
  wireSVGEvents();

  // Palette: add node
  getContainer()?.querySelectorAll(".wf-palette-item").forEach(btn => {
    btn.addEventListener("click", () => {
      const workflow = getWorkflow();
      if (!workflow) return;
      const type = (btn as HTMLElement).dataset.type as string;
      const def = getNodeDef(type);
      const id = nanoid();
      const offset = workflow.nodes.length * 30;
      const config = def ? { ...def.defaultConfig } : {};
      workflow.nodes.push({
        id,
        type,
        label: def?.defaultLabel ?? type.replace(/-/g, " "),
        config,
        positionX: 200 + offset,
        positionY: 150 + offset,
      });
      setDirty(true);
      autoSave();
      refreshSVG();

      // Auto-close palette drawer on mobile after adding
      closeMobileDrawers();
    });
  });

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
          <button class="btn wf-test-activate" data-session-id="${session?.sessionId ?? ""}" ${canActivate ? "" : "disabled"}>Activate</button>
          ${canStopStream
            ? `<button class="btn wf-test-stop-stream" data-session-id="${session!.sessionId}" style="border-color:rgba(248,113,113,0.4)">Stop</button>`
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
