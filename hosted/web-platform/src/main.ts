/**
 * Viewer entry point — SPA router, gallery init, auth, auto-open session
 */

import { loadConfig } from "./config.js";
import { initAuth, requireAuth, authFetch, isNoAuth, getToken } from "./auth.js";
import { ingest, clearGallery, initFilters, onCardAction } from "./gallery/render.js";
import { watchLive, closeLive, setQuality, resumeAudio, getPlayer, getPendingLiveSession, clearPendingLiveSession } from "./live.js";
import { openRecordedPlayer, closeRecordedPlayer, initRecordedPlayerEvents } from "./recorded.js";
import { Router } from "./router/router.js";
import { routes } from "./router/routes.js";
import { initSidebar } from "./components/sidebar.js";
import { bus } from "./core/event-bus.js";
import "./share.js";

// ─── SPA Router Setup ───

const gallery = document.getElementById("gallery")!;
const pageContent = document.getElementById("page-content")!;
const sidebar = document.getElementById("sidebar")!;

// Show gallery by default, hide page-content
function showGallery(): void {
  gallery.classList.remove("hidden");
  pageContent.classList.add("hidden");
}

function showPageContent(): void {
  gallery.classList.add("hidden");
  pageContent.classList.remove("hidden");
}

// Override router page loading to handle gallery vs SPA pages
const router = new Router(pageContent, (path) => {
  bus.emit("route:changed", { path, params: {} });
});

// The "/" route is handled specially — it shows the gallery
// Other routes render SPA pages
const spaRoutes = routes.filter((r) => r.path !== "/");
router.addRoutes(spaRoutes);

// Handle "/" by showing gallery, other routes by SPA
function handleRoute(): void {
  const path = location.hash.slice(1) || "/";
  if (path === "/" || path === "") {
    showGallery();
    // Load gallery data if not already loaded
    if (!hasGalleryData) fetchGallery();
  } else if (path.startsWith("/play/")) {
    // Direct play route — open recorded player
    const sessionId = path.slice(6);
    if (sessionId) openRecordedPlayer(sessionId);
    showGallery();
  } else {
    showPageContent();
  }
}

window.addEventListener("hashchange", () => {
  handleRoute();
});

// Init sidebar
const cleanupSidebar = initSidebar(sidebar, location.hash.slice(1) || "/");

// ─── Existing functionality (preserved) ───

// Wire card action delegation
onCardAction((action, data) => {
  switch (action) {
    case "share":
      if (requireAuth()) return;
      (window as any).openShareDialog(data.sessionId);
      break;
    case "play":
      if (requireAuth()) return;
      if (data.live === "true") {
        watchLive(data.sessionId);
      } else {
        openRecordedPlayer(data.sessionId);
      }
      break;
  }
});

// Module-level state
let pendingSession: string | null = null;
let pendingShareToken: string | null = null;
let hasGalleryData = false;

// Wire button handlers
document.getElementById("backBtn")!.addEventListener("click", closeLive);
document.getElementById("recBackBtn")!.addEventListener("click", closeRecordedPlayer);
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
pttBtn.addEventListener("contextmenu", (e) => e.preventDefault());

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
    } else {
      fetchGallery();
    }
  }
});

// Auth logout handler
window.addEventListener("auth:logout", () => {
  hasGalleryData = false;
  clearGallery();
});

// Init filter buttons
initFilters();

// Init video player overlay events
initRecordedPlayerEvents();

/** Auth-aware gallery fetch */
export async function fetchGallery(): Promise<void> {
  if (!isNoAuth() && !getToken()) {
    requireAuth();
    return;
  }
  try {
    const res = await authFetch("/gallery/api");
    if (!res.ok) {
      if (res.status !== 401) showNetworkError(`Server error ${res.status}`);
      return;
    }
    const data = await res.json();
    clearNetworkError();
    ingest(data);
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
  const m = location.pathname.match(/^\/session\/([^/]+)$/);
  if (m) return m[1];
  return new URLSearchParams(location.search).get("session");
}

function shareTokenFromUrl(): string | null {
  return new URLSearchParams(location.search).get("share");
}

// ─── Boot sequence ───

(async () => {
  await loadConfig();
  await initAuth();

  const sessionId = sessionIdFromUrl();
  const shareToken = shareTokenFromUrl();

  console.log("[boot] sessionId:", sessionId, "shareToken:", !!shareToken, "token:", !!getToken(), "noAuth:", isNoAuth());

  // If a specific session is in the URL, open it directly
  if (sessionId) {
    const authNeeded = watchLive(sessionId, shareToken ?? undefined);
    if (authNeeded) {
      pendingSession = sessionId;
      pendingShareToken = shareToken;
    }
    return;
  }

  // SPA routing: if hash is set, use router; otherwise default to gallery
  const hash = location.hash.slice(1);
  if (hash && hash !== "/") {
    handleRoute();
  } else {
    // Default: show gallery
    showGallery();
    if (!requireAuth()) {
      fetchGallery();
    }
  }

  // Start the router (listens for hash changes)
  router.start();
})();

// Background refresh every 30s (gallery only when visible)
setInterval(() => {
  if (!gallery.classList.contains("hidden")) {
    fetchGallery();
  }
}, 30000);
