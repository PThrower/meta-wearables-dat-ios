/**
 * Control wiring — mic/codec selectors, buttons, audio sliders.
 * Called once at player init. Info panel toggle is now handled by ActivityBar.
 */

import { getPlayer, getCurrentDeviceId, getCurrentSessionId } from "./state.js";

// --- Info panel toggle (removed — ActivityBar handles sidebar) ---
const infoPanel = document.getElementById("infoPanel")!;
const infoPanelToggle = document.createElement("div"); // dummy, not in DOM

// Collapsible section headers
document.querySelectorAll(".info-section-header").forEach((header) => {
  header.addEventListener("click", () => {
    const collapsible = header.closest(".info-collapsible") as HTMLElement;
    if (!collapsible) return;
    const isOpen = collapsible.classList.toggle("open");
    header.setAttribute("aria-expanded", String(isOpen));
  });
});

// --- Mic selector buttons ---
const micSelector = document.getElementById("micSelector")!;

export function setMicActive(mode: string): void {
  micSelector.querySelectorAll(".mic-btn").forEach((btn) => {
    btn.classList.toggle("active", (btn as HTMLElement).dataset.mode === mode);
  });
}

micSelector.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest(".mic-btn") as HTMLElement | null;
  if (!btn?.dataset.mode) return;
  if (btn.classList.contains("active")) return;
  const player = getPlayer();
  if (!player) return;
  player.sendJson({ type: "set_audio_mode", mode: btn.dataset.mode });
});

// --- Codec selector buttons ---
const codecSelector = document.getElementById("codecSelector")!;

export function setCodecActive(codec: string): void {
  codecSelector.querySelectorAll(".mic-btn").forEach((btn) => {
    btn.classList.toggle("active", (btn as HTMLElement).dataset.codec === codec);
  });
}

codecSelector.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest(".mic-btn") as HTMLElement | null;
  if (!btn?.dataset.codec) return;
  if (btn.classList.contains("active")) return;
  const player = getPlayer();
  if (!player) return;
  player.sendJson({ type: "set_codec", codec: btn.dataset.codec });
});

// --- Control buttons ---
document.getElementById("btnCapture")!.addEventListener("click", () => {
  const player = getPlayer();
  if (player) player.sendJson({ type: "capture_photo" });
});
document.getElementById("btnRecStart")!.addEventListener("click", () => {
  const player = getPlayer();
  if (player) player.sendJson({ type: "start_recording" });
});
document.getElementById("btnRecStop")!.addEventListener("click", () => {
  const player = getPlayer();
  if (player) player.sendJson({ type: "stop_recording" });
});
document.getElementById("btnStreamStart")!.addEventListener("click", () => {
  const player = getPlayer();
  if (player) player.sendJson({ type: "start_stream" });
});
document.getElementById("btnStreamStop")!.addEventListener("click", () => {
  const player = getPlayer();
  if (player) player.sendJson({ type: "stop_stream" });
});
document.getElementById("btnSpeak")!.addEventListener("click", () => {
  const input = document.getElementById("speakInput") as HTMLInputElement;
  const text = input.value.trim();
  const player = getPlayer();
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
  wakeStatus.textContent = "Waking...";
  wakeStatus.style.color = "#8be9fd";
  try {
    const payload: { deviceId?: string; sessionId?: string } = {};
    const deviceId = getCurrentDeviceId();
    const sessionId = getCurrentSessionId();
    if (deviceId) payload.deviceId = deviceId;
    else if (sessionId) payload.sessionId = sessionId;
    else {
      wakeStatus.textContent = "No device";
      wakeStatus.style.color = "#ff5555";
      return;
    }
    const res = await fetch("/api/wake-device", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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
  const player = getPlayer();
  if (player) player.sendJson({ type: "set_audio_gain", codecType: 0, gainDb: db });
});
gainGlassesSlider.addEventListener("input", () => {
  const db = Number(gainGlassesSlider.value);
  gainGlassesVal.textContent = `${db > 0 ? "+" : ""}${db}dB`;
  const player = getPlayer();
  if (player) player.sendJson({ type: "set_audio_gain", codecType: 1, gainDb: db });
});
noiseGateSlider.addEventListener("input", () => {
  const val = Number(noiseGateSlider.value);
  noiseGateVal.textContent = val === 0 ? "OFF" : val.toFixed(3);
  const player = getPlayer();
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
  const player = getPlayer();
  if (player) {
    player.sendJson({ type: "set_noise_suppression", codecType: 0, enabled: noiseSuppressEnabled });
    player.sendJson({ type: "set_noise_suppression", codecType: 1, enabled: noiseSuppressEnabled });
  }
});

export function resetAudioControls(): void {
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

/** Sync audio config UI from publisher state (audio_config message). */
export function syncAudioConfig(cfg: Record<string, unknown>): void {
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

export { infoPanel, infoPanelToggle };
