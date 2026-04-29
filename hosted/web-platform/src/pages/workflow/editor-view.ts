/**
 * Workflow editor view — palette, canvas, config panel, toolbar layout.
 */

import {
  fetchWorkflow, updateWorkflow, deleteWorkflow,
  activateWorkflow, fetchSessions, fetchDevices, esc,
  startStream, stopStream, wakeDevice,
} from "../../core/api-client.js";
import {
  getContainer, getWorkflow, setWorkflow,
  isDirty, setDirty, setViewX, setViewY, setZoom,
  setSelectedNodeId, getSelectedNodeId, autoSave, doSave, updateSaveIndicator,
  nanoid, getWorkflowId, getViewBox,
} from "./state.js";
import { getNodeDef, getNodeDefs, loadNodeDefs } from "./node-defs.js";
import { buildSVG, buildSVGFromData, refreshSVG } from "./svg-renderer.js";
import { wireSVGEvents, onKeyDown } from "./interactions.js";
import { renderConfigPanel, setFlowConfigActive } from "./config-panel.js";
import { isSettingsPanelActive, setSettingsPanelActive } from "./state.js";
import {
  findActiveSession, connectPreview, disconnectPreview,
  startSessionPolling, stopSessionPolling, destroyPreview,
  addPreviewListener, removePreviewListener, getNodePreviews,
  isPreviewConnected,
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
        <div class="wf-palette">
          ${buildPaletteHTML()}
        </div>
        <div class="wf-canvas-wrap" id="wf-canvas-wrap">
          ${buildSVG()}
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
        <button class="btn" id="wf-wake-btn" title="Wake device via push notification">Wake</button>
        <button class="btn" id="wf-activate-btn" title="Activate workflow against a live session">Activate</button>
        <button class="btn" id="wf-stream-btn" title="Start camera stream on activated device">Stream</button>
        <button class="btn" id="wf-test-btn" title="Open fleet testing panel">Testing</button>
        <span id="wf-preview-status" style="font-size:11px;margin-left:8px;${liveSessionId ? "" : "display:none"}">
          <span class="wf-live-dot" style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#4ade80;margin-right:3px;vertical-align:middle"></span>
          <span style="color:#4ade80;vertical-align:middle">LIVE</span>
        </span>
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
  wirePreview(liveSessionId, workflow.id);
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

  // Toolbar: wake — send APNs push to wake a device
  getContainer()?.querySelector("#wf-wake-btn")?.addEventListener("click", async () => {
    const workflow = getWorkflow();
    if (!workflow?.id) return;

    const settings = workflow.settings;
    if (settings?.targetDeviceId) {
      // Wake the configured target device directly
      const result = await wakeDevice(settings.targetDeviceId);
      if (!result?.ok) { alert(result?.error ?? "Wake failed"); return; }
      alert(`Wake sent to device ${settings.targetDeviceId.slice(0, 8)}...`);
      refreshTestingPanel();
      return;
    }

    // No target configured — show device picker
    const existing = getContainer()?.querySelector(".wf-wake-dropdown");
    if (existing) { existing.remove(); return; }

    const devices = await fetchDevices();
    if (devices.length === 0) { alert("No registered devices. Open the app on a device first."); return; }

    const dd = document.createElement("div");
    dd.className = "wf-wake-dropdown";
    dd.style.cssText = "position:absolute;right:200px;bottom:60px;background:var(--bg-surface);border:1px solid var(--border);border-radius:8px;padding:8px;z-index:200;min-width:220px";
    dd.innerHTML = `
      <div style="font-size:11px;color:var(--text-secondary);margin-bottom:4px;">Select device to wake:</div>
      <select class="wf-wake-select" style="width:100%;margin-bottom:6px;padding:4px;background:var(--bg-surface-alt);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);font-size:12px">
        ${devices.map(d => `<option value="${d.device_id}">${d.deviceName ?? d.device_id.slice(0, 8)} ${d.deviceModel ?? ""}</option>`).join("")}
      </select>
      <button class="btn" style="width:100%">Wake Device</button>
    `;
    getContainer()?.querySelector(".workflow-editor-page")?.appendChild(dd);

    dd.querySelector(".btn")?.addEventListener("click", async () => {
      const deviceId = (dd.querySelector(".wf-wake-select") as HTMLSelectElement)?.value;
      if (!deviceId) return;
      dd.remove();
      const result = await wakeDevice(deviceId);
      if (!result?.ok) { alert(result?.error ?? "Wake failed"); return; }
      alert(`Wake sent to ${deviceId.slice(0, 8)}...`);
      refreshTestingPanel();
    });

    const dismiss = (ev: MouseEvent) => {
      if (!dd.contains(ev.target as Node)) { dd.remove(); document.removeEventListener("click", dismiss); }
    };
    setTimeout(() => document.addEventListener("click", dismiss), 0);
  });

  // Toolbar: activate — session-based workflow activation
  getContainer()?.querySelector("#wf-activate-btn")?.addEventListener("click", async () => {
    const workflow = getWorkflow();
    if (!workflow?.id) return;
    const existing = getContainer()?.querySelector(".wf-activate-dropdown");
    if (existing) { existing.remove(); return; }

    // Session-based: show live session picker
    const sessions = await fetchSessions();
    const liveSessions = sessions.filter(s => s.live);

    if (liveSessions.length === 0) {
      alert("No live sessions. Wake a device first, then activate.");
      return;
    }

    const dd = document.createElement("div");
    dd.className = "wf-activate-dropdown";
    dd.style.cssText = "position:absolute;right:140px;bottom:60px;background:var(--bg-surface);border:1px solid var(--border);border-radius:8px;padding:8px;z-index:200;min-width:260px";
    dd.innerHTML = `
      <div style="font-size:11px;color:var(--text-secondary);margin-bottom:4px;">Select session:</div>
      <select class="wf-activate-select" style="width:100%;margin-bottom:6px;padding:4px;background:var(--bg-surface-alt);border:1px solid var(--border);border-radius:4px;color:var(--text-primary);font-size:12px">
        ${liveSessions.map(s => `<option value="${s.sessionId}">${s.device?.deviceName ?? "unknown"} (${s.sessionId.slice(0, 8)})</option>`).join("")}
      </select>
      <button class="btn" style="width:100%">Activate</button>
    `;
    getContainer()?.querySelector(".workflow-editor-page")?.appendChild(dd);

    dd.querySelector(".btn")?.addEventListener("click", async () => {
      const sessionId = (dd.querySelector(".wf-activate-select") as HTMLSelectElement)?.value;
      if (!sessionId) return;
      dd.remove();

      let result = await activateWorkflow(workflow!.id, sessionId);
      if (!result) { alert("Activation failed"); return; }

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
        result = await activateWorkflow(workflow!.id, sessionId, { override: true, reason: "Manual override" });
        if (!result) { alert("Override failed"); return; }
      }

      if (result.status === "passive") alert("Activated (passive). Sinks/transforms configured on device.");
      else if (result.appId) alert(`Activated! App: ${result.appId}, Status: ${result.status}`);
      else alert("Activation result: " + result.status);
      refreshTestingPanel();
    });

    const dismiss = (ev: MouseEvent) => {
      if (!dd.contains(ev.target as Node)) { dd.remove(); document.removeEventListener("click", dismiss); }
    };
    setTimeout(() => document.addEventListener("click", dismiss), 0);
  });

  // Toolbar: stream toggle — start or stop camera on a live session
  getContainer()?.querySelector("#wf-stream-btn")?.addEventListener("click", async () => {
    const btn = getContainer()?.querySelector("#wf-stream-btn") as HTMLElement;
    const isStreaming = btn?.textContent?.trim() === "Stop";

    // Find a live session to target
    const sessions = await fetchSessions();
    const liveSessions = sessions.filter(s => s.live);
    if (liveSessions.length === 0) {
      alert("No live sessions. Wake a device first.");
      return;
    }

    // If only one session, use it directly; otherwise pick by workflow target or first
    const workflow = getWorkflow();
    const settings = workflow?.settings;
    let target = liveSessions.find(s => s.device?.deviceId === settings?.targetDeviceId) ?? liveSessions[0];

    if (isStreaming) {
      const result = await stopStream(target.sessionId);
      if (!result?.ok) { alert(result?.error ?? "Stop failed"); return; }
      btn.textContent = "Stream";
      refreshTestingPanel();
      return;
    }

    const result = await startStream(target.sessionId);
    if (!result?.ok) {
      const err = result?.error ?? "Unknown error";
      if (err.includes("Publisher not connected")) { alert("Publisher not connected. Wake the device first."); }
      else { alert("Stream failed: " + err); }
      return;
    }
    btn.textContent = "Stop";
    refreshTestingPanel();
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

  // Flow dot click on SVG canvas — opens flow config panel
  getContainer()?.addEventListener("click", (e) => {
    const dot = (e.target as HTMLElement).closest(".wf-flow-dot");
    if (dot) {
      e.stopPropagation();
      setFlowConfigActive(true);
    }
  });
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

  // Listen for preview data changes and re-render
  _previewListener = () => {
    // Re-render SVG with node states
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

    if (nodeStates.size > 0) {
      wrap.innerHTML = buildSVGFromData(workflow, getViewBox(), getSelectedNodeId(), nodeStates);
      wireSVGEvents();
    }

    // Update preview status indicator
    const statusEl = container.querySelector("#wf-preview-status");
    if (statusEl) {
      (statusEl as HTMLElement).style.display = isPreviewConnected() ? "" : "none";
    }

    // Re-render config panel to update preview section
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
}
