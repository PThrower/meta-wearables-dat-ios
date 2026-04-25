/**
 * WebSocket message handler — dispatches all onJsonMessage types.
 */

import type { GuidancePanel } from "../guidance.js";
import type { RelayPlayer } from "../player/relay-player.js";
import { getPlayer } from "./state.js";
import { showToast, setPill } from "./toast.js";
import { setMicActive, setCodecActive, syncAudioConfig } from "./controls.js";
import { handleSessionInfo } from "./session-info";
import { handleConnectionState, handleConnectionStatus, connOverlay, connSpinner, connStatus, connDetail } from "./connection-overlay.js";

const aiPill = document.getElementById("p-ai")!;
const meterFill = document.getElementById("audio-meter-fill")!;

/** Wire the player's onJsonMessage callback. */
export function wireMessageHandler(player: RelayPlayer, guidancePanel: GuidancePanel): void {
  player.onJsonMessage = (msg) => {
    guidancePanel.handleMessage(msg);

    // Session info from server
    if (msg.type === "session_info") {
      handleSessionInfo(msg as Record<string, unknown>);
    }

    // Publisher status
    if (msg.type === "publisher_status") {
      const s = (msg as { status: string; reason?: string; reconnectHint?: { deviceBound?: boolean; estimatedResumeMs?: number } }).status;
      const reason = (msg as { reason?: string }).reason;
      const reconnectHint = (msg as { reconnectHint?: { deviceBound?: boolean; estimatedResumeMs?: number } }).reconnectHint;
      const pubPill = document.getElementById("p-publisher")!;
      if (s === "live") {
        setPill(pubPill, "PUB LIVE", "status-live");
        showToast("Publisher streaming", "info");
      } else if (s === "standby") {
        setPill(pubPill, "PUB READY", "status-standby");
        showToast("Publisher ready (standby)", "info");
      } else if (s === "paused") {
        setPill(pubPill, "PAUSED", "status-standby");
        showToast("Stream paused", "info");
      } else if (s === "dropped" || s === "orphaned") {
        if (reconnectHint?.deviceBound) {
          setPill(pubPill, "RECONNECTING", "status-warn");
          showToast("Publisher disconnected -- reconnecting...", "warn");
          connOverlay.classList.remove("hidden");
          connSpinner.classList.remove("hidden");
          connStatus.textContent = "Reconnecting...";
          connStatus.className = "connection-status";
          if (reconnectHint.estimatedResumeMs) {
            const sec = Math.round(reconnectHint.estimatedResumeMs / 1000);
            connDetail.textContent = `Device reconnecting (~${sec}s)`;
          } else {
            connDetail.textContent = "Waiting for device...";
          }
        } else {
          setPill(pubPill, "PUB DROP", "status-error");
          const detail = reason === "stale_timeout" ? "No frames received" : "Publisher disconnected";
          showToast(detail, "warn");
        }
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

    // Audio mode changed
    if (msg.type === "audio_mode_changed") {
      setMicActive((msg as { mode: string }).mode);
    }

    // Codec changed
    if (msg.type === "codec_changed") {
      const codec = (msg as { codec: string }).codec;
      setCodecActive(codec);
      showToast("Codec: " + codec.toUpperCase(), "info");
      const p = getPlayer();
      if (p) p.resetVideoDecoder();
    }

    // Photo captured
    if (msg.type === "photo_captured") {
      showToast("Photo captured", "info");
    }

    // Recording changed
    if (msg.type === "recording_changed") {
      const rec = (msg as { recording: boolean }).recording;
      showToast(rec ? "Recording started" : "Recording stopped", "info");
      const siRecRow = document.getElementById("si-rec-row")!;
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
      handleTelemetry(msg as Record<string, unknown>);
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

    // Audio config response
    if (msg.type === "audio_config") {
      syncAudioConfig(msg as Record<string, unknown>);
    }
  };
}

/** Handle publisher_telemetry — update all telemetry DOM elements. */
function handleTelemetry(m: Record<string, unknown>): void {
  const frame = m.frame as Record<string, unknown> | undefined;
  const relay = m.relay as Record<string, unknown> | undefined;
  const errors = m.errors as Record<string, unknown> | undefined;
  const battery = m.battery as Record<string, unknown> | undefined;
  const thermal = m.thermal as Record<string, unknown> | undefined;
  const network = m.network as Record<string, unknown> | undefined;
  const memory = m.memory as Record<string, unknown> | undefined;
  const relayLatency = m.relayLatency as Record<string, unknown> | undefined;
  const disk = m.disk as Record<string, unknown> | undefined;
  const cellular = m.cellular as Record<string, unknown> | undefined;
  const display = m.display as Record<string, unknown> | undefined;
  const camera = m.camera as Record<string, unknown> | undefined;
  const orientation = m.orientation as string | undefined;
  const motion = m.motion as Record<string, unknown> | undefined;
  const bluetooth = m.bluetooth as Record<string, unknown> | undefined;
  const cpu = m.cpu as Record<string, unknown> | undefined;
  const location = m.location as Record<string, unknown> | undefined;
  const gyro = m.gyro as Record<string, unknown> | undefined;
  const magnetometer = m.magnetometer as Record<string, unknown> | undefined;
  const barometer = m.barometer as Record<string, unknown> | undefined;
  const audioLevel = m.audioLevel as Record<string, unknown> | undefined;
  const memoryFootprint = m.memoryFootprint as Record<string, unknown> | undefined;
  const proximity = m.proximity as Record<string, unknown> | undefined;
  const background = m.background as Record<string, unknown> | undefined;
  const throughput = m.throughput as Record<string, unknown> | undefined;

  const set = (id: string, text: string) => { const el = document.getElementById(id); if (el) el.textContent = text; };

  // Frame / relay stats
  if (relay) {
    set("t-relay-fps", typeof frame?.fps === "number" ? (frame.fps as number).toFixed(1) : "--");
    set("t-encode-ema", ((relay.encodeTimeEmaMs as number) ?? 0).toFixed(1) + "ms");
    set("t-relay-dropped", String(relay.framesDropped ?? "--"));
    const avgFrame = (relay.avgFrameSizeBytes as number) ?? 0;
    set("t-frame-size", avgFrame > 0 ? (avgFrame / 1024).toFixed(1) + " KB" : "--");
    const codecVal = relay.videoCodec as number | undefined;
    if (typeof codecVal === "number") {
      setCodecActive(codecVal === 1 ? "h264" : "jpeg");
    }
  }
  if (errors) set("t-errors", String(errors.total ?? 0));

  if (battery) {
    const level = typeof battery.level === "number" && battery.level >= 0 ? Math.round(battery.level * 100) + "%" : "--";
    const state = typeof battery.state === "string" ? battery.state : "";
    const lpm = battery.lowPowerMode ? " LPM" : "";
    set("t-battery", level + (state === "charging" ? " +" : "") + lpm);
  }

  if (thermal) {
    const s = String(thermal.state ?? "--");
    const el = document.getElementById("t-thermal");
    if (el) {
      el.textContent = s;
      el.style.color = s === "nominal" ? "#50fa7b" : s === "fair" ? "#f1fa8c" : s === "serious" ? "#ffb86c" : s === "critical" ? "#ff5555" : "";
    }
  }

  if (network) {
    const t = String(network.type ?? "--");
    const exp = network.expensive ? " $" : "";
    set("t-network", t + exp);
  }

  if (memory) {
    const mb = typeof memory.availableMB === "number" ? (memory.availableMB as number).toFixed(0) : "--";
    set("t-memory", mb + "MB " + String(memory.pressure ?? ""));
  }

  if (relayLatency) {
    const ms = typeof relayLatency.ms === "number" ? (relayLatency.ms as number).toFixed(1) : "--";
    set("t-relay-rtt", ms + "ms");
  }

  if (disk) {
    const avail = typeof disk.availableGB === "number" ? (disk.availableGB as number).toFixed(1) : "--";
    const total = typeof disk.totalGB === "number" ? (disk.totalGB as number).toFixed(0) : "--";
    set("t-disk", avail + "/" + total + "GB");
  }

  if (cellular && cellular.technology) {
    const tech = String(cellular.technology);
    const carrier = cellular.carrier ? " (" + String(cellular.carrier) + ")" : "";
    set("t-cellular", tech + carrier);
  } else { set("t-cellular", "--"); }

  if (display) {
    const b = typeof display.brightness === "number" ? Math.round((display.brightness as number) * 100) : "--";
    set("t-display", b + "%");
  }

  if (camera && camera.iso != null) {
    const iso = typeof camera.iso === "number" ? (camera.iso as number).toFixed(0) : "--";
    const exp = typeof camera.exposureMs === "number" ? (camera.exposureMs as number).toFixed(1) : "--";
    set("t-camera", "ISO" + iso + " " + exp + "ms");
  } else { set("t-camera", "--"); }

  set("t-orientation", orientation ?? "--");

  if (motion) {
    const x = typeof motion.x === "number" ? (motion.x as number).toFixed(2) : "0";
    const y = typeof motion.y === "number" ? (motion.y as number).toFixed(2) : "0";
    const z = typeof motion.z === "number" ? (motion.z as number).toFixed(2) : "0";
    const stat = motion.stationary ? " idle" : "";
    set("t-motion", "x" + x + " y" + y + " z" + z + stat);
  }

  if (bluetooth) set("t-bluetooth", String(bluetooth.state ?? "--"));

  if (cpu) {
    const pct = typeof cpu.usagePercent === "number" ? (cpu.usagePercent as number).toFixed(1) : "--";
    set("t-cpu", pct + "%");
  }

  if (location) {
    const speed = typeof location.speed === "number" ? (location.speed as number).toFixed(1) + "m/s" : "";
    const alt = typeof location.altitude === "number" ? " " + (location.altitude as number).toFixed(0) + "m" : "";
    set("t-location", speed + alt || "--");
  } else { set("t-location", "--"); }

  if (gyro) {
    const x = typeof gyro.x === "number" ? (gyro.x as number).toFixed(1) : "0";
    const y = typeof gyro.y === "number" ? (gyro.y as number).toFixed(1) : "0";
    const z = typeof gyro.z === "number" ? (gyro.z as number).toFixed(1) : "0";
    set("t-gyro", "x" + x + " y" + y + " z" + z);
  } else { set("t-gyro", "--"); }

  if (magnetometer) {
    const x = typeof magnetometer.x === "number" ? (magnetometer.x as number).toFixed(0) : "0";
    const y = typeof magnetometer.y === "number" ? (magnetometer.y as number).toFixed(0) : "0";
    const z = typeof magnetometer.z === "number" ? (magnetometer.z as number).toFixed(0) : "0";
    set("t-magnetometer", "x" + x + " y" + y + " z" + z + "uT");
  } else { set("t-magnetometer", "--"); }

  if (barometer && typeof barometer.pressureKPa === "number") {
    set("t-barometer", (barometer.pressureKPa as number).toFixed(2) + "kPa");
  } else { set("t-barometer", "--"); }

  if (audioLevel && audioLevel.peakDb != null) {
    const peak = typeof audioLevel.peakDb === "number" ? (audioLevel.peakDb as number).toFixed(0) : "--";
    const avg = typeof audioLevel.averageDb === "number" ? (audioLevel.averageDb as number).toFixed(0) : "--";
    set("t-audio-level", "p:" + peak + "dB a:" + avg + "dB");
  } else { set("t-audio-level", "--"); }

  if (memoryFootprint && typeof memoryFootprint.footprintMB === "number") {
    set("t-memory-footprint", (memoryFootprint.footprintMB as number).toFixed(0) + "MB");
  } else { set("t-memory-footprint", "--"); }

  if (proximity) set("t-proximity", proximity.near ? "near" : "far");

  if (background) {
    const fg = typeof background.foregroundSec === "number" ? background.foregroundSec as number : 0;
    const bg = typeof background.backgroundSec === "number" ? background.backgroundSec as number : 0;
    const total = fg + bg;
    set("t-background", total > 0 ? Math.round((fg / total) * 100) + "%fg" : "--");
  }

  if (throughput && typeof throughput.bytesPerSec === "number") {
    const bps = throughput.bytesPerSec as number;
    const totalMB = typeof throughput.totalMB === "number" ? (throughput.totalMB as number).toFixed(1) : "0";
    const kbps = bps / 1024;
    set("t-throughput", (kbps > 1024 ? (kbps / 1024).toFixed(1) + "MB/s" : kbps.toFixed(0) + "KB/s") + " " + totalMB + "MB");
  } else { set("t-throughput", "--"); }
}
