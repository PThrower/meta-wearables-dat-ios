/**
 * Command Center — operator dashboard for live streams.
 * Grid of stream cards (live video + per-stream telemetry) + right sidebar
 * with active workflows grouped by workflow ID.
 */

import type { PageModule } from "../router/router.js";
import { fetchSessions, fetchWorkflows, esc } from "../core/api-client.js";
import type { SessionInfo } from "../core/api-client.js";
import { RelayPlayer } from "../player/relay-player.js";
import { watchLive } from "../live/index.js";
import { getToken } from "../auth.js";

const POLL_INTERVAL_MS = 10_000;
const FPS_BUFFER_SIZE = 60;
const SPARKLINE_WIDTH = 280;
const SPARKLINE_HEIGHT = 24;
const SIDEBAR_STORAGE_KEY = "cmd-sidebar-collapsed";
const WORKFLOW_NAME_TTL_MS = 60_000;

let _container: HTMLElement | null = null;
let _pollTimer: ReturnType<typeof setInterval> | null = null;
const _cards = new Map<string, StreamCard>();
const _workflowNames = new Map<string, string>();
let _workflowsRefreshedAt = 0;
let _sidebarCollapsed = false;
let _activeWorkflowFilter: string | null = null;

export const page: PageModule = {
  init(container) {
    _container = container;
    _sidebarCollapsed = localStorage.getItem(SIDEBAR_STORAGE_KEY) === "1";
    renderShell();
    refreshWorkflowNames();
    poll();
    startPolling();
    document.addEventListener("visibilitychange", onVisibilityChange);
  },

  destroy() {
    stopPolling();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    for (const card of _cards.values()) card.destroy();
    _cards.clear();
    _activeWorkflowFilter = null;
    _container = null;
  },
};

export default page;

// ── Shell ──────────────────────────────────────────────────────────────────

function renderShell(): void {
  if (!_container) return;
  _container.innerHTML = `
    <div class="page cmd-page">
      <div class="page-header">
        <div class="cmd-page-header-row">
          <div>
            <h1 class="page-title">Command Center</h1>
            <span class="page-subtitle">Live operator view</span>
          </div>
          <div class="cmd-pills">
            <div class="cmd-pill"><span class="label">Live</span><span class="val" id="cmd-live-count">0</span></div>
            <div class="cmd-pill"><span class="label">Devices</span><span class="val" id="cmd-device-count">0</span></div>
          </div>
        </div>
      </div>
      <div class="cmd-body">
        <div id="cmd-grid" class="cmd-stream-grid"></div>
        <aside id="cmd-sidebar" class="cmd-sidebar"${_sidebarCollapsed ? " data-collapsed" : ""}>
          <div class="cmd-sidebar-header">
            <span class="cmd-sidebar-title section-title">Active Workflows</span>
            <button class="cmd-sidebar-chevron" type="button" aria-label="Toggle sidebar">▸</button>
          </div>
          <div class="cmd-sidebar-body">
            <div id="cmd-workflows" class="cmd-workflow-list"></div>
          </div>
        </aside>
      </div>
    </div>
  `;

  _container.querySelector(".cmd-sidebar-chevron")?.addEventListener("click", (e) => {
    e.stopPropagation();
    _sidebarCollapsed = !_sidebarCollapsed;
    const sb = _container?.querySelector("#cmd-sidebar");
    if (sb) {
      if (_sidebarCollapsed) sb.setAttribute("data-collapsed", "");
      else sb.removeAttribute("data-collapsed");
    }
    try { localStorage.setItem(SIDEBAR_STORAGE_KEY, _sidebarCollapsed ? "1" : "0"); } catch {}
  });
}

// ── Polling lifecycle ──────────────────────────────────────────────────────

function startPolling(): void {
  if (_pollTimer) return;
  _pollTimer = setInterval(poll, POLL_INTERVAL_MS);
}

function stopPolling(): void {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

function onVisibilityChange(): void {
  if (document.hidden) {
    stopPolling();
    for (const c of _cards.values()) c.player?.setQuality("low");
  } else {
    poll();
    startPolling();
  }
}

// ── Poll + diff ────────────────────────────────────────────────────────────

async function poll(): Promise<void> {
  if (!_container) return;
  refreshWorkflowNames();

  let sessions: SessionInfo[];
  try {
    sessions = (await fetchSessions()).filter(s => s.live);
  } catch {
    return;
  }
  if (!_container) return;

  sessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId));

  const cap = (typeof VideoDecoder !== "undefined") ? 6 : 2;
  const liveSet = new Set(sessions.slice(0, cap).map(s => s.sessionId));

  // Add new + update existing
  const seen = new Set<string>();
  for (const s of sessions) {
    seen.add(s.sessionId);
    const existing = _cards.get(s.sessionId);
    if (!existing) {
      _cards.set(s.sessionId, new StreamCard(s, liveSet.has(s.sessionId)));
    } else {
      existing.updateMeta(s);
      const wantLive = liveSet.has(s.sessionId);
      if (wantLive && !existing.player) existing.upgradeToLive();
      else if (!wantLive && existing.player) existing.downgradeToThumb();
    }
  }
  // Remove gone
  for (const [id, card] of _cards) {
    if (!seen.has(id)) { card.destroy(); _cards.delete(id); }
  }

  // Filter still valid?
  if (_activeWorkflowFilter && !sessions.some(s => s.activeWorkflowId === _activeWorkflowFilter)) {
    _activeWorkflowFilter = null;
  }

  renderGrid(sessions);
  updateTopPills(sessions);
  renderSidebar(sessions);
}

// ── Grid / pills / sidebar ─────────────────────────────────────────────────

function renderGrid(sessions: SessionInfo[]): void {
  const grid = _container?.querySelector("#cmd-grid");
  if (!grid) return;

  if (sessions.length === 0) {
    grid.innerHTML = `
      <div class="empty-state-large">
        <div class="empty-icon">
          <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" style="color:rgba(255,255,255,0.1)">
            <polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
          </svg>
        </div>
        <p>No active live streams</p>
        <span class="empty-hint">Streams will appear here when devices go live</span>
      </div>
    `;
    return;
  }

  const visible = _activeWorkflowFilter
    ? sessions.filter(s => s.activeWorkflowId === _activeWorkflowFilter)
    : sessions;

  grid.innerHTML = "";
  for (const s of visible) {
    const card = _cards.get(s.sessionId);
    if (card) grid.appendChild(card.el);
  }
}

function updateTopPills(sessions: SessionInfo[]): void {
  const liveEl = _container?.querySelector("#cmd-live-count");
  const devEl = _container?.querySelector("#cmd-device-count");
  if (liveEl) liveEl.textContent = String(sessions.length);
  if (devEl) {
    const ids = new Set(sessions.map(s => s.device?.deviceId).filter(Boolean));
    devEl.textContent = String(ids.size);
  }
}

function renderSidebar(sessions: SessionInfo[]): void {
  const list = _container?.querySelector("#cmd-workflows");
  if (!list) return;

  const groups = new Map<string, number>();
  for (const s of sessions) {
    if (s.activeWorkflowId) {
      groups.set(s.activeWorkflowId, (groups.get(s.activeWorkflowId) ?? 0) + 1);
    }
  }

  if (groups.size === 0) {
    list.innerHTML = `<p class="empty-state">No active workflows</p>`;
    return;
  }

  list.innerHTML = Array.from(groups.entries()).map(([wfId, n]) => {
    const name = _workflowNames.get(wfId) ?? truncateId(wfId);
    const isActive = _activeWorkflowFilter === wfId;
    return `<div class="cmd-workflow-row activity-item${isActive ? " is-active" : ""}" data-workflow-id="${esc(wfId)}">
      <span class="activity-dot live"></span>
      <span class="activity-text">${esc(name)}</span>
      <span class="activity-time">${n} ${n === 1 ? "device" : "devices"}</span>
    </div>`;
  }).join("");

  list.querySelectorAll(".cmd-workflow-row").forEach((el) => {
    el.addEventListener("click", () => {
      const id = (el as HTMLElement).dataset.workflowId!;
      _activeWorkflowFilter = (_activeWorkflowFilter === id) ? null : id;
      poll();
    });
  });
}

// ── Workflow name cache ────────────────────────────────────────────────────

async function refreshWorkflowNames(): Promise<void> {
  if (Date.now() - _workflowsRefreshedAt < WORKFLOW_NAME_TTL_MS) return;
  _workflowsRefreshedAt = Date.now();
  try {
    const wfs = await fetchWorkflows();
    for (const w of wfs) _workflowNames.set(w.id, w.name);
  } catch {}
}

// ── StreamCard ─────────────────────────────────────────────────────────────

class StreamCard {
  el: HTMLDivElement;
  canvas: HTMLCanvasElement;
  player: RelayPlayer | null = null;
  private session: SessionInfo;
  private fpsBuffer: number[] = [];
  private detectionWindow: number[] = [];
  private decayInterval: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  private signalLostEl: HTMLDivElement | null = null;
  private signalLostSubEl: HTMLDivElement | null = null;

  constructor(session: SessionInfo, makeLive: boolean) {
    this.session = session;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "cmd-card-canvas";
    this.el = document.createElement("div");
    this.el.className = "cmd-stream-card";
    this.el.dataset.sessionId = session.sessionId;
    this.renderShell();
    this.el.addEventListener("click", (e) => {
      // Don't navigate if user clicked something interactive inside
      if ((e.target as HTMLElement).closest("button")) return;
      watchLive(session.sessionId);
    });
    this.decayInterval = setInterval(() => this.decayDetections(), 1000);
    if (makeLive) this.upgradeToLive();
  }

  private renderShell(): void {
    const wfId = this.session.activeWorkflowId || null;
    const wfName = wfId ? (_workflowNames.get(wfId) ?? truncateId(wfId)) : "No workflow";
    const status = wfId ? "running" : (this.session.publisherStandby ? "standby" : "live");
    const statusClass = status === "running" ? "status-active" : status === "standby" ? "status-standby" : "status-live";
    const dev = this.session.device?.deviceName || "Unknown";
    const model = this.session.device?.deviceModel || "";
    const sid = this.session.sessionId;

    this.el.innerHTML = `
      <div class="cmd-card-video">
        <span class="live-badge">LIVE</span>
        <span class="cmd-card-duration">${this.session.startedAt ? elapsedSince(this.session.startedAt) : ""}</span>
        <div class="cmd-signal-lost">
          <svg class="cmd-signal-lost-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/>
            <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>
            <line x1="2" y1="2" x2="22" y2="22"/>
          </svg>
          <div class="cmd-signal-lost-text">SIGNAL LOST</div>
          <div class="cmd-signal-lost-sub">Reconnecting...</div>
        </div>
      </div>
      <div class="cmd-card-meta">
        <div class="cmd-card-row-1">
          <span class="cmd-card-device">${esc(dev)}</span>
          <span class="status-pill ${statusClass}">${status.toUpperCase()}</span>
        </div>
        <div class="cmd-card-row-2">
          <span class="cmd-card-id" title="${esc(sid)}">${esc(truncateId(sid))}${model ? " · " + esc(model) : ""}</span>
          <span class="cmd-card-workflow" title="${esc(wfName)}">${esc(wfName)}</span>
        </div>
        <div class="cmd-card-metrics">
          <div class="cmd-metric"><span class="k">FPS</span><span class="v" data-metric="fps">—</span></div>
          <div class="cmd-metric"><span class="k">DET</span><span class="v" data-metric="det">—</span></div>
          <div class="cmd-metric"><span class="k">LAT</span><span class="v" data-metric="lat">—</span></div>
          <div class="cmd-spark-slot"></div>
        </div>
      </div>
    `;
    this.placeMedia();
    this.signalLostEl = this.el.querySelector<HTMLDivElement>(".cmd-signal-lost");
    this.signalLostSubEl = this.el.querySelector<HTMLDivElement>(".cmd-signal-lost-sub");
  }

  private placeMedia(): void {
    const slot = this.el.querySelector(".cmd-card-video");
    if (!slot) return;
    slot.querySelectorAll(".cmd-card-canvas, .cmd-card-thumb").forEach(n => n.remove());
    if (this.player) {
      slot.insertBefore(this.canvas, slot.firstChild);
    } else {
      const img = document.createElement("img");
      img.className = "cmd-card-thumb";
      img.src = `/session/${encodeURIComponent(this.session.sessionId)}/thumbnail?t=${Date.now()}`;
      img.loading = "lazy";
      img.onerror = () => { img.style.display = "none"; };
      slot.insertBefore(img, slot.firstChild);
    }
  }

  upgradeToLive(): void {
    if (this.player || this.destroyed) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/view?session=${encodeURIComponent(this.session.sessionId)}`;
    const player = new RelayPlayer({
      canvas: this.canvas,
      onFps: (fps) => this.onFps(fps),
      onLatency: (ms) => this.onLatency(ms),
      onConnectionState: (s) => {
        if (s === "connected") { player.setQuality("low"); this.hideSignalLost(); }
        else if (s === "reconnecting") this.showSignalLost(true);
        else if (s === "disconnected" || s === "error") this.showSignalLost(false);
      },
      onAuthRequired: () => this.downgradeToThumb(),
    });
    player.onJsonMessage = (msg) => this.handleJson(msg);
    this.player = player;
    this.placeMedia();
    player.connect(url, undefined, getToken() || undefined);
  }

  downgradeToThumb(): void {
    if (!this.player) return;
    try { this.player.destroy(); } catch {}
    this.player = null;
    this.fpsBuffer = [];
    this.detectionWindow = [];
    this.hideSignalLost();
    this.placeMedia();
    this.setMetric("fps", "—");
    this.setMetric("det", "—");
    this.setMetric("lat", "—");
    this.updateSpark();
  }

  private showSignalLost(reconnecting: boolean): void {
    this.signalLostEl?.classList.add("visible");
    if (this.signalLostSubEl) this.signalLostSubEl.style.display = reconnecting ? "" : "none";
  }

  private hideSignalLost(): void {
    this.signalLostEl?.classList.remove("visible");
  }

  updateMeta(session: SessionInfo): void {
    const prev = this.session;
    this.session = session;

    if (prev.activeWorkflowId !== session.activeWorkflowId || prev.publisherStandby !== session.publisherStandby) {
      const wfId = session.activeWorkflowId || null;
      const wfName = wfId ? (_workflowNames.get(wfId) ?? truncateId(wfId)) : "No workflow";
      const wfEl = this.el.querySelector(".cmd-card-workflow") as HTMLElement | null;
      if (wfEl) { wfEl.textContent = wfName; wfEl.title = wfName; }
      const status = wfId ? "running" : (session.publisherStandby ? "standby" : "live");
      const statusClass = status === "running" ? "status-active" : status === "standby" ? "status-standby" : "status-live";
      const pillEl = this.el.querySelector(".status-pill");
      if (pillEl) {
        pillEl.className = `status-pill ${statusClass}`;
        pillEl.textContent = status.toUpperCase();
      }
    }

    if (session.startedAt) {
      const durEl = this.el.querySelector(".cmd-card-duration");
      if (durEl) durEl.textContent = elapsedSince(session.startedAt);
    }

    if (!this.player) {
      const img = this.el.querySelector(".cmd-card-thumb") as HTMLImageElement | null;
      if (img) img.src = `/session/${encodeURIComponent(session.sessionId)}/thumbnail?t=${Date.now()}`;
    }
  }

  private onFps(fps: number): void {
    this.fpsBuffer.push(fps);
    if (this.fpsBuffer.length > FPS_BUFFER_SIZE) this.fpsBuffer.shift();
    this.setMetric("fps", String(fps));
    this.updateSpark();
  }

  private onLatency(ms: number): void {
    this.setMetric("lat", `${ms}ms`);
  }

  private handleJson(msg: Record<string, unknown>): void {
    if (msg.type !== "guidance_event") return;
    const payload = msg.payload as Record<string, unknown> | undefined;
    const bboxes = (payload?.bbox ?? payload?.boundingBoxes) as unknown[] | undefined;
    const count = Array.isArray(bboxes) ? bboxes.length : 1;
    const now = Date.now();
    for (let i = 0; i < count; i++) this.detectionWindow.push(now);
  }

  private decayDetections(): void {
    const cutoff = Date.now() - 1000;
    this.detectionWindow = this.detectionWindow.filter(t => t >= cutoff);
    if (this.player) this.setMetric("det", String(this.detectionWindow.length));
  }

  private setMetric(name: string, val: string): void {
    const el = this.el.querySelector(`[data-metric="${name}"]`);
    if (el) el.textContent = val;
  }

  private updateSpark(): void {
    const slot = this.el.querySelector(".cmd-spark-slot");
    if (slot) slot.innerHTML = renderSparkline(this.fpsBuffer);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.decayInterval) { clearInterval(this.decayInterval); this.decayInterval = null; }
    if (this.player) { try { this.player.destroy(); } catch {} this.player = null; }
    this.el.remove();
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function elapsedSince(iso: string): string {
  try {
    const ms = Date.now() - new Date(iso).getTime();
    const m = Math.floor(ms / 60000);
    if (m < 1) return "< 1m";
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  } catch { return ""; }
}

function truncateId(id: string): string {
  return id.length <= 12 ? id : id.slice(0, 8) + "…";
}

function renderSparkline(samples: number[]): string {
  if (samples.length < 2) return "";
  const w = SPARKLINE_WIDTH;
  const h = SPARKLINE_HEIGHT;
  const maxVal = Math.max(...samples, 30);
  const stepX = w / (samples.length - 1);
  const points: string[] = [];
  for (let i = 0; i < samples.length; i++) {
    const x = i * stepX;
    const y = h - (samples[i] / maxVal) * h;
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  const d = "M" + points.join(" L");
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:100%;display:block;"><path d="${d}" fill="none" stroke="var(--accent-green)" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}
