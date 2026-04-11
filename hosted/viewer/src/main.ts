/**
 * Viewer entry point — gallery init, auth, auto-open session
 */

import { loadConfig } from "./config.js";
import { initAuth, requireAuth, authFetch } from "./auth.js";
import { ingest, initFilters, onCardAction } from "./gallery/render.js";
import { watchLive, closeLive, setQuality, resumeAudio, getPlayer, getPendingLiveSession, clearPendingLiveSession } from "./live.js";
import { playVideo, closeVideo, initVideoPlayerEvents } from "./recorded.js";
import "./share.js";

// Wire card action delegation
onCardAction((action, data) => {
  switch (action) {
    case "share":
      if (requireAuth()) return;
      (window as any).openShareDialog(data.sessionId);
      break;
    case "play":
      if (requireAuth()) return;
      playVideo(data.url);
      break;
  }
});

// Module-level state
let pendingSession: string | null = null;
let pendingShareToken: string | null = null;
let hasGalleryData = false;

// Wire button handlers
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

// Auth login handler
window.addEventListener("auth:login", () => {
  if (pendingSession) {
    watchLive(pendingSession, pendingShareToken ?? undefined);
    pendingSession = null;
    pendingShareToken = null;
  } else {
    const pending = getPendingLiveSession();
    if (pending) {
      clearPendingLiveSession();
      watchLive(pending.sessionId, pending.shareToken);
    } else if (!hasGalleryData) {
      fetchGallery();
    }
  }
});

// Auth logout handler
window.addEventListener("auth:logout", () => {
  hasGalleryData = false;
  const grid = document.getElementById("grid");
  if (grid) grid.innerHTML = "";
  const subtitle = document.getElementById("subtitle");
  if (subtitle) subtitle.textContent = "";
});

// Init filter buttons
initFilters();

// Init video player overlay click-to-close
initVideoPlayerEvents();

/** Auth-aware gallery fetch */
export async function fetchGallery(): Promise<void> {
  try {
    const res = await authFetch("/gallery/api");
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

// Derive session ID and share token from URL
function sessionIdFromUrl(): string | null {
  // /session/<id> path format
  const m = location.pathname.match(/^\/session\/([^/]+)$/);
  if (m) return m[1];
  // ?session=<id> query param
  return new URLSearchParams(location.search).get("session");
}

function shareTokenFromUrl(): string | null {
  return new URLSearchParams(location.search).get("share");
}

// Boot sequence
(async () => {
  await loadConfig();
  await initAuth();

  const sessionId = sessionIdFromUrl();
  const shareToken = shareTokenFromUrl();

  if (sessionId) {
    const authNeeded = watchLive(sessionId, shareToken ?? undefined);
    if (authNeeded) {
      pendingSession = sessionId;
      pendingShareToken = shareToken;
    }
  } else {
    fetchGallery();
  }
})();

// Background refresh every 30s
setInterval(fetchGallery, 30000);
