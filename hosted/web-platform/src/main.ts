/**
 * Viewer entry point — SPA router, auth, auto-open session
 */

import { loadConfig } from "./config.js";
import { initAuth, requireAuth, isNoAuth, getToken } from "./auth.js";
import { watchLive, closeLive, setQuality, resumeAudio, getPlayer, getPendingLiveSession, clearPendingLiveSession } from "./live/index.js";
import { openRecordedPlayer, closeRecordedPlayer, initRecordedPlayerEvents } from "./recorded.js";
import { Router } from "./router/router.js";
import { routes } from "./router/routes.js";
import { initSidebar, initTheme } from "./components/sidebar.js";
import { bus } from "./core/event-bus.js";
import "./share.js";

// ─── SPA Router Setup ───

const pageContent = document.getElementById("page-content")!;
const sidebar = document.getElementById("sidebar")!;

const router = new Router(pageContent, (path) => {
  bus.emit("route:changed", { path, params: {} });
});

// All routes including "/" (dashboard)
router.addRoutes(routes);

// Init sidebar
const cleanupSidebar = initSidebar(sidebar, location.hash.slice(1) || "/");

// ─── Button handlers ───

let pendingSession: string | null = null;
let pendingShareToken: string | null = null;

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
    }
  }
});

// Init video player overlay events
initRecordedPlayerEvents();

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

initTheme();

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

  // Start the router — handles "/" as dashboard, all SPA routes, and "/play/*"
  router.start();
})();
