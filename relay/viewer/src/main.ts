/**
 * Viewer entry point — gallery init, auth, auto-open session
 */

import { initAuth } from "./auth.js";
import { ingest, initFilters } from "./gallery/render.js";
import { onThumbLoad } from "./gallery/format.js";
import { watchLive, closeLive, setQuality, resumeAudio } from "./live.js";
import { playVideo, closeVideo, initVideoPlayerEvents } from "./recorded.js";
import "./share.js";

// Expose functions needed by inline HTML handlers (card onclick/onload attributes)
(window as any).onThumbLoad = onThumbLoad;
(window as any).watchLive = watchLive;
(window as any).closeLive = closeLive;
(window as any).setQuality = setQuality;
(window as any).resumeAudio = resumeAudio;
(window as any).playVideo = playVideo;
(window as any).closeVideo = closeVideo;

// Init auth (GIS client ID setup)
initAuth();

// Init filter buttons
initFilters();

// Init video player overlay click-to-close
initVideoPlayerEvents();

// Wire up button handlers (replacing inline onclick in HTML)
document.getElementById("backBtn")!.addEventListener("click", closeLive);
document.getElementById("closeVideoBtn")!.addEventListener("click", closeVideo);
document.getElementById("unmute")!.addEventListener("click", resumeAudio);
document.getElementById("quality-select")!.addEventListener("change", (e) => {
  setQuality((e.target as HTMLSelectElement).value);
});

// Auth login handler — dispatch from auth.ts
window.addEventListener("auth:login", () => {
  if ((window as any).__pendingSession) {
    watchLive((window as any).__pendingSession);
    (window as any).__pendingSession = null;
  } else if (!(window as any).__GALLERY_DATA) {
    fetchGallery();
  }
});

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
if ((window as any).__GALLERY_DATA) ingest((window as any).__GALLERY_DATA);

/** Auth-aware gallery fetch with Bearer token */
export async function fetchGallery(): Promise<void> {
  try {
    const token = localStorage.getItem("relay_token");
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch("/gallery/api", { headers });
    if (res.status === 401) {
      // Token expired or missing — trigger re-auth
      const { requireAuth } = await import("./auth.js");
      requireAuth();
      return;
    }
    ingest(await res.json());
  } catch {}
}

// Auto-open or show gallery
if (!autoOpenSession()) {
  if (!(window as any).__GALLERY_DATA) fetchGallery();
}

// Handle share token from URL
const shareToken = (window as any).__SHARE_TOKEN || new URLSearchParams(location.search).get("share");
if (shareToken) {
  // Store for WebSocket connection
  (window as any).__SHARE_TOKEN = shareToken;
}

// Background refresh every 30s
setInterval(fetchGallery, 30000);
