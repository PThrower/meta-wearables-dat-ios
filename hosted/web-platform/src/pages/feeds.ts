/**
 * Feeds page — all sessions browser with time buckets, expandable rows,
 * inline video player, guidance events, and action buttons.
 * Consolidated from gallery — now shows both live and recorded sessions.
 */

import type { PageModule } from "../router/router.js";
import { fetchGallery, fetchGuidanceHistory, esc } from "../core/api-client.js";
import type { SessionInfo, GuidanceHistoryEvent } from "../core/api-client.js";
import { fmtDur } from "../core/format.js";
import { watchLive } from "../live/index.js";
import { openRecordedPlayer } from "../recorded.js";
import { authUrl } from "../auth.js";

type TimeBucket = "today" | "week" | "month" | "all";

export const page: PageModule = {
  init(container) {
    container.innerHTML = `
      <div class="page feeds-page">
        <div class="page-header">
          <h1 class="page-title">Feeds</h1>
          <span class="page-subtitle" id="feeds-subtitle">Sessions</span>
        </div>
        <div class="feeds-stats" id="feeds-stats"></div>
        <div class="feeds-toolbar">
          <div class="filter-pills" id="feeds-bucket-filters">
            <button class="filter-pill active" data-bucket="all">All</button>
            <button class="filter-pill" data-bucket="today">Today</button>
            <button class="filter-pill" data-bucket="week">This Week</button>
            <button class="filter-pill" data-bucket="month">This Month</button>
          </div>
        </div>
        <div id="feeds-list" class="feeds-list">
          <p class="empty-state">Loading sessions...</p>
        </div>
      </div>
    `;
    loadFeeds(container);
    bindBucketFilters(container);
    bindActionDelegation(container);
  },

  destroy() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  },
};

let _pollTimer: ReturnType<typeof setInterval> | null = null;
let _allSessions: SessionInfo[] = [];
let _currentBucket: TimeBucket = "all";
let _expandedRow: string | null = null;

async function loadFeeds(container: HTMLElement): Promise<void> {
  const sessions = await fetchGallery();
  _allSessions = sessions;
  renderStats(container, sessions);
  renderList(container, sessions);

  if (!_pollTimer) {
    _pollTimer = setInterval(async () => {
      _allSessions = await fetchGallery();
      renderStats(container, _allSessions);
      renderList(container, _allSessions);
    }, 30000);
  }
}

function renderStats(container: HTMLElement, sessions: SessionInfo[]): void {
  const el = container.querySelector("#feeds-stats");
  if (!el) return;

  const recorded = sessions.filter(s => !s.live);
  const totalContentDuration = recorded.reduce((sum, s) => sum + (s.videoDurationMs || s.durationMs || 0), 0);
  const totalWallDuration = recorded.reduce((sum, s) => sum + (s.durationMs || 0), 0);
  const liveCount = sessions.filter(s => s.live).length;
  const totalSegments = recorded.reduce((sum, s) => sum + (s.segments || 0), 0);

  el.innerHTML = `
    <div class="stat-card"><span class="stat-value">${recorded.length}</span><span class="stat-label">Recordings</span></div>
    <div class="stat-card"><span class="stat-value">${fmtDur(totalContentDuration)}</span><span class="stat-label">Content</span></div>
    <div class="stat-card"><span class="stat-value stat-live">${liveCount}</span><span class="stat-label">Live Now</span></div>
    <div class="stat-card"><span class="stat-value">${totalSegments}</span><span class="stat-label">Segments</span></div>
  `;
}

function renderList(container: HTMLElement, sessions: SessionInfo[]): void {
  const listEl = container.querySelector("#feeds-list")!;

  // Separate live and recorded sessions
  const liveSessions = sessions.filter(s => s.live);
  let recorded = sessions.filter(s => !s.live);

  // Apply time bucket filter to recorded only
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  if (_currentBucket === "today") {
    recorded = recorded.filter(s => s.startedAt && new Date(s.startedAt) >= todayStart);
  } else if (_currentBucket === "week") {
    recorded = recorded.filter(s => s.startedAt && new Date(s.startedAt) >= weekStart);
  } else if (_currentBucket === "month") {
    recorded = recorded.filter(s => s.startedAt && new Date(s.startedAt) >= monthStart);
  }

  // Sort newest first
  recorded.sort((a, b) => {
    const ta = a.startedAt ? new Date(a.startedAt).getTime() : 0;
    const tb = b.startedAt ? new Date(b.startedAt).getTime() : 0;
    return tb - ta;
  });

  const totalCount = liveSessions.length + recorded.length;
  const subtitle = container.querySelector("#feeds-subtitle");
  if (subtitle) subtitle.textContent = `${totalCount} session${totalCount !== 1 ? "s" : ""}`;

  if (totalCount === 0) {
    listEl.innerHTML = `<div class="empty-state-large">
      <p>No sessions found</p>
      <span class="empty-hint">Sessions will appear here after streaming</span>
    </div>`;
    return;
  }

  let html = "";

  // Live sessions section (always at top)
  if (liveSessions.length > 0) {
    html += `
      <div class="feed-bucket feed-bucket-live">
        <div class="feed-bucket-header">
          <span class="feed-bucket-date">
            <span class="status-pill status-live" style="margin-right:6px">LIVE</span>
            Active Streams
          </span>
          <span class="feed-bucket-count">${liveSessions.length} live</span>
        </div>
        <div class="feed-bucket-rows">
          ${liveSessions.map(s => liveRow(s)).join("")}
        </div>
      </div>
    `;
  }

  // Recorded sessions bucketed by date
  const buckets = bucketByDate(recorded);
  html += Object.entries(buckets)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, items]) => `
      <div class="feed-bucket">
        <div class="feed-bucket-header">
          <span class="feed-bucket-date">${formatBucketDate(date)}</span>
          <span class="feed-bucket-count">${items.length} session${items.length !== 1 ? "s" : ""}</span>
        </div>
        <div class="feed-bucket-rows">
          ${items.map(s => feedRow(s)).join("")}
        </div>
      </div>
    `).join("");

  listEl.innerHTML = html;

  // Bind row clicks (recorded sessions expand)
  listEl.querySelectorAll<HTMLElement>(".feed-row").forEach((row) => {
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".feed-expanded")) return;
      if ((e.target as HTMLElement).closest("[data-action]")) return;
      const sessionId = row.dataset.sessionId;
      if (sessionId) toggleRow(container, sessionId);
    });
  });
}

function liveRow(s: SessionInfo): string {
  return `
    <div class="feed-row feed-row-live" data-session-id="${esc(s.sessionId)}">
      <div class="feed-row-expand-icon feed-row-live-dot">
        <span class="status-pill status-live">LIVE</span>
      </div>
      <div class="feed-row-thumb">
        <div class="feed-row-placeholder feed-row-placeholder-live"></div>
      </div>
      <div class="feed-row-info">
        <span class="feed-row-device">${esc(s.device?.deviceName || "Unknown")}${s.wearable?.wearableType ? ` + ${esc(s.wearable.wearableType)}` : ""}</span>
        <span class="feed-row-meta">Live &middot; ${fmtDur(s.durationMs || 0)}</span>
      </div>
      <div class="feed-row-actions">
        <button class="action-btn primary" data-action="watch-live" data-session-id="${esc(s.sessionId)}">Watch Live</button>
        <button class="action-btn" data-action="share" data-session-id="${esc(s.sessionId)}">Share</button>
      </div>
    </div>
  `;
}

function feedRow(s: SessionInfo): string {
  const isExpanded = _expandedRow === s.sessionId;
  const contentDur = s.videoDurationMs || s.durationMs || 0;
  const driftAbs = Math.abs(s.driftMs || 0);
  const driftLabel = driftAbs > 2000 ? ` \u00b1${fmtDur(driftAbs)}` : "";
  return `
    <div class="feed-row${isExpanded ? " expanded" : ""}" data-session-id="${esc(s.sessionId)}">
      <div class="feed-row-expand-icon">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </div>
      <div class="feed-row-thumb">
        ${s.hasThumbnail
          ? `<img src="/session/${esc(s.sessionId)}/thumbnail" alt="" loading="lazy" onerror="this.style.display='none'" />`
          : '<div class="feed-row-placeholder"></div>'}
      </div>
      <div class="feed-row-info">
        <span class="feed-row-device">${esc(s.device?.deviceName || "Unknown")}</span>
        <span class="feed-row-meta">${fmtDur(contentDur)}${driftLabel} &middot; ${s.segments || 0} segs</span>
      </div>
      <span class="feed-row-time">${fmtSessionTime(s.startedAt)}</span>
    </div>
    <div class="feed-expanded${isExpanded ? " open" : ""}" data-expanded-id="${esc(s.sessionId)}">
      ${isExpanded ? buildExpandedContent(s) : ""}
    </div>
  `;
}

function buildExpandedContent(s: SessionInfo): string {
  const hasVideo = (s.segments || 0) > 0;
  const contentDur = s.videoDurationMs || s.durationMs || 0;
  const driftMs = s.driftMs || 0;
  const driftAbs = Math.abs(driftMs);
  const hasDrift = driftAbs > 2000;

  let syncHtml = "";
  if (hasDrift) {
    const direction = driftMs > 0 ? "audio longer" : "video longer";
    syncHtml = `<div class="feed-detail-row"><span class="feed-detail-label">A/V Drift</span><span class="feed-detail-value" style="color:#ffb86c">${fmtDur(driftAbs)} (${direction})</span></div>`;
  }

  let streamDriftHtml = "";
  const relayed = s.framesRelayed;
  const recorded = s.framesRecorded;
  if (relayed != null && recorded != null) {
    const diff = Math.abs(relayed - recorded);
    if (diff > 0) {
      const direction = relayed > recorded ? "more streamed" : "more recorded";
      streamDriftHtml = `<div class="feed-detail-row"><span class="feed-detail-label">Stream Drift</span><span class="feed-detail-value" style="color:#bd93f9">${diff} frames (${direction}) &middot; ${relayed} relayed / ${recorded} recorded</span></div>`;
    } else {
      streamDriftHtml = `<div class="feed-detail-row"><span class="feed-detail-label">Stream Drift</span><span class="feed-detail-value" style="color:#50fa7b">0 (perfect match: ${recorded} frames)</span></div>`;
    }
  }

  return `<div class="feed-expanded-inner" id="feed-expanded-${esc(s.sessionId)}">
    ${hasVideo ? `<div class="feed-video-wrap">
      <video class="feed-inline-video" controls preload="metadata">
        <source src="/session/${esc(s.sessionId)}/video.mp4?audio" type="video/mp4" />
      </video>
    </div>` : ""}
    <div class="feed-expanded-details" id="feed-details-${esc(s.sessionId)}">
      <div class="feed-detail-rows">
        <div class="feed-detail-row"><span class="feed-detail-label">Session</span><span class="feed-detail-value">${esc(s.sessionId.slice(0, 12))}</span></div>
        <div class="feed-detail-row"><span class="feed-detail-label">Duration</span><span class="feed-detail-value">${fmtDur(contentDur)}${contentDur !== (s.durationMs || 0) ? ` <span style="color:#6272a4">(wall ${fmtDur(s.durationMs || 0)})</span>` : ""}</span></div>
        ${s.audioDurationMs ? `<div class="feed-detail-row"><span class="feed-detail-label">Audio</span><span class="feed-detail-value">${fmtDur(s.audioDurationMs)}</span></div>` : ""}
        ${syncHtml}
        ${streamDriftHtml}
        <div class="feed-detail-row"><span class="feed-detail-label">Segments</span><span class="feed-detail-value">${s.segments || 0}</span></div>
        <div class="feed-detail-row"><span class="feed-detail-label">Device</span><span class="feed-detail-value">${esc(s.device?.deviceName || "Unknown")}${s.device?.deviceModel ? ` (${esc(s.device.deviceModel)})` : ""}</span></div>
        ${s.wearable?.wearableType ? `<div class="feed-detail-row"><span class="feed-detail-label">Camera</span><span class="feed-detail-value">${esc(s.wearable.wearableType)}${s.wearable.wearableId ? ` &middot; ${esc(s.wearable.wearableId.slice(0, 8))}` : ""}</span></div>` : ""}
        <div class="feed-detail-row"><span class="feed-detail-label">Started</span><span class="feed-detail-value">${fmtSessionTime(s.startedAt)}</span></div>
        <div class="feed-detail-row"><span class="feed-detail-label">Access</span><span class="feed-detail-value">${esc(s.access || "private")}</span></div>
      </div>
      <div class="feed-expanded-actions">
        ${hasVideo ? `<a class="action-btn" href="${authUrl("/session/" + s.sessionId + "/video.mp4?audio")}" target="_blank" rel="noopener">Download MP4</a>
        <button class="action-btn" data-action="play-overlay" data-session-id="${esc(s.sessionId)}">Open in Player</button>` : ""}
        <button class="action-btn" data-action="share" data-session-id="${esc(s.sessionId)}">Share</button>
      </div>
      <div class="feed-guidance-section">
        <h4 class="section-title">Guidance Events</h4>
        <div class="feed-guidance-log" id="feed-guidance-${esc(s.sessionId)}">
          <p class="empty-state">Loading...</p>
        </div>
      </div>
    </div>
  </div>`;
}

async function toggleRow(container: HTMLElement, sessionId: string): Promise<void> {
  if (_expandedRow && _expandedRow !== sessionId) {
    collapseRow(_expandedRow);
  }

  if (_expandedRow === sessionId) {
    collapseRow(sessionId);
    _expandedRow = null;
    return;
  }

  _expandedRow = sessionId;

  const expandedEl = container.querySelector(`[data-expanded-id="${sessionId}"]`);
  const row = container.querySelector(`.feed-row[data-session-id="${sessionId}"]`);

  if (row) row.classList.add("expanded");
  if (expandedEl) {
    expandedEl.classList.add("open");
    const session = _allSessions.find(s => s.sessionId === sessionId);
    if (session) {
      expandedEl.innerHTML = buildExpandedContent(session);
    }
    loadGuidanceHistory(sessionId);
  }
}

function collapseRow(sessionId: string): void {
  const expandedEl = document.querySelector(`[data-expanded-id="${sessionId}"]`);
  const row = document.querySelector(`.feed-row[data-session-id="${sessionId}"]`);
  if (row) row.classList.remove("expanded");
  if (expandedEl) {
    expandedEl.classList.remove("open");
    const video = expandedEl.querySelector("video") as HTMLVideoElement;
    if (video) video.pause();
    expandedEl.innerHTML = "";
  }
}

async function loadGuidanceHistory(sessionId: string): Promise<void> {
  const el = document.getElementById(`feed-guidance-${sessionId}`);
  if (!el) return;

  const events = await fetchGuidanceHistory(sessionId);
  if (!events || events.length === 0) {
    el.innerHTML = '<p class="empty-state">No guidance events for this session</p>';
    return;
  }

  el.innerHTML = events.slice(0, 30).map(e => `
    <div class="feed-guidance-item">
      <span class="feed-guidance-type" data-type="${esc(e.type)}">${esc(e.type.replace("guidance.", "").toUpperCase())}</span>
      <span class="feed-guidance-text">${esc(e.content)}</span>
      <span class="feed-guidance-conf">${Math.round(e.confidence * 100)}%</span>
    </div>
  `).join("");
}

/** Delegated action handler for share/download/play-overlay/watch-live buttons */
function bindActionDelegation(container: HTMLElement): void {
  container.addEventListener("click", (e) => {
    const target = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
    if (!target) return;
    e.stopPropagation();

    const action = target.dataset.action;
    const sessionId = target.dataset.sessionId;
    if (!action || !sessionId) return;

    switch (action) {
      case "watch-live":
        watchLive(sessionId);
        break;
      case "play-overlay":
        openRecordedPlayer(sessionId);
        break;
      case "share": {
        const openShareDialog = (window as any).openShareDialog;
        if (openShareDialog) openShareDialog(sessionId);
        break;
      }
    }
  });
}

function bindBucketFilters(container: HTMLElement): void {
  const filters = container.querySelector("#feeds-bucket-filters");
  if (!filters) return;

  filters.addEventListener("click", (e) => {
    const pill = (e.target as HTMLElement).closest(".filter-pill");
    if (!pill) return;

    filters.querySelectorAll(".filter-pill").forEach(p => p.classList.remove("active"));
    pill.classList.add("active");
    _currentBucket = (pill as HTMLElement).dataset.bucket as TimeBucket || "all";
    renderList(container, _allSessions);
  });
}

function bucketByDate(sessions: SessionInfo[]): Record<string, SessionInfo[]> {
  const buckets: Record<string, SessionInfo[]> = {};
  for (const s of sessions) {
    const date = s.startedAt ? s.startedAt.slice(0, 10) : "unknown";
    if (!buckets[date]) buckets[date] = [];
    buckets[date].push(s);
  }
  return buckets;
}

function formatBucketDate(date: string): string {
  if (date === "unknown") return "Unknown date";
  try {
    const d = new Date(date + "T00:00:00");
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return "Today";
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
    return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
  } catch { return date; }
}

function fmtSessionTime(iso?: string): string {
  if (!iso) return "--";
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch { return "--"; }
}

export default page;
