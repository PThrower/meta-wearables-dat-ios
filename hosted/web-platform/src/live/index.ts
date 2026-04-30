/**
 * Live player controls — open/close live stream, quality, audio resume, AI guidance.
 * Composes: state, controls, message-handler, connection-overlay, session-info, toast,
 *           activity-bar, bottom-panel, split-resize, status-bar.
 */

import { RelayPlayer } from "../player/relay-player.js";
import { GuidancePanel } from "../guidance.js";
import { requireAuth, getToken } from "../auth.js";
import {
  getPlayer, setPlayer,
  getGuidancePanel, setGuidancePanel,
  setCurrentSessionId, setCurrentDeviceId,
  getUptimeInterval, setUptimeInterval,
  setSessionConnectedAt,
  getPendingReauth, setPendingReauth,
} from "./state.js";
import { showToast, setPill } from "./toast.js";
import { setMicActive, resetAudioControls } from "./controls.js";
import { siStrip } from "./session-info.js";
import { handleConnectionState, handleConnectionStatus } from "./connection-overlay.js";
import { wireMessageHandler } from "./message-handler.js";
import { MiniWorkflowEditor } from "./mini-editor.js";
import { ActivityBar } from "./activity-bar.js";
import { BottomPanel } from "./bottom-panel.js";
import { SplitResize } from "./split-resize.js";
import { initStatusBarSync, syncStatusBar } from "./status-bar.js";

const meterFill = document.getElementById("audio-meter-fill")!;
const pubPill = document.getElementById("p-publisher")!;
let miniEditor: MiniWorkflowEditor | null = null;
let activityBar: ActivityBar | null = null;
let bottomPanel: BottomPanel | null = null;
let splitResize: SplitResize | null = null;

// Re-auth state: when WS closes with 401, store session for post-login replay
export function getPendingLiveSession() { return getPendingReauth(); }
export function clearPendingLiveSession() { setPendingReauth(null); }

/**
 * Open a live stream viewer for the given session.
 * @returns true if auth was required (caller should store sessionId for post-login replay)
 */
export function watchLive(sessionId: string, shareToken?: string): boolean {
  console.log("[watchLive] called -- sessionId:", sessionId, "shareToken:", !!shareToken);
  try {
    return _watchLiveInner(sessionId, shareToken);
  } catch (err) {
    console.error("[watchLive] FATAL -- uncaught error:", err);
    showToast("Failed to open live stream -- see console", "error");
    return false;
  }
}

function _watchLiveInner(sessionId: string, shareToken?: string): boolean {
  const authNeeded = requireAuth();
  console.log("[watchLive] requireAuth() =", authNeeded);
  if (authNeeded) return true;
  setCurrentSessionId(sessionId);

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  let wsUrl = `${proto}//${location.host}/view?session=${encodeURIComponent(sessionId)}`;
  if (shareToken) wsUrl += `&share=${encodeURIComponent(shareToken)}`;

  const existingPlayer = getPlayer();
  if (existingPlayer) { existingPlayer.destroy(); setPlayer(null); }

  document.getElementById("p-fps")!.textContent = "--";
  document.getElementById("p-size")!.textContent = "--";
  document.getElementById("p-latency")!.textContent = "--";
  document.getElementById("p-drop")!.textContent = "--";
  document.getElementById("p-audio")!.textContent = "OFF";
  setMicActive("phone");
  meterFill.style.width = "0%";
  document.getElementById("unmute")!.classList.remove("show");
  setPill(pubPill, "PUB WAIT", "status-off");
  setPill(document.getElementById("p-ai")!, "AI OFF", "status-off");

  const player = new RelayPlayer({
    canvas: document.getElementById("liveCanvas") as HTMLCanvasElement,
    onFps: (fps) => { document.getElementById("p-fps")!.textContent = String(fps); syncStatusBar(); },
    onSize: (w, h) => { document.getElementById("p-size")!.textContent = `${w}x${h}`; syncStatusBar(); },
    onLatency: (ms) => { document.getElementById("p-latency")!.textContent = `${ms}ms`; syncStatusBar(); },
    onDropped: (c) => document.getElementById("p-drop")!.textContent = String(c),
    onAudioState: (s) => { document.getElementById("p-audio")!.textContent = s; syncStatusBar(); },
    onAudioLevel: (pct) => meterFill.style.width = pct + "%",
    onNeedUnmute: () => document.getElementById("unmute")!.classList.add("show"),
    onAuthRequired: () => {
      setPendingReauth({ sessionId, shareToken });
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
      syncStatusBar();
    },
  });
  setPlayer(player);

  // Wire guidance panel (now inside sidebar)
  const guidanceContainer = document.getElementById("guidancePanel")!;
  setGuidancePanel(null);
  const guidancePanel = new GuidancePanel(guidanceContainer, (msg) => {
    const p = getPlayer();
    if (p) p.sendJson(msg);
  });
  setGuidancePanel(guidancePanel);
  guidancePanel.loadApps();

  // Wire bbox overlay callbacks
  guidancePanel.setBboxCallback((boxes) => {
    const p = getPlayer();
    if (p) p.setBoundingBoxes(boxes ?? []);
  });
  guidancePanel.setOverlayToggleCallback((show) => {
    const p = getPlayer();
    if (p) p.setShowOverlays(show);
  });

  // Wire message handler
  wireMessageHandler(player, guidancePanel);

  // Wire mini workflow editor (now inside sidebar)
  const miniEditorContainer = document.getElementById("miniEditorPanel")!;
  miniEditor = new MiniWorkflowEditor(miniEditorContainer, guidancePanel, (msg) => {
    const p = getPlayer();
    if (p) p.sendJson(msg);
  });

  // Initialize activity bar, bottom panel, resize handles, status bar
  activityBar = new ActivityBar({
    onSectionChange: (section) => {
      if (section === "workflow" && miniEditor) {
        miniEditor.show();
      } else if (miniEditor) {
        miniEditor.hide();
      }
      syncStatusBar();
    },
  });

  bottomPanel = new BottomPanel();
  splitResize = new SplitResize();
  initStatusBarSync();

  // Forward node_states to mini editor
  const origOnJsonMessage = player.onJsonMessage;
  player.onJsonMessage = (msg) => {
    if (origOnJsonMessage) origOnJsonMessage(msg);
    if (msg.type === "node_states" && miniEditor) {
      miniEditor.updateNodeStates((msg as { nodes: import("../guidance.js").NodeState[] }).nodes);
    }
    // Forward transcription/debug events to bottom panel debug tab + mini editor debug-sink
    if (msg.type === "guidance_event" && miniEditor) {
      const evt = (msg as { event: { type: string; content: string; source: string } }).event;
      if (evt && (evt.type === "guidance.transcript" || evt.type === "guidance.transcription")) {
        miniEditor.pushDebugOutput(evt.source ?? "", evt.content ?? "");
        if (bottomPanel) bottomPanel.pushDebug(evt.source ?? "", evt.content ?? "");
      }
    }
  };

  // Hide page-content behind the player overlay
  console.log("[watchLive] showing overlay -- wsUrl:", wsUrl);
  document.getElementById("page-content")!.classList.add("hidden");
  document.getElementById("livePlayer")!.classList.add("active");
  player.connect(wsUrl, shareToken, getToken() || undefined);
  setTimeout(() => { const p = getPlayer(); if (p) p.sendJson({ type: "get_audio_config" }); }, 2000);
  return false;
}

export function closeLive(): void {
  document.getElementById("livePlayer")!.classList.remove("active");
  document.getElementById("unmute")!.classList.remove("show");
  document.getElementById("page-content")!.classList.remove("hidden");
  document.getElementById("connectionOverlay")!.classList.add("hidden");
  siStrip.classList.add("hidden");
  setMicActive("phone");
  resetAudioControls();
  const uptimeInt = getUptimeInterval();
  if (uptimeInt) { clearInterval(uptimeInt); setUptimeInterval(null); }
  setSessionConnectedAt(0);
  setCurrentDeviceId(null);
  setCurrentSessionId(null);
  const player = getPlayer();
  if (player) { player.destroy(); setPlayer(null); }
  const guidancePanel = getGuidancePanel();
  if (guidancePanel) { guidancePanel.destroy(); setGuidancePanel(null); }
  if (miniEditor) { miniEditor.destroy(); miniEditor = null; }
  if (activityBar) { activityBar.close(); activityBar = null; }
  if (splitResize) { splitResize = null; }
  if (bottomPanel) { bottomPanel = null; }

  // Reset telemetry
  ["t-relay-fps", "t-encode-ema", "t-relay-dropped"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = "--";
  });
  const linkEl = document.getElementById("t-link-state");
  if (linkEl) { linkEl.textContent = "--"; linkEl.style.color = ""; }
  const errEl = document.getElementById("t-errors");
  if (errEl) errEl.textContent = "0";
  const speakIn = document.getElementById("speakInput") as HTMLInputElement;
  if (speakIn) speakIn.value = "";

  // Reset status bar
  ["sb-fps", "sb-size", "sb-latency", "sb-audio", "sb-link", "sb-battery"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = "--";
  });
}

export function setQuality(preset: string): void {
  const player = getPlayer();
  if (player) player.setQuality(preset);
}

export function resumeAudio(): void {
  const player = getPlayer();
  if (player) {
    player.resumeAudio();
    document.getElementById("unmute")!.classList.remove("show");
  }
}

export { getPlayer } from "./state.js";
