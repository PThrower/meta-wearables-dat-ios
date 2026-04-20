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

// Mic selector buttons
const micSelector = document.getElementById("micSelector")!;
function setMicActive(mode: string): void {
  micSelector.querySelectorAll(".mic-btn").forEach((btn) => {
    btn.classList.toggle("active", (btn as HTMLElement).dataset.mode === mode);
  });
}
micSelector.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest(".mic-btn") as HTMLElement | null;
  if (!btn?.dataset.mode) return;
  if (btn.classList.contains("active")) return;
  if (!player) return;
  player.sendJson({ type: "set_audio_mode", mode: btn.dataset.mode });
});

// Control buttons
document.getElementById("btnCapture")!.addEventListener("click", () => {
  if (player) player.sendJson({ type: "capture_photo" });
});
document.getElementById("btnRecStart")!.addEventListener("click", () => {
  if (player) player.sendJson({ type: "start_recording" });
});
document.getElementById("btnRecStop")!.addEventListener("click", () => {
  if (player) player.sendJson({ type: "stop_recording" });
});
document.getElementById("btnStreamStart")!.addEventListener("click", () => {
  if (player) player.sendJson({ type: "start_stream" });
});
document.getElementById("btnStreamStop")!.addEventListener("click", () => {
  if (player) player.sendJson({ type: "stop_stream" });
});
document.getElementById("btnSpeak")!.addEventListener("click", () => {
  const input = document.getElementById("speakInput") as HTMLInputElement;
  const text = input.value.trim();
  if (text && player) {
    player.sendJson({ type: "speak_text", text });
    input.value = "";
  }
});
document.getElementById("speakInput")!.addEventListener("keydown", (e) => {
  if ((e as KeyboardEvent).key === "Enter") {
    document.getElementById("btnSpeak")!.click();
  }
});

// --- Wake Device (APNs push) ---
document.getElementById("btnWakeDevice")!.addEventListener("click", async () => {
  const wakeStatus = document.getElementById("wakeStatus")!;
  if (!currentDeviceId) {
    wakeStatus.textContent = "No device";
    wakeStatus.style.color = "#ff5555";
    return;
  }
  wakeStatus.textContent = "Waking...";
  wakeStatus.style.color = "#8be9fd";
  try {
    const res = await fetch("/api/wake-device", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: currentDeviceId }),
    });
    const data = await res.json();
    if (data.ok) {
      wakeStatus.textContent = data.status === "already_connected" ? "Already online" : "Push sent";
      wakeStatus.style.color = "#50fa7b";
    } else {
      wakeStatus.textContent = data.error || "Failed";
      wakeStatus.style.color = "#ff5555";
    }
  } catch {
    wakeStatus.textContent = "Network error";
    wakeStatus.style.color = "#ff5555";
  }
  setTimeout(() => { wakeStatus.textContent = ""; }, 5000);
});

// --- Audio processing controls ---
const gainPhoneSlider = document.getElementById("gainPhone") as HTMLInputElement;
const gainGlassesSlider = document.getElementById("gainGlasses") as HTMLInputElement;
const gainPhoneVal = document.getElementById("gainPhoneVal")!;
const gainGlassesVal = document.getElementById("gainGlassesVal")!;
const noiseGateSlider = document.getElementById("noiseGateThreshold") as HTMLInputElement;
const noiseGateVal = document.getElementById("noiseGateVal")!;
const btnNoiseSuppress = document.getElementById("btnNoiseSuppress") as HTMLButtonElement;
let noiseSuppressEnabled = false;

gainPhoneSlider.addEventListener("input", () => {
  const db = Number(gainPhoneSlider.value);
  gainPhoneVal.textContent = `${db > 0 ? "+" : ""}${db}dB`;
  if (player) player.sendJson({ type: "set_audio_gain", codecType: 0, gainDb: db });
});
gainGlassesSlider.addEventListener("input", () => {
  const db = Number(gainGlassesSlider.value);
  gainGlassesVal.textContent = `${db > 0 ? "+" : ""}${db}dB`;
  if (player) player.sendJson({ type: "set_audio_gain", codecType: 1, gainDb: db });
});
noiseGateSlider.addEventListener("input", () => {
  const val = Number(noiseGateSlider.value);
  noiseGateVal.textContent = val === 0 ? "OFF" : val.toFixed(3);
  // Apply to both sources
  if (player) {
    player.sendJson({ type: "set_noise_gate", codecType: 0, threshold: val });
    player.sendJson({ type: "set_noise_gate", codecType: 1, threshold: val });
  }
});
btnNoiseSuppress.addEventListener("click", () => {
  noiseSuppressEnabled = !noiseSuppressEnabled;
  btnNoiseSuppress.textContent = noiseSuppressEnabled ? "ON" : "OFF";
  btnNoiseSuppress.classList.toggle("ctrl-btn-start", noiseSuppressEnabled);
  btnNoiseSuppress.classList.toggle("ctrl-btn-stop", !noiseSuppressEnabled);
  if (player) {
    player.sendJson({ type: "set_noise_suppression", codecType: 0, enabled: noiseSuppressEnabled });
    player.sendJson({ type: "set_noise_suppression", codecType: 1, enabled: noiseSuppressEnabled });
  }
});

function resetAudioControls(): void {
  gainPhoneSlider.value = "0";
  gainGlassesSlider.value = "0";
  gainPhoneVal.textContent = "0dB";
  gainGlassesVal.textContent = "0dB";
  noiseGateSlider.value = "0";
  noiseGateVal.textContent = "OFF";
  noiseSuppressEnabled = false;
  btnNoiseSuppress.textContent = "OFF";
  btnNoiseSuppress.classList.remove("ctrl-btn-start");
  btnNoiseSuppress.classList.add("ctrl-btn-stop");
}

let uptimeInterval: ReturnType<typeof setInterval> | null = null;
let sessionConnectedAt = 0;
let currentDeviceId: string | null = null;

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
  setMicActive("phone");
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
        showToast("Publisher streaming", "info");
      } else if (s === "standby") {
        setPill(pubPill, "PUB READY", "status-standby");
        showToast("Publisher ready (standby)", "info");
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

    // Audio mode changed (from publisher via server)
    if (msg.type === "audio_mode_changed") {
      const mode = (msg as { mode: string }).mode;
      setMicActive(mode);
    }

    // Photo captured
    if (msg.type === "photo_captured") {
      showToast("Photo captured", "info");
    }

    // Recording changed
    if (msg.type === "recording_changed") {
      const rec = (msg as { recording: boolean }).recording;
      showToast(rec ? "Recording started" : "Recording stopped", "info");
      siRecRow.classList.toggle("hidden", !rec);
    }

    // Stream changed
    if (msg.type === "stream_changed") {
      showToast((msg as { streaming: boolean }).streaming ? "Stream started" : "Stream stopped", "info");
    }

    // Spoken text confirmation
    if (msg.type === "spoken_text") {
      showToast("Spoken: " + ((msg as { text: string }).text ?? "").slice(0, 40), "info");
    }

    // Publisher telemetry
    if (msg.type === "publisher_telemetry") {
      const frame = (msg as Record<string, unknown>).frame as Record<string, unknown> | undefined;
      const relay = (msg as Record<string, unknown>).relay as Record<string, unknown> | undefined;
      const errors = (msg as Record<string, unknown>).errors as Record<string, unknown> | undefined;
      if (relay) {
        const el1 = document.getElementById("t-relay-fps");
        const el2 = document.getElementById("t-encode-ema");
        const el3 = document.getElementById("t-relay-dropped");
        if (el1) el1.textContent = String(typeof frame?.fps === "number" ? (frame.fps as number).toFixed(1) : "--");
        if (el2) el2.textContent = ((relay.encodeTimeEmaMs as number) ?? 0).toFixed(1) + "ms";
        if (el3) el3.textContent = String(relay.framesDropped ?? "--");
      }
      if (errors) {
        const el = document.getElementById("t-errors");
        if (el) el.textContent = String(errors.total ?? 0);
      }
    }

    // BT link state changed
    if (msg.type === "link_state_changed") {
      const el = document.getElementById("t-link-state");
      if (el) {
        const state = (msg as { state: string }).state ?? "unknown";
        el.textContent = state;
        el.style.color = state === "connected" ? "#50fa7b" : "#ff5555";
      }
    }

    // Publisher error
    if (msg.type === "publisher_error") {
      const error = (msg as { error: string }).error;
      showToast("Publisher error: " + (error ?? "").slice(0, 60), "error");
    }

    // Audio config response — sync UI with publisher state
    if (msg.type === "audio_config") {
      const cfg = msg as Record<string, unknown>;
      const gd = cfg.gainDb as Record<string, number> | undefined;
      const ng = cfg.noiseGate as Record<string, number> | undefined;
      const ns = cfg.noiseSuppression as Record<string, boolean> | undefined;
      if (gd) {
        const phoneDb = gd["0"] ?? 0;
        const glassesDb = gd["1"] ?? 0;
        gainPhoneSlider.value = String(phoneDb);
        gainGlassesSlider.value = String(glassesDb);
        gainPhoneVal.textContent = `${phoneDb > 0 ? "+" : ""}${phoneDb}dB`;
        gainGlassesVal.textContent = `${glassesDb > 0 ? "+" : ""}${glassesDb}dB`;
      }
      if (ng) {
        const threshold = ng["0"] ?? 0;
        noiseGateSlider.value = String(threshold);
        noiseGateVal.textContent = threshold === 0 ? "OFF" : threshold.toFixed(3);
      }
      if (ns) {
        noiseSuppressEnabled = ns["0"] ?? false;
        btnNoiseSuppress.textContent = noiseSuppressEnabled ? "ON" : "OFF";
      }
    }
  };

  document.getElementById("gallery")!.classList.add("hidden");
  document.getElementById("livePlayer")!.classList.add("active");
  // Pass token separately — RelayPlayer includes it in the hello message
  player.connect(wsUrl, shareToken, getToken() || undefined);
  // Request current audio config from publisher after connect
  setTimeout(() => { if (player) player.sendJson({ type: "get_audio_config" }); }, 2000);
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

  // Capture device ID for wake-device push
  const devId = msg.deviceId as string | undefined;
  if (devId) currentDeviceId = devId;

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

  const appVer = msg.appVersion as string | undefined;
  const buildNum = msg.buildNumber as string | undefined;
  const appEl = document.getElementById("si-app");
  const buildEl = document.getElementById("si-build");
  if (appEl) appEl.textContent = appVer ?? "--";
  if (buildEl) buildEl.textContent = buildNum ?? "--";

  // Link state from session snapshot
  const ls = msg.linkState as string | undefined;
  if (ls) {
    const el = document.getElementById("t-link-state");
    if (el) {
      el.textContent = ls;
      el.style.color = ls === "connected" ? "#50fa7b" : "#ff5555";
    }
  }

  // Publisher status from session snapshot
  const ps = msg.publisherStatus as string | undefined;
  if (ps) {
    if (ps === "live") {
      setPill(pubPill, "PUB LIVE", "status-live");
    } else if (ps === "standby") {
      setPill(pubPill, "PUB READY", "status-standby");
    } else {
      setPill(pubPill, "PUB OFF", "status-off");
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
  setMicActive("phone");
  resetAudioControls();
  if (uptimeInterval) { clearInterval(uptimeInterval); uptimeInterval = null; }
  sessionConnectedAt = 0;
  currentDeviceId = null;
  if (player) { player.destroy(); player = null; }
  guidancePanel = null;

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
