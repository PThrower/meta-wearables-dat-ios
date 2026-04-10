/**
 * Gallery card rendering and session ingestion
 */

import { fmtDur, fmtTime } from "./format.js";

export interface GallerySession {
  sessionId: string;
  live: boolean;
  durationMs?: number;
  startedAt?: string;
  segments?: number;
  audioChunks?: number;
  exportCached?: boolean;
  thumbnailUrl?: string;
  videoUrl?: string;
  device?: { deviceName?: string; deviceModel?: string; wearableType?: string };
}

const BATCH = 6;
const grid = document.getElementById("grid")!;
const subtitle = document.getElementById("subtitle")!;
const lastRefresh = document.getElementById("last-refresh")!;

let allSessions: GallerySession[] = [];
let activeFilter = "all";

export function getAllSessions(): GallerySession[] { return allSessions; }

export function filtered(): GallerySession[] {
  if (activeFilter === "live") return allSessions.filter(s => s.live);
  if (activeFilter === "recorded") return allSessions.filter(s => !s.live);
  return allSessions;
}

export function ingest(data: GallerySession[]): void {
  allSessions = data;
  render(filtered());
  lastRefresh.textContent = new Date().toLocaleTimeString();
}

function cardHtml(s: GallerySession, delay: number): string {
  const device = s.device?.deviceName || s.device?.deviceModel || "Unknown Device";
  const wearable = s.device?.wearableType || "";
  const badgeClass = s.live ? "badge-live" : "badge-recorded";
  const badgeText = s.live ? "LIVE" : "RECORDED";
  const cached = s.exportCached ? "cached" : "on-demand";
  const thumb = (s.segments ?? 0) > 0
    ? `<img class="card-thumb" src="${s.thumbnailUrl}" alt=""
            onload="onThumbLoad(this)"
            onerror="this.outerHTML='<div class=\\'card-thumb-placeholder\\'>No preview</div>'" loading="lazy">`
    : `<div class="card-thumb-placeholder">No video</div>`;
  return `<div class="card" style="animation-delay:${delay}ms">
    ${thumb}
    <div class="card-body">
      <div class="card-top">
        <span class="card-title">${device}</span>
        <span class="badge ${badgeClass}">${badgeText}</span>
      </div>
      <div class="card-meta">
        ${wearable ? `<div class="row"><span class="label">Wearable</span><span class="value">${wearable}</span></div>` : ""}
        <div class="row"><span class="label">Duration</span><span class="value">${fmtDur(s.durationMs ?? 0)}</span></div>
        <div class="row"><span class="label">Started</span><span class="value">${fmtTime(s.startedAt ?? "")}</span></div>
        <div class="row"><span class="label">Segments</span><span class="value">${s.segments ?? 0} vid / ${s.audioChunks ?? 0} aud</span></div>
        <div class="row"><span class="label">MP4</span><span class="value">${cached}</span></div>
        <div class="row"><span class="label">ID</span><span class="value">${s.sessionId.slice(0, 8)}</span></div>
      </div>
      <div class="card-actions">
        ${(s.segments ?? 0) > 0 ? `<button class="action-btn primary" onclick="playVideo('${s.videoUrl}')">Play</button>
        <a class="action-btn" href="${s.videoUrl}" target="_blank">Download</a>` : ""}
        ${s.live ? `<a class="action-btn primary" href="/view?session=${encodeURIComponent(s.sessionId)}">Watch Live</a>` : ""}
      </div>
    </div>
  </div>`;
}

export function render(sessions: GallerySession[]): void {
  const live = allSessions.filter(s => s.live).length;
  subtitle.textContent = `${allSessions.length} session${allSessions.length !== 1 ? "s" : ""} (${live} live)`;
  grid.innerHTML = "";
  if (sessions.length === 0) {
    grid.innerHTML = '<div class="empty">No sessions found<p>Sessions appear after publishers connect and stream.</p></div>';
    return;
  }
  let i = 0;
  function nextBatch() {
    const frag = document.createDocumentFragment();
    const end = Math.min(i + BATCH, sessions.length);
    for (; i < end; i++) {
      const div = document.createElement("div");
      div.innerHTML = cardHtml(sessions[i], (i % BATCH) * 30);
      frag.appendChild(div.firstElementChild!);
    }
    grid.appendChild(frag);
    if (i < sessions.length) requestAnimationFrame(nextBatch);
  }
  nextBatch();
}

export function initFilters(): void {
  document.querySelectorAll(".filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      activeFilter = (btn as HTMLElement).dataset.filter ?? "all";
      render(filtered());
    });
  });
}
