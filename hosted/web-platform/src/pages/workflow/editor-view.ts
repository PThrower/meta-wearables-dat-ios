/**
 * Workflow editor view — palette, canvas, config panel, toolbar layout.
 */

import {
  fetchWorkflow, updateWorkflow, deleteWorkflow,
  activateWorkflow, fetchSessions, esc,
} from "../../core/api-client.js";
import {
  getContainer, getWorkflow, setWorkflow,
  isDirty, setDirty, setViewX, setViewY, setZoom,
  setSelectedNodeId, autoSave, doSave, updateSaveIndicator,
  nanoid, getWorkflowId,
} from "./state.js";
import { getNodeDef, getNodeDefs, loadNodeDefs } from "./node-defs.js";
import { buildSVG } from "./svg-renderer.js";
import { wireSVGEvents, onKeyDown } from "./interactions.js";
import { refreshSVG } from "./svg-renderer.js";
import { renderConfigPanel, setFlowConfigActive } from "./config-panel.js";

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
        <button class="btn" id="wf-activate-btn">Activate</button>
      </div>
    </div>
  `;

  wireEditorEvents();
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

  // Toolbar: activate — inline session dropdown
  getContainer()?.querySelector("#wf-activate-btn")?.addEventListener("click", async () => {
    const workflow = getWorkflow();
    if (!workflow?.id) return;
    const existing = getContainer()?.querySelector(".wf-activate-dropdown");
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
    (getContainer()?.querySelector("#wf-activate-btn") as HTMLElement)?.after(dd);

    dd.querySelector(".wf-activate-go")?.addEventListener("click", async () => {
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

      if (result.status === "passive") alert(`Activated (passive). No AI processor — sinks/transforms configured on device.`);
      else if (result.appId) alert(`Activated! App: ${result.appId}, Status: ${result.status}`);
      else alert("Activation failed");
    });

    const dismiss = (ev: MouseEvent) => {
      if (!dd.contains(ev.target as Node)) { dd.remove(); document.removeEventListener("click", dismiss); }
    };
    setTimeout(() => document.addEventListener("click", dismiss), 0);
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
