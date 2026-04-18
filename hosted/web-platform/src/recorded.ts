/**
 * Recorded session player — full overlay with info panel, metadata fetch, lifecycle
 */

import { authFetch, authUrl } from "./auth.js";
import { fmtDur, fmtTime } from "./gallery/format.js";

interface SessionExport {
  sessionId: string;
  live: boolean;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  device?: { deviceName?: string; deviceModel?: string; wearableType?: string };
  ownerId?: string;
  ownerEmail?: string;
  accessLevel?: string;
  segments?: number;
  audioChunks?: number;
  exportCached?: boolean;
  systemVersion?: string;
  acl?: Array<{ userId: string; email: string; role: string }>;
  viewerRole?: string;
}

let currentSessionId: string | null = null;

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function setText(id: string, val: string): void {
  $(id).textContent = val;
}

function showToast(msg: string, type: "info" | "warn" | "error" = "info"): void {
  const container = $("recToastContainer");
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

/** Open the recorded player overlay for a given session */
export async function openRecordedPlayer(sessionId: string): Promise<void> {
  currentSessionId = sessionId;

  // Show overlay, hide gallery
  $("recordedPlayer").classList.add("active");
  $("gallery").classList.add("hidden");

  // Start loading video immediately (auth-aware URL with ?audio for muxed audio)
  const video = $("recVideo") as HTMLVideoElement;
  video.src = authUrl(`/session/${sessionId}/video.mp4?audio`);

  // Fetch full session metadata
  try {
    const res = await authFetch(`/session/${sessionId}/export`);
    if (!res.ok) {
      showToast(`Failed to load metadata (${res.status})`, "warn");
      return;
    }
    const meta: SessionExport = await res.json();
    populateInfoPanel(meta);
  } catch (err) {
    showToast("Network error loading metadata", "error");
    console.warn("[recorded] metadata fetch failed:", err);
  }
}

/** Populate the recorded info panel from SessionExport metadata */
function populateInfoPanel(m: SessionExport): void {
  const device = m.device?.deviceName || m.device?.deviceModel || "Unknown Device";
  const wearable = m.device?.wearableType || "--";

  setText("ri-device", device);
  setText("ri-wearable", wearable);
  setText("ri-duration", fmtDur(m.durationMs ?? 0));
  setText("ri-started", fmtTime(m.startedAt ?? ""));
  setText("ri-finished", fmtTime(m.finishedAt ?? ""));
  setText("ri-session-id", m.sessionId.slice(0, 8));
  setText("ri-access", m.accessLevel ?? "--");
  setText("ri-owner", m.ownerEmail ?? m.ownerId ?? "--");

  setText("ri-segments", String(m.segments ?? 0));
  setText("ri-audio-chunks", String(m.audioChunks ?? 0));
  setText("ri-has-audio", (m.audioChunks ?? 0) > 0 ? "Yes" : "No");
  setText("ri-mp4-status", m.exportCached ? "Cached" : "On-demand");
  setText("ri-system", m.systemVersion ?? "--");

  // Share button visibility — only for owner/editor
  const canShare = m.viewerRole === "owner" || m.viewerRole === "editor";
  const shareRow = $("recShareRow");
  if (canShare) {
    shareRow.classList.remove("rec-action-hidden");
  } else {
    shareRow.classList.add("rec-action-hidden");
  }
}

/** Close the recorded player and return to gallery */
export function closeRecordedPlayer(): void {
  // Pause and clear video
  const video = $("recVideo") as HTMLVideoElement;
  video.pause();
  video.src = "";

  // Close info panel if open
  $("recInfoPanel").classList.remove("open");
  $("recInfoPanelToggle").classList.remove("active");

  // Hide overlay, show gallery
  $("recordedPlayer").classList.remove("active");
  $("gallery").classList.remove("hidden");

  currentSessionId = null;
}

/** Wire up all recorded player event handlers */
export function initRecordedPlayerEvents(): void {
  // Back button
  $("recBackBtn").addEventListener("click", closeRecordedPlayer);

  // Info panel toggle (same pattern as live)
  $("recInfoPanelToggle").addEventListener("click", () => {
    const panel = $("recInfoPanel");
    const toggle = $("recInfoPanelToggle");
    panel.classList.toggle("open");
    toggle.classList.toggle("active");
  });

  // Download MP4 button
  $("recDownloadBtn").addEventListener("click", () => {
    if (!currentSessionId) return;
    window.open(authUrl(`/session/${currentSessionId}/video.mp4?audio`), "_blank", "noopener");
  });

  // Share button
  $("recShareBtn").addEventListener("click", () => {
    if (!currentSessionId) return;
    const openShareDialog = (window as any).openShareDialog;
    if (openShareDialog) openShareDialog(currentSessionId);
  });
}
