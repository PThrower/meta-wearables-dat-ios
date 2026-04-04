/**
 * caringmind-frame-relay
 *
 * Bun WebSocket relay server that:
 * 1. Accepts multiple publishers (iOS apps) on separate sessions
 * 2. Fans out frames to per-session browser viewers in real-time
 * 3. Uses WASM module for frame throttling (falls back to pure JS)
 *
 * Endpoints:
 *   /publish?session=<id>  - WebSocket, iOS publisher connects here
 *   /view?session=<id>     - WebSocket, browser viewers connect here
 *   /sessions              - JSON list of active sessions (live)
 *   /session/<id>          - Serve viewer HTML scoped to a session
 *   /stats                 - JSON stats (platform-wide + per-session)
 *   /                      - Directory page if sessions active, else viewer
 *
 * Backward compatible: omitting ?session= routes to "default" session.
 *
 * Wire protocol (FRLY):
 *   [4B "FRLY"][8B sequence][4B width][4B height][1B quality][8B timestamp_ms][JPEG payload]
 */

import { join } from "node:path";
import os from "node:os";
import { createObjectStore, type ObjectStore } from "@ebowwa/object-store";

import type { WsData, QualityPreset } from "./types.js";
import { QUALITY_PRESETS } from "./types.js";
import { isAudioFrame, isVideoFrame } from "./protocol.js";
import { SessionRegistry } from "./session-registry.js";

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

// --- Session Registry ---

const registry = new SessionRegistry(store);

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

// --- Load HTML templates ---

const viewerHtml = await Bun.file(join(import.meta.dir, "../../viewer/index.html")).text().catch(() =>
  "<html><body><h1>Viewer HTML not found</h1></body></html>"
);

const directoryHtml = await Bun.file(join(import.meta.dir, "../../viewer/directory.html")).text().catch(() =>
  ""
);

// --- Stale cleanup ---

setInterval(() => registry.cleanupStale(), 5_000);

// --- Server ---

const server = Bun.serve<WsData>({
  hostname: "0.0.0.0",
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url, `http://${req.headers.get("host") || "localhost"}`);

    // --- Stats ---

    if (url.pathname === "/stats") {
      return Response.json(await registry.stats(wifiIp, PORT, serverStartTime));
    }

    // --- Live Sessions (active relay sessions) ---

    if (url.pathname === "/sessions") {
      const active = registry.listActive();

      // Merge with S3-stored historical sessions
      const keys = await store.list("sessions/") as string[];
      const historicalSessionIds: string[] = [];
      for (const key of keys) {
        if (key.startsWith("sessions/") && key.endsWith("/meta.json")) {
          historicalSessionIds.push(key.slice("sessions/".length, key.length - "/meta.json".length));
        }
      }

      // Combine: active sessions (with live metadata) + historical (id only)
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

    // --- Serve viewer scoped to a session: /session/<id> ---

    const liveSessionMatch = url.pathname.match(/^\/session\/([^/]+)$/);
    if (liveSessionMatch) {
      const sessionId = liveSessionMatch[1];
      // Check if session exists (live or historical)
      const liveSession = registry.get(sessionId);
      if (!liveSession) {
        // Check S3 for historical session
        const data = await store.get(`sessions/${sessionId}/meta.json`);
        if (!data) return Response.json({ error: "Session not found" }, { status: 404 });
      }
      // Inject session id into the HTML so the viewer auto-connects to the right session
      const html = viewerHtml.replace(
        "</head>",
        `<script>window.__SESSION_ID = "${sessionId}";</script></head>`
      );
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }

    // --- S3 Retrieval Endpoints ---

    const videoMatch = url.pathname.match(/^\/session\/([^/]+)\/video\/(.+)$/);
    if (videoMatch) {
      const [, id, seg] = videoMatch;
      const key = `sessions/${id}/video/${seg}`;
      try {
        const signed = await store.signedUrl(key, 3600);
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
        const signed = await store.signedUrl(key, 3600);
        return Response.redirect(signed);
      } catch {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
    }

    // --- Root: directory if sessions active, else viewer ---

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const active = registry.listActive();
      if (directoryHtml && active.length > 0) {
        // Inject live session data into directory page
        const html = directoryHtml.replace(
          "</head>",
          `<script>window.__SESSIONS = ${JSON.stringify(active)};</script></head>`
        );
        return new Response(html, { headers: { "Content-Type": "text/html" } });
      }
      return new Response(viewerHtml, { headers: { "Content-Type": "text/html" } });
    }

    // --- WebSocket upgrade: /publish and /view ---

    const isPublish = url.pathname === "/publish";
    const isView = url.pathname === "/view";
    if (!isPublish && !isView) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const role = isPublish ? "publish" : "view";
    const sessionId = registry.resolveSessionId(url);
    const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || req.headers.get("x-real-ip")
      || "unknown";

    server.upgrade(req, { data: { role, clientIp, sessionId } });
    return new Response(null, { status: 204 });
  },
  websocket: {
    open(ws) {
      const { role, clientIp, sessionId } = ws.data;

      if (role === "publish") {
        const err = registry.claimPublisher(sessionId, ws, clientIp);
        if (err) {
          ws.close(4001, err);
          return;
        }
      } else {
        registry.addViewer(sessionId, ws, clientIp);
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
              session.publisher.deviceId = cmd.deviceId || null;
              session.publisher.deviceName = cmd.deviceName || null;
              session.publisher.wearableId = cmd.wearableId || null;
              session.publisher.wearableType = cmd.wearableType || null;
              session.publisher.deviceModel = cmd.deviceModel || null;
              session.publisher.systemVersion = cmd.systemVersion || null;

              // Update session metadata
              session.metadata.deviceName = cmd.deviceName || null;
              session.metadata.deviceModel = cmd.deviceModel || null;
              session.metadata.deviceId = cmd.deviceId || null;
              session.metadata.systemVersion = cmd.systemVersion || null;
              session.metadata.wearableType = cmd.wearableType || null;

              console.log(`[relay] Publisher hello: device=${cmd.deviceName || "?"} wearable=${cmd.wearableType || "none"} ip=${session.publisher.clientIp} session=${sessionId}`);

              // Update recorder device info
              if (session.recorder) {
                session.recorder.deviceInfo = {
                  deviceId: cmd.deviceId || null,
                  deviceName: cmd.deviceName || null,
                  wearableId: cmd.wearableId || null,
                  wearableType: cmd.wearableType || null,
                  deviceModel: cmd.deviceModel || null,
                  systemVersion: cmd.systemVersion || null,
                };
              }
            }
          } catch {}
        } else {
          // Binary frame (Uint8Array in Bun)
          const buf = message as Uint8Array;

          if (isAudioFrame(buf)) {
            // Audio frame (FRAU)
            session.publisher.audioCount++;
            session.publisher.audioBytes += buf.length;
            registry.fanoutAudio(sessionId, buf);
            session.recorder?.appendAudio(buf);
          } else if (isVideoFrame(buf)) {
            // Video frame (FRLY)
            session.publisher.frameCount++;
            session.publisher.totalBytes += buf.length;
            registry.fanout(sessionId, buf);
            session.recorder?.appendVideo(buf);
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
            }
          } catch {}
        }
      }
    },
    async close(ws) {
      const { role, sessionId } = ws.data;

      if (role === "publish") {
        await registry.releasePublisher(sessionId);
      } else {
        const viewerId = ws.data.viewerId;
        if (viewerId) {
          registry.removeViewer(sessionId, viewerId);
        }
      }
    },
  },
});

console.log(`[relay] Server on 0.0.0.0:${PORT}`);
console.log(`[relay] Publisher: ws://${wifiIp}:${PORT}/publish[?session=<id>]`);
console.log(`[relay] Viewer:   http://${wifiIp}:${PORT}[?session=<id>]`);
console.log(`[relay] Directory: http://${wifiIp}:${PORT}/`);
