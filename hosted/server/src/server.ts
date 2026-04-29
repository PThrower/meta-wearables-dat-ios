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

import type { WsData, QualityPreset, AccessLevel, AclEntry, Session } from "./types.js";
import { QUALITY_PRESETS, createTokenBucket } from "./types.js";
import { dropReasonFromCloseCode } from "./session-state.js";
import { HEADER_SIZE, AUDIO_HEADER_SIZE, SENSOR_HEADER_SIZE, isAudioFrame, isVideoFrame, isSensorFrame, parseAudioHeader, parseSensorHeader, isBackpressureMessage, isBackpressureAckMessage, buildAudioFrame, PROTOCOL_VERSION } from "./protocol.js";
import { decodeOpusFrame } from "./opus-decode.js";
import { computeHealth } from "./health.js";
import { SessionRegistry } from "./session-registry.js";
import { AudioTapBus } from "./audio-tap.js";
import { ControlEventBus } from "./control-event-bus.js";
import { AppRegistry, resolveWorkflowToApp, resolveWorkflowToPipeline } from "./app-registry.js";
import type { AppDefinition, WorkflowControlAction, WorkflowNodeType, NodeExecutionInfo, FlowExecutionConfig, FlowTrigger, DetectedFlow, WorkflowSettings } from "./app-types.js";
import { detectFlows } from "./flow-detection.js";
import { isSttResult, isVadResult } from "./message-types.js";
import { GuidanceOrchestrator } from "./guidance-orchestrator.js";
import { JEPAOrchestrator } from "./jepa-orchestrator.js";
import { NODE_DEFINITIONS, NODE_DEF_MAP, buildAllowedEdgeMap, validateStructure, resolveNodeType, isSinkType } from "./node-definitions.js";
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

/** BFS from a node to find the nearest speaker sink type — returns true if glasses-speaker reachable */
function resolveSinkTarget(
  startNodeId: string,
  nodes: Array<{ id: string; type: string }>,
  edges: Array<{ sourceNodeId: string; targetNodeId: string }>,
): boolean {
  const visited = new Set<string>();
  const queue = [startNodeId];
  visited.add(startNodeId);
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    for (const edge of edges) {
      if (edge.sourceNodeId !== currentId) continue;
      if (visited.has(edge.targetNodeId)) continue;
      visited.add(edge.targetNodeId);
      const targetNode = nodes.find(n => n.id === edge.targetNodeId);
      if (!targetNode) continue;
      const resolved = resolveNodeType(targetNode.type);
      if (resolved === "glasses-speaker") return true;
      // Keep walking through transforms
      const def = NODE_DEF_MAP.get(resolved);
      if (def?.role === "transform" || def?.role === "sink") {
        queue.push(edge.targetNodeId);
      }
    }
  }
  return false;
}

/** Estimate speech duration for a group of TTS chains (ms).
 *  ~150 wpm average, ~5 chars/word → ~12.5 chars/sec → 80ms/char.
 *  Adds 500ms buffer per chain for synthesis startup overhead. */
function estimateGroupDuration(chains: Array<{ textContent: string }>): number {
  let totalMs = 0;
  for (const chain of chains) {
    totalMs += Math.max(chain.textContent.length * 80, 1500); // floor of 1.5s per chain
    totalMs += 500; // synthesis buffer
  }
  return totalMs;
}

/** Push text→local-tts→speaker chains for passive workflows to the publisher */
function pushPassiveTTSChains(
  nodes: Array<{ id: string; type: string; config: Record<string, unknown> }>,
  edges: Array<{ sourceNodeId: string; targetNodeId: string }>,
  publisherWs: { send: (data: string) => void; readyState: number },
  sessionId: string,
  flowConfig?: FlowExecutionConfig | null,
): void {
  if (publisherWs.readyState !== 1) return; // WebSocket.OPEN

  // Build all text→tts chains, keyed by the text node's flow
  const chains: Array<{ textNodeId: string; textContent: string; ttsNodeId: string; preferGlasses: boolean; flowId: string }> = [];
  for (const node of nodes) {
    if (node.type !== "text") continue;
    const textContent = node.config?.text as string | undefined;
    if (!textContent) continue;
    for (const edge of edges) {
      if (edge.sourceNodeId !== node.id) continue;
      const ttsNode = nodes.find(n => n.id === edge.targetNodeId);
      if (!ttsNode) continue;
      const ttsDef = NODE_DEF_MAP.get(resolveNodeType(ttsNode.type));
      if (ttsDef?.type !== "local-tts") continue;
      const preferGlasses = resolveSinkTarget(ttsNode.id, nodes, edges);
      // Determine flowId from the text node (lexicographically smallest node in its component)
      const flowId = getFlowIdForNode(node.id, nodes, edges);
      chains.push({ textNodeId: node.id, textContent, ttsNodeId: ttsNode.id, preferGlasses, flowId });
    }
  }

  // Determine push order
  const flowOrder = flowConfig?.flowOrder;
  if (flowOrder && flowOrder.length > 1) {
    // Sort chains by their flow's position in flowOrder
    const orderMap = new Map(flowOrder.map((fid, idx) => [fid, idx]));
    chains.sort((a, b) => (orderMap.get(a.flowId) ?? 999) - (orderMap.get(b.flowId) ?? 999));
  }

  // For sequential mode: push all chains but with inter-flow delays
  const mode = flowConfig?.mode ?? "parallel";
  if (mode === "sequential" && chains.length > 1) {
    // Group chains by flowId, preserving configured flow order
    const flowGroups = new Map<string, typeof chains>();
    for (const chain of chains) {
      if (!flowGroups.has(chain.flowId)) flowGroups.set(chain.flowId, []);
      flowGroups.get(chain.flowId)!.push(chain);
    }
    const groups = [...flowGroups.values()];

    // Push first flow's chains immediately
    for (const chain of groups[0]) {
      publisherWs.send(JSON.stringify({ type: "audio_route", preferGlasses: chain.preferGlasses }));
      publisherWs.send(JSON.stringify({ type: "guidance_text", text: chain.textContent, preferGlasses: chain.preferGlasses }));
      console.log(`[relay] Passive TTS (sequential flow 0): pushed text (${chain.textContent.length} chars) preferGlasses=${chain.preferGlasses} session=${sessionId}`);
    }

    // Subsequent flows delayed by estimated speech duration of prior flows
    // ~150 wpm average TTS speed, ~5 chars/word → ~12.5 chars/sec → 80ms/char
    // Add 500ms buffer per chain for synthesis overhead
    let delayMs = estimateGroupDuration(groups[0]);
    for (let gi = 1; gi < groups.length; gi++) {
      const group = groups[gi];
      const capturedDelay = delayMs;
      const giLabel = gi;
      setTimeout(() => {
        for (const chain of group) {
          publisherWs.send(JSON.stringify({ type: "audio_route", preferGlasses: chain.preferGlasses }));
          publisherWs.send(JSON.stringify({ type: "guidance_text", text: chain.textContent, preferGlasses: chain.preferGlasses }));
          console.log(`[relay] Passive TTS (sequential flow ${giLabel}, delayed ${capturedDelay}ms): pushed text (${chain.textContent.length} chars) preferGlasses=${chain.preferGlasses} session=${sessionId}`);
        }
      }, delayMs);
      delayMs += estimateGroupDuration(group);
    }
    return;
  }

  // Parallel or default: push all immediately in order
  for (const chain of chains) {
    publisherWs.send(JSON.stringify({ type: "audio_route", preferGlasses: chain.preferGlasses }));
    publisherWs.send(JSON.stringify({ type: "guidance_text", text: chain.textContent, preferGlasses: chain.preferGlasses }));
    console.log(`[relay] Passive TTS: pushed text (${chain.textContent.length} chars) preferGlasses=${chain.preferGlasses} session=${sessionId}`);
  }
}

/** Determine the flowId for a node using the same algorithm as detectFlows (lexicographically smallest node in the connected component) */
function getFlowIdForNode(
  targetNodeId: string,
  nodes: Array<{ id: string }>,
  edges: Array<{ sourceNodeId: string; targetNodeId: string }>,
): string {
  // BFS from targetNodeId to find all nodes in its connected component
  const adjacency = new Map<string, string[]>();
  for (const n of nodes) adjacency.set(n.id, []);
  for (const e of edges) {
    if (adjacency.has(e.sourceNodeId) && adjacency.has(e.targetNodeId)) {
      adjacency.get(e.sourceNodeId)!.push(e.targetNodeId);
      adjacency.get(e.targetNodeId)!.push(e.sourceNodeId);
    }
  }
  const visited = new Set<string>();
  const queue = [targetNodeId];
  visited.add(targetNodeId);
  let smallest = targetNodeId;
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current < smallest) smallest = current;
    for (const neighbor of (adjacency.get(current) ?? [])) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return `flow_${smallest}`;
}

/** Build mobile-side config for passive workflows (no AI, just sinks/transforms) */
function buildMobileWorkflowConfig(
  nodes: Array<{ id: string; type: string; config: Record<string, unknown> }>,
  edges: Array<{ sourceNodeId: string; targetNodeId: string }>,
): Record<string, unknown> | null {
  const sinkNodes = nodes.filter(n => {
    const def = NODE_DEF_MAP.get(resolveNodeType(n.type));
    return def && (def.role === "sink" || def.role === "transform");
  });
  if (sinkNodes.length === 0) return null;

  const sourceNodes = nodes.filter(n => {
    const def = NODE_DEF_MAP.get(resolveNodeType(n.type));
    return def?.role === "source";
  });
  // Resolve input config from source nodes via OR-merge (same as resolveSourceInput)
  const hasCamera = sourceNodes.some(n => resolveNodeType(n.type) === "camera-source");
  const hasPhoneMic = sourceNodes.some(n => resolveNodeType(n.type) === "phone-mic-source");
  const hasGlassesMic = sourceNodes.some(n => resolveNodeType(n.type) === "glasses-mic-source");
  const hasGestures = sourceNodes.some(n => resolveNodeType(n.type) === "gesture-source");
  return {
    sinks: sinkNodes.map(n => ({ type: n.type, config: n.config })),
    input: sourceNodes.length > 0 ? {
      video: hasCamera,
      phoneMic: hasPhoneMic,
      glassesMic: hasGlassesMic,
      gestures: hasGestures,
    } : undefined,
    edges: edges.map(e => ({ source: e.sourceNodeId, target: e.targetNodeId })),
  };
}

/**
 * Dispatch workflow config messages (speech, vision, enhance, sensor, workflow)
 * to the publisher WebSocket. Called both on activation and on publisher reconnect.
 */
function dispatchWorkflowConfig(
  ws: import("ws").WebSocket | { send: (data: string) => void; readyState: number },
  nodes: Array<{ id: string; type: string; config: Record<string, unknown> }>,
  sid: string,
): void {
  if (ws.readyState !== 1 /* WebSocket.OPEN */) return;

  const speechIdx: number[] = [];
  const visionIdx: number[] = [];
  const enhanceIdx: number[] = [];
  const sensorIdx: number[] = [];

  for (let i = 0; i < nodes.length; i++) {
    const def = NODE_DEF_MAP.get(nodes[i].type);
    if (def?.activationMode === "speech")  { speechIdx.push(i);  continue; }
    if (def?.activationMode === "vision")  { visionIdx.push(i);  continue; }
    if (def?.activationMode === "enhance") { enhanceIdx.push(i); continue; }
    if (def?.activationMode === "sensor")  { sensorIdx.push(i);  continue; }
  }

  // Speech config (mobile-stt, vad)
  if (speechIdx.length > 0) {
    const speechConfigs = speechIdx.map(i => ({
      speechType: nodes[i].type,
      config: { ...(nodes[i].config ?? {}) },
    }));
    ws.send(JSON.stringify({ type: "speech_stage_config", stages: speechConfigs, enabled: true }));
    console.log(`[relay] Replayed speech config (${speechConfigs.length} stages) session=${sid}`);
  }

  // Vision config
  for (const i of visionIdx) {
    const cfg = nodes[i].config as any;
    ws.send(JSON.stringify({
      type: "vision_stage_config",
      nodeType: nodes[i].type,
      detectionTypes: [nodes[i].type],
      confidence: cfg?.confidence ?? 0.5,
      targetFPS: cfg?.targetFPS ?? 5,
      maxResults: cfg?.maxFaces ?? cfg?.maxPersons ?? cfg?.maxPoses ?? 0,
      language: cfg?.language ?? "en-US",
      symbologies: Object.entries(cfg?.symbologies ?? { qr: true }).filter(([, v]) => v).map(([k]) => k),
      maxLabels: cfg?.maxLabels ?? 5,
    }));
  }

  // Enhance config
  if (enhanceIdx.length > 0) {
    const filters = enhanceIdx.map(i => ({
      type: nodes[i].type,
      params: (nodes[i].config ?? {}) as Record<string, number>,
    }));
    ws.send(JSON.stringify({ type: "enhance_stage_config", filters, enabled: true }));
    console.log(`[relay] Replayed enhance config (${filters.length} filters) session=${sid}`);
  }

  // Sensor config
  if (sensorIdx.length > 0) {
    const sensors = sensorIdx.map(i => {
      const rawConfig = { ...(nodes[i].config ?? {}) as Record<string, unknown> };
      if (nodes[i].type === "sensor-sound" && typeof rawConfig.targetLabels === "string") {
        rawConfig.targetLabels = (rawConfig.targetLabels as string).split(",").map((s: string) => s.trim()).filter((s: string) => s.length > 0);
      }
      return { sensorType: nodes[i].type, config: rawConfig };
    });
    ws.send(JSON.stringify({ type: "sensor_stage_config", sensors, enabled: true }));
    console.log(`[relay] Replayed sensor config (${sensors.length} sensors) session=${sid}`);
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

// Clean up orchestrator state when sessions expire
registry.setOnSessionDestroy((id: string) => {
  orchestrator.cleanup(id);
  jepaOrchestrator.deactivate(id);
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

/** Broadcast a JSON message to all viewers in a session */
function broadcastToViewers(session: Session | undefined, msg: object): void {
  if (!session) return;
  const data = JSON.stringify(msg);
  for (const viewer of session.viewers.values()) {
    if (viewer.ws.readyState === WebSocket.OPEN) {
      try { viewer.ws.send(data); } catch { /* skip */ }
    }
  }
}

/** Build session_info payload for viewer info strip */
function buildSessionInfo(session: { metadata: any; viewers: Map<any, any>; recorder: any; createdAt: number; publisher: any; linkState?: string; state?: string; dropReason?: string }) {
  const publisherStatus = session.publisher
    ? (session.publisher.standby ? "standby" : "live")
    : "offline";
  return {
    deviceId: session.metadata.deviceId || null,
    deviceName: session.metadata.deviceName || null,
    deviceModel: session.metadata.deviceModel || null,
    wearableType: session.metadata.wearableType || null,
    systemVersion: session.metadata.systemVersion || null,
    appVersion: session.metadata.appVersion || null,
    buildNumber: session.metadata.buildNumber || null,
    viewerCount: session.viewers.size,
    recording: !!session.recorder?.getStats?.()?.active,
    linkState: session.linkState || null,
    publisherStatus,
    sessionAge: Date.now() - session.createdAt,
    connectedAt: session.createdAt,
    state: session.state || null,
    dropReason: session.dropReason || null,
  };
}

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

    /** Validate workflow edges — returns error string or null */
    const ALLOWED_EDGE_MAP = buildAllowedEdgeMap();
    function validateEdges(
      nodes: Array<{ id: string; type: string }>,
      edges: Array<{ sourceNodeId: string; targetNodeId: string }>,
    ): string | null {
      const nodeMap = new Map(nodes.map(n => [n.id, n.type]));
      const nodeIds = new Set(nodes.map(n => n.id));

      for (const e of edges) {
        if (!nodeIds.has(e.sourceNodeId) || !nodeIds.has(e.targetNodeId)) {
          return "Edge references unknown node";
        }
        const srcType = resolveNodeType(nodeMap.get(e.sourceNodeId)!);
        const tgtType = resolveNodeType(nodeMap.get(e.targetNodeId)!);
        if (!ALLOWED_EDGE_MAP.get(srcType)?.has(tgtType)) {
          return `Invalid edge: ${srcType} -> ${tgtType}`;
        }
      }
      return null;
    }

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

        const wf = q.getWorkflow(wfId);
        if (!wf) return Response.json({ error: "Workflow not found" }, { status: 404 });

        // Device-first activation: wake device, store pending, return immediately
        if (!body.sessionId && body.deviceId) {
          const wakeSettings = wf.settings ? JSON.parse(wf.settings) as WorkflowSettings : null;
          if (!wakeSettings?.wakeOnActivate) {
            return Response.json({ error: "wakeOnActivate not enabled in workflow settings" }, { status: 400 });
          }
          const deviceToken = q.getDeviceToken(body.deviceId);
          if (!deviceToken) {
            return Response.json({ error: "Device has no APNs token — cannot wake" }, { status: 400 });
          }
          pendingWakeActivations.set(body.deviceId, { workflowId: wfId, requestedAt: Date.now() });
          // Visible notification first so user taps to open the app (silent push can't launch a killed app)
          sendVisibleWake(deviceToken, `wake_${wfId}`, wf.name).then(r => {
            if (r.success) {
              console.log(`[wake] Visible push delivered for workflow ${wfId} to device ${body.deviceId!.slice(0, 8)}...`);
              // Follow up with silent push for background wake if app is already running
              sendSilentWake(deviceToken, `wake_${wfId}`).catch(() => {});
            } else {
              console.warn(`[wake] Visible push failed: ${r.reason} — trying silent as fallback`);
              sendSilentWake(deviceToken, `wake_${wfId}`).catch(() => {});
            }
          }).catch(() => {
            sendSilentWake(deviceToken, `wake_${wfId}`).catch(() => {});
          });
          console.log(`[wake] Pending activation stored: device=${body.deviceId.slice(0, 8)}... workflow=${wfId}`);
          return Response.json({ status: "wake_sent", deviceId: body.deviceId });
        }

        if (!body.sessionId) return Response.json({ error: "sessionId or deviceId required" }, { status: 400 });

        const nodes = q.getWorkflowNodes(wfId).map(n => ({
          ...n, config: JSON.parse(n.config),
        }));
        const edges = q.getWorkflowEdges(wfId);

        // Validate chain
        const structErr = validateStructure(nodes);
        if (structErr) return Response.json({ error: structErr }, { status: 400 });
        const edgeErr = validateEdges(nodes, edges);
        if (edgeErr) return Response.json({ error: edgeErr }, { status: 400 });

        // --- Activation Guard: check for conflicts ---
        const conflict = orchestrator.checkConflict(body.sessionId);
        if (conflict.hasConflict && !body.override) {
          // Return 409 with conflict details so the client can prompt for override
          return Response.json({
            error: "Session has active AI",
            conflict: {
              activeAppId: conflict.appId,
              status: conflict.status,
              activatedAt: conflict.activatedAt,
            },
          }, { status: 409 });
        }

        // If overriding, mark the previous activation as overridden in the audit log
        if (conflict.hasConflict && body.override) {
          const prevActivation = q.getActiveActivation(body.sessionId);
          if (prevActivation) {
            dbWriter.enqueue(q.overrideActivation(prevActivation.id, "override"));
          }
          orchestrator.forceDeactivate(body.sessionId);
        }

        const pipelineApps = resolveWorkflowToPipeline(nodes as any, edges as any, { id: wfId, name: wf.name }, wf.flowConfig ? JSON.parse(wf.flowConfig) : null, wf.settings ? JSON.parse(wf.settings) : null);
        const primaryApp = pipelineApps[0];  // undefined for passive pipelines (no AI processor)
        for (const app of pipelineApps) {
          appRegistry.registerTransientApp(app);
        }

        const parsedSettings: WorkflowSettings | null = wf.settings ? JSON.parse(wf.settings) : null;

        const session = registry.get(body.sessionId);
        if (!session) {
          return Response.json({ error: "Session not found or not active" }, { status: 404 });
        }

        // Parse flow config for sequential mode handling
        const flowConfig: FlowExecutionConfig | null = wf.flowConfig ? JSON.parse(wf.flowConfig) : null;
        const flows = detectFlows(nodes as any, edges as any);

        // For sequential mode: only activate first flow's apps, register remaining as pending
        let appsToActivate = pipelineApps;
        if (flowConfig?.mode === "sequential" && flows.length > 1) {
          const firstFlowId = flowConfig.flowOrder[0] ?? flows[0]?.flowId;
          const firstFlow = flows.find(f => f.flowId === firstFlowId) ?? flows[0];
          const firstFlowNodeIds = new Set(firstFlow.nodeIds);

          appsToActivate = pipelineApps.filter(app => {
            const flowId = (app.config as any).flowId as string | undefined;
            return flowId === firstFlowId || (firstFlowNodeIds.size > 0 && !flowId);
          });

          // Build remaining flow schedule for sequential activation
          const remainingFlows = flowConfig.flowOrder
            .filter(fid => fid !== firstFlowId)
            .map(fid => {
              const flow = flows.find(f => f.flowId === fid);
              if (!flow) return null;
              return {
                flowId: flow.flowId,
                apps: pipelineApps.filter(app => (app.config as any).flowId === flow.flowId),
              };
            })
            .filter((f): f is { flowId: string; apps: AppDefinition[] } => f !== null);

          orchestrator.registerPendingFlows(
            body.sessionId,
            wfId,
            [{ flowId: firstFlowId, apps: appsToActivate }, ...remainingFlows],
            flowConfig,
          );
        }

        // For event-driven mode: separate immediate (no trigger) and pending (has trigger) flows
        if (flowConfig?.mode === "event-driven" && flows.length > 1) {
          const triggers = flowConfig.flowTriggers ?? {};
          const triggeredFlowMap = new Map<string, AppDefinition[]>();
          const immediateFlows: Array<{ flowId: string; apps: AppDefinition[] }> = [];

          for (const fid of flowConfig.flowOrder) {
            const flowApps = pipelineApps.filter(app => (app.config as Record<string, unknown>).flowId === fid);
            const trigger = triggers[fid];
            if (!trigger) {
              immediateFlows.push({ flowId: fid, apps: flowApps });
            } else {
              if (flowApps.length > 0) {
                triggeredFlowMap.set(fid, flowApps);
              }
            }
          }

          appsToActivate = immediateFlows.flatMap(f => f.apps);

          orchestrator.registerEventDrivenFlows(
            body.sessionId,
            wfId,
            immediateFlows,
            triggeredFlowMap,
            triggers,
          );
        }

        // Passive pipelines (no processable nodes) — configure session but skip AI activation
        if (!primaryApp) {
          session.activeAppId = null;
          session.appPipeline = null;

          // Request codec change if specified
          const inputCodec = (nodes as any[]).find((n: any) => n.type === "camera-source")?.config?.codec as string | undefined;
          if (inputCodec && ["jpeg", "h264"].includes(inputCodec) && session.publisher?.ws?.readyState === WebSocket.OPEN) {
            session.publisher.ws.send(JSON.stringify({ type: "set_codec", codec: inputCodec }));
          }

          // Audit log
          const activationId = `act_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
          dbWriter.enqueue(q.insertActivation({
            id: activationId,
            sessionId: body.sessionId,
            workflowId: wfId,
            appId: "passive",
            activatedBy: session.activeAppId ?? "api",
            overrodeAppId: conflict.hasConflict ? conflict.appId ?? undefined : undefined,
            reason: body.reason ?? (conflict.hasConflict ? "Override" : "Activate"),
          }));
          dbWriter.flushNow();

          // Send workflow config to mobile for sink/transform setup
          const mobileConfig = buildMobileWorkflowConfig(nodes as any, edges as any);
          if (mobileConfig && session.publisher?.ws?.readyState === WebSocket.OPEN) {
            session.publisher.ws.send(JSON.stringify({ type: "workflow_config", config: mobileConfig }));
          }

          // For passive workflows with text→local-tts→speaker chains, push text as guidance_text
          if (session.publisher?.ws) {
            pushPassiveTTSChains(nodes as any, edges as any, session.publisher.ws, body.sessionId, flowConfig);
          }

          return Response.json({ appId: null, status: "passive", apps: [] });
        }

        session.activeAppId = primaryApp.id;
        session.appPipeline = { appId: primaryApp.id, primitiveId: primaryApp.binding };

        // Request codec change from publisher if workflow specifies one
        const inputCodec = (nodes as any[]).find((n: any) => n.type === "camera-source")?.config?.codec as string | undefined;
        if (inputCodec && ["jpeg", "h264"].includes(inputCodec) && session.publisher?.ws?.readyState === WebSocket.OPEN) {
          session.publisher.ws.send(JSON.stringify({ type: "set_codec", codec: inputCodec }));
          console.log(`[relay] Codec change from workflow: codec=${inputCodec} session=${body.sessionId}`);
          // Start H.264 decoder if needed
          if (inputCodec === "h264") getH264Decoder(body.sessionId).start();
        }

        // Audit log: record activation for the primary app
        const activationId = `act_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        dbWriter.enqueue(q.insertActivation({
          id: activationId,
          sessionId: body.sessionId,
          workflowId: wfId,
          appId: primaryApp.id,
          activatedBy: session.activeAppId ?? "api",
          overrodeAppId: conflict.hasConflict ? conflict.appId ?? undefined : undefined,
          reason: body.reason ?? (conflict.hasConflict ? "Override" : "Activate"),
        }));

        // Activate all apps in the pipeline, routing by activationMode
        const activatedAppIds: string[] = [];
        const processableNodes = (nodes as any[]).filter((n: any) => {
          const d = NODE_DEF_MAP.get(n.type);
          return d && d.activationMode !== null;
        });

        // Build app-id → raw-node lookup so sequential/event-driven filtering
        // of appsToActivate doesn't break the processableNodes index mapping.
        // pipelineApps[i] maps 1:1 to processableNodes[i] (same source, same filter).
        const rawNodeByAppId = new Map<string, any>();
        for (let i = 0; i < pipelineApps.length && i < processableNodes.length; i++) {
          rawNodeByAppId.set(pipelineApps[i].id, processableNodes[i]);
        }

        // Register workflow instance for execution controls
        session.activeWorkflowId = wfId;
        // Persist to DB so it survives server restarts
        dbWriter.enqueue(q.updateSession(body.sessionId!, { activeWorkflowId: wfId }));

        // Max session duration enforcement
        const maxDur = parsedSettings?.maxSessionDuration;
        if (maxDur && maxDur > 0) {
          setTimeout(() => {
            const sid = body.sessionId;
            if (!sid) return;
            orchestrator.handleWorkflowControl(sid, "stop_workflow", wfId, undefined, "system").catch(() => {});
            console.log(`[relay] Auto-deactivated (max session duration ${maxDur}min) session=${sid}`);
          }, maxDur * 60 * 1000);
        }

        // Device wake: send APNs push to trigger device to open app / start session
        if (parsedSettings?.wakeOnActivate && isApnsConfigured()) {
          const targetDeviceId = parsedSettings.targetDeviceId || session.metadata?.deviceId;
          if (targetDeviceId) {
            const deviceToken = q.getDeviceToken(targetDeviceId);
            if (deviceToken) {
              console.log(`[wake] Sending wake push to device ${targetDeviceId.slice(0, 8)}... on activate`);
              sendSilentWake(deviceToken, body.sessionId).then(r => {
                if (!r.success) console.warn(`[wake] Silent push failed: ${r.reason}`);
                else console.log(`[wake] Silent push delivered to ${targetDeviceId.slice(0, 8)}...`);
              }).catch(() => {});
            } else {
              console.warn(`[wake] No APNs token for target device ${targetDeviceId.slice(0, 8)}...`);
            }
          }
        }

        // Auto-start stream: if publisher is connected, send start_stream immediately
        // Triggered by autoStartStream setting OR wakeActivation (device was woken via APNs)
        if ((parsedSettings?.autoStartStream || body.wakeActivation) && session.publisher?.ws && session.publisher.ws.readyState === 1) {
          console.log(`[activate] Auto-starting stream for session ${body.sessionId} (wakeActivation=${!!body.wakeActivation})`);
          session.publisher.ws.send(JSON.stringify({ type: "start_stream" }));
        }

        const nodeEntries = (nodes as any[]).map((n: any) => ({
          nodeId: n.id,
          appId: n.id,
          nodeType: n.type as WorkflowNodeType,
          label: n.label || n.type,
          triggerChained: false,
        }));
        if ((nodes as any[]).length > 1) {
          orchestrator.activateWorkflow(body.sessionId, wfId, wf.name, nodeEntries);
        }
        // --- Parallel activation dispatch ---
        // Categorize processable nodes by dispatch type.
        // Independent nodes activate concurrently; dependsOn handles ordering
        // internally via the deferred activation mechanism in GuidanceOrchestrator.
        const sid = body.sessionId; // Guaranteed non-null by guard above
        const enhanceIdx: number[] = [];
        const visionIdx: number[] = [];
        const sensorIdx: number[] = [];
        const speechIdx: number[] = [];
        const jepaIdx: number[] = [];
        const aiIdx: number[] = [];

        for (let i = 0; i < appsToActivate.length; i++) {
          const rawNode = rawNodeByAppId.get(appsToActivate[i].id);
          const pDef = rawNode ? NODE_DEF_MAP.get(rawNode.type) : null;
          if (pDef?.activationMode === "enhance") { enhanceIdx.push(i); continue; }
          if (pDef?.activationMode === "vision") { visionIdx.push(i); continue; }
          if (pDef?.activationMode === "sensor") { sensorIdx.push(i); continue; }
          if (pDef?.activationMode === "speech") { speechIdx.push(i); continue; }
          if (pDef?.activationMode === "jepa")   { jepaIdx.push(i);   continue; }
          aiIdx.push(i);
        }

        // 1. Fire-and-forget: send all vision configs to iOS immediately
        for (const i of visionIdx) {
          const rawNode = rawNodeByAppId.get(appsToActivate[i].id);
          if (!rawNode) continue;
          const visionConfig = {
            type: "vision_stage_config" as const,
            nodeType: rawNode.type,
            detectionTypes: [rawNode.type],
            confidence: (rawNode.config as any)?.confidence ?? 0.5,
            targetFPS: (rawNode.config as any)?.targetFPS ?? 5,
            maxResults: (rawNode.config as any)?.maxFaces
              ?? (rawNode.config as any)?.maxPersons
              ?? (rawNode.config as any)?.maxPoses ?? 0,
            language: (rawNode.config as any)?.language ?? "en-US",
            symbologies: Object.entries(
              (rawNode.config as any)?.symbologies ?? { qr: true }
            ).filter(([, v]) => v).map(([k]) => k),
            maxLabels: (rawNode.config as any)?.maxLabels ?? 5,
          };
          if (session.publisher?.ws?.readyState === WebSocket.OPEN) {
            session.publisher.ws.send(JSON.stringify(visionConfig));
          }
          activatedAppIds.push(appsToActivate[i].id);
        }

        // 2. Activate all AI nodes in parallel (dependsOn defers internally)
        if (aiIdx.length > 0) {
          console.log(`[relay] Activating ${aiIdx.length} AI node(s) in parallel session=${sid}`);
          const aiResults = await Promise.allSettled(
            aiIdx.map(i => orchestrator.activateWithConfig(sid, appsToActivate[i]))
          );
          for (let r = 0; r < aiResults.length; r++) {
            if (aiResults[r].status === "fulfilled") {
              activatedAppIds.push(appsToActivate[aiIdx[r]].id);
            } else {
              console.error(`[relay] AI activation failed: ${appsToActivate[aiIdx[r]].id}`, (aiResults[r] as PromiseRejectedResult).reason);
            }
          }
        }

        // 3. Activate all JEPA nodes in parallel
        if (jepaIdx.length > 0) {
          console.log(`[relay] Activating ${jepaIdx.length} JEPA node(s) in parallel session=${sid}`);
          const jepaResults = await Promise.allSettled(
            jepaIdx.map(i => {
              const app = appsToActivate[i];
              const jc = app.config.jepa as any;
              activatedAppIds.push(app.id);
              return jepaOrchestrator.activate(sid, {
                provider: jc.provider,
                model: jc.model ?? app.config.model,
                gpu: jc.gpu,
                clipLength: jc.clipLength,
                sampleFps: jc.sampleFps,
                resolution: jc.resolution,
                tasks: jc.tasks,
                sessionId: sid,
              });
            })
          );
        }

        // 4. Collect all enhance nodes and send one combined config to iOS
        // IMPORTANT: use rawNode.config (raw node config with brightness/contrast/saturation)
        // NOT appsToActivate[i].config (resolved AppConfig with model/voice/input/output)
        if (enhanceIdx.length > 0) {
          const enhanceFilters: Array<{ type: string; params: Record<string, number> }> = [];
          for (const i of enhanceIdx) {
            const rawNode = rawNodeByAppId.get(appsToActivate[i].id);
            if (!rawNode) continue;
            enhanceFilters.push({
              type: rawNode.type,
              params: (rawNode.config ?? {}) as Record<string, number>,
            });
            activatedAppIds.push(appsToActivate[i].id);
          }
          if (session.publisher?.ws?.readyState === WebSocket.OPEN) {
            session.publisher.ws.send(JSON.stringify({
              type: "enhance_stage_config",
              filters: enhanceFilters,
              enabled: true,
            }));
            console.log(`[relay] Sent enhance config with ${enhanceFilters.length} filters session=${sid}`);
          }
        }

        // 5. Collect all sensor nodes and send one combined config to iOS
        if (sensorIdx.length > 0) {
          const sensorConfigs: Array<{ sensorType: string; config: Record<string, unknown> }> = [];
          for (const i of sensorIdx) {
            const rawNode = rawNodeByAppId.get(appsToActivate[i].id);
            if (!rawNode) continue;
            const rawConfig = { ...(rawNode.config ?? {}) as Record<string, unknown> };

            // Parse targetLabels from comma-separated string to array for sound classifier
            if (rawNode.type === "sensor-sound" && typeof rawConfig.targetLabels === "string") {
              const parsed = (rawConfig.targetLabels as string).split(",").map(s => s.trim()).filter(s => s.length > 0);
              rawConfig.targetLabels = parsed.length > 0 ? parsed : undefined;
            }

            sensorConfigs.push({
              sensorType: rawNode.type,
              config: rawConfig,
            });
            activatedAppIds.push(appsToActivate[i].id);
          }
          if (session.publisher?.ws?.readyState === WebSocket.OPEN) {
            session.publisher.ws.send(JSON.stringify({
              type: "sensor_stage_config",
              sensors: sensorConfigs,
              enabled: true,
            }));
            console.log(`[relay] Sent sensor config with ${sensorConfigs.length} sensors session=${sid}`);
          }
        }

        // 6. Collect all speech nodes (mobile-stt, vad) and send one combined config to iOS
        if (speechIdx.length > 0) {
          const speechConfigs: Array<{ speechType: string; config: Record<string, unknown> }> = [];
          for (const i of speechIdx) {
            const rawNode = rawNodeByAppId.get(appsToActivate[i].id);
            if (!rawNode) continue;
            const rawConfig = { ...(rawNode.config ?? {}) as Record<string, unknown> };
            speechConfigs.push({
              speechType: rawNode.type,
              config: rawConfig,
            });
            activatedAppIds.push(appsToActivate[i].id);
          }
          if (session.publisher?.ws?.readyState === WebSocket.OPEN) {
            session.publisher.ws.send(JSON.stringify({
              type: "speech_stage_config",
              stages: speechConfigs,
              enabled: true,
            }));
            console.log(`[relay] Sent speech config with ${speechConfigs.length} stages session=${sid}`);
          }
        }
        const cachedFrame = registry.getLastFrame(body.sessionId);
        if (cachedFrame) sendCachedFrameToAI(body.sessionId, cachedFrame);

        dbWriter.flushNow();

        // Check actual activation status from orchestrator
        const aiStatus = orchestrator.getStatus(body.sessionId);
        const finalStatus = aiStatus.status === "error" ? "error" : "active";
        return Response.json({ appId: primaryApp.id, status: finalStatus, apps: activatedAppIds });
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
          if (wfId) {
            session.activeWorkflowId = wfId;
            console.log(`[relay] Restored activeWorkflowId=${wfId} from DB for session=${sessionId}`);
          }
        }
        if (wfId && ws.readyState === WebSocket.OPEN) {
          const wf = q.getWorkflow(wfId);
          if (wf) {
            const wfNodes = q.getWorkflowNodes(wfId);
            if (wfNodes.length > 0) {
              const typedNodes = wfNodes.map(n => ({
                id: n.id,
                type: n.type,
                config: typeof n.config === "string" ? JSON.parse(n.config) : (n.config ?? {}),
              }));
              dispatchWorkflowConfig(ws, typedNodes, sessionId);
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
      const { role, sessionId } = ws.data;

      const session = registry.get(sessionId);
      if (!session) return;

      if (role === "publish" && session.publisher?.ws === ws) {
        if (typeof message === "string") {
          // Publisher JSON control messages
          try {
            const cmd = JSON.parse(message);
            if (cmd.type === "hello" && session.publisher) {
              const MAX_FIELD_LEN = 256;
              const strField = (v: unknown): string | null => {
                if (typeof v !== "string") return null;
                const trimmed = v.slice(0, MAX_FIELD_LEN);
                return trimmed || null;
              };
              session.publisher.deviceId = strField(cmd.deviceId);
              session.publisher.deviceName = strField(cmd.deviceName);
              session.publisher.wearableId = strField(cmd.wearableId);
              session.publisher.wearableType = strField(cmd.wearableType);
              session.publisher.deviceModel = strField(cmd.deviceModel);
              session.publisher.systemVersion = strField(cmd.systemVersion);
              session.publisher.appVersion = strField(cmd.appVersion);
              session.publisher.buildNumber = strField(cmd.buildNumber);
              session.publisher.batteryLevel = typeof cmd.batteryLevel === "number" ? cmd.batteryLevel : null;
              session.publisher.batteryState = strField(cmd.batteryState);
              session.publisher.lowPowerMode = !!cmd.lowPowerMode;

              // Update session metadata
              session.metadata.deviceName = strField(cmd.deviceName);
              session.metadata.deviceModel = strField(cmd.deviceModel);
              session.metadata.deviceId = strField(cmd.deviceId);
              session.metadata.systemVersion = strField(cmd.systemVersion);
              session.metadata.wearableType = strField(cmd.wearableType);
              session.metadata.appVersion = strField(cmd.appVersion);
              session.metadata.buildNumber = strField(cmd.buildNumber);

              // Bind device→session so reconnects resume the same session
              if (cmd.deviceId && typeof cmd.deviceId === "string") {
                registry.bindDeviceToSession(cmd.deviceId, sessionId);
              }

              console.log(`[relay] Publisher hello: device=${session.publisher.deviceName || "?"} wearable=${session.publisher.wearableType || "none"} ip=${session.publisher.clientIp} session=${sessionId}`);

              // Shadow write: upsert device + link session to device
              if (session.publisher.deviceId) {
                dbWriter.enqueue(q.upsertDevice({
                  id: session.publisher.deviceId,
                  name: session.publisher.deviceName ?? undefined,
                  model: session.publisher.deviceModel ?? undefined,
                  systemVersion: session.publisher.systemVersion ?? undefined,
                  wearableType: session.publisher.wearableType ?? undefined,
                  wearableId: session.publisher.wearableId ?? undefined,
                  appVersion: session.publisher.appVersion ?? undefined,
                  buildNumber: session.publisher.buildNumber ?? undefined,
                  batteryLevel: session.publisher.batteryLevel ?? undefined,
                  status: session.publisher.standby ? "standby" : "online",
                  lastSessionId: sessionId,
                }));
                // Record build sighting for build history audit trail
                if (session.publisher.appVersion && session.publisher.buildNumber) {
                  dbWriter.enqueue(q.recordBuildSighting({
                    deviceId: session.publisher.deviceId,
                    appVersion: session.publisher.appVersion,
                    buildNumber: session.publisher.buildNumber,
                  }));
                }
                dbWriter.enqueue(q.upsertSession({
                  id: sessionId,
                  publisherDeviceId: session.publisher.deviceId,
                }));
              }

              // Auto-activate pending wake workflows when device connects
              const pendingWake = session.publisher.deviceId ? pendingWakeActivations.get(session.publisher.deviceId) : null;
              if (pendingWake) {
                pendingWakeActivations.delete(session.publisher.deviceId!);
                const pwId = pendingWake.workflowId;
                console.log(`[wake-auto] Device ${session.publisher.deviceId!.slice(0, 8)}... connected, auto-activating workflow ${pwId}`);
                // Internal activation via self-fetch to reuse all existing logic (conflicts, sequential, event-driven, etc.)
                // wakeActivation: true forces start_stream to be sent to publisher
                fetch(`http://127.0.0.1:${PORT}/workflows/${pwId}/activate`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ sessionId, wakeActivation: true }),
                }).then(r => r.json()).then(result => {
                  console.log(`[wake-auto] Activation result for ${pwId}:`, JSON.stringify(result));
                }).catch(err => {
                  console.error(`[wake-auto] Activation failed for ${pwId}:`, err);
                });
              }

              // Broadcast session_info to all viewers (device info now available)
              broadcastToViewers(session, { type: "session_info", ...buildSessionInfo(session) });

              // Update recorder device info
              if (session.recorder) {
                session.recorder.deviceInfo = {
                  deviceId: strField(cmd.deviceId),
                  deviceName: strField(cmd.deviceName),
                  deviceModel: strField(cmd.deviceModel),
                  systemVersion: strField(cmd.systemVersion),
                };
                // Camera/wearable device info (separate from phone)
                if (cmd.wearableId || cmd.wearableType) {
                  session.recorder.wearableInfo = {
                    wearableId: strField(cmd.wearableId),
                    wearableType: strField(cmd.wearableType),
                  };
                }
                // Sync access control to recorder
                session.recorder.accessLevel = session.accessLevel;
                session.recorder.acl = session.acl;
                session.recorder.ownerId = session.ownerId;
                session.recorder.ownerEmail = session.ownerEmail;
              }
            } else if (cmd.type === "gesture") {
              // Hand gesture from iOS publisher
              controlEventBus.publish({
                type: "gesture",
                gesture: cmd.gesture,
                confidence: cmd.confidence,
                timestampMs: cmd.timestampMs || Date.now(),
              });
              console.log(`[relay] Gesture: ${cmd.gesture} confidence=${cmd.confidence} session=${sessionId}`);
              // Check if gesture resolves to an app and activate via orchestrator
              const gesturePipeline = appRegistry.resolveByGesture(cmd.gesture);
              if (gesturePipeline) {
                orchestrator.activateApp(sessionId, gesturePipeline.appId).catch(() => {});
                // Send cached frame to AI for immediate context
                const cachedFrame = registry.getLastFrame(sessionId);
                if (cachedFrame) sendCachedFrameToAI(sessionId, cachedFrame);
              }
              // Forward gesture as text trigger to active AI service
              if (session.activeAppId) {
                orchestrator.sendTrigger(sessionId, `[Gesture detected: ${cmd.gesture}, confidence: ${cmd.confidence ?? 1.0}]`);
              }
            } else if (cmd.type === "activate_app") {
              // Activate an app for this session
              const appId = cmd.appId as string;
              // If this is a workflow app (wf- prefix), resolve and register it
              if (appId.startsWith("wf-")) {
                const wfId = appId.slice(3);
                try {
                  const wf = q.getWorkflow(wfId);
                  if (!wf) throw new Error("Workflow not found");
                  const nodes = q.getWorkflowNodes(wfId).map(n => ({ ...n, config: JSON.parse(n.config) }));
                  const edges = q.getWorkflowEdges(wfId);
                  const pipelineApps = resolveWorkflowToPipeline(nodes as any, edges as any, { id: wfId, name: wf.name }, undefined, wf.settings ? JSON.parse(wf.settings) : null);
                  const primaryApp = pipelineApps[0];
                  for (const app of pipelineApps) {
                    appRegistry.registerTransientApp(app);
                  }
                  if (primaryApp) {
                    session.activeAppId = primaryApp.id;
                    session.activeWorkflowId = wfId;
                    session.appPipeline = { appId: primaryApp.id, primitiveId: primaryApp.binding };
                    dbWriter.enqueue(q.updateSession(sessionId, { activeWorkflowId: wfId }));
                    // Register workflow instance for execution controls
                    if ((nodes as any[]).length > 1) {
                      const nodeEntries = (nodes as any[]).map((n: any) => ({
                        nodeId: n.id,
                        appId: n.id,
                        nodeType: n.type as WorkflowNodeType,
                        label: n.label || n.type,
                        triggerChained: false,
                      }));
                      orchestrator.activateWorkflow(sessionId, wfId, wf.name, nodeEntries);
                    }
                    for (const app of pipelineApps) {
                      await orchestrator.activateWithConfig(sessionId, app);
                    }
                    ws.send(JSON.stringify({ type: "app_status", appId: primaryApp.id, status: "active" }));
                    const ic = orchestrator.getInputConfig(sessionId);
                    if (ic && session.publisher) session.publisher.ws.send(JSON.stringify({ type: "configure_sources", input: ic }));
                    const cachedFrame = registry.getLastFrame(sessionId);
                    if (cachedFrame) sendCachedFrameToAI(sessionId, cachedFrame);
                  } else {
                    ws.send(JSON.stringify({ type: "app_status", appId, status: "active", info: "passive pipeline" }));
                    if (session.publisher?.ws) {
                      const publisherFlowConfig: FlowExecutionConfig | null = wf.flowConfig ? JSON.parse(wf.flowConfig) : null;
                      pushPassiveTTSChains(nodes as any, edges as any, session.publisher.ws, sessionId, publisherFlowConfig);
                    }
                  }
                } catch (e) {
                  ws.send(JSON.stringify({ type: "app_status", appId, status: "error", error: String(e) }));
                }
              } else {
                const pipeline = appRegistry.resolvePipeline(appId);
                if (pipeline) {
                  session.activeAppId = appId;
                  session.appPipeline = pipeline;
                  console.log(`[relay] App activated: ${appId} binding=${pipeline.primitiveId} session=${sessionId}`);
                  ws.send(JSON.stringify({ type: "app_status", appId, status: "active" }));
                  orchestrator.activateApp(sessionId, appId).catch(() => {});
                  const cachedFrame = registry.getLastFrame(sessionId);
                  if (cachedFrame) sendCachedFrameToAI(sessionId, cachedFrame);
                } else {
                  console.warn(`[relay] App activation failed: ${appId} not found`);
                  ws.send(JSON.stringify({ type: "app_status", appId, status: "error", error: "App not found" }));
                }
              }
            } else if (cmd.type === "deactivate_app") {
              const prevApp = session.activeAppId;
              session.activeAppId = null;
              session.activeWorkflowId = null;
              session.appPipeline = null;
              console.log(`[relay] App deactivated: ${prevApp} session=${sessionId}`);
              // Audit log: record deactivation
              if (prevApp) {
                dbWriter.enqueue(q.deactivateActivation(sessionId, "publisher"));
                dbWriter.flushNow();
              }
              ws.send(JSON.stringify({ type: "app_status", appId: prevApp, status: "inactive" }));
              // Notify orchestrator
              orchestrator.deactivateApp(sessionId).catch(() => {});
            } else if (cmd.type === "activate_workflow") {
              // Activate a workflow for this session
              const workflowId = cmd.workflowId as string;
              try {
                const wf = q.getWorkflow(workflowId);
                if (!wf) { ws.send(JSON.stringify({ type: "workflow_error", error: "Workflow not found" })); return; }
                const nodes = q.getWorkflowNodes(workflowId).map(n => ({ ...n, config: JSON.parse(n.config) }));
                const edges = q.getWorkflowEdges(workflowId);
                const pipelineApps = resolveWorkflowToPipeline(nodes as any, edges as any, { id: workflowId, name: wf.name }, undefined, wf.settings ? JSON.parse(wf.settings) : null);
                const primaryApp = pipelineApps[0];
                for (const app of pipelineApps) {
                  appRegistry.registerTransientApp(app);
                }
                if (primaryApp) {
                  session.activeAppId = primaryApp.id;
                  session.activeWorkflowId = workflowId;
                  session.appPipeline = { appId: primaryApp.id, primitiveId: primaryApp.binding };
                  // Register workflow instance for execution controls
                  if ((nodes as any[]).length > 1) {
                    const nodeEntries = (nodes as any[]).map((n: any) => ({
                      nodeId: n.id,
                      appId: n.id,
                      nodeType: n.type as WorkflowNodeType,
                      label: n.label || n.type,
                      triggerChained: false,
                    }));
                    orchestrator.activateWorkflow(sessionId, workflowId, wf.name, nodeEntries);
                  }
                  for (const app of pipelineApps) {
                    await orchestrator.activateWithConfig(sessionId, app);
                  }
                  // Activate JEPA nodes by activationMode
                  for (const app of pipelineApps) {
                    if (app.config?.jepa) {
                      const jc = app.config.jepa as Record<string, any>;
                      await jepaOrchestrator.activate(sessionId, {
                        provider: jc.provider,
                        model: jc.model ?? app.config.model,
                        gpu: jc.gpu,
                        clipLength: jc.clipLength,
                        sampleFps: jc.sampleFps,
                        resolution: jc.resolution,
                        tasks: jc.tasks,
                        sessionId,
                      });
                    }
                  }
                }
                ws.send(JSON.stringify({ type: "workflow_activated", appId: primaryApp?.id ?? "passive" }));
                if (!primaryApp && session.publisher?.ws) {
                  const viewerFlowConfig: FlowExecutionConfig | null = wf.flowConfig ? JSON.parse(wf.flowConfig) : null;
                  pushPassiveTTSChains(nodes as any, edges as any, session.publisher.ws, sessionId, viewerFlowConfig);
                }
                const ic = orchestrator.getInputConfig(sessionId);
                if (ic && session.publisher) session.publisher.ws.send(JSON.stringify({ type: "configure_sources", input: ic }));
                const cachedFrame = registry.getLastFrame(sessionId);
                if (cachedFrame) sendCachedFrameToAI(sessionId, cachedFrame);
              } catch (e) {
                ws.send(JSON.stringify({ type: "workflow_error", error: String(e) }));
              }
            } else if (cmd.type === "set_vision_fps" && typeof cmd.fps === "number") {
              const fps = Math.max(0.1, Math.min(cmd.fps, 5));
              orchestrator.setVisionFps(sessionId, fps);
              ws.send(JSON.stringify({ type: "vision_fps", fps }));
            } else if (cmd.type === "vision_result" && Array.isArray(cmd.detections)) {
              // iOS VisionStage detection results — inject as context into active AI sessions.
              //
              // NOTE: Vision runs at ~5fps by default, so this fires ~5x/sec. Each call
              // sends a [Vision: ...] text trigger to every active AI service via sendText().
              // If the AI context window becomes noisy, consider throttling the AI injection
              // to e.g. 1 trigger every 2-3 seconds (deduplicate identical summaries, or
              // only send on detection change). The viewer fan-out below is fine at 5fps.
              if (session.activeAppId) {
                const summary = (cmd.detections as any[]).map((d: any) => {
                  if (d.type === "vision-face-detect") return `Face detected (confidence: ${(d.confidence * 100).toFixed(0)}%)`;
                  if (d.type === "vision-barcode-scan") return `Barcode: ${d.label}`;
                  if (d.type === "vision-ocr") return `OCR text: ${d.label}`;
                  if (d.type === "vision-scene-classify") {
                    const labels = (d.labels as any[] || []).map((l: any) => `${l.label} ${(l.confidence * 100).toFixed(0)}%`).join(", ");
                    return `Scene: ${labels}`;
                  }
                  if (d.type === "vision-person-detect") return `Person detected (confidence: ${(d.confidence * 100).toFixed(0)}%)`;
                  if (d.type === "vision-body-pose") {
                    const jointCount = (d.joints as any[] || []).length;
                    return `Body pose detected (${jointCount} joints, confidence: ${(d.confidence * 100).toFixed(0)}%)`;
                  }
                  return `${d.type}: ${d.label}`;
                }).join("; ");
                if (summary) {
                  orchestrator.sendTrigger(sessionId, `[Vision: ${summary}]`);
                }
              }
              // Fan out to viewers for overlay rendering
              broadcastToViewers(session, cmd);
            } else if (cmd.type === "sensor_result") {
              // iOS sensor stage results — inject as context into active AI sessions
              if (session.activeAppId) {
                const sensorType = cmd.sensorType as string;
                let summary = "";
                if (sensorType === "sensor-sound") {
                  const labels = (cmd.labels as any[] || []).map((l: any) => `${l.label} ${(l.confidence * 100).toFixed(0)}%`).join(", ");
                  summary = `Sound: ${labels}`;
                } else if (sensorType === "sensor-location") {
                  const eventType = cmd.eventType as string ?? "location_update";
                  const lat = (cmd.latitude as number)?.toFixed(6);
                  const lon = (cmd.longitude as number)?.toFixed(6);
                  if (eventType === "geofence_enter") {
                    const label = cmd.regionLabel ?? cmd.regionId ?? "unknown";
                    summary = `Geofence entered: ${label} (${lat}, ${lon})`;
                  } else if (eventType === "geofence_exit") {
                    const label = cmd.regionLabel ?? cmd.regionId ?? "unknown";
                    summary = `Geofence exited: ${label} (${lat}, ${lon})`;
                  } else if (eventType === "visit_detected") {
                    summary = `Visit detected at ${lat}, ${lon}`;
                  } else {
                    const speed = (cmd.speed as number) >= 0 ? ` speed=${(cmd.speed as number).toFixed(1)}m/s` : "";
                    summary = `Location: ${lat}, ${lon}${speed}`;
                  }
                }
                if (summary) {
                  orchestrator.sendTrigger(sessionId, `[Sensor: ${summary}]`);
                }
              }
              // Fan out to viewers
              broadcastToViewers(session, cmd);
            } else if (cmd.type === "stt_result") {
              // iOS speech-to-text results — inject as context into active AI sessions
              if (isSttResult(cmd) && session.activeAppId) {
                const text = (cmd.text || "").trim();
                if (text && cmd.isFinal) {
                  const summary = `Transcription: "${text}"`;
                  orchestrator.sendTrigger(sessionId, `[STT: ${summary}]`);
                }
                if (cmd.error) {
                  console.warn(`[relay] STT error from publisher: ${cmd.error} session=${sessionId}`);
                }
              }
              // Fan out to viewers
              broadcastToViewers(session, cmd);
            } else if (cmd.type === "vad_result") {
              // iOS voice activity detection results — inject as context into active AI sessions
              if (isVadResult(cmd) && session.activeAppId) {
                const { eventType } = cmd;
                const energyDb = cmd.energyDb?.toFixed(1);
                let summary = "";
                if (eventType === "speech_start") {
                  summary = `Speech started (energy: ${energyDb}dB)`;
                } else if (eventType === "speech_end") {
                  const duration = cmd.durationMs?.toFixed(0);
                  summary = `Speech ended (${duration}ms, energy: ${energyDb}dB)`;
                } else if (eventType === "speech_active") {
                  summary = `Speech active (energy: ${energyDb}dB)`;
                }
                if (summary) {
                  orchestrator.sendTrigger(sessionId, `[VAD: ${summary}]`);
                }
                if (cmd.error) {
                  console.warn(`[relay] VAD error from publisher: ${cmd.error} session=${sessionId}`);
                }
              }
              // Fan out to viewers
              broadcastToViewers(session, cmd);
            } else if (isBackpressureAckMessage(cmd)) {
              // Publisher acknowledges backpressure adjustment
              console.log(`[relay] Backpressure ack from publisher: targetFps=${cmd.targetFps} session=${sessionId}`);
            } else if (cmd.type === "audio_mode_changed") {
              // Publisher acknowledges audio mode change — broadcast to all viewers
              console.log(`[relay] Audio mode changed by publisher: mode=${cmd.mode} session=${sessionId}`);
              broadcastToViewers(session, { type: "audio_mode_changed", mode: cmd.mode });
            } else if (cmd.type === "workflow_control") {
              // Publisher sends workflow control action
              const action = cmd.action as string;
              const workflowId = cmd.workflowId as string;
              const nodeId = cmd.nodeId as string | undefined;
              if (action && workflowId) {
                await orchestrator.handleWorkflowControl(sessionId, action as any, workflowId, nodeId, "publisher");
                if (action === "stop_workflow") {
                  session.activeAppId = null;
                  session.activeWorkflowId = null;
                  session.appPipeline = null;
                  dbWriter.enqueue(q.deactivateActivation(sessionId, "publisher"));
                  dbWriter.flushNow();
                  // Disable on-device stages (vision, enhance, sensor)
                  if (session.publisher?.ws?.readyState === WebSocket.OPEN) {
                    session.publisher.ws.send(JSON.stringify({ type: "vision_stage_config", enabled: false }));
                    session.publisher.ws.send(JSON.stringify({ type: "enhance_stage_config", enabled: false }));
                    session.publisher.ws.send(JSON.stringify({ type: "sensor_stage_config", enabled: false }));
                    session.publisher.ws.send(JSON.stringify({ type: "speech_stage_config", enabled: false }));
                  }
                  broadcastToViewers(session, { type: "app_status", appId: null, status: "inactive" });
                }
              }
            } else if (cmd.type === "audio_config") {
              // Publisher responds with current audio config — broadcast to all viewers
              broadcastToViewers(session, cmd);
            } else if (cmd.type === "photo_captured") {
              broadcastToViewers(session, { type: "photo_captured" });
            } else if (cmd.type === "recording_changed") {
              broadcastToViewers(session, { type: "recording_changed", recording: !!cmd.recording });
            } else if (cmd.type === "stream_changed") {
              // Toggle publisher standby state on stream change
              if (cmd.streaming) {
                // Publisher went active — resume or activate
                const sess = registry.get(sessionId);
                if (sess?.state === "paused") {
                  registry.resumeSession(sessionId).catch(() => {});
                } else {
                  registry.activatePublisher(sessionId).catch(() => {});
                }
              } else {
                // Publisher went back to standby — pause releases resources
                registry.pauseSession(sessionId).catch(() => {});
              }
              broadcastToViewers(session, { type: "stream_changed", streaming: !!cmd.streaming });
            } else if (cmd.type === "publisher_telemetry") {
              // Update battery from telemetry
              if (cmd.battery && session.publisher) {
                session.publisher.batteryLevel = typeof cmd.battery.level === "number" ? cmd.battery.level : null;
                session.publisher.batteryState = typeof cmd.battery.state === "string" ? cmd.battery.state : null;
                session.publisher.lowPowerMode = !!cmd.battery.lowPowerMode;
              }
              broadcastToViewers(session, { type: "publisher_telemetry", ...cmd });
            } else if (cmd.type === "link_state_changed") {
              session.linkState = cmd.state as string || "unknown";
              broadcastToViewers(session, { type: "link_state_changed", state: session.linkState });
            } else if (cmd.type === "publisher_error") {
              broadcastToViewers(session, { type: "publisher_error", error: cmd.error, state: cmd.state });
            } else if (cmd.type === "codec_changed") {
              console.log(`[relay] Publisher codec changed: codec=${cmd.codec} session=${sessionId}`);
              broadcastToViewers(session, { type: "codec_changed", codec: cmd.codec });
            } else if (cmd.type === "spoken_text") {
              broadcastToViewers(session, { type: "spoken_text", text: cmd.text });
            } else if (cmd.type === "standby") {
              // Publisher announcing standby state (connected but not streaming)
              const isReady = cmd.status === "ready";
              if (isReady) {
                // Pause session: transitions state to "paused" so stale checker won't evict
                registry.pauseSession(sessionId).catch(() => {});
              } else {
                // Resume session: transitions state back to "active"
                if (session.state === "paused" || session.state === "standby") {
                  registry.activatePublisher(sessionId).catch(() => {});
                }
              }
              console.log(`[relay] Publisher standby: ${isReady} session=${sessionId}`);
              broadcastToViewers(session, { type: "publisher_status", status: isReady ? "standby" : "live" });
            }
          } catch (err) { console.warn("[relay] Publisher message parse error:", err); }
        } else {
          // Binary frame (Uint8Array in Bun)
          const buf = message as Uint8Array;

          if (isAudioFrame(buf)) {
            // Audio frame (FRAU) — auto-activate standby publisher on first frame
            if (session.publisher?.standby) {
              registry.activatePublisher(sessionId).catch(() => {});
            }
            session.publisher.audioCount++;
            session.publisher.audioBytes += buf.length;
            const audioHdr = parseAudioHeader(buf);
            registry.fanoutAudio(sessionId, buf, audioHdr?.codecType ?? 0, audioHdr?.sampleRate ?? 0);
            session.recorder?.appendAudio(buf);
            audioTapBus.publish(buf, sessionId);

            // Forward PCM payload to AI service (if active)
            // Decode Opus to PCM for AI pipelines (Gemini Live, STT expect raw PCM)
            if (audioHdr && session.activeAppId) {
              if (audioHdr.isOpus) {
                const opusPayload = buf.slice(AUDIO_HEADER_SIZE);
                const pcmBytes = decodeOpusFrame(opusPayload, audioHdr.sampleRate);
                if (pcmBytes.length > 0) {
                  // codecType is now the source (0-3), preserved through Opus encoding
                  orchestrator.sendAudio(sessionId, pcmBytes, audioHdr.codecType, audioHdr.sampleRate);
                }
              } else {
                const pcmPayload = buf.slice(AUDIO_HEADER_SIZE);
                orchestrator.sendAudio(sessionId, pcmPayload, audioHdr.codecType, audioHdr.sampleRate);
              }
            }
          } else if (isVideoFrame(buf)) {
            // Video frame (FRLY) — codec-aware routing
            // Auto-activate standby publisher on first frame if not yet activated
            if (session.publisher?.standby) {
              registry.activatePublisher(sessionId).catch(() => {});
            }
            session.publisher.frameCount++;
            session.publisher.totalBytes += buf.length;
            registry.fanout(sessionId, buf);
            session.recorder?.appendVideo(buf);

            // Decode codec from byte[25]: top nibble = codec type (0=JPEG, 1=H.264)
            const codecFlags = buf[25];
            const codecType = (codecFlags >> 4) & 0x0F;

            if (codecType === 0) {
              // JPEG: forward directly to AI (if active)
              if (session.activeAppId) {
                const jpegPayload = buf.slice(HEADER_SIZE);
                orchestrator.sendVideoFrame(sessionId, jpegPayload);
              }
              // Forward to JEPA encoder (if active) -- parallel to AI
              if (jepaOrchestrator.isActive(sessionId)) {
                const jpegPayload = buf.slice(HEADER_SIZE);
                jepaOrchestrator.sendFrame(sessionId, jpegPayload, Date.now());
              }
            } else if (codecType === 1) {
              // H.264: feed through server-side ffmpeg decoder
              // Always decode so the recorder gets JPEGs via appendDecodedVideo callback
              const decoder = getH264Decoder(sessionId);
              if (!decoder.active) decoder.start();
              decoder.feed(buf.slice(HEADER_SIZE));
            }
          } else if (isSensorFrame(buf)) {
            // Sensor telemetry frame (FRSE) — fan-out to viewers + forward to orchestrator
            const sensorHdr = parseSensorHeader(buf);
            registry.fanout(sessionId, buf);

            if (sensorHdr && session.activeAppId) {
              orchestrator.sendSensor(sessionId, sensorHdr.json, sensorHdr.sensorFlags);
            }

            session.publisher.sensorCount = (session.publisher.sensorCount ?? 0) + 1;
            session.publisher.sensorBytes = (session.publisher.sensorBytes ?? 0) + buf.length;
          }
        }
      } else if (role === "view") {
        // Viewer control messages
        if (typeof message === "string") {
          try {
            const cmd = JSON.parse(message);
            if (cmd.type === "stats") {
              const s = await registry.stats(wifiIp, PORT, serverStartTime);
              ws.send(JSON.stringify({ type: "stats", ...s }));
            } else if (cmd.type === "hello") {
              // Viewer identity — store version info
              const viewerId = ws.data.viewerId;
              if (viewerId) {
                const found = registry.findViewerSession(viewerId);
                if (found) {
                  found.viewer.gitCommit = cmd.gitCommit || null;
                  found.viewer.buildVersion = cmd.buildVersion || null;
                }
              }
            } else if (cmd.type === "config" && cmd.quality && cmd.quality in QUALITY_PRESETS) {
              const viewerId = ws.data.viewerId;
              if (!viewerId) return;
              const found = registry.findViewerSession(viewerId);
              if (found) {
                const newQuality = cmd.quality as QualityPreset;
                found.viewer.quality = newQuality;
                found.viewer.bucket = createTokenBucket(newQuality);
                console.log(`[relay] Viewer ${viewerId.slice(0, 8)} quality: ${newQuality} (${QUALITY_PRESETS[newQuality].maxFps} FPS)`);
                ws.send(JSON.stringify({
                  type: "quality",
                  preset: newQuality,
                  maxFps: QUALITY_PRESETS[newQuality].maxFps,
                  label: QUALITY_PRESETS[newQuality].label,
                }));
              }
            } else if (cmd.type === "activate_app" && cmd.appId) {
              // Viewer requests app activation
              const appId = cmd.appId as string;
              if (appId.startsWith("wf-")) {
                // Workflow app — resolve from DB, register transient, activate
                const wfId = appId.slice(3);
                try {
                  const wf = q.getWorkflow(wfId);
                  if (!wf) throw new Error("Workflow not found");
                  const nodes = q.getWorkflowNodes(wfId).map(n => ({ ...n, config: JSON.parse(n.config) }));
                  const edges = q.getWorkflowEdges(wfId);
                  const pipelineApps = resolveWorkflowToPipeline(nodes as any, edges as any, { id: wfId, name: wf.name }, undefined, wf.settings ? JSON.parse(wf.settings) : null);
                  const primaryApp = pipelineApps[0];
                  for (const app of pipelineApps) {
                    appRegistry.registerTransientApp(app);
                  }
                  if (primaryApp) {
                    session.activeAppId = primaryApp.id;
                    session.activeWorkflowId = wfId;
                    session.appPipeline = { appId: primaryApp.id, primitiveId: primaryApp.binding };
                    dbWriter.enqueue(q.updateSession(sessionId, { activeWorkflowId: wfId }));
                    // Register workflow instance for execution controls
                    if ((nodes as any[]).length > 1) {
                      const nodeEntries = (nodes as any[]).map((n: any) => ({
                        nodeId: n.id,
                        appId: n.id,
                        nodeType: n.type as WorkflowNodeType,
                        label: n.label || n.type,
                        triggerChained: false,
                      }));
                      orchestrator.activateWorkflow(sessionId, wfId, wf.name, nodeEntries);
                    }
                    for (const app of pipelineApps) {
                      // Route to correct orchestrator based on activationMode
                      if (app.config?.jepa) {
                        const jc = app.config.jepa as any;
                        await jepaOrchestrator.activate(sessionId, {
                          provider: jc.provider,
                          model: jc.model ?? app.config.model,
                          gpu: jc.gpu,
                          clipLength: jc.clipLength,
                          sampleFps: jc.sampleFps,
                          resolution: jc.resolution,
                          tasks: jc.tasks,
                          sessionId,
                        });
                      } else {
                        await orchestrator.activateWithConfig(sessionId, app);
                      }
                    }
                    console.log(`[relay] Viewer activated workflow app: ${primaryApp.id} session=${sessionId}`);
                    ws.send(JSON.stringify({ type: "app_status", appId: primaryApp.id, status: "active" }));
                  const ic = orchestrator.getInputConfig(sessionId);
                  if (ic && session.publisher) session.publisher.ws.send(JSON.stringify({ type: "configure_sources", input: ic }));
                  const cachedFrame = registry.getLastFrame(sessionId);
                    if (cachedFrame) sendCachedFrameToAI(sessionId, cachedFrame);
                  } else {
                    ws.send(JSON.stringify({ type: "app_status", appId, status: "active", info: "passive pipeline" }));
                    if (session.publisher?.ws) {
                      const publisherFlowConfig: FlowExecutionConfig | null = wf.flowConfig ? JSON.parse(wf.flowConfig) : null;
                      pushPassiveTTSChains(nodes as any, edges as any, session.publisher.ws, sessionId, publisherFlowConfig);
                    }
                  }
                } catch (e) {
                  ws.send(JSON.stringify({ type: "app_status", appId, status: "error", error: String(e) }));
                }
              } else {
                const pipeline = appRegistry.resolvePipeline(appId);
                if (pipeline) {
                  session.activeAppId = appId;
                  session.appPipeline = pipeline;
                  console.log(`[relay] Viewer activated app: ${appId} session=${sessionId}`);
                  ws.send(JSON.stringify({ type: "app_status", appId, status: "active" }));
                  orchestrator.activateApp(sessionId, appId).catch(() => {});
                  const cachedFrame = registry.getLastFrame(sessionId);
                  if (cachedFrame) sendCachedFrameToAI(sessionId, cachedFrame);
                } else {
                  ws.send(JSON.stringify({ type: "app_status", appId, status: "error", error: "App not found" }));
                }
              }
            } else if (cmd.type === "deactivate_app") {
              // Viewer requests app deactivation
              const prevApp = session.activeAppId;
              session.activeAppId = null;
              session.activeWorkflowId = null;
              session.appPipeline = null;
              console.log(`[relay] Viewer deactivated app: ${prevApp} session=${sessionId}`);
              // Audit log: record deactivation
              if (prevApp) {
                dbWriter.enqueue(q.deactivateActivation(sessionId, "viewer"));
                dbWriter.flushNow();
              }
              ws.send(JSON.stringify({ type: "app_status", appId: prevApp, status: "inactive" }));
              orchestrator.deactivateApp(sessionId).catch(() => {});
            } else if (cmd.type === "trigger_gesture" && cmd.gesture) {
              // Viewer triggers a gesture (testing/debugging)
              controlEventBus.publish({
                type: "gesture",
                gesture: cmd.gesture,
                confidence: cmd.confidence ?? 1.0,
                timestampMs: Date.now(),
              });
              console.log(`[relay] Viewer gesture: ${cmd.gesture} session=${sessionId}`);
              const viewerPipeline = appRegistry.resolveByGesture(cmd.gesture);
              if (viewerPipeline) {
                orchestrator.activateApp(sessionId, viewerPipeline.appId).catch(() => {});
                // Send cached frame to AI for immediate context
                const cachedFrame = registry.getLastFrame(sessionId);
                if (cachedFrame) sendCachedFrameToAI(sessionId, cachedFrame);
              }
            } else if (cmd.type === "set_vision_fps" && typeof cmd.fps === "number") {
              // Viewer updates vision FPS at runtime
              const fps = Math.max(0.1, Math.min(cmd.fps, 5));
              orchestrator.setVisionFps(sessionId, fps);
              console.log(`[relay] Vision FPS set to ${fps} session=${sessionId}`);
              ws.send(JSON.stringify({ type: "vision_fps", fps }));
            } else if (cmd.type === "send_text" && typeof cmd.text === "string") {
              // Viewer sends text prompt to the active AI service
              const text = cmd.text.slice(0, 1000);
              if (text.length > 0) {
                orchestrator.sendTrigger(sessionId, text);
                console.log(`[relay] Text to AI: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}" session=${sessionId}`);
              }
            } else if (cmd.type === "ai_telemetry") {
              // Viewer requests telemetry
              ws.send(JSON.stringify({
                type: "ai_telemetry",
                telemetry: orchestrator.getTelemetry(sessionId),
              }));
            } else if (cmd.type === "workflow_control") {
              // Viewer requests workflow control action
              const action = cmd.action as string;
              const workflowId = cmd.workflowId as string;
              const nodeId = cmd.nodeId as string | undefined;
              if (action && workflowId) {
                await orchestrator.handleWorkflowControl(sessionId, action as any, workflowId, nodeId, "viewer");
                // On stop_workflow, also clear session-level state
                if (action === "stop_workflow") {
                  session.activeAppId = null;
                  session.activeWorkflowId = null;
                  session.appPipeline = null;
                  dbWriter.enqueue(q.deactivateActivation(sessionId, "viewer"));
                  dbWriter.flushNow();
                  broadcastToViewers(session, { type: "app_status", appId: null, status: "inactive" });
                }
              }
            } else if (isBackpressureMessage(cmd)) {
              // Viewer -> Server -> Publisher: relay backpressure signal (clamp to 1-60 fps)
              const clampedFps = Math.max(1, Math.min(60, cmd.targetFps));
              console.log(`[relay] Backpressure from viewer: targetFps=${clampedFps} session=${sessionId}`);
              const publisherWs = session.publisher?.ws;
              if (publisherWs && publisherWs.readyState === WebSocket.OPEN) {
                publisherWs.send(JSON.stringify({ type: "backpressure", targetFps: clampedFps }));
              }
            } else if (cmd.type === "set_audio_mode") {
              // Viewer -> Server -> Publisher: relay mic switching command
              const mode = cmd.mode as string;
              if (["phone", "glasses", "all"].includes(mode)) {
                console.log(`[relay] Audio mode change from viewer: mode=${mode} session=${sessionId}`);
                const publisherWs = session.publisher?.ws;
                if (publisherWs && publisherWs.readyState === WebSocket.OPEN) {
                  publisherWs.send(JSON.stringify({ type: "set_audio_mode", mode }));
                }
              }
            } else if (cmd.type === "set_audio_gain") {
              // Viewer -> Server -> Publisher: per-source gain control
              const publisherWs = session.publisher?.ws;
              if (publisherWs && publisherWs.readyState === WebSocket.OPEN) {
                publisherWs.send(JSON.stringify({ type: "set_audio_gain", codecType: cmd.codecType, gainDb: cmd.gainDb }));
              }
            } else if (cmd.type === "set_noise_gate") {
              // Viewer -> Server -> Publisher: per-source noise gate
              const publisherWs = session.publisher?.ws;
              if (publisherWs && publisherWs.readyState === WebSocket.OPEN) {
                publisherWs.send(JSON.stringify({ type: "set_noise_gate", codecType: cmd.codecType, threshold: cmd.threshold }));
              }
            } else if (cmd.type === "set_noise_suppression") {
              // Viewer -> Server -> Publisher: per-source noise suppression toggle
              const publisherWs = session.publisher?.ws;
              if (publisherWs && publisherWs.readyState === WebSocket.OPEN) {
                publisherWs.send(JSON.stringify({ type: "set_noise_suppression", codecType: cmd.codecType, enabled: cmd.enabled }));
              }
            } else if (cmd.type === "set_audio_mix") {
              // Viewer -> Server -> Publisher: audio mix control
              const publisherWs = session.publisher?.ws;
              if (publisherWs && publisherWs.readyState === WebSocket.OPEN) {
                publisherWs.send(JSON.stringify({ type: "set_audio_mix", enabled: cmd.enabled, weightPhone: cmd.weightPhone, weightGlasses: cmd.weightGlasses }));
              }
            } else if (cmd.type === "get_audio_config") {
              // Viewer -> Server -> Publisher: request current audio config
              const publisherWs = session.publisher?.ws;
              if (publisherWs && publisherWs.readyState === WebSocket.OPEN) {
                publisherWs.send(JSON.stringify({ type: "get_audio_config" }));
              }
            } else if (cmd.type === "capture_photo") {
              const publisherWs = session.publisher?.ws;
              if (publisherWs && publisherWs.readyState === WebSocket.OPEN) {
                publisherWs.send(JSON.stringify({ type: "capture_photo" }));
              }
            } else if (cmd.type === "start_recording") {
              const publisherWs = session.publisher?.ws;
              if (publisherWs && publisherWs.readyState === WebSocket.OPEN) {
                publisherWs.send(JSON.stringify({ type: "start_recording" }));
              }
            } else if (cmd.type === "stop_recording") {
              const publisherWs = session.publisher?.ws;
              if (publisherWs && publisherWs.readyState === WebSocket.OPEN) {
                publisherWs.send(JSON.stringify({ type: "stop_recording" }));
              }
            } else if (cmd.type === "start_stream") {
              const publisherWs = session.publisher?.ws;
              if (publisherWs && publisherWs.readyState === WebSocket.OPEN) {
                publisherWs.send(JSON.stringify({ type: "start_stream" }));
              }
            } else if (cmd.type === "stop_stream") {
              const publisherWs = session.publisher?.ws;
              if (publisherWs && publisherWs.readyState === WebSocket.OPEN) {
                publisherWs.send(JSON.stringify({ type: "stop_stream" }));
              }
            } else if (cmd.type === "speak_text" && typeof cmd.text === "string") {
              const publisherWs = session.publisher?.ws;
              if (publisherWs && publisherWs.readyState === WebSocket.OPEN) {
                publisherWs.send(JSON.stringify({ type: "speak_text", text: cmd.text.slice(0, 500) }));
              }
            } else if (cmd.type === "set_codec" && typeof cmd.codec === "string") {
              // Viewer -> Server -> Publisher: relay codec switch command
              const codec = (cmd.codec as string).toLowerCase();
              if (["jpeg", "h264"].includes(codec)) {
                console.log(`[relay] Codec change from viewer: codec=${codec} session=${sessionId}`);
                // Start/stop H.264 decoder based on new codec
                if (codec === "h264" && session.activeAppId) {
                  getH264Decoder(sessionId).start();
                } else {
                  stopH264Decoder(sessionId);
                }
                const publisherWs = session.publisher?.ws;
                if (publisherWs && publisherWs.readyState === WebSocket.OPEN) {
                  publisherWs.send(JSON.stringify({ type: "set_codec", codec }));
                }
              }
            }
          } catch (err) { console.warn("[relay] Viewer message parse error:", err); }
        } else {
          // Binary frame from viewer — forward FRAU audio to publisher
          const buf = message as Uint8Array;
          if (isAudioFrame(buf)) {
            const sent = registry.sendToPublisher(sessionId, buf);
            if (!sent) {
              console.warn(`[relay] Viewer audio frame dropped: publisher not connected for session=${sessionId}`);
            }
            // Log first frame only, then every 100th
            if (sent && !ws.data._audioFrameCount) {
              ws.data._audioFrameCount = 1;
              console.log(`[relay] Viewer audio forwarding to publisher: session=${sessionId} frameSize=${buf.length}`);
            } else if (sent) {
              ws.data._audioFrameCount = (ws.data._audioFrameCount ?? 0) + 1;
              if (ws.data._audioFrameCount % 100 === 0) {
                console.log(`[relay] Viewer audio: ${ws.data._audioFrameCount} frames forwarded session=${sessionId}`);
              }
            }
          }
        }
      }
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
