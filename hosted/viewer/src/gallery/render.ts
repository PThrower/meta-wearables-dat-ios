/**
 * Gallery card rendering and session ingestion
 */

import { fmtDur, fmtTime } from "./format.js";
import { authUrl } from "../auth.js";

/** Escape a string for safe insertion into an HTML attribute value (inside double quotes) */
function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface GallerySession {
  sessionId: string;
  live: boolean;
  durationMs?: number;
  startedAt?: string;
  segments?: number;
  audioChunks?: number;
  exportCached?: boolean;
  hasThumbnail?: boolean;
  thumbnailUrl?: string;
  videoUrl?: string;
  device?: { deviceName?: string; deviceModel?: string; wearableType?: string };
  ownerId?: string;
  ownerEmail?: string;
  accessLevel?: "public" | "link" | "private";
  acl?: Array<{ userId: string; email: string; role: string }>;
  viewerRole?: "owner" | "editor" | "viewer" | "public" | "none";
}

const BATCH = 6;
const grid = document.getElementById("grid")!;
const subtitle = document.getElementById("subtitle")!;
const lastRefresh = document.getElementById("last-refresh")!;

let allSessions: GallerySession[] = [];
let activeFilter = "all";

// Delegated event handlers for card actions (replaces inline onclick)
let cardActionHandler: ((action: string, data: Record<string, string>) => void) | null = null;

export function onCardAction(handler: (action: string, data: Record<string, string>) => void): void {
  cardActionHandler = handler;
}

grid.addEventListener("click", (e) => {
  const target = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
  if (!target || !cardActionHandler) return;
  const action = target.dataset.action ?? "";
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(target.dataset)) {
    if (k !== "action" && v !== undefined) data[k] = v;
  }
  cardActionHandler(action, data);
});

// Lazy image load handler via MutationObserver (replaces inline onload/onerror)
const imgObserver = new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node instanceof HTMLElement) {
        node.querySelectorAll<HTMLImageElement>("img.card-thumb").forEach(img => {
          if (img.dataset.wired) return;
          img.dataset.wired = "1";
          img.addEventListener("load", () => img.classList.add("loaded"));
          img.addEventListener("error", () => {
            img.outerHTML = '<div class="card-thumb-placeholder">No preview</div>';
          });
        });
      }
    }
  }
});
imgObserver.observe(grid, { childList: true, subtree: true });

export function getAllSessions(): GallerySession[] { return allSessions; }

export function filtered(): GallerySession[] {
  if (activeFilter === "live") return allSessions.filter(s => s.live);
  if (activeFilter === "recorded") return allSessions.filter(s => !s.live);
  if (activeFilter === "mine") return allSessions.filter(s => s.viewerRole === "owner" || s.viewerRole === "editor");
  return allSessions;
}

export function clearGallery(): void {
  allSessions = [];
  activeFilter = "all";
  grid.innerHTML = "";
  subtitle.textContent = "";
  lastRefresh.textContent = "";
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
  const isPrivate = s.accessLevel === "private";
  const isOwner = s.viewerRole === "owner";
  const canEdit = s.viewerRole === "owner" || s.viewerRole === "editor";
  const lockIcon = isPrivate ? `<span class="lock-icon" title="Private">&#x1F512;</span>` : "";
  const ownerBadge = isOwner ? `<span class="owner-badge">Owner</span>` : "";
  const shareBtn = canEdit ? `<button class="action-btn share-btn" data-action="share" data-session-id="${escAttr(s.sessionId)}">Share</button>` : "";
  const hasVideo = (s.segments ?? 0) > 0;
  const thumb = (s.hasThumbnail ?? false)
    ? `<img class="card-thumb" src="${escAttr(authUrl(s.thumbnailUrl ?? ""))}" alt="" loading="lazy">`
    : `<div class="card-thumb-placeholder">${hasVideo ? "Processing" : "No video"}</div>`;
  const safeVideoUrl = escAttr(authUrl(s.videoUrl ?? ""));
  return `<div class="card" style="animation-delay:${delay}ms">
    ${thumb}
    <div class="card-body">
      <div class="card-top">
        <span class="card-title">${lockIcon}${escAttr(device)}${ownerBadge}</span>
        <span class="badge ${badgeClass}">${badgeText}</span>
      </div>
      <div class="card-meta">
        ${wearable ? `<div class="row"><span class="label">Wearable</span><span class="value">${escAttr(wearable)}</span></div>` : ""}
        <div class="row"><span class="label">Duration</span><span class="value">${fmtDur(s.durationMs ?? 0)}</span></div>
        <div class="row"><span class="label">Started</span><span class="value">${fmtTime(s.startedAt ?? "")}</span></div>
        <div class="row"><span class="label">Segments</span><span class="value">${s.segments ?? 0} vid / ${s.audioChunks ?? 0} aud</span></div>
        <div class="row"><span class="label">MP4</span><span class="value">${cached}</span></div>
        <div class="row"><span class="label">ID</span><span class="value">${escAttr(s.sessionId.slice(0, 8))}</span></div>
      </div>
      <div class="card-actions">
        ${hasVideo ? `<button class="action-btn primary" data-action="play" data-url="${safeVideoUrl}">Play</button>
        <a class="action-btn" href="${safeVideoUrl}" target="_blank" rel="noopener">Download</a>` : ""}
        ${s.live ? `<a class="action-btn primary" href="/session/${encodeURIComponent(s.sessionId)}">Watch Live</a>` : ""}
        ${shareBtn}
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
