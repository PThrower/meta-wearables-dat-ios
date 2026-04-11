/**
 * Live player controls — open/close live stream, quality, audio resume
 */

import { RelayPlayer } from "./player/relay-player.js";
import { requireAuth } from "./auth.js";

let player: RelayPlayer | null = null;
const meterFill = document.getElementById("audio-meter-fill")!;

export function getPlayer(): RelayPlayer | null { return player; }

export function watchLive(sessionId: string): void {
  if (requireAuth()) {
    (window as any).__pendingSession = sessionId;
    return;
  }

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const token = localStorage.getItem("relay_token") || "";
  const wsUrl = `${proto}//${location.host}/view?session=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token)}`;

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
  });

  document.getElementById("gallery")!.classList.add("hidden");
  document.getElementById("livePlayer")!.classList.add("active");
  player.connect(wsUrl);
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

export function startMic(): void {
  if (player) player.startMic();
}

export function stopMic(): void {
  if (player) player.stopMic();
}
