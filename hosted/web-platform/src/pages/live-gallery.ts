/**
 * Live Streams gallery — shows active sessions in a grid.
 * Clicking opens the existing live player overlay.
 * Phase 3: Enhanced with proper session cards and refresh.
 */

import type { PageModule } from "../router/router.js";
import { fetchSessions, esc, formatTime } from "../core/api-client.js";
import type { SessionInfo } from "../core/api-client.js";
import { watchLive } from "../live.js";

export const page: PageModule = {
  init(container) {
    container.innerHTML = `
      <div class="page live-gallery-page">
        <div class="page-header">
          <h1 class="page-title">Live Streams</h1>
          <span class="page-subtitle" id="live-subtitle">Active sessions</span>
        </div>
        <div class="pulse-strip" id="live-stats"></div>
        <div id="live-sessions-grid" class="live-sessions-grid">
          <p class="empty-state">Loading live sessions...</p>
        </div>
      </div>
    `;
    loadLiveSessions(container);
    _pollTimer = setInterval(() => loadLiveSessions(container), 10000);
  },

  destroy() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  },
};

let _pollTimer: ReturnType<typeof setInterval> | null = null;

async function loadLiveSessions(container: HTMLElement): Promise<void> {
  const sessions = await fetchSessions();
  const live = sessions.filter(s => s.live);

  renderStats(container, live);
  renderGrid(container, live);
}

function renderStats(container: HTMLElement, live: SessionInfo[]): void {
  const el = container.querySelector("#live-stats");
  if (!el) return;

  el.innerHTML = `
    <div class="stat-card"><span class="stat-value stat-live">${live.length}</span><span class="stat-label">Live Now</span></div>
    <div class="stat-card"><span class="stat-value">${new Set(live.map(s => s.device?.deviceName).filter(Boolean)).size}</span><span class="stat-label">Active Devices</span></div>
  `;
}

function renderGrid(container: HTMLElement, live: SessionInfo[]): void {
  const grid = container.querySelector("#live-sessions-grid")!;
  const subtitle = container.querySelector("#live-subtitle");

  if (subtitle) subtitle.textContent = `${live.length} active session${live.length !== 1 ? "s" : ""}`;

  if (live.length === 0) {
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

  grid.innerHTML = live.map(s => `
    <div class="live-session-card" data-session-id="${esc(s.sessionId)}">
      <div class="live-card-thumb">
        <img src="/session/${esc(s.sessionId)}/thumbnail" alt="" loading="lazy" onerror="this.style.display='none'" />
        <span class="live-badge">LIVE</span>
        <span class="live-card-duration">${s.startedAt ? elapsedSince(s.startedAt) : ""}</span>
      </div>
      <div class="live-card-info">
        <div class="live-card-left">
          <span class="live-card-device">${esc(s.device?.deviceName || "Unknown")}</span>
          <span class="live-card-meta">${esc(s.device?.deviceModel || "")} &middot; ${formatTime(s.startedAt)}</span>
        </div>
        <span class="live-card-view-btn">Watch</span>
      </div>
    </div>
  `).join("");

  // Click to watch
  grid.querySelectorAll(".live-session-card").forEach((card) => {
    card.addEventListener("click", () => {
      const sessionId = (card as HTMLElement).dataset.sessionId;
      if (sessionId) watchLive(sessionId);
    });
  });
}

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

export default page;
