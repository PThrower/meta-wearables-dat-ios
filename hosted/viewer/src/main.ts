/**
 * Viewer entry point — gallery init, auth, auto-open session
 */

import { initAuth, requireAuth } from "./auth.js";
import { ingest, initFilters, onCardAction } from "./gallery/render.js";
import { watchLive, closeLive, setQuality, resumeAudio, getPlayer } from "./live.js";
import { playVideo, closeVideo, initVideoPlayerEvents } from "./recorded.js";
import "./share.js";

// Wire card action delegation (replaces all inline onclick in rendered HTML)
onCardAction((action, data) => {
  switch (action) {
    case "share":
      (window as any).openShareDialog(data.sessionId);
      break;
    case "play":
      playVideo(data.url);
      break;
  }
});

// Init auth (GIS client ID setup)
initAuth();

// Init filter buttons
initFilters();

// Init video player overlay click-to-close
initVideoPlayerEvents();

// Wire up button handlers
document.getElementById("backBtn")!.addEventListener("click", closeLive);
document.getElementById("closeVideoBtn")!.addEventListener("click", closeVideo);
document.getElementById("unmute")!.addEventListener("click", resumeAudio);
document.getElementById("quality-select")!.addEventListener("change", (e) => {
  setQuality((e.target as HTMLSelectElement).value);
});

// Push-to-talk mic capture
const pttBtn = document.getElementById("ptt-btn")!;

function pttStart(): void {
  const player = getPlayer();
  if (!player) return;
  pttBtn.classList.add("active");
  player.startMic().catch((err) => {
    console.warn("[PTT] Mic start failed:", err);
    pttBtn.classList.remove("active");
  });
}

function pttStop(): void {
  const player = getPlayer();
  if (player) player.stopMic();
  pttBtn.classList.remove("active");
}

pttBtn.addEventListener("mousedown", (e) => { e.preventDefault(); pttStart(); });
pttBtn.addEventListener("touchstart", (e) => { e.preventDefault(); pttStart(); });
pttBtn.addEventListener("mouseup", pttStop);
pttBtn.addEventListener("mouseleave", pttStop);
pttBtn.addEventListener("touchend", pttStop);
pttBtn.addEventListener("touchcancel", pttStop);

// Auth login handler — dispatch from auth.ts
window.addEventListener("auth:login", () => {
  if (pendingSession) {
    watchLive(pendingSession);
    pendingSession = null;
  } else if (!hasGalleryData) {
    fetchGallery();
  }
});

// Module-level state (replaces window globals where possible)
let pendingSession: string | null = null;
let hasGalleryData = false;

// Auto-open session if provided
function autoOpenSession(): boolean {
  const sessionId = (window as any).__SESSION_ID
    || new URLSearchParams(location.search).get("session");
  if (sessionId) {
    watchLive(sessionId);
    return true;
  }
  return false;
}

// Ingest server-injected gallery data
if ((window as any).__GALLERY_DATA) {
  ingest((window as any).__GALLERY_DATA);
  hasGalleryData = true;
}

/** Auth-aware gallery fetch with Bearer token */
export async function fetchGallery(): Promise<void> {
  try {
    const token = localStorage.getItem("relay_token");
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch("/gallery/api", { headers });
    if (res.status === 401) {
      requireAuth();
      return;
    }
    if (!res.ok) {
      showNetworkError(`Server error ${res.status}`);
      return;
    }
    clearNetworkError();
    ingest(await res.json());
    hasGalleryData = true;
  } catch (err) {
    showNetworkError("Network error — relay server unreachable");
    console.warn("[gallery] fetch failed:", err);
  }
}

function showNetworkError(msg: string): void {
  let el = document.getElementById("network-error");
  if (!el) {
    el = document.createElement("div");
    el.id = "network-error";
    el.className = "network-error";
    const status = document.getElementById("status-bar");
    status?.parentNode?.insertBefore(el, status);
  }
  el.textContent = msg;
  el.classList.add("show");
}

function clearNetworkError(): void {
  const el = document.getElementById("network-error");
  if (el) el.classList.remove("show");
}

// Auto-open or show gallery
if (!autoOpenSession()) {
  if (!hasGalleryData) fetchGallery();
}

// Handle share token from URL
const shareToken = (window as any).__SHARE_TOKEN || new URLSearchParams(location.search).get("share");
if (shareToken) {
  (window as any).__SHARE_TOKEN = shareToken;
}

// Background refresh every 30s
setInterval(fetchGallery, 30000);
