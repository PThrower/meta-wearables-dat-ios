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

// Connection overlay elements
const connOverlay = document.getElementById("connectionOverlay")!;
const connSpinner = document.getElementById("connSpinner")!;
const connStatus = document.getElementById("connStatus")!;
const connDetail = document.getElementById("connDetail")!;

// Info panel elements
const infoPanel = document.getElementById("infoPanel")!;
const infoPanelToggle = document.getElementById("infoPanelToggle")!;
const siStrip = document.getElementById("sessionInfoStrip")!;
const siDevice = document.getElementById("si-device")!;
const siWearable = document.getElementById("si-wearable")!;
const siUptime = document.getElementById("si-uptime")!;
const siViewers = document.getElementById("si-viewers")!;
const siRecRow = document.getElementById("si-rec-row")!;

// Info panel toggle
infoPanelToggle.addEventListener("click", () => {
  infoPanel.classList.toggle("open");
  infoPanelToggle.classList.toggle("active");
});

let uptimeInterval: ReturnType<typeof setInterval> | null = null;
let sessionConnectedAt = 0;

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
    onAudioState: (s) => {
      document.getElementById("p-audio")!.textContent = s;
    },
    onAudioLevel: (pct) => meterFill.style.width = pct + "%",
    onNeedUnmute: () => document.getElementById("unmute")!.classList.add("show"),
    onAuthRequired: () => {
      pendingReauth = { sessionId, shareToken };
      closeLive();
      requireAuth();
    },
    onConnectionState: (state) => handleConnectionState(state),
    onStatus: (status) => handleConnectionStatus(status),
    onBandwidth: (bytesPerSec) => {
      const kb = Math.round(bytesPerSec / 1024);
      const quality = bytesPerSec > 500_000 ? "good" : bytesPerSec > 200_000 ? "ok" : "low";
      const el = document.getElementById("p-size")!;
      el.title = `Bandwidth: ${kb} KB/s (${quality})`;
    },
    onBackpressureFps: (targetFps) => {
      const el = document.getElementById("p-fps")!;
      const current = el.textContent || "--";
      el.title = `Delivered: ${current} / Target: ${targetFps} FPS`;
    },
    onAudioCodec: (codecType) => {
      const map: Record<number, string> = { 0: "Phone Mic", 1: "Glasses Mic", 2: "TTS", 3: "Relay In" };
      document.getElementById("p-audio")!.textContent = map[codecType] ?? `Codec ${codecType}`;
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

    // Session info from server
    if (msg.type === "session_info") {
      handleSessionInfo(msg as Record<string, unknown>);
    }

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

// --- Connection overlay handlers ---

function handleConnectionState(state: string): void {
  switch (state) {
    case "connected":
      connOverlay.classList.add("hidden");
      break;
    case "reconnecting":
      connOverlay.classList.remove("hidden");
      connSpinner.classList.remove("hidden");
      connStatus.textContent = "Reconnecting...";
      connStatus.className = "connection-status";
      connDetail.textContent = "";
      break;
    case "error":
      connOverlay.classList.remove("hidden");
      connSpinner.classList.add("hidden");
      connStatus.textContent = "Connection Error";
      connStatus.className = "connection-status error";
      break;
    case "disconnected":
      // Handled via reconnecting state immediately after
      break;
  }
}

function handleConnectionStatus(status: string): void {
  if (status === "AUTH REQUIRED") {
    connOverlay.classList.remove("hidden");
    connSpinner.classList.add("hidden");
    connStatus.textContent = "Authentication Required";
    connStatus.className = "connection-status error";
    connDetail.textContent = "Please sign in to access this stream.";
  } else if (status === "ACCESS DENIED") {
    connOverlay.classList.remove("hidden");
    connSpinner.classList.add("hidden");
    connStatus.textContent = "Access Denied";
    connStatus.className = "connection-status error";
    connDetail.textContent = "You do not have permission to view this stream.";
  }
}

// --- Session info strip handler ---

function handleSessionInfo(msg: Record<string, unknown>): void {
  siStrip.classList.remove("hidden");

  const device = [msg.deviceName, msg.deviceModel].filter(Boolean).join(" / ") as string || "Unknown Device";
  siDevice.textContent = device;

  const wt = msg.wearableType as string | undefined;
  siWearable.textContent = wt ? wt.replace(/-/g, " ") : "";
  siWearable.classList.toggle("hidden", !wt);

  const vc = msg.viewerCount as number | undefined;
  if (vc != null) siViewers.textContent = `${vc} viewer${vc !== 1 ? "s" : ""}`;

  const rec = msg.recording as boolean | undefined;
  siRecRow.classList.toggle("hidden", !rec);

  const connectedAt = msg.connectedAt as number | undefined;
  if (connectedAt && connectedAt > 0) {
    sessionConnectedAt = connectedAt;
    if (!uptimeInterval) {
      updateUptime();
      uptimeInterval = setInterval(updateUptime, 1000);
    }
  }
}

function updateUptime(): void {
  if (!sessionConnectedAt) return;
  const elapsed = Math.floor((Date.now() - sessionConnectedAt) / 1000);
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = elapsed % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  siUptime.textContent = h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function closeLive(): void {
  document.getElementById("livePlayer")!.classList.remove("active");
  document.getElementById("unmute")!.classList.remove("show");
  document.getElementById("gallery")!.classList.remove("hidden");
  connOverlay.classList.add("hidden");
  infoPanel.classList.remove("open");
  infoPanelToggle.classList.remove("active");
  siStrip.classList.add("hidden");
  if (uptimeInterval) { clearInterval(uptimeInterval); uptimeInterval = null; }
  sessionConnectedAt = 0;
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
