/**
 * Command Center — dashboard with stats, activity feed, agent cards.
 * Phase 2: Full implementation with polling and proper cleanup.
 */

import type { PageModule } from "../router/router.js";
import { fetchStats, fetchSessions, fetchApps, esc, formatUptime, formatTime, formatBytes } from "../core/api-client.js";
import type { StatsResponse, SessionInfo, AppInfo } from "../core/api-client.js";

export const page: PageModule = {
  init(container) {
    container.innerHTML = `
      <div class="page dashboard-page">
        <div class="page-header">
          <div class="page-header-row">
            <div>
              <h1 class="page-title">Command Center</h1>
              <span class="page-subtitle">Platform overview</span>
            </div>
            <span class="fleet-health-badge" id="dash-health">
              <span class="health-dot"></span>
              <span class="health-text">Checking...</span>
            </span>
          </div>
        </div>
        <div class="pulse-strip">
          <div class="stat-card">
            <span class="stat-value" id="dash-live">--</span>
            <span class="stat-label">Live Streams</span>
          </div>
          <div class="stat-card">
            <span class="stat-value" id="dash-devices">--</span>
            <span class="stat-label">Devices</span>
          </div>
          <div class="stat-card">
            <span class="stat-value" id="dash-guidance">--</span>
            <span class="stat-label">Guidance Events</span>
          </div>
          <div class="stat-card">
            <span class="stat-value" id="dash-recordings">--</span>
            <span class="stat-label">Total Sessions</span>
          </div>
        </div>
        <div class="dashboard-grid">
          <section class="dashboard-section activity-section">
            <h2 class="section-title">Activity Feed</h2>
            <div id="dash-activity" class="activity-feed">
              <p class="empty-state">Loading activity...</p>
            </div>
          </section>
          <section class="dashboard-section agents-section">
            <h2 class="section-title">AI Agents</h2>
            <div id="dash-agents" class="agent-cards">
              <p class="empty-state">Loading agents...</p>
            </div>
          </section>
        </div>
      </div>
    `;
    loadDashboard(container);
    _pollTimer = setInterval(() => loadDashboard(container), 15000);
  },

  destroy() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  },
};

let _pollTimer: ReturnType<typeof setInterval> | null = null;

async function loadDashboard(container: HTMLElement): Promise<void> {
  const [stats, sessions, apps] = await Promise.all([
    fetchStats(),
    fetchSessions(),
    fetchApps(),
  ]);

  renderStats(container, stats);
  renderActivity(container, sessions);
  renderAgents(container, apps);
  renderHealth(container, stats, sessions);
}

function renderStats(container: HTMLElement, stats: StatsResponse | null): void {
  if (!stats) return;

  const liveEl = container.querySelector("#dash-live");
  const devicesEl = container.querySelector("#dash-devices");
  const guidanceEl = container.querySelector("#dash-guidance");
  const recsEl = container.querySelector("#dash-recordings");

  const liveCount = stats.activeSessions ?? stats.active_sessions ?? 0;
  const deviceCount = stats.totalDevices ?? stats.total_devices ?? 0;
  const guidanceCount = stats.guidanceEvents ?? stats.guidance_events ?? 0;
  const totalSessions = stats.totalSessions ?? stats.total_sessions ?? 0;

  if (liveEl) liveEl.textContent = String(liveCount);
  if (devicesEl) devicesEl.textContent = String(deviceCount);
  if (guidanceEl) guidanceEl.textContent = String(guidanceCount);
  if (recsEl) recsEl.textContent = String(totalSessions);

  // Animate live count with accent color
  if (liveEl && liveCount > 0) liveEl.classList.add("stat-live");
}

function renderActivity(container: HTMLElement, sessions: SessionInfo[]): void {
  const feed = container.querySelector("#dash-activity");
  if (!feed) return;

  if (sessions.length === 0) {
    feed.innerHTML = '<p class="empty-state">No recent activity</p>';
    return;
  }

  feed.innerHTML = sessions.slice(0, 15).map(s => `
    <div class="activity-item">
      <span class="activity-dot ${s.live ? "live" : "recorded"}"></span>
      <span class="activity-text">${esc(s.device?.deviceName || s.sessionId)}</span>
      <span class="activity-time">${s.live ? "LIVE" : formatTime(s.startedAt)}</span>
    </div>
  `).join("");
}

function renderAgents(container: HTMLElement, apps: AppInfo[]): void {
  const agentsEl = container.querySelector("#dash-agents");
  if (!agentsEl) return;

  if (apps.length === 0) {
    agentsEl.innerHTML = '<p class="empty-state">No AI apps configured</p>';
    return;
  }

  agentsEl.innerHTML = apps.map(a => {
    const isActive = a.active;
    return `
      <div class="agent-card">
        <div class="agent-info">
          <span class="agent-name">${esc(a.name || a.id)}</span>
          ${a.config?.model ? `<span class="agent-model">${esc(a.config.model)}</span>` : ""}
        </div>
        <span class="agent-status ${isActive ? "active" : "standby"}">${isActive ? "Active" : "Standby"}</span>
      </div>
    `;
  }).join("");
}

function renderHealth(container: HTMLElement, stats: StatsResponse | null, sessions: SessionInfo[]): void {
  const badge = container.querySelector("#dash-health");
  if (!badge) return;

  const liveCount = sessions.filter(s => s.live).length;
  const dot = badge.querySelector(".health-dot") as HTMLElement;
  const text = badge.querySelector(".health-text") as HTMLElement;

  if (liveCount > 0) {
    if (dot) dot.className = "health-dot health-good";
    if (text) text.textContent = `${liveCount} live stream${liveCount !== 1 ? "s" : ""}`;
    badge.classList.add("healthy");
  } else if (stats) {
    if (dot) dot.className = "health-dot health-idle";
    if (text) text.textContent = "Idle — no active streams";
    badge.classList.remove("healthy");
  }
}

export default page;
