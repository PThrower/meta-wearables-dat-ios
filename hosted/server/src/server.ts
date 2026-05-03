/**
 * caringmind-frame-relay
 *
 * Bun WebSocket relay server (pure API — no HTML serving).
 * Web platform SPA is served by the gateway from hosted/web-platform/dist.
 *
 * 1. Accepts multiple publishers (iOS apps) on separate sessions
 * 2. Fans out frames to per-session browser viewers in real-time
 * 3. Uses WASM module for frame throttling (falls back to pure JS)
 *
 * API Endpoints:
 *   /api/config              - Runtime config for SPA (auth, version)
 *   /publish?session=<id>    - WebSocket, iOS publisher connects here
 *   /view?session=<id>       - WebSocket, browser viewers connect here
 *   /tap/audio?session=<id>  - WebSocket, audio tap for AI pipeline
 *   /sessions                - JSON list of active + historical sessions
 *   /gallery/api             - JSON feed with metadata + thumbnails
 *   /session/<id>/thumbnail  - Mid-frame JPEG (cached to R2)
 *   /session/<id>/video.mp4  - MP4 export (cached to R2 after first build)
 *   /session/<id>/export     - JSON metadata about recorded session
 *   /session/<id>/share      - Create share token (POST)
 *   /session/<id>/shares     - List share tokens (GET)
 *   /session/<id>/access     - Update access level/ACL (PATCH)
 *   /session/<id>/audio-in   - Push audio to publisher (POST)
 *   /session/<id>/guidance   - AI guidance history, status, telemetry (GET)
 *   /session/<id>/guidance/history - Persisted guidance events from R2 (GET)
 *   /api/device-token       - Register APNs device token (POST)
 *   /api/wake-device         - Wake device via APNs push (POST)
 *   /latest/video.mp4        - Redirect to most recent session's mp4 export
 *   /latest/export           - JSON metadata for most recent session
 *   /stats                   - JSON stats (platform-wide + per-session)
 *   /telemetry/ai            - JSON AI telemetry (aggregate or per-session with ?session=<id>)
 *   /telemetry/ai/log        - WebSocket, live AI guidance event log (optional ?session=<id>)
 *
 * Backward compatible: omitting ?session= routes to "default" session.
 *
 * Wire protocol (FRLY):
 *   [4B "FRLY"][8B sequence][4B width][4B height][1B quality][8B timestamp_ms][JPEG payload]
 */

import { join } from "node:path";
import os from "node:os";
import { createObjectStore, type ObjectStore } from "@ebowwa/object-store";

import type { WsData, AccessLevel, AclEntry, Session } from "./types.js";
import { dropReasonFromCloseCode } from "./session-state.js";
import { HEADER_SIZE, AUDIO_HEADER_SIZE, isAudioFrame, parseAudioHeader, buildAudioFrame } from "./protocol.js";
import { computeHealth } from "./health.js";
import { SessionRegistry } from "./session-registry.js";
import { AudioTapBus } from "./audio-tap.js";
import { ControlEventBus } from "./control-event-bus.js";
import { AppRegistry, resolveWorkflowToPipeline } from "./app-registry.js";
import type { FlowTrigger, WorkflowSettings } from "./app-types.js";

import { GuidanceOrchestrator } from "./guidance-orchestrator.js";
import { JEPAOrchestrator } from "./jepa-orchestrator.js";
import { ReIDOrchestrator } from "./reid-orchestrator.js";
import { PalantirOrchestrator } from "./palantir-orchestrator.js";
import { NODE_DEFINITIONS, validateStructure } from "./node-definitions.js";
import { H264ToJpegDecoder } from "./h264-decoder.js";
// Auth disabled — all endpoints are open access
import {
  getSessionExportMeta,
  getSessionThumbnail,
  getCachedMp4Url,
  exportAndCacheMp4,
  getGalleryData,
  ExportError,
  type GallerySession,
} from "./session-export.js";
// Auth disabled — permissions module not needed
import { SessionStore } from "./session-store.js";
import { initDb, getDbRaw } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import { dbWriter } from "./db/db-writer.js";
import * as q from "./db/queries.js";
import { isApnsConfigured, sendSilentWake, sendVisibleWake } from "./apns.js";
import { handleWorkflowActivation, validateEdges, type ActivationDeps } from "./workflow-activation.js";
import { dispatchWorkflowConfig } from "./workflow-dispatch.js";
import type { ServerErrorCallback } from "./message-types.js";
import { handleWsMessage, broadcastToViewers, buildSessionInfo, type WsMessageDeps } from "./ws-message-handler.js";

// --- Auto-detect WiFi IP ---

function getWifiIp(): string {
  const nets = os.networkInterfaces();
  for (const addrs of Object.values(nets) as (os.NetworkInterfaceInfo[] | undefined)[]) {
    for (const a of (addrs ?? [])) {
      if (a.family === "IPv4" && !a.internal && !a.address.startsWith("100.") && !a.address.startsWith("169.")) {
        return a.address;
      }
    }
  }
  return "127.0.0.1";
}

// --- Constants ---

const PORT = parseInt(process.env.RELAY_PORT || "8080");
const wifiIp = getWifiIp();
const serverStartTime = Date.now();

// --- Pending wake activations (deviceId → workflowId) ---
const pendingWakeActivations = new Map<string, { workflowId: string; requestedAt: number }>();

// --- Object Store ---

const store: ObjectStore = createObjectStore();
const sessionStore = new SessionStore(store);

// --- SQLite Database ---

initDb();
runMigrations(getDbRaw());
dbWriter.start();

// --- Seed pre-built apps as published workflows ---
import { seedAppsAsWorkflows } from "./seed-apps.js";
import { DetectionThrottle } from "./detection-throttle.js";

seedAppsAsWorkflows();

// --- Session Registry ---

const registry = new SessionRegistry(store);

// --- Audio Tap Bus ---
// Pluggable audio dispatch: custom taps subscribe to receive parsed audio frames.
// Built-in taps (fanout, recording) continue via their existing paths.
// Add custom taps via: audioTapBus.subscribe()

const audioTapBus = new AudioTapBus();

// --- H.264 Decoders (per-session, lazy-created) ---
const h264Decoders = new Map<string, H264ToJpegDecoder>();

/** Get or create an H.264 decoder for a session */
function getH264Decoder(sessionId: string): H264ToJpegDecoder {
  let decoder = h264Decoders.get(sessionId);
  if (!decoder) {
    decoder = new H264ToJpegDecoder(sessionId);
    decoder.onJpeg = (jpeg: Uint8Array) => {
      orchestrator.sendVideoFrame(sessionId, jpeg);
      // Feed decoded JPEG to recorder so H.264 sessions get video recordings
      const session = registry.get(sessionId);
      session?.recorder?.appendDecodedVideo(jpeg);
    };
    h264Decoders.set(sessionId, decoder);
  }
  return decoder;
}

/** Stop and remove H.264 decoder for a session */
function stopH264Decoder(sessionId: string): void {
  const decoder = h264Decoders.get(sessionId);
  if (decoder) {
    decoder.stop();
    h264Decoders.delete(sessionId);
  }
}

/** Check if a cached FRLY frame is H.264 (codecType 1) */
function isCachedFrameH264(frame: Uint8Array): boolean {
  if (frame.length < 26) return false;
  const codecFlags = frame[25];
  return ((codecFlags >> 4) & 0x0F) === 1;
}

/** Send cached frame to AI, handling both JPEG and H.264 codecs */
function sendCachedFrameToAI(sessionId: string, frame: Uint8Array): void {
  if (isCachedFrameH264(frame)) {
    // H.264: feed through decoder (async, JPEG arrives via onJpeg callback)
    const decoder = h264Decoders.get(sessionId);
    if (decoder?.active) {
      decoder.feed(frame.slice(HEADER_SIZE));
    }
  } else {
    // JPEG: send directly
    orchestrator.sendVideoFrame(sessionId, frame.slice(HEADER_SIZE));
  }
}

// --- Control Event Bus ---
// Pub/sub for gesture/control events from iOS publisher.

const controlEventBus = new ControlEventBus();

// --- App Registry ---

const appRegistry = new AppRegistry();

// --- Guidance Orchestrator ---
// AI guidance routing: subscribes to ControlEventBus, manages per-session app state,
// broadcasts GuidanceEvent objects to session viewers. Uses AIService providers
// (Gemini Live, etc.) for real multimodal inference.

const orchestrator = new GuidanceOrchestrator(controlEventBus, appRegistry);

// Detection throttle — reduces AI context noise by deduplicating identical
// detection summaries within a 2-second window. Vision fires ~5fps; without
// throttling, AI gets 5 near-identical `[Vision: Face (87%)]` messages/sec.
const detectionThrottle = new DetectionThrottle(2000);

// Clean up orchestrator state when sessions expire
registry.setOnSessionDestroy((id: string) => {
  orchestrator.cleanup(id);
  jepaOrchestrator.deactivate(id);
  palantirOrchestrator.deactivateAll(id);
  detectionThrottle.clear(id);
});

// Pause/resume active workflow when session pauses/resumes
registry.setOnSessionPause((id: string) => {
  const session = registry.get(id);
  if (session?.activeWorkflowId) {
    orchestrator.handleWorkflowControl(id, "pause_workflow", session.activeWorkflowId, undefined, "system");
  }
});

registry.setOnSessionResume((id: string) => {
  const session = registry.get(id);
  if (session?.activeWorkflowId) {
    orchestrator.handleWorkflowControl(id, "resume_workflow", session.activeWorkflowId, undefined, "system");
  }
});

// Audio push: when AI produces spoken audio, wrap as FRAU codecType 3 and
// push through the relay's audio-in path (fan-out to publisher + viewers).
orchestrator.setAudioPushFn((sessionId: string, pcm: Uint8Array, preferGlasses: boolean) => {
  if (pcm.length === 0) return;

  console.log(`[relay] AI audio push: ${pcm.length} bytes session=${sessionId} preferGlasses=${preferGlasses}`);

  // Send routing control message to publisher BEFORE binary frames
  const session = registry.get(sessionId);
  if (session?.publisher?.ws && session.publisher.ws.readyState === WebSocket.OPEN) {
    session.publisher.ws.send(JSON.stringify({ type: "audio_route", preferGlasses }));
  }

  // Build FRAU v1 frame: codecType=3 (relay-inbound), 16kHz, mono, 16-bit
  const seq = Date.now();
  const timestampMs = Date.now();
  const frame = buildAudioFrame(3, seq, 16000, 1, 16, timestampMs, pcm);

  // Fan out to viewers
  registry.fanoutAudio(sessionId, frame, 3, 16000);

  // Push to publisher for local playback
  registry.sendToPublisher(sessionId, frame);

  // Record
  session?.recorder?.appendAudio(frame);
});

// Guidance text push: when AI emits a guidance event with content,
// send it to the publisher as JSON for client-side TTS.
// The publisher's RelayStage receives it and triggers AudioPlaybackStage.speakGuidance().
orchestrator.setGuidanceTextPushFn((sessionId: string, text: string, preferGlasses: boolean) => {
  const session = registry.get(sessionId);
  if (session?.publisher?.ws && session.publisher.ws.readyState === WebSocket.OPEN) {
    session.publisher.ws.send(JSON.stringify({ type: "guidance_text", text, preferGlasses }));
  }
});

// Bbox annotation recording: when AI detects objects, write to annotations.jsonl
orchestrator.setBboxAnnotationFn((sessionId: string, annotation) => {
  const session = registry.get(sessionId);
  session?.recorder?.appendBboxAnnotation(annotation);
});

// Push full guidance events (with bounding boxes) to publisher for iOS overlay
orchestrator.setGuidanceEventPushFn((sessionId: string, event) => {
  const session = registry.get(sessionId);
  if (session?.publisher?.ws && session.publisher.ws.readyState === WebSocket.OPEN) {
    session.publisher.ws.send(JSON.stringify({ type: "guidance_event", event }));
  }
});

// Persist guidance events to R2 guidance.jsonl sidecar
orchestrator.setGuidancePersistFn((sessionId: string, event) => {
  const session = registry.get(sessionId);
  session?.recorder?.appendGuidanceEvent(event);
});

orchestrator.start();

// --- JEPA Orchestrator setup ---

const jepaOrchestrator = new JEPAOrchestrator();

// --- ReID Orchestrator setup ---

const reidOrchestrator = new ReIDOrchestrator();

// --- Palantir Orchestrator setup ---

const palantirOrchestrator = new PalantirOrchestrator();

// Palantir events fan out to viewer WebSockets
palantirOrchestrator.setEventFanoutFn((sessionId: string, event) => {
  const subs = orchestrator.getSubscriberSet(sessionId);
  if (!subs) return;
  const msg = { type: "guidance_event", event };
  for (const cb of subs) {
    try { cb(msg); } catch { /* subscriber error, skip */ }
  }
});

// Palantir events persist to R2 guidance.jsonl
palantirOrchestrator.setFlowTriggerFn((sessionId: string, event) => {
  const session = registry.get(sessionId);
  session?.recorder?.appendGuidanceEvent(event);
  orchestrator.checkFlowTriggers(sessionId, "palantir", { event });
});

// JEPA events fan out to viewer WebSockets (same subscriber list as AI guidance)
jepaOrchestrator.setEventFanoutFn((sessionId: string, event) => {
  const subs = orchestrator.getSubscriberSet(sessionId);
  if (!subs) return;
  const msg = { type: "guidance_event", event };
  for (const cb of subs) {
    try { cb(msg); } catch { /* subscriber error, skip */ }
  }
});

// JEPA anomaly alerts push to publisher (for audio cue via HFP)
jepaOrchestrator.setGuidancePushFn((sessionId: string, event) => {
  const session = registry.get(sessionId);
  if (session?.publisher?.ws && session.publisher.ws.readyState === WebSocket.OPEN) {
    session.publisher.ws.send(JSON.stringify({ type: "guidance_event", event }));
  }
});

// JEPA events persist to R2 guidance.jsonl
jepaOrchestrator.setPersistFn((sessionId: string, event) => {
  const session = registry.get(sessionId);
  session?.recorder?.appendGuidanceEvent(event);
});

// JEPA events feed into flow trigger evaluation engine
jepaOrchestrator.setFlowTriggerFn((sessionId: string, event) => {
  orchestrator.checkFlowTriggers(sessionId, "jepa", { event });
});

// --- Shared server error callback ---
// All three orchestrators push errors to iOS publisher + viewers via this single callback.
const pushServerError: ServerErrorCallback = (sessionId, report) => {
  registry.sendJsonToPublisher(sessionId, {
    type: "server_error",
    ...report,
    context: { ...report.context, sessionId },
  });
  // Also broadcast to viewers for web platform error display
  const session = registry.get(sessionId);
  if (session) broadcastToViewers(session, { type: "server_error", ...report, context: { ...report.context, sessionId } });
};
orchestrator.setServerErrorCallback(pushServerError);
jepaOrchestrator.setServerErrorCallback(pushServerError);
reidOrchestrator.setServerErrorCallback(pushServerError);

// --- WASM Loading ---
// Load the FrameRelay class constructor once, instantiate per-session (lazy)

async function loadWasm() {
  try {
    const pkgDir = join(import.meta.dir, "..", "pkg");
    const gluePath = join(pkgDir, "frame_relay_wasm.js");
    const glueFile = Bun.file(gluePath);
    if (!(await glueFile.exists())) {
      console.log("[relay] WASM not found, running pure JS");
      return;
    }
    const { FrameRelay } = await import(gluePath);
    registry.setFrameRelayClass(FrameRelay);
    console.log("[relay] WASM FrameRelay class loaded (per-session throttle: 30 FPS)");
  } catch (err) {
    console.log("[relay] WASM load failed:", err);
    console.log("[relay] Running without WASM throttle");
  }
}

await loadWasm();

// --- Stale cleanup ---

const staleCleanupTimer = setInterval(() => registry.cleanupStale(), 5_000);

// --- Periodic session stats flush to SQLite ---

const STATS_FLUSH_INTERVAL_MS = 30_000;
setInterval(() => {
  for (const s of registry.listActive()) {
    const session = registry.get(s.id);
    if (!session?.publisher) continue;
    if (session.publisher.standby) continue; // No stats for standby publishers
    dbWriter.enqueue(q.updateSessionStats(s.id, {
      totalFrames: session.publisher.frameCount,
      totalBytes: session.publisher.totalBytes + session.publisher.audioBytes,
      peakViewers: session.viewers.size,
      resolutionW: session.metadata.resolution?.width,
      resolutionH: session.metadata.resolution?.height,
    }));
  }
}, STATS_FLUSH_INTERVAL_MS);

// --- Background timers for gallery index and cleanup ---

sessionStore.startBackgroundTimers(() => new Set(registry.listActive().map(s => s.id)));

// --- Helpers ---

async function findLatestSessionId(): Promise<string | null> {
  const sessionIds = await sessionStore.getSessionIds();
  if (sessionIds.length === 0) return null;

  let latestId: string | null = null;
  let latestTime = 0;
  for (const id of sessionIds) {
    const meta = await sessionStore.getMeta(id);
    if (!meta) continue;
    const t = new Date(meta.startedAt || 0).getTime();
    if (t > latestTime) { latestTime = t; latestId = id; }
  }
  return latestId;
}

const VIEWER_GIT_COMMIT = process.env.GIT_COMMIT?.slice(0, 7) ?? "dev";
const VIEWER_BUILD_VERSION = process.env.BUILD_VERSION ?? "dev";

// --- Server ---

const server = Bun.serve<WsData>({
  hostname: process.env.RELAY_TRUST_HEADERS === "1" ? "127.0.0.1" : "0.0.0.0",
  port: PORT,
  idleTimeout: 120,
  async fetch(req, server) {
    const url = new URL(req.url, `http://${req.headers.get("host") || "localhost"}`);

    // --- Latest session (auth-gated, user-scoped) ---

    if (url.pathname === "/latest/video.mp4") {
      const latestId = await findLatestSessionId();
      if (!latestId) {
        return Response.json({ error: "No recorded sessions" }, { status: 404 });
      }
      const proto = req.headers.get("x-forwarded-proto") || "https";
      const host = req.headers.get("host") || url.host;
      return Response.redirect(`${proto}://${host}/session/${latestId}/video.mp4?audio`);
    }

    if (url.pathname === "/latest/export") {
      const latestId = await findLatestSessionId();
      if (!latestId) {
        return Response.json({ error: "No recorded sessions" }, { status: 404 });
      }
      const meta = await getSessionExportMeta(latestId, store);
      return Response.json({ ...meta, sessionId: latestId });
    }

    // --- Health (zero I/O) ---

    if (url.pathname === "/health") {
      return Response.json(computeHealth({
        serverStartTime,
        wasmLoaded: registry.wasmLoaded(),
      }));
    }

    // --- Stats ---

    if (url.pathname === "/stats") {
      return Response.json(await registry.stats(wifiIp, PORT, serverStartTime, audioTapBus.tapCount()));
    }

    // --- Gallery API ---

    if (url.pathname === "/gallery/api") {
      const showAll = true;
      const userId: string | undefined = undefined;
      console.log(`[gallery] showAll=${showAll}`);
      const recorded = await sessionStore.galleryCached(userId, undefined, showAll, () => new Set(registry.listActive().map(s => s.id)));
      console.log(`[gallery] recorded=${recorded.length}`);

      // Merge live sessions that aren't in R2 yet (apply same visibility rules)
      const r2Ids = new Set(recorded.map(s => s.sessionId));
      const liveEntries = registry.listActive()
        .filter(s => !r2Ids.has(s.id))
        // Only show non-terminal, non-ephemeral sessions as live
        .filter(s => {
          const session = registry.get(s.id);
          return session && ["created", "active", "standby", "paused", "orphaned"].includes(session.state) && !session.flags.ephemeral;
        })
        .map(s => {
          return {
            sessionId: s.id,
            live: true,
            startedAt: new Date(Date.now() - s.uptimeMs).toISOString(),
            device: {
              deviceName: s.metadata.deviceName,
              deviceModel: s.metadata.deviceModel,
              wearableType: s.metadata.wearableType,
            },
            segments: 0,
            audioChunks: 0,
            exportCached: false,
            hasThumbnail: false,
            thumbnailUrl: `/session/${s.id}/thumbnail`,
            videoUrl: `/session/${s.id}/video.mp4?audio`,
            accessLevel: s.accessLevel as AccessLevel,
            acl: s.acl as AclEntry[],
          };
        });

      return Response.json([...liveEntries, ...recorded], {
        headers: { "Cache-Control": "public, max-age=30" },
      });
    }

    // --- Live Sessions (active relay sessions) ---

    if (url.pathname === "/sessions") {
      // Only show sessions that have (or had) a publisher — skip phantom sessions
      const active = registry.listActive().filter(s => s.publisherConnected || s.metadata.deviceName);

      const historicalSessionIds = await sessionStore.getSessionIds();

      const activeIds = new Set(active.map(s => s.id));
      const result = [
        ...active.map(s => ({
          id: s.id,
          live: true,
          publisherConnected: s.publisherConnected,
          publisherStandby: (registry.get(s.id)?.publisher?.standby ?? true) as boolean,
          viewerCount: s.viewerCount,
          metadata: s.metadata,
          uptimeMs: s.uptimeMs,
          activeWorkflowId: s.activeWorkflowId ?? null,
        })),
        ...historicalSessionIds
          .filter(id => !activeIds.has(id))
          .map(id => ({ id, live: false })),
      ];
      return Response.json(result);
    }

    // --- Share token management: POST /session/{id}/share ---

    // --- Share token management: removed (auth disabled) ---
    // --- Revoke share token: removed (auth disabled) ---
    // --- List share tokens: removed (auth disabled) ---
    // --- Update access level/ACL: removed (auth disabled) ---

    // --- Push audio to publisher: POST /session/<id>/audio-in ---

    const audioInMatch = url.pathname.match(/^\/session\/([^/]+)\/audio-in$/);
    if (audioInMatch && req.method === "POST") {
      const sessionId = audioInMatch[1];

      const buf = await req.arrayBuffer();
      if (buf.byteLength < AUDIO_HEADER_SIZE) return Response.json({ error: "Payload too small" }, { status: 400 });

      const data = new Uint8Array(buf);
      if (!isAudioFrame(data)) return Response.json({ error: "Not a FRAU frame" }, { status: 400 });

      const audioHdr = parseAudioHeader(data);

      // Record inbound audio to session
      const session = registry.get(sessionId);
      session?.recorder?.appendAudio(data);

      // Fan out to viewers so they hear it too
      registry.fanoutAudio(sessionId, data, audioHdr?.codecType ?? 3, audioHdr?.sampleRate ?? 22050);

      // Push to publisher for local playback
      const sent = registry.sendToPublisher(sessionId, data);
      if (!sent) return Response.json({ error: "No connected publisher" }, { status: 404 });

      return Response.json({ ok: true, bytes: data.length });
    }

    // --- Session Thumbnail ---

    const thumbMatch = url.pathname.match(/^\/session\/([^/]+)\/thumbnail$/);
    if (thumbMatch) {
      const sessionId = registry.resolveRecordingId(thumbMatch[1]);

      try {
        const jpeg = await getSessionThumbnail(sessionId, store);
        if (!jpeg) return Response.json({ error: "No video data" }, { status: 404 });
        return new Response(new Uint8Array(jpeg), {
          headers: {
            "Content-Type": "image/jpeg",
            "Cache-Control": "public, max-age=86400",
          },
        });
      } catch (err) {
        console.error("[thumbnail]", err);
        return Response.json({ error: "Thumbnail failed" }, { status: 500 });
      }
    }

    // --- Session Export (mp4) — serves cached R2 version or builds + caches ---

    const mp4Match = url.pathname.match(/^\/session\/([^/]+)\/video\.mp4$/);
    if (mp4Match) {
      // Resolve sessionId → recordingId (R2 prefix may differ from session ID)
      const sessionId = registry.resolveRecordingId(mp4Match[1]);
      const includeAudio = url.searchParams.has("audio");
      const forceRebuild = url.searchParams.has("rebuild");
      try {
        // Serve from R2 cache if available — proxy through server to avoid
        // cross-origin redirect issues (R2 signed URLs are different origin).
        const cachedUrl = forceRebuild ? null : await getCachedMp4Url(sessionId, store, includeAudio);
        if (cachedUrl) {
          console.log(`[export] Proxying cached MP4 for ${sessionId.slice(0, 8)}`);
          const abortCtrl = new AbortController();
          // Abort R2 fetch if client disconnects
          req.signal?.addEventListener("abort", () => abortCtrl.abort(), { once: true });
          const mp4Resp = await fetch(cachedUrl, { signal: abortCtrl.signal });
          if (mp4Resp.ok) {
            return new Response(mp4Resp.body, {
              headers: {
                "Content-Type": "video/mp4",
                "Content-Length": mp4Resp.headers.get("content-length") || "",
                "Cache-Control": "public, max-age=3600",
              },
            });
          }
          // R2 fetch failed — fall through to rebuild
          console.warn(`[export] R2 cache fetch failed (${mp4Resp.status}), rebuilding`);
        }
        // Build, stream to client, and persist to R2
        return await exportAndCacheMp4({ sessionId, store, includeAudio });
      } catch (err) {
        if (err instanceof ExportError) {
          return Response.json({ error: err.message }, { status: err.status });
        }
        console.error("[export] Unexpected error:", err);
        return Response.json({ error: "Export failed" }, { status: 500 });
      }
    }

    // --- Session Export Metadata ---

    const exportMetaMatch = url.pathname.match(/^\/session\/([^/]+)\/export$/);
    if (exportMetaMatch) {
      const sessionId = registry.resolveRecordingId(exportMetaMatch[1]);
      const meta = await getSessionExportMeta(sessionId, store);
      return Response.json(meta);
    }

    // --- S3 Retrieval Endpoints (auth-gated) ---

    const videoMatch = url.pathname.match(/^\/session\/([^/]+)\/video\/(.+)$/);
    if (videoMatch) {
      const [, id, seg] = videoMatch;
      const key = `sessions/${id}/video/${seg}`;
      try {
        const signed = await sessionStore.signedUrl(key, 3600);
        return Response.redirect(signed);
      } catch {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
    }

    const audioMatch = url.pathname.match(/^\/session\/([^/]+)\/audio\/(.+)$/);
    if (audioMatch) {
      const [, id, chunk] = audioMatch;
      const key = `sessions/${id}/audio/${chunk}`;
      try {
        const signed = await sessionStore.signedUrl(key, 3600);
        return Response.redirect(signed);
      } catch {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
    }

    // --- Runtime config for SPA (gateway handles this, but keep as fallback for direct access) ---

    if (url.pathname === "/api/config") {
      return Response.json({
        noAuth: true,
        version: { gitCommit: VIEWER_GIT_COMMIT, buildVersion: VIEWER_BUILD_VERSION },
      });
    }

    // --- Fleet: list all known devices with online status ---

    if (url.pathname === "/api/registered-devices" && req.method === "GET") {
      const dbDevices = q.listAllDevices();

      // Cross-reference with active sessions to determine online status + lastSeen
      const activeSessions = registry.listActive();
      const onlineDeviceIds = new Set<string>();
      const deviceLastSeen = new Map<string, string>();
      for (const s of activeSessions) {
        if (s.publisherConnected && s.metadata.deviceId) {
          onlineDeviceIds.add(s.metadata.deviceId);
          deviceLastSeen.set(s.metadata.deviceId, new Date().toISOString());
        }
      }

      const devices = dbDevices.map(d => ({
        device_id: d.id,
        deviceName: d.name,
        deviceModel: d.model,
        systemVersion: d.systemVersion,
        wearableType: d.wearableType,
        appVersion: d.appVersion,
        buildNumber: d.buildNumber,
        battery: d.batteryLevel,
        online: onlineDeviceIds.has(d.id),
        lastSeen: deviceLastSeen.get(d.id) ?? d.lastSeenAt,
        apnsToken: d.hasApnsToken ? "registered" : null,
      }));
      return Response.json({ devices });
    }

    // --- Fleet: build history for a specific device ---
    if (url.pathname.startsWith("/api/devices/") && url.pathname.endsWith("/build-history") && req.method === "GET") {
      const deviceId = url.pathname.split("/")[3];
      if (!deviceId) return Response.json({ error: "Device ID required" }, { status: 400 });
      const history = q.getDeviceBuildHistory(decodeURIComponent(deviceId));
      return Response.json({ builds: history });
    }

    // --- Fleet: bulk delete devices ---
    if (url.pathname === "/api/devices" && req.method === "DELETE") {
      try {
        const body = await req.json() as { deviceIds?: string[] };
        if (!body.deviceIds?.length) {
          return Response.json({ error: "deviceIds required" }, { status: 400 });
        }
        dbWriter.enqueue(q.deleteDevices(body.deviceIds));
        dbWriter.flushNow();
        console.log(`[fleet] Deleted ${body.deviceIds.length} device(s): ${body.deviceIds.map(id => id.slice(0, 8)).join(", ")}`);
        return Response.json({ ok: true, deleted: body.deviceIds.length });
      } catch (e) {
        console.error("[fleet] Device delete failed:", e);
        return Response.json({ error: "Invalid request body" }, { status: 400 });
      }
    }

    // --- APNs Device Token Registration ---

    if (url.pathname === "/api/device-token" && req.method === "POST") {
      try {
        const body = await req.json() as { deviceId?: string; deviceToken?: string; platform?: string; bundleId?: string };
        if (!body.deviceId || !body.deviceToken) {
          return Response.json({ error: "deviceId and deviceToken required" }, { status: 400 });
        }
        dbWriter.enqueue(q.updateDeviceToken(body.deviceId, body.deviceToken));
        dbWriter.flushNow();
        console.log(`[apns] Device token registered for ${body.deviceId.slice(0, 8)}... (${(body.deviceToken as string).slice(0, 8)}...)`);
        return Response.json({ ok: true });
      } catch (e) {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }
    }

    // --- Wake Device via APNs ---

    if (url.pathname === "/api/wake-device" && req.method === "POST") {
      try {
        const body = await req.json() as { deviceId?: string; sessionId?: string };

        // Resolve deviceId: explicit > session metadata > in-memory map > DB fallback
        let deviceId = body.deviceId;
        if (!deviceId && body.sessionId) {
          const session = registry.getSession(body.sessionId);
          deviceId = session?.metadata?.deviceId ?? undefined;
          if (!deviceId) {
            deviceId = registry.findDeviceBySession(body.sessionId);
          }
          if (!deviceId) {
            deviceId = q.findDeviceBySessionDb(body.sessionId) ?? undefined;
          }
        }
        if (!deviceId) {
          return Response.json({ error: "No device found for this session" }, { status: 404 });
        }

        // Check if device already has an active WebSocket connection
        const existingSessionId = registry.findByDevice(deviceId);
        if (existingSessionId) {
          const session = registry.getSession(existingSessionId);
          if (session?.publisher?.ws && session.publisher.ws.readyState === 1) { // WebSocket.OPEN
            console.log(`[wake] Device ${deviceId.slice(0, 8)} already connected — sending start_stream directly`);
            session.publisher.ws.send(JSON.stringify({ type: "start_stream" }));
            return Response.json({ ok: true, status: "already_connected" });
          }
        }

        // Look up APNs device token
        const deviceToken = q.getDeviceToken(deviceId);
        if (!deviceToken) {
          return Response.json({ error: "No device token registered for this device" }, { status: 404 });
        }

        if (!isApnsConfigured()) {
          return Response.json({ error: "APNs not configured on server" }, { status: 503 });
        }

        // Send both silent + visible push simultaneously.
        // Silent push wakes the app in background (when iOS delivers it).
        // Visible push shows a banner the user can tap (reliable even when silent is throttled).
        console.log(`[wake] Sending silent + visible push to device ${deviceId.slice(0, 8)}...`);
        const [silentResult, visibleResult] = await Promise.all([
          sendSilentWake(deviceToken, body.sessionId),
          sendVisibleWake(deviceToken, body.sessionId),
        ]);

        if (silentResult.reason === "Unregistered" || silentResult.reason === "BadDeviceToken") {
          dbWriter.enqueue(q.clearDeviceToken(deviceId));
          return Response.json({ error: "Device token invalid", reason: silentResult.reason }, { status: 410 });
        }

        console.log(`[wake] Silent: ${silentResult.success ? "sent" : silentResult.reason}, Visible: ${visibleResult.success ? "sent" : visibleResult.reason}`);
        return Response.json({ ok: true, status: "push_sent", silent: silentResult.success, visible: visibleResult.success });
      } catch (e) {
        const apnsStatus = {
          configured: isApnsConfigured(),
          keyId: process.env.APNS_KEY_ID ? "set" : "missing",
          teamId: process.env.APNS_TEAM_ID ? "set" : "missing",
          bundleId: process.env.APNS_BUNDLE_ID ?? "N/A",
          production: process.env.APNS_PRODUCTION ?? "N/A",
        };
        return Response.json({ error: "Wake handler error", msg: String(e), apns: apnsStatus }, { status: 500 });
      }
    }

    // --- App Registry ---

    if (url.pathname === "/apps") {
      // All apps are now published workflows — each processable node becomes its own tab
      const publishedWorkflows = q.listWorkflows()
        .filter(w => w.status === "published")
        .flatMap(w => {
          const nodes = q.getWorkflowNodes(w.id);
          const edges = q.getWorkflowEdges(w.id);
          const wfRow = q.getWorkflow(w.id);
          try {
            return resolveWorkflowToPipeline(
              nodes.map(n => ({ ...n, config: JSON.parse(n.config) })) as any,
              edges as any,
              { id: w.id, name: w.name },
              wfRow?.flowConfig ? JSON.parse(wfRow.flowConfig) : null,
              wfRow?.settings ? JSON.parse(wfRow.settings) : null,
            );
          } catch { return []; }
        });
      return Response.json(publishedWorkflows);
    }

    // --- Primitives (for workflow node palette metadata) ---

    if (url.pathname === "/primitives") {
      return Response.json(appRegistry.listPrimitives().map(p => ({
        id: p.id,
        inputs: p.inputs,
        outputs: p.outputs,
      })));
    }

    // --- Workflow CRUD ---

    // Node definitions (single source of truth for frontend)
    if (url.pathname === "/api/node-definitions" && req.method === "GET") {
      return Response.json(NODE_DEFINITIONS);
    }

    // List workflows
    if (url.pathname === "/workflows" && req.method === "GET") {
      const rows = q.listWorkflows();
      return Response.json(rows.map(r => ({
        id: r.id,
        name: r.name,
        description: r.description,
        status: r.status,
        ownerId: r.ownerId,
        nodeCount: r.nodeCount,
        updatedAt: r.updatedAt,
      })));
    }

    // Create workflow
    if (url.pathname === "/workflows" && req.method === "POST") {
      try {
        const body = await req.json() as {
          name?: string;
          description?: string;
          nodes?: Array<{ id: string; type: string; label?: string; config?: string; positionX?: number; positionY?: number }>;
          edges?: Array<{ id: string; sourceNodeId: string; targetNodeId: string }>;
        };
        if (!body.name) return Response.json({ error: "name required" }, { status: 400 });

        const id = `wf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const nodes = body.nodes ?? [];
        const edges = body.edges ?? [];

        // Validate: exactly 1 source, at least 1 processor, 1 output
        if (nodes.length > 0) {
          const structErr = validateStructure(nodes);
          if (structErr) return Response.json({ error: structErr }, { status: 400 });
        }
        const edgeErr = validateEdges(nodes, edges);
        if (edgeErr) return Response.json({ error: edgeErr }, { status: 400 });

        dbWriter.enqueue(q.insertWorkflow({
          id,
          name: body.name,
          description: body.description,
          nodes,
          edges,
        }));
        dbWriter.flushNow();

        const wf = q.getWorkflow(id);
        return Response.json({
          id: wf!.id,
          name: wf!.name,
          description: wf!.description,
          status: wf!.status,
          ownerId: wf!.ownerId,
          nodes: q.getWorkflowNodes(id).map(n => ({
            id: n.id, type: n.type, label: n.label,
            config: JSON.parse(n.config), positionX: n.positionX, positionY: n.positionY,
          })),
          edges: q.getWorkflowEdges(id).map(e => ({
            id: e.id, sourceNodeId: e.sourceNodeId, targetNodeId: e.targetNodeId,
          })),
          canvasViewport: JSON.parse(wf!.canvasViewport ?? '{"x":0,"y":0,"zoom":1}'),
          flowConfig: wf!.flowConfig ? JSON.parse(wf!.flowConfig) : null,
          settings: wf!.settings ? JSON.parse(wf!.settings) : null,
          createdAt: wf!.createdAt,
          updatedAt: wf!.updatedAt,
        }, { status: 201 });
      } catch (e) {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }
    }

    // Workflow detail / update / delete (prefix match)
    const wfMatch = url.pathname.match(/^\/workflows\/([^/]+)$/);
    if (wfMatch) {
      const wfId = wfMatch[1];

      if (req.method === "GET") {
        const wf = q.getWorkflow(wfId);
        if (!wf) return Response.json({ error: "Workflow not found" }, { status: 404 });
        return Response.json({
          id: wf.id, name: wf.name, description: wf.description,
          status: wf.status, ownerId: wf.ownerId,
          nodes: q.getWorkflowNodes(wfId).map(n => ({
            id: n.id, type: n.type, label: n.label,
            config: JSON.parse(n.config), positionX: n.positionX, positionY: n.positionY,
          })),
          edges: q.getWorkflowEdges(wfId).map(e => ({
            id: e.id, sourceNodeId: e.sourceNodeId, targetNodeId: e.targetNodeId,
          })),
          canvasViewport: JSON.parse(wf.canvasViewport ?? '{"x":0,"y":0,"zoom":1}'),
          flowConfig: wf.flowConfig ? JSON.parse(wf.flowConfig) : null,
          settings: wf.settings ? JSON.parse(wf.settings) : null,
          createdAt: wf.createdAt, updatedAt: wf.updatedAt,
        });
      }

      if (req.method === "PUT") {
        try {
          const body = await req.json() as {
            name?: string; description?: string; status?: string;
            canvasViewport?: string;
            flowConfig?: { mode: string; flowOrder: string[]; flowTriggers?: Record<string, FlowTrigger> } | null;
            settings?: WorkflowSettings | null;
            nodes?: Array<{ id: string; type: string; label?: string; config?: string; positionX?: number; positionY?: number }>;
            edges?: Array<{ id: string; sourceNodeId: string; targetNodeId: string }>;
          };
          const existing = q.getWorkflow(wfId);
          if (!existing) return Response.json({ error: "Workflow not found" }, { status: 404 });

          // Validate if nodes provided
          if (body.nodes) {
            const structErr = validateStructure(body.nodes);
            if (structErr) return Response.json({ error: structErr }, { status: 400 });
            const edgeErr = validateEdges(body.nodes, body.edges ?? q.getWorkflowEdges(wfId));
            if (edgeErr) return Response.json({ error: edgeErr }, { status: 400 });
          }

          dbWriter.enqueue(q.updateWorkflow(wfId, {
            name: body.name,
            description: body.description,
            status: body.status,
            canvasViewport: body.canvasViewport,
            flowConfig: body.flowConfig !== undefined
              ? (body.flowConfig === null ? null : JSON.stringify(body.flowConfig))
              : undefined,
            settings: body.settings !== undefined
              ? (body.settings === null ? null : JSON.stringify(body.settings))
              : undefined,
            nodes: body.nodes?.map(n => ({ ...n, config: n.config ?? "{}" })),
            edges: body.edges,
          }));
          dbWriter.flushNow();

          const wf = q.getWorkflow(wfId);
          return Response.json({
            id: wf!.id, name: wf!.name, description: wf!.description,
            status: wf!.status, ownerId: wf!.ownerId,
            nodes: q.getWorkflowNodes(wfId).map(n => ({
              id: n.id, type: n.type, label: n.label,
              config: JSON.parse(n.config), positionX: n.positionX, positionY: n.positionY,
            })),
            edges: q.getWorkflowEdges(wfId).map(e => ({
              id: e.id, sourceNodeId: e.sourceNodeId, targetNodeId: e.targetNodeId,
            })),
            canvasViewport: JSON.parse(wf!.canvasViewport ?? '{"x":0,"y":0,"zoom":1}'),
            flowConfig: wf!.flowConfig ? JSON.parse(wf!.flowConfig) : null,
            settings: wf!.settings ? JSON.parse(wf!.settings) : null,
            createdAt: wf!.createdAt, updatedAt: wf!.updatedAt,
          });
        } catch (e) {
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        }
      }

      if (req.method === "DELETE") {
        dbWriter.enqueue(q.deleteWorkflow(wfId));
        dbWriter.flushNow();
        return Response.json({ ok: true });
      }
    }

    // Activate workflow against a session
    const wfActivateMatch = url.pathname.match(/^\/workflows\/([^/]+)\/activate$/);
    if (wfActivateMatch && req.method === "POST") {
      try {
        const wfId = wfActivateMatch[1];
        const body = await req.json() as { sessionId?: string; deviceId?: string; override?: boolean; reason?: string; wakeActivation?: boolean };
        return await handleWorkflowActivation(
          { orchestrator, jepaOrchestrator, reidOrchestrator, palantirOrchestrator, appRegistry, registry, pendingWakeActivations, getH264Decoder, sendCachedFrameToAI },
          wfId,
          body,
        );
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 500 });
      }
    }

    // --- Session Stream Control (start/stop camera stream) ---
    // Independent of workflow activation — just sends start_stream/stop_stream
    // to the publisher's WebSocket, same as the live viewer does.

    const sessStartMatch = url.pathname.match(/^\/session\/([^/]+)\/start-stream$/);
    if (sessStartMatch && req.method === "POST") {
      try {
        const sessionId = sessStartMatch[1];
        const session = registry.getSession(sessionId);
        if (!session?.publisher?.ws || session.publisher.ws.readyState !== WebSocket.OPEN) {
          return Response.json({ error: "Publisher not connected" }, { status: 404 });
        }
        session.publisher.ws.send(JSON.stringify({ type: "start_stream" }));
        console.log(`[stream-control] start_stream sent to session ${sessionId}`);
        return Response.json({ ok: true, sessionId });
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 500 });
      }
    }

    const sessStopMatch = url.pathname.match(/^\/session\/([^/]+)\/stop-stream$/);
    if (sessStopMatch && req.method === "POST") {
      try {
        const sessionId = sessStopMatch[1];
        const session = registry.getSession(sessionId);
        if (!session?.publisher?.ws || session.publisher.ws.readyState !== WebSocket.OPEN) {
          return Response.json({ error: "Publisher not connected" }, { status: 404 });
        }
        session.publisher.ws.send(JSON.stringify({ type: "stop_stream" }));
        console.log(`[stream-control] stop_stream sent to session ${sessionId}`);
        return Response.json({ ok: true, sessionId });
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 500 });
      }
    }

    // --- Guidance History ---

    const guidanceMatch = url.pathname.match(/^\/session\/([^/]+)\/guidance$/);
    if (guidanceMatch) {
      const gSessionId = guidanceMatch[1];
      return Response.json({
        history: orchestrator.getEventHistory(gSessionId),
        status: orchestrator.getStatus(gSessionId),
        telemetry: orchestrator.getTelemetry(gSessionId),
      });
    }

    // --- Persisted Guidance History (reads from R2, works for recorded sessions) ---
    const guidanceHistoryMatch = url.pathname.match(/^\/session\/([^/]+)\/guidance\/history$/);
    if (guidanceHistoryMatch) {
      const gSessionId = guidanceHistoryMatch[1];
      const buf = await store.get(`sessions/${gSessionId}/guidance.jsonl`);
      if (!buf) return Response.json({ events: [], count: 0 });
      const lines = new TextDecoder().decode(buf).trim().split("\n").filter(Boolean);
      const events = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      return Response.json({ events, count: events.length });
    }

    // --- AI Telemetry ---

    if (url.pathname === "/telemetry/ai") {
      const sessionId = url.searchParams.get("session");

      if (sessionId) {
        // Per-session AI telemetry
        return Response.json({
          sessionId,
          status: orchestrator.getStatus(sessionId),
          telemetry: orchestrator.getTelemetry(sessionId),
          eventHistory: orchestrator.getEventHistory(sessionId),
        });
      }

      // Aggregate across all sessions
      const sessionIds = orchestrator.listSessions();
      const sessions: Record<string, any> = {};
      let totalTriggers = 0;
      let totalGuidanceEvents = 0;

      for (const id of sessionIds) {
        const s = orchestrator.getStatus(id);
        const t = orchestrator.getTelemetry(id);
        const h = orchestrator.getEventHistory(id);
        sessions[id] = { status: s, telemetry: t, eventCount: h.length };
        totalTriggers += t.triggers;
        totalGuidanceEvents += t.guidanceEvents;
      }

      return Response.json({
        aggregate: {
          sessions: sessionIds.length,
          totalTriggers,
          totalGuidanceEvents,
        },
        sessions,
      });
    }

    // --- AI Telemetry Live Log WebSocket: /telemetry/ai/log ---

    if (url.pathname === "/telemetry/ai/log") {
      const sessionId = url.searchParams.get("session") || undefined;
      server.upgrade(req, { data: { role: "ai-log", clientIp: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || server.requestIP(req)?.address.replace(/::ffff:/, "") || "unknown", sessionId: sessionId ?? "all", userId: undefined, email: undefined } });
      return new Response(null, { status: 204 });
    }

    // --- Audio tap WebSocket: /tap/audio?session=<id> ---

    if (url.pathname === "/tap/audio") {
      const sessionId = url.searchParams.get("session") || "default";
      const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
        || req.headers.get("x-real-ip")
        || server.requestIP(req)?.address.replace(/::ffff:/, "")
        || "unknown";
      server.upgrade(req, { data: { role: "audio-tap", clientIp, sessionId, userId: undefined, email: undefined } });
      return new Response(null, { status: 204 });
    }

    // --- /view as HTML page (browser GET) or WebSocket upgrade ---

    const isPublish = url.pathname === "/publish";
    const isView = url.pathname === "/view";
    if (!isPublish && !isView) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    // Viewer page now served by Caddy (SPA) — only handle WebSocket upgrades
    const wsUpgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
    if (isView && !wsUpgrade) {
      const proto = req.headers.get("x-forwarded-proto") || "https";
      const host = req.headers.get("host") || url.host;
      return Response.redirect(`${proto}://${host}/`);
    }

    const role = isPublish ? "publish" : "view";
    const sessionId = isPublish
      ? registry.resolvePublisherSessionId(url)
      : registry.resolveViewerSessionId(url);
    const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || req.headers.get("x-real-ip")
      || server.requestIP(req)?.address.replace(/::ffff:/, "")
      || "unknown";

    server.upgrade(req, { data: { role, clientIp, sessionId, userId: undefined, email: undefined } });
    return new Response(null, { status: 204 });
  },
  websocket: {
    async open(ws) {
      const { role, clientIp, sessionId } = ws.data;

      if (role === "audio-tap") {
        const unsub = audioTapBus.onFrame((frame) => {
          if (ws.readyState !== WebSocket.OPEN) { unsub(); return; }
          // Filter by session if specified
          if (sessionId && frame.sessionId && frame.sessionId !== sessionId) return;
          // Send binary FRAU v1 frame (raw PCM) instead of base64 JSON for efficiency
          const frauFrame = buildAudioFrame(frame.codecType, frame.sequence, frame.sampleRate, frame.channels, frame.bitsPerSample, frame.timestampMs, new Uint8Array(frame.pcm));
          ws.send(frauFrame);
        });
        ws.data = { ...ws.data, unsub };
        console.log(`[relay] Audio tap connected: session=${sessionId} taps=${audioTapBus.tapCount()}`);
        return;
      }

      if (role === "ai-log") {
        // Subscribe to guidance events for all sessions (or a specific one)
        const filterSession = sessionId === "all" ? undefined : sessionId;
        const send = (msg: any) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
        };

        // Subscribe to existing sessions and track subscriptions for cleanup
        const unsubs: (() => void)[] = [];

        // If specific session, subscribe to that one
        if (filterSession) {
          const unsub = orchestrator.subscribeViewer(filterSession, send);
          unsubs.push(unsub);
          // Send initial state
          send({ type: "ai_status", status: orchestrator.getStatus(filterSession) });
          send({ type: "ai_telemetry", telemetry: orchestrator.getTelemetry(filterSession) });
          for (const evt of orchestrator.getEventHistory(filterSession)) {
            send({ type: "guidance_event", event: evt });
          }
        } else {
          // Subscribe to all known sessions
          for (const id of orchestrator.listSessions()) {
            const unsub = orchestrator.subscribeViewer(id, send);
            unsubs.push(unsub);
            send({ type: "ai_status", status: orchestrator.getStatus(id), sessionId: id });
            send({ type: "ai_telemetry", telemetry: orchestrator.getTelemetry(id), sessionId: id });
            for (const evt of orchestrator.getEventHistory(id)) {
              send({ type: "guidance_event", event: evt, sessionId: id });
            }
          }
        }

        ws.data = { ...ws.data, aiLogUnsubs: unsubs };
        console.log(`[relay] AI telemetry log connected: session=${filterSession ?? "all"}`);
        return;
      }

      if (role === "publish") {
        const err = await registry.claimPublisher(sessionId, ws, clientIp, ws.data.userId, ws.data.email);
        if (err) {
          ws.close(err === "session owned by another user" ? 4003 : 4001, err);
          return;
        }
        // Tell the publisher what session it's on
        ws.send(JSON.stringify({ type: "session_assigned", sessionId }));

        // Check lifecycle policy: on reconnect, should we resume AI?
        const session = registry.get(sessionId);
        const aiStatus = orchestrator.getStatus(sessionId);
        if (session?.activeAppId && aiStatus.status !== "idle") {
          const lifecycleConfig = aiStatus.config?.lifecycle as { onReconnect?: string } | undefined;
          const onReconnect = lifecycleConfig?.onReconnect ?? "restart";
          if (onReconnect === "noop") {
            // Do nothing — AI continues as-is
          }
          // Note: "resume" and "restart" are handled by the orchestrator state.
          // For "restart", the server could trigger re-activation here, but
          // that requires the workflow ID. For now, the orchestrator keeps
          // the AI running on "continue" policy, and "pause" was already handled
          // on disconnect. A full restart would require storing the workflow ID
          // in the session metadata.
          console.log(`[relay] Publisher reconnected: AI policy=${onReconnect} session=${sessionId}`);
        }

        // Replay workflow config if there's an active workflow (publisher reconnected)
        // Check in-memory first, then fall back to DB (survives server restarts)
        let wfId = session?.activeWorkflowId;
        if (!wfId) {
          const dbSession = q.getSession(sessionId);
          wfId = (dbSession as any)?.active_workflow_id ?? (dbSession as any)?.activeWorkflowId ?? undefined;
          if (wfId && session) {
            session.activeWorkflowId = wfId;
            console.log(`[relay] Restored activeWorkflowId=${wfId} from DB for session=${sessionId}`);
          }
        }
        if (wfId && ws.readyState === WebSocket.OPEN) {
          const wf = q.getWorkflow(wfId);
          if (wf) {
            const wfNodes = q.getWorkflowNodes(wfId);
            const wfEdges = q.getWorkflowEdges(wfId);
            if (wfNodes.length > 0) {
              const typedNodes = wfNodes.map(n => ({
                id: n.id,
                type: n.type,
                config: typeof n.config === "string" ? JSON.parse(n.config) : (n.config ?? {}),
              }));
              dispatchWorkflowConfig(ws, typedNodes, sessionId, wfEdges);
              console.log(`[relay] Replayed workflow config for ${wfId} on publisher reconnect session=${sessionId}`);
            }
          }
        }

        // Notify viewers that publisher is in standby (connected but not streaming)
        broadcastToViewers(registry.get(sessionId), { type: "publisher_status", status: "standby" });
      } else {
        const result = await registry.addViewer(sessionId, ws, clientIp, ws.data.userId, ws.data.email, undefined);
        if (result.startsWith("error:")) {
          ws.close(4003, result.slice(6));
          return;
        }
        // Subscribe viewer to guidance events for this session
        const unsubGuidance = orchestrator.subscribeViewer(sessionId, (msg: any) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
          }
        });
        ws.data.guidanceUnsub = unsubGuidance;

        // Send current node states if a workflow is active
        const activeSess = registry.get(sessionId);
        if (activeSess?.activeWorkflowId) {
          orchestrator.broadcastNodeStates(sessionId, activeSess.activeWorkflowId);
        }

        // Send cached last frame so viewer sees current scene immediately
        const cachedFrame = registry.getLastFrame(sessionId);
        if (cachedFrame && ws.readyState === WebSocket.OPEN) {
          ws.send(cachedFrame);
          console.log(`[relay] Sent cached frame (${cachedFrame.length}B) to new viewer session=${sessionId}`);
        }

        // Send session info so viewer can populate the info strip
        const sessForInfo = registry.get(sessionId);
        if (sessForInfo && ws.readyState === WebSocket.OPEN) {
          const si = buildSessionInfo(sessForInfo);
          ws.send(JSON.stringify({ type: "session_info", ...si }));
        }
      }
    },
    async message(ws, message) {
      const wsMessageDeps: WsMessageDeps = {
        registry, orchestrator, jepaOrchestrator, reidOrchestrator, palantirOrchestrator, appRegistry,
        detectionThrottle, audioTapBus, controlEventBus,
        getH264Decoder, stopH264Decoder, sendCachedFrameToAI,
        broadcastToViewers, buildSessionInfo,
        pendingWakeActivations,
        wifiIp, PORT, serverStartTime,
      };
      await handleWsMessage(ws, message, wsMessageDeps);
    },
    async close(ws, code, _reason) {
      const { role, sessionId } = ws.data;

      if (role === "audio-tap") {
        if (ws.data.unsub) ws.data.unsub();
        console.log(`[relay] Audio tap disconnected: session=${sessionId} taps=${audioTapBus.tapCount()}`);
        return;
      }

      if (role === "ai-log") {
        if (ws.data.aiLogUnsubs) {
          for (const unsub of ws.data.aiLogUnsubs) unsub();
        }
        console.log(`[relay] AI telemetry log disconnected: session=${sessionId ?? "all"}`);
        return;
      }

      if (role === "publish") {
        // Check lifecycle policy before deciding AI behavior on disconnect
        const session = registry.get(sessionId);
        if (session?.activeAppId) {
          const aiStatus = orchestrator.getStatus(sessionId);
          const lifecycleConfig = aiStatus.config?.lifecycle as { onDisconnect?: string; autoDeactivateMin?: number | null } | undefined;
          const onDisconnect = lifecycleConfig?.onDisconnect ?? "stop";

          if (onDisconnect === "stop") {
            // Default: deactivate AI on publisher disconnect
            orchestrator.deactivateApp(sessionId).catch(() => {});
            dbWriter.enqueue(q.deactivateActivation(sessionId, "publisher_disconnect"));
            dbWriter.flushNow();
          } else if (onDisconnect === "pause") {
            // Pause: disconnect AI services but keep session state
            orchestrator.forceDeactivate(sessionId);
            console.log(`[relay] AI paused (publisher disconnect) session=${sessionId}`);
          } else {
            // Continue: AI keeps running. Schedule auto-deactivation if configured.
            const autoMin = lifecycleConfig?.autoDeactivateMin;
            if (autoMin && autoMin > 0) {
              setTimeout(() => {
                // Only auto-deactivate if no publisher has reconnected
                const current = registry.get(sessionId);
                if (!current?.publisher?.ws || current.publisher.standby) {
                  console.log(`[relay] Auto-deactivating AI (timeout ${autoMin}min) session=${sessionId}`);
                  orchestrator.deactivateApp(sessionId).catch(() => {});
                  dbWriter.enqueue(q.deactivateActivation(sessionId, "auto_timeout"));
                  dbWriter.flushNow();
                }
              }, autoMin * 60 * 1000);
            }
            console.log(`[relay] AI continuing (publisher disconnect, policy=continue) session=${sessionId}`);
          }
        }
        // Notify viewers that publisher dropped (enriched with reason and reconnect hint)
        const dropReason = dropReasonFromCloseCode(code);
        const isDeviceBound = !!session?.metadata.deviceId || !!registry.findByDevice(sessionId);
        broadcastToViewers(session, {
          type: "publisher_status",
          status: "dropped",
          reason: dropReason,
          reconnectHint: {
            deviceBound: isDeviceBound,
            estimatedResumeMs: isDeviceBound ? 30_000 : undefined,
          },
        });
        // Stop H.264 decoder if running
        stopH264Decoder(sessionId);
        await registry.releasePublisher(sessionId, dropReason);
        try {
          const meta = await sessionStore.getMeta(sessionId);
          if (meta) {
            const exportCached = await sessionStore.exists(`sessions/${sessionId}/export.mp4`);
            sessionStore.updateGalleryIndexEntry(sessionId, meta, exportCached);
          }
        } catch { /* non-critical */ }
        // Generate thumbnail in background — don't block disconnect
        getSessionThumbnail(sessionId, store).catch(() => {});
        sessionStore.invalidateGalleryCache();
        sessionStore.invalidateSessionListCache();
      } else {
        const viewerId = ws.data.viewerId;
        if (viewerId) {
          registry.removeViewer(sessionId, viewerId);
        }
        // Clean up guidance subscription
        if (ws.data.guidanceUnsub) {
          ws.data.guidanceUnsub();
        }
      }
    },
  },
});

console.log(`[relay] Server on ${process.env.RELAY_TRUST_HEADERS === "1" ? "127.0.0.1" : "0.0.0.0"}:${PORT}`);
console.log(`[relay] Trusted headers: ${process.env.RELAY_TRUST_HEADERS === "1" ? "ON (gateway mode)" : "OFF (direct mode)"}`);
console.log(`[relay] Publisher: ws://${wifiIp}:${PORT}/publish[?session=<id>]`);
console.log(`[relay] Viewer:   http://${wifiIp}:${PORT}/ (served by gateway)`);
console.log(`[relay] API:      http://${wifiIp}:${PORT}/api/config`);

// --- Graceful shutdown ---

async function shutdown() {
  console.log("[relay] Shutting down...");
  clearInterval(staleCleanupTimer);
  sessionStore.stopBackgroundTimers();
  orchestrator.stop();
  // Finish all active recorders — await to prevent data loss
  const finishes: Promise<void>[] = [];
  for (const entry of registry.listActive()) {
    const s = registry.get(entry.id);
    if (s?.recorder) {
      finishes.push(s.recorder.finish());
    }
  }
  await Promise.all(finishes).catch(() => {});
  server.stop(true);
  process.exit(0);
}

process.on("SIGTERM", () => { shutdown(); });
process.on("SIGINT", () => { shutdown(); });
process.on("unhandledRejection", (err) => {
  console.error("[relay] Unhandled rejection (not crashing):", err);
});
process.on("uncaughtException", (err) => {
  console.error("[relay] Uncaught exception (not crashing):", err);
});
