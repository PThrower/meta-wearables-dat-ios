/**
 * Live player controls — open/close live stream, quality, audio resume
 */

import { RelayPlayer } from "./player/relay-player.js";
import { requireAuth, getToken } from "./auth.js";

let player: RelayPlayer | null = null;
const meterFill = document.getElementById("audio-meter-fill")!;

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
  const authToken = getToken() || "";
  // Server reads token from URL during WebSocket upgrade via extractToken()
  let wsUrl = `${proto}//${location.host}/view?session=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(authToken)}`;
  if (shareToken) wsUrl += `&share=${encodeURIComponent(shareToken)}`;

  if (player) { player.destroy(); player = null; }

  document.getElementById("p-fps")!.textContent = "--";
  document.getElementById("p-size")!.textContent = "--";
  document.getElementById("p-latency")!.textContent = "--";
  document.getElementById("p-drop")!.textContent = "--";
  document.getElementById("p-audio")!.textContent = "OFF";
  meterFill.style.width = "0%";
  document.getElementById("unmute")!.classList.remove("show");

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

  document.getElementById("gallery")!.classList.add("hidden");
  document.getElementById("livePlayer")!.classList.add("active");
  player.connect(wsUrl, shareToken);
  return false;
}

export function closeLive(): void {
  document.getElementById("livePlayer")!.classList.remove("active");
  document.getElementById("unmute")!.classList.remove("show");
  document.getElementById("gallery")!.classList.remove("hidden");
  if (player) { player.destroy(); player = null; }
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
