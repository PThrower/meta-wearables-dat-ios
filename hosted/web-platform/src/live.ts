/**
 * Live player controls — open/close live stream, quality, audio resume, AI guidance
 */

import { RelayPlayer } from "./player/relay-player.js";
import { GuidancePanel } from "./guidance.js";
import { requireAuth, getToken } from "./auth.js";

let player: RelayPlayer | null = null;
let guidancePanel: GuidancePanel | null = null;
const meterFill = document.getElementById("audio-meter-fill")!;
const pubPill = document.getElementById("p-publisher")!;
const aiPill = document.getElementById("p-ai")!;

// --- Toast notifications ---
function showToast(message: string, kind: "info" | "warn" | "error" = "info"): void {
  const container = document.getElementById("toastContainer");
  if (!container) return;
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function setPill(el: HTMLElement, text: string, cls: string): void {
  el.textContent = text;
  el.className = `status-pill ${cls}`;
}

export function getPlayer(): RelayPlayer | null { return player; }

// Re-auth state: when WS closes with 401, store session for post-login replay
let pendingReauth: { sessionId: string; shareToken?: string } | null = null;

export function getPendingLiveSession(): { sessionId: string; shareToken?: string } | null {
  return pendingReauth;
}

export function clearPendingLiveSession(): void {
  pendingReauth = null;
}

/**
 * Open a live stream viewer for the given session.
 * @returns true if auth was required (caller should store sessionId for post-login replay)
 */
export function watchLive(sessionId: string, shareToken?: string): boolean {
  if (requireAuth()) return true;

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  // No token in URL — auth is done via hello message (RelayPlayer includes it)
  let wsUrl = `${proto}//${location.host}/view?session=${encodeURIComponent(sessionId)}`;
  if (shareToken) wsUrl += `&share=${encodeURIComponent(shareToken)}`;

  if (player) { player.destroy(); player = null; }

  document.getElementById("p-fps")!.textContent = "--";
  document.getElementById("p-size")!.textContent = "--";
  document.getElementById("p-latency")!.textContent = "--";
  document.getElementById("p-drop")!.textContent = "--";
  document.getElementById("p-audio")!.textContent = "OFF";
  meterFill.style.width = "0%";
  document.getElementById("unmute")!.classList.remove("show");
  setPill(pubPill, "PUB WAIT", "status-off");
  setPill(aiPill, "AI OFF", "status-off");

  player = new RelayPlayer({
    canvas: document.getElementById("liveCanvas") as HTMLCanvasElement,
    onFps: (fps) => document.getElementById("p-fps")!.textContent = String(fps),
    onSize: (w, h) => document.getElementById("p-size")!.textContent = `${w}x${h}`,
    onLatency: (ms) => document.getElementById("p-latency")!.textContent = `${ms}ms`,
    onDropped: (c) => document.getElementById("p-drop")!.textContent = String(c),
    onAudioState: (s) => document.getElementById("p-audio")!.textContent = s,
    onAudioLevel: (pct) => meterFill.style.width = pct + "%",
    onNeedUnmute: () => document.getElementById("unmute")!.classList.add("show"),
    onAuthRequired: () => {
      pendingReauth = { sessionId, shareToken };
      closeLive();
      requireAuth();
    },
  });

  // Wire guidance panel
  const guidanceContainer = document.getElementById("guidancePanel")!;
  if (guidancePanel) {
    // Re-render into the same container if it already exists
    guidancePanel = null;
  }
  guidancePanel = new GuidancePanel(guidanceContainer, (msg) => {
    if (player) player.sendJson(msg);
  });
  guidancePanel.loadApps();

  // Wire bbox overlay callbacks: guidance panel -> relay player overlay canvas
  guidancePanel.setBboxCallback((boxes) => {
    if (player) player.setBoundingBoxes(boxes ?? []);
  });
  guidancePanel.setOverlayToggleCallback((show) => {
    if (player) player.setShowOverlays(show);
  });

  player.onJsonMessage = (msg) => {
    if (guidancePanel) guidancePanel.handleMessage(msg);

    // Publisher status
    if (msg.type === "publisher_status") {
      const s = (msg as { status: string }).status;
      if (s === "live") {
        setPill(pubPill, "PUB LIVE", "status-live");
        showToast("Publisher connected", "info");
      } else if (s === "dropped") {
        setPill(pubPill, "PUB DROP", "status-error");
        showToast("Publisher disconnected", "warn");
      }
    }

    // AI status
    if (msg.type === "ai_status") {
      const s = (msg as { status: { status: string } }).status?.status;
      if (s === "active" || s === "connected") {
        setPill(aiPill, "AI ON", "status-active");
      } else if (s === "error") {
        setPill(aiPill, "AI ERR", "status-error");
        showToast("AI service error", "error");
      } else if (s === "rate_limited") {
        setPill(aiPill, "AI RATE", "status-warn");
      } else if (s === "activating") {
        setPill(aiPill, "AI ...", "status-warn");
      } else {
        setPill(aiPill, "AI OFF", "status-off");
      }
    }
  };

  document.getElementById("gallery")!.classList.add("hidden");
  document.getElementById("livePlayer")!.classList.add("active");
  // Pass token separately — RelayPlayer includes it in the hello message
  player.connect(wsUrl, shareToken, getToken() || undefined);
  return false;
}

export function closeLive(): void {
  document.getElementById("livePlayer")!.classList.remove("active");
  document.getElementById("unmute")!.classList.remove("show");
  document.getElementById("gallery")!.classList.remove("hidden");
  if (player) { player.destroy(); player = null; }
  guidancePanel = null;
}

export function setQuality(preset: string): void {
  if (player) player.setQuality(preset);
}

export function resumeAudio(): void {
  if (player) {
    player.resumeAudio();
    document.getElementById("unmute")!.classList.remove("show");
  }
}
