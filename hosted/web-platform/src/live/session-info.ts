/**
 * Session info strip handler — populates device, wearable, uptime, viewers.
 */

import {
  getCurrentDeviceId, setCurrentDeviceId,
  getSessionConnectedAt, setSessionConnectedAt,
  getUptimeInterval, setUptimeInterval,
} from "./state.js";
import { setPill } from "./toast.js";

const siStrip = document.getElementById("sessionInfoStrip")!;
const siDevice = document.getElementById("si-device")!;
const siWearable = document.getElementById("si-wearable")!;
const siUptime = document.getElementById("si-uptime")!;
const siViewers = document.getElementById("si-viewers")!;
const siRecRow = document.getElementById("si-rec-row")!;
const pubPill = document.getElementById("p-publisher")!;

export function handleSessionInfo(msg: Record<string, unknown>): void {
  siStrip.classList.remove("hidden");

  // Capture device ID for wake-device push
  const devId = msg.deviceId as string | undefined;
  if (devId) setCurrentDeviceId(devId);

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
    setSessionConnectedAt(connectedAt);
    if (!getUptimeInterval()) {
      updateUptime();
      setUptimeInterval(setInterval(updateUptime, 1000));
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

export function updateUptime(): void {
  if (!getSessionConnectedAt()) return;
  const elapsed = Math.floor((Date.now() - getSessionConnectedAt()) / 1000);
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = elapsed % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  siUptime.textContent = h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export { siStrip, siRecRow, pubPill };
