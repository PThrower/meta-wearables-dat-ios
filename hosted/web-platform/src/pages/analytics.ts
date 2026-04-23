/**
 * Analytics page — KPIs, SVG charts, sortable performance table.
 * Phase 5: Full implementation with line chart, donut chart, and sortable table.
 */

import type { PageModule } from "../router/router.js";
import { fetchStats, fetchGallery, esc, formatBytes, formatDateTime } from "../core/api-client.js";
import type { SessionInfo } from "../core/api-client.js";
import { fmtDur } from "../core/format.js";
import { renderLineChart } from "../components/charts/line-chart.js";
import { renderDonutChart } from "../components/charts/donut-chart.js";

type SortColumn = "device" | "duration" | "date" | "status";
type SortDir = "asc" | "desc";

export const page: PageModule = {
  init(container) {
    container.innerHTML = `
      <div class="page analytics-page">
        <div class="page-header">
          <h1 class="page-title">Analytics</h1>
          <span class="page-subtitle">Platform metrics</span>
        </div>
        <div class="analytics-kpis" id="analytics-kpis">
          <div class="stat-card"><span class="stat-value" id="an-sessions">--</span><span class="stat-label">Total Sessions</span></div>
          <div class="stat-card"><span class="stat-value" id="an-duration">--</span><span class="stat-label">Avg Duration</span></div>
          <div class="stat-card"><span class="stat-value" id="an-recordings">--</span><span class="stat-label">Recordings</span></div>
          <div class="stat-card"><span class="stat-value" id="an-bandwidth">--</span><span class="stat-label">Bandwidth</span></div>
        </div>
        <div class="analytics-grid">
          <section class="analytics-section">
            <h2 class="section-title">Sessions Over Time</h2>
            <div id="an-chart" class="analytics-chart"></div>
          </section>
          <section class="analytics-section">
            <h2 class="section-title">Session Types</h2>
            <div id="an-donut" class="analytics-donut"></div>
          </section>
        </div>
        <section class="analytics-section" style="margin-top:16px">
          <h2 class="section-title">Session Performance</h2>
          <div id="an-table" class="analytics-table-wrap">
            <p class="empty-state">Loading...</p>
          </div>
        </section>
      </div>
    `;
    _sortColumn = "date";
    _sortDir = "desc";
    loadAnalytics(container);
  },

  destroy() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  },
};

let _pollTimer: ReturnType<typeof setInterval> | null = null;
let _sortColumn: SortColumn = "date";
let _sortDir: SortDir = "desc";
let _sessions: SessionInfo[] = [];

async function loadAnalytics(container: HTMLElement): Promise<void> {
  const [stats, sessions] = await Promise.all([
    fetchStats(),
    fetchGallery(),
  ]);

  _sessions = sessions;

  renderKPIs(container, stats, sessions);
  renderLineChartSection(container, sessions);
  renderDonutSection(container, sessions);
  renderTable(container, sessions);

  if (!_pollTimer) {
    _pollTimer = setInterval(async () => {
      if (!container.isConnected) { clearInterval(_pollTimer!); _pollTimer = null; return; }
      const [s, sess] = await Promise.all([fetchStats(), fetchGallery()]);
      if (!container.isConnected) return;
      _sessions = sess;
      renderKPIs(container, s, sess);
      renderLineChartSection(container, sess);
      renderDonutSection(container, sess);
      renderTable(container, sess);
    }, 30000);
  }
}

function renderKPIs(container: HTMLElement, stats: any, sessions: SessionInfo[]): void {
  const sessionsEl = container.querySelector("#an-sessions");
  const durationEl = container.querySelector("#an-duration");
  const recsEl = container.querySelector("#an-recordings");
  const bwEl = container.querySelector("#an-bandwidth");

  if (stats) {
    if (sessionsEl) sessionsEl.textContent = String(stats.totalSessions ?? stats.total_sessions ?? sessions.length);
    if (bwEl) bwEl.textContent = formatBytes(stats.totalBytesSent ?? stats.bytes_sent ?? 0);
  }

  const recorded = sessions.filter(s => !s.live);
  if (recsEl) recsEl.textContent = String(recorded.length);

  if (recorded.length > 0 && durationEl) {
    const avg = recorded.reduce((sum, s) => sum + (s.durationMs || 0), 0) / recorded.length;
    durationEl.textContent = fmtDur(avg);
  }
}

function renderLineChartSection(container: HTMLElement, sessions: SessionInfo[]): void {
  const chartEl = container.querySelector("#an-chart") as HTMLElement;
  if (!chartEl) return;

  // Group sessions by date
  const byDate: Record<string, number> = {};
  for (const s of sessions) {
    if (!s.startedAt) continue;
    const date = s.startedAt.slice(0, 10);
    byDate[date] = (byDate[date] || 0) + 1;
  }

  const sorted = Object.entries(byDate).sort(([a], [b]) => a.localeCompare(b));
  const points = sorted.map(([date, count]) => ({
    label: date,
    value: count,
  }));

  renderLineChart(chartEl, points, {
    color: "#4ade80",
    height: 200,
    formatLabel: (l: string) => {
      try {
        return new Date(l + "T00:00:00").toLocaleDateString([], { month: "short", day: "numeric" });
      } catch { return l; }
    },
    formatValue: (v: number) => String(v),
  });
}

function renderDonutSection(container: HTMLElement, sessions: SessionInfo[]): void {
  const donutEl = container.querySelector("#an-donut") as HTMLElement;
  if (!donutEl) return;

  const live = sessions.filter(s => s.live).length;
  const recorded = sessions.filter(s => !s.live).length;

  renderDonutChart(donutEl, [
    { label: "Recorded", value: recorded, color: "#60a5fa" },
    { label: "Live (active)", value: live, color: "#4ade80" },
  ], {
    centerValue: String(sessions.length),
    centerLabel: "Sessions",
  });
}

function renderTable(container: HTMLElement, sessions: SessionInfo[]): void {
  const tableEl = container.querySelector("#an-table");
  if (!tableEl) return;
  const sorted = sortSessions(sessions);
  const recent = sorted.slice(0, 50);

  if (recent.length === 0) {
    tableEl.innerHTML = '<p class="empty-state">No session data</p>';
    return;
  }

  const sortIcon = (col: SortColumn) =>
    _sortColumn === col ? (_sortDir === "asc" ? " ↑" : " ↓") : "";

  tableEl.innerHTML = `
    <div class="table-scroll">
      <table class="data-table sortable">
        <thead><tr>
          <th class="sortable-col" data-sort="device">Device${sortIcon("device")}</th>
          <th class="sortable-col" data-sort="duration">Duration${sortIcon("duration")}</th>
          <th class="sortable-col" data-sort="date">Date${sortIcon("date")}</th>
          <th class="sortable-col" data-sort="status">Status${sortIcon("status")}</th>
        </tr></thead>
        <tbody>${recent.map(s => `
          <tr>
            <td>${esc(s.device?.deviceName || s.sessionId?.slice(0, 8) || "--")}</td>
            <td>${fmtDur(s.durationMs || 0)}</td>
            <td>${formatDateTime(s.startedAt)}</td>
            <td><span class="status-pill ${s.live ? "status-live" : "status-recorded"}">${s.live ? "Live" : "Recorded"}</span></td>
          </tr>
        `).join("")}</tbody>
      </table>
    </div>
  `;

  // Bind sort headers
  tableEl.querySelectorAll(".sortable-col").forEach(th => {
    th.addEventListener("click", () => {
      const col = (th as HTMLElement).dataset.sort as SortColumn;
      if (_sortColumn === col) {
        _sortDir = _sortDir === "asc" ? "desc" : "asc";
      } else {
        _sortColumn = col;
        _sortDir = "asc";
      }
      renderTable(container, sessions);
    });
  });
}

function sortSessions(sessions: SessionInfo[]): SessionInfo[] {
  return [...sessions].sort((a, b) => {
    let cmp = 0;
    switch (_sortColumn) {
      case "device":
        cmp = (a.device?.deviceName || "").localeCompare(b.device?.deviceName || "");
        break;
      case "duration":
        cmp = (a.durationMs || 0) - (b.durationMs || 0);
        break;
      case "date":
        cmp = (a.startedAt || "").localeCompare(b.startedAt || "");
        break;
      case "status":
        cmp = Number(b.live) - Number(a.live);
        break;
    }
    return _sortDir === "asc" ? cmp : -cmp;
  });
}

export default page;
