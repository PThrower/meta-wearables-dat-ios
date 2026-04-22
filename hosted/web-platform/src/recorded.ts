/**
 * Recorded session player — full overlay with info panel, metadata fetch, lifecycle
 */

import { authFetch, authUrl } from "./auth.js";
import { fmtDur, fmtTime } from "./core/format.js";
import type { GuidanceEvent } from "./guidance.js";
import { EVENT_COLORS, EVENT_LABELS, sourceBadgeClass, esc } from "./guidance.js";

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
  recording?: {
    videoDurationMs?: number;
    audioDurationMs?: number;
    driftMs?: number;
    totalFrames?: number;
    framesRelayed?: number;
    segmentsWritten?: number;
    audioChunks?: number;
    bytesToBucket?: number;
  };
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

  // Show overlay, hide page-content
  $("recordedPlayer").classList.add("active");
  $("page-content").classList.add("hidden");

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

  // Fetch guidance history (non-blocking — don't block video playback if it fails)
  authFetch(`/session/${sessionId}/guidance/history`)
    .then(res => res.ok ? res.json() : { events: [] })
    .then(({ events }: { events: GuidanceEvent[] }) => populateGuidanceLog(events))
    .catch(() => { /* non-critical */ });
}

/** Populate the recorded info panel from SessionExport metadata */
function populateInfoPanel(m: SessionExport): void {
  const device = m.device?.deviceName || m.device?.deviceModel || "Unknown Device";
  const wearable = m.device?.wearableType || "--";
  const contentDur = m.recording?.videoDurationMs ?? m.durationMs ?? 0;
  const driftMs = m.recording?.driftMs ?? 0;

  setText("ri-device", device);
  setText("ri-wearable", wearable);
  setText("ri-duration", fmtDur(contentDur));
  setText("ri-started", fmtTime(m.startedAt ?? ""));
  setText("ri-finished", fmtTime(m.finishedAt ?? ""));
  setText("ri-session-id", m.sessionId.slice(0, 8));
  setText("ri-access", m.accessLevel ?? "--");
  setText("ri-owner", m.ownerEmail ?? m.ownerId ?? "--");

  setText("ri-segments", String(m.segments ?? m.recording?.segmentsWritten ?? 0));
  setText("ri-audio-chunks", String(m.audioChunks ?? m.recording?.audioChunks ?? 0));
  setText("ri-has-audio", (m.audioChunks ?? m.recording?.audioChunks ?? 0) > 0 ? "Yes" : "No");
  setText("ri-mp4-status", m.exportCached ? "Cached" : "On-demand");
  setText("ri-system", m.systemVersion ?? "--");

  // Stream vs recording drift
  const relayed = m.recording?.framesRelayed;
  const recorded = m.recording?.totalFrames;
  if (relayed != null && recorded != null) {
    const diff = Math.abs(relayed - recorded);
    if (diff > 0) {
      const dir = relayed > recorded ? "more streamed" : "more recorded";
      setText("ri-stream-drift", `${diff} frames (${dir}) — ${relayed} relayed / ${recorded} recorded`);
    } else {
      setText("ri-stream-drift", `0 (perfect — ${recorded} frames)`);
    }
  } else {
    setText("ri-stream-drift", "--");
  }

  // Show A/V drift if significant (> 2s)
  const driftAbs = Math.abs(driftMs);
  if (driftAbs > 2000 && m.recording?.audioDurationMs) {
    const el = $("ri-duration");
    if (el) {
      const wallEl = m.durationMs && contentDur !== m.durationMs ? ` (wall ${fmtDur(m.durationMs)})` : "";
      const driftLabel = driftMs > 0 ? "audio +" : "video +";
      el.textContent = fmtDur(contentDur) + wallEl + ` [${driftLabel}${fmtDur(driftAbs)} drift]`;
    }
  }

  // Share button visibility — only for owner/editor
  const canShare = m.viewerRole === "owner" || m.viewerRole === "editor";
  const shareRow = $("recShareRow");
  if (canShare) {
    shareRow.classList.remove("rec-action-hidden");
  } else {
    shareRow.classList.add("rec-action-hidden");
  }
}

/** Render guidance events into the recorded info panel log */
function populateGuidanceLog(events: GuidanceEvent[]): void {
  setText("ri-guidance-count", String(events.length));
  const container = $("recGuidanceLog");
  if (events.length === 0) {
    container.innerHTML = '<div class="guidance-hint">No AI guidance events</div>';
    return;
  }
  container.innerHTML = events.map(renderGuidanceEvent).join("");
}

/** Render a single guidance event (mirrors live panel rendering in guidance.ts) */
function renderGuidanceEvent(e: GuidanceEvent): string {
  const color = EVENT_COLORS[e.type] || "#fff";
  const label = EVENT_LABELS[e.type] || "???";
  const time = new Date(e.timestampMs).toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

  if (e.type === "guidance.transcript") {
    return `<div class="guidance-event guidance-transcript">
      <span class="guidance-transcript-time">${time}</span>
      <span class="guidance-transcript-text">${esc(e.content)}</span>
    </div>`;
  }

  const confidence = Math.round(e.confidence * 100);
  const stepMeta = e.metadata?.stepNumber != null
    ? ` <span class="guidance-step-num">#${e.metadata.stepNumber}</span>` : "";
  const severityMeta = e.metadata?.severity
    ? ` <span class="guidance-severity guidance-severity-${e.metadata.severity}">${e.metadata.severity}</span>` : "";
  const objectMeta = e.metadata?.objectLabel
    ? ` <span class="guidance-object">${esc(e.metadata.objectLabel)}</span>` : "";

  const ttsIcon = e.trigger === "ai_tool_call"
    ? ` <span class="guidance-tts-badge" title="Spoken via TTS">TTS</span>` : "";
  const srcBadge = e.source
    ? `<span class="guidance-source-badge ${sourceBadgeClass(e.source)}">${esc(e.source)}</span>` : "";
  const triggerBadge = (e.trigger && e.trigger !== e.source && e.trigger !== "ai_tool_call")
    ? `<span class="guidance-trigger-badge">${esc(e.trigger)}</span>` : "";

  if (e.type === "guidance.bbox" && e.boundingBoxes) {
    const objectTags = e.boundingBoxes
      .map(b => `<span class="guidance-object">${esc(b.label)} ${Math.round(b.confidence * 100)}%</span>`)
      .join(" ");
    return `<div class="guidance-event" style="border-left-color:${color}">
      <div class="guidance-event-header">
        <span class="guidance-event-type" style="color:${color}">${label}</span>${srcBadge}${triggerBadge}
        <span class="guidance-event-confidence">${confidence}%</span>
        <span class="guidance-event-time">${time}</span>
      </div>
      <div class="guidance-event-body">${esc(e.content)} ${objectTags}</div>
    </div>`;
  }

  return `<div class="guidance-event" style="border-left-color:${color}">
    <div class="guidance-event-header">
      <span class="guidance-event-type" style="color:${color}">${label}</span>${ttsIcon}${srcBadge}${triggerBadge}
      <span class="guidance-event-confidence">${confidence}%</span>
      <span class="guidance-event-time">${time}</span>
    </div>
    <div class="guidance-event-body">${esc(e.content)}${stepMeta}${severityMeta}${objectMeta}</div>
  </div>`;
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

  // Hide overlay, restore page-content (router manages which page is visible)
  $("recordedPlayer").classList.remove("active");
  $("page-content").classList.remove("hidden");

  // Clear guidance log
  $("recGuidanceLog").innerHTML = "";
  setText("ri-guidance-count", "--");

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
