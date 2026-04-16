/**
 * caringmind-frame-relay
 *
 * Bun WebSocket relay server (pure API — no HTML serving).
 * Viewer SPA is served by Caddy from hosted/viewer/dist.
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
 *   /latest/video.mp4        - Redirect to most recent session's mp4 export
 *   /latest/export           - JSON metadata for most recent session
 *   /stats                   - JSON stats (platform-wide + per-session)
 *
 * Backward compatible: omitting ?session= routes to "default" session.
 *
 * Wire protocol (FRLY):
 *   [4B "FRLY"][8B sequence][4B width][4B height][1B quality][8B timestamp_ms][JPEG payload]
 */

import { join } from "node:path";
import os from "node:os";
import { createObjectStore, type ObjectStore } from "@ebowwa/object-store";

import type { WsData, QualityPreset, AccessLevel, AclEntry } from "./types.js";
import { QUALITY_PRESETS } from "./types.js";
import { isAudioFrame, isVideoFrame, parseAudioHeader } from "./protocol.js";
import { SessionRegistry } from "./session-registry.js";
import { AudioTapBus } from "./audio-tap.js";
import { ControlEventBus } from "./control-event-bus.js";
import { AppRegistry } from "./app-registry.js";
import { GuidanceOrchestrator } from "./guidance-orchestrator.js";
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

// --- Object Store ---

const store: ObjectStore = createObjectStore();
const sessionStore = new SessionStore(store);

// --- Session Registry ---

const registry = new SessionRegistry(store);

// --- Audio Tap Bus ---
// Pluggable audio dispatch: custom taps subscribe to receive parsed audio frames.
// Built-in taps (fanout, recording) continue via their existing paths.
// Add custom taps via: audioTapBus.subscribe()

const audioTapBus = new AudioTapBus();

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

// Audio push: when AI produces spoken audio, wrap as FRAU codecType 3 and
// push through the relay's audio-in path (fan-out to publisher + viewers).
orchestrator.setAudioPushFn((sessionId: string, pcm: Uint8Array) => {
  if (pcm.length === 0) return;

  console.log(`[relay] AI audio push: ${pcm.length} bytes session=${sessionId}`);

  // Build FRAU frame: codecType=3 (relay-inbound), 16kHz, mono, 16-bit
  const seq = BigInt(Date.now());
  const timestampMs = BigInt(Date.now());
  const headerSize = 29;
  const frame = new Uint8Array(headerSize + pcm.length);
  const view = new DataView(frame.buffer);

  // Magic "FRAU"
  view.setUint8(0, 0x46); view.setUint8(1, 0x52);
  view.setUint8(2, 0x41); view.setUint8(3, 0x55);
  // codecType = 3 (relay-inbound)
  view.setUint8(4, 3);
  // Sequence (u64 LE)
  view.setBigUint64(5, seq, true);
  // Sample rate 16000 (u32 LE)
  view.setUint32(13, 16000, true);
  // Channels 1 (u16 LE)
  view.setUint16(17, 1, true);
  // Bits per sample 16 (u16 LE)
  view.setUint16(19, 16, true);
  // Timestamp ms (u64 LE)
  view.setBigUint64(21, timestampMs, true);
  // PCM payload
  frame.set(pcm, headerSize);

  // Fan out to viewers
  registry.fanoutAudio(sessionId, frame, 3, 16000);

  // Push to publisher for local playback (glasses speakers via HFP)
  registry.sendToPublisher(sessionId, frame);

  // Record
  const session = registry.get(sessionId);
  session?.recorder?.appendAudio(frame);
});

orchestrator.start();

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
      const active = registry.listActive();

      const historicalSessionIds = await sessionStore.getSessionIds();

      const activeIds = new Set(active.map(s => s.id));
      const result = [
        ...active.map(s => ({
          id: s.id,
          live: true,
          publisherConnected: s.publisherConnected,
          viewerCount: s.viewerCount,
          metadata: s.metadata,
          uptimeMs: s.uptimeMs,
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
      if (buf.byteLength < 29) return Response.json({ error: "Payload too small" }, { status: 400 });

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
      const sessionId = thumbMatch[1];

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
      const sessionId = mp4Match[1];
      const includeAudio = url.searchParams.has("audio");
      try {
        // Serve from R2 cache if available — proxy through server to avoid
        // cross-origin redirect issues (R2 signed URLs are different origin).
        const cachedUrl = await getCachedMp4Url(sessionId, store);
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
      const sessionId = exportMetaMatch[1];
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

    // --- App Registry ---

    if (url.pathname === "/apps") {
      return Response.json(appRegistry.listApps());
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

    // --- Audio tap WebSocket: /tap/audio?session=<id> ---

    if (url.pathname === "/tap/audio") {
      const sessionId = url.searchParams.get("session") || "default";
      const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
        || req.headers.get("x-real-ip")
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
    const sessionId = registry.resolveSessionId(url);
    const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || req.headers.get("x-real-ip")
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
          // Send binary FRAU frame (raw PCM) instead of base64 JSON for efficiency
          // Reconstruct the original binary frame from the parsed AudioFrame
          const pcmLen = frame.pcm.length;
          const buf = new ArrayBuffer(29 + pcmLen);
          const view = new DataView(buf);
          // Magic "FRAU"
          view.setUint8(0, 0x46); view.setUint8(1, 0x52);
          view.setUint8(2, 0x41); view.setUint8(3, 0x55);
          view.setUint8(4, frame.codecType);
          view.setBigUint64(5, BigInt(frame.sequence), true);
          view.setUint32(13, frame.sampleRate, true);
          view.setUint16(17, frame.channels, true);
          view.setUint16(19, frame.bitsPerSample, true);
          view.setBigUint64(21, BigInt(frame.timestampMs), true);
          new Uint8Array(buf, 29).set(frame.pcm);
          ws.send(new Uint8Array(buf));
        });
        ws.data = { ...ws.data, unsub };
        console.log(`[relay] Audio tap connected: session=${sessionId} taps=${audioTapBus.tapCount()}`);
        return;
      }

      if (role === "publish") {
        const err = await registry.claimPublisher(sessionId, ws, clientIp, ws.data.userId, ws.data.email);
        if (err) {
          ws.close(err === "session owned by another user" ? 4003 : 4001, err);
          return;
        }
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

              // Update session metadata
              session.metadata.deviceName = strField(cmd.deviceName);
              session.metadata.deviceModel = strField(cmd.deviceModel);
              session.metadata.deviceId = strField(cmd.deviceId);
              session.metadata.systemVersion = strField(cmd.systemVersion);
              session.metadata.wearableType = strField(cmd.wearableType);

              console.log(`[relay] Publisher hello: device=${session.publisher.deviceName || "?"} wearable=${session.publisher.wearableType || "none"} ip=${session.publisher.clientIp} session=${sessionId}`);

              // Update recorder device info
              if (session.recorder) {
                session.recorder.deviceInfo = {
                  deviceId: strField(cmd.deviceId),
                  deviceName: strField(cmd.deviceName),
                  wearableId: strField(cmd.wearableId),
                  wearableType: strField(cmd.wearableType),
                  deviceModel: strField(cmd.deviceModel),
                  systemVersion: strField(cmd.systemVersion),
                };
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
              }
              // Forward gesture as text trigger to active AI service
              if (session.activeAppId) {
                orchestrator.sendTrigger(sessionId, `[Gesture detected: ${cmd.gesture}, confidence: ${cmd.confidence ?? 1.0}]`);
              }
            } else if (cmd.type === "activate_app") {
              // Activate an app for this session
              const appId = cmd.appId as string;
              const pipeline = appRegistry.resolvePipeline(appId);
              if (pipeline) {
                session.activeAppId = appId;
                session.appPipeline = pipeline;
                console.log(`[relay] App activated: ${appId} binding=${pipeline.primitiveId} session=${sessionId}`);
                // Confirm to publisher
                ws.send(JSON.stringify({ type: "app_status", appId, status: "active" }));
                // Notify orchestrator
                orchestrator.activateApp(sessionId, appId).catch(() => {});
              } else {
                console.warn(`[relay] App activation failed: ${appId} not found`);
                ws.send(JSON.stringify({ type: "app_status", appId, status: "error", error: "App not found" }));
              }
            } else if (cmd.type === "deactivate_app") {
              const prevApp = session.activeAppId;
              session.activeAppId = null;
              session.appPipeline = null;
              console.log(`[relay] App deactivated: ${prevApp} session=${sessionId}`);
              ws.send(JSON.stringify({ type: "app_status", appId: prevApp, status: "inactive" }));
              // Notify orchestrator
              orchestrator.deactivateApp(sessionId).catch(() => {});
            } else if (cmd.type === "set_vision_fps" && typeof cmd.fps === "number") {
              const fps = Math.max(0.1, Math.min(cmd.fps, 5));
              orchestrator.setVisionFps(sessionId, fps);
              ws.send(JSON.stringify({ type: "vision_fps", fps }));
            }
          } catch (err) { console.warn("[relay] Publisher message parse error:", err); }
        } else {
          // Binary frame (Uint8Array in Bun)
          const buf = message as Uint8Array;

          if (isAudioFrame(buf)) {
            // Audio frame (FRAU)
            session.publisher.audioCount++;
            session.publisher.audioBytes += buf.length;
            const audioHdr = parseAudioHeader(buf);
            registry.fanoutAudio(sessionId, buf, audioHdr?.codecType ?? 0, audioHdr?.sampleRate ?? 0);
            session.recorder?.appendAudio(buf);
            audioTapBus.publish(buf);

            // Forward PCM payload to AI service (if active)
            if (audioHdr && session.activeAppId) {
              const pcmPayload = buf.slice(29);
              orchestrator.sendAudio(sessionId, pcmPayload);
            }
          } else if (isVideoFrame(buf)) {
            // Video frame (FRLY)
            session.publisher.frameCount++;
            session.publisher.totalBytes += buf.length;
            registry.fanout(sessionId, buf);
            session.recorder?.appendVideo(buf);

            // Forward JPEG payload to AI service (if active, rate-limited by service)
            if (session.activeAppId) {
              const jpegPayload = buf.slice(29);
              orchestrator.sendVideoFrame(sessionId, jpegPayload);
            }
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
              const pipeline = appRegistry.resolvePipeline(appId);
              if (pipeline) {
                session.activeAppId = appId;
                session.appPipeline = pipeline;
                console.log(`[relay] Viewer activated app: ${appId} session=${sessionId}`);
                ws.send(JSON.stringify({ type: "app_status", appId, status: "active" }));
                orchestrator.activateApp(sessionId, appId).catch(() => {});
              } else {
                ws.send(JSON.stringify({ type: "app_status", appId, status: "error", error: "App not found" }));
              }
            } else if (cmd.type === "deactivate_app") {
              // Viewer requests app deactivation
              const prevApp = session.activeAppId;
              session.activeAppId = null;
              session.appPipeline = null;
              console.log(`[relay] Viewer deactivated app: ${prevApp} session=${sessionId}`);
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
              }
            } else if (cmd.type === "set_vision_fps" && typeof cmd.fps === "number") {
              // Viewer updates vision FPS at runtime
              const fps = Math.max(0.1, Math.min(cmd.fps, 5));
              orchestrator.setVisionFps(sessionId, fps);
              console.log(`[relay] Vision FPS set to ${fps} session=${sessionId}`);
              ws.send(JSON.stringify({ type: "vision_fps", fps }));
            } else if (cmd.type === "ai_telemetry") {
              // Viewer requests telemetry
              ws.send(JSON.stringify({
                type: "ai_telemetry",
                telemetry: orchestrator.getTelemetry(sessionId),
              }));
            }
          } catch (err) { console.warn("[relay] Viewer message parse error:", err); }
        } else {
          // Binary frame from viewer — forward FRAU audio to publisher
          const buf = message as Uint8Array;
          if (isAudioFrame(buf)) {
            const viewerId = ws.data.viewerId;
            if (viewerId) {
              const found = registry.findViewerSession(viewerId);
              if (found && found.session.publisher) {
                found.session.publisher.ws.send(buf);
              }
            }
          }
        }
      }
    },
    async close(ws) {
      const { role, sessionId } = ws.data;

      if (role === "audio-tap") {
        if (ws.data.unsub) ws.data.unsub();
        console.log(`[relay] Audio tap disconnected: session=${sessionId} taps=${audioTapBus.tapCount()}`);
        return;
      }

      if (role === "publish") {
        await registry.releasePublisher(sessionId);
        // Update gallery index incrementally and generate thumbnail
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

function shutdown() {
  console.log("[relay] Shutting down...");
  clearInterval(staleCleanupTimer);
  sessionStore.stopBackgroundTimers();
  orchestrator.stop();
  // Finish all active recorders
  for (const entry of registry.listActive()) {
    const s = registry.get(entry.id);
    if (s?.recorder) {
      s.recorder.finish().catch(() => {});
    }
  }
  server.stop(true);
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("unhandledRejection", (err) => {
  console.error("[relay] Unhandled rejection (not crashing):", err);
});
process.on("uncaughtException", (err) => {
  console.error("[relay] Uncaught exception (not crashing):", err);
});
