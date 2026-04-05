/**
 * caringmind-frame-relay
 *
 * Bun WebSocket relay server that:
 * 1. Accepts multiple publishers (iOS apps) on separate sessions
 * 2. Fans out frames to per-session browser viewers in real-time
 * 3. Uses WASM module for frame throttling (falls back to pure JS)
 *
 * Endpoints:
 *   /publish?session=<id>    - WebSocket, iOS publisher connects here
 *   /view?session=<id>       - WebSocket, browser viewers connect here
 *   /sessions                - JSON list of active sessions (live)
 *   /gallery                 - Content creator gallery (all recorded sessions)
 *   /gallery/api             - JSON feed for gallery with metadata + thumbnails
 *   /session/<id>            - Serve viewer HTML scoped to a session
 *   /session/<id>/thumbnail  - First-frame JPEG (cached to R2)
 *   /session/<id>/video.mp4  - MP4 export (cached to R2 after first build)
 *   /session/<id>/export     - JSON metadata about recorded session
 *   /latest/video.mp4        - Redirect to most recent session's mp4 export
 *   /latest/export           - JSON metadata for most recent session
 *   /stats                   - JSON stats (platform-wide + per-session + gallery)
 *   /                        - Directory page if sessions active, else viewer
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
import {
  exportSessionMp4,
  getSessionExportMeta,
  getSessionThumbnail,
  getCachedMp4Url,
  exportAndCacheMp4,
  getGalleryData,
  ExportError,
  type GallerySession,
} from "./session-export.js";

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

const galleryHtml = await Bun.file(join(import.meta.dir, "../../viewer/gallery.html")).text().catch(() =>
  ""
);

// --- Stale cleanup ---

setInterval(() => registry.cleanupStale(), 5_000);

// --- Gallery cache (30s TTL, avoids N+1 R2 fetches per refresh) ---

let galleryCache: { data: GallerySession[]; expiry: number } | null = null;
const GALLERY_TTL_MS = 30_000;

async function galleryCached(): Promise<GallerySession[]> {
  const now = Date.now();
  if (galleryCache && now < galleryCache.expiry) {
    // Patch live status from current registry state
    const liveIds = new Set(registry.listActive().map(s => s.id));
    for (const s of galleryCache.data) s.live = liveIds.has(s.sessionId);
    return galleryCache.data;
  }

  const active = registry.listActive();
  const liveIds = new Set(active.map(s => s.id));
  const data = await getGalleryData(store, liveIds);
  galleryCache = { data, expiry: now + GALLERY_TTL_MS };
  return data;
}

// --- Server ---

const server = Bun.serve<WsData>({
  hostname: "0.0.0.0",
  port: PORT,
  idleTimeout: 120,
  async fetch(req, server) {
    const url = new URL(req.url, `http://${req.headers.get("host") || "localhost"}`);

    // --- Latest session (timestamp-ordered, most recent) ---

    if (url.pathname === "/latest/video.mp4") {
      const keys = await store.list("sessions/") as string[];
      const metaKeys = keys.filter(k => k.endsWith("/meta.json"));
      if (metaKeys.length === 0) {
        return Response.json({ error: "No recorded sessions" }, { status: 404 });
      }
      // Fetch all meta.json, parse startedAt, pick most recent
      let latestId: string | null = null;
      let latestTime = 0;
      for (const mk of metaKeys) {
        const id = mk.slice("sessions/".length, mk.length - "/meta.json".length);
        const buf = await store.get(mk);
        if (!buf) continue;
        try {
          const meta = JSON.parse(new TextDecoder().decode(buf));
          const t = new Date(meta.startedAt).getTime();
          if (t > latestTime) { latestTime = t; latestId = id; }
        } catch {}
      }
      if (!latestId) {
        return Response.json({ error: "No valid session metadata" }, { status: 404 });
      }
      // Redirect to the actual mp4 export URL
      const proto = req.headers.get("x-forwarded-proto") || "https";
      const host = req.headers.get("host") || url.host;
      return Response.redirect(`${proto}://${host}/session/${latestId}/video.mp4?audio`);
    }

    if (url.pathname === "/latest/export") {
      const keys = await store.list("sessions/") as string[];
      const metaKeys = keys.filter(k => k.endsWith("/meta.json"));
      if (metaKeys.length === 0) {
        return Response.json({ error: "No recorded sessions" }, { status: 404 });
      }
      let latestId: string | null = null;
      let latestTime = 0;
      for (const mk of metaKeys) {
        const id = mk.slice("sessions/".length, mk.length - "/meta.json".length);
        const buf = await store.get(mk);
        if (!buf) continue;
        try {
          const meta = JSON.parse(new TextDecoder().decode(buf));
          const t = new Date(meta.startedAt).getTime();
          if (t > latestTime) { latestTime = t; latestId = id; }
        } catch {}
      }
      if (!latestId) {
        return Response.json({ error: "No valid session metadata" }, { status: 404 });
      }
      const meta = await getSessionExportMeta(latestId, store);
      return Response.json({ ...meta, sessionId: latestId });
    }

    // --- Stats ---

    if (url.pathname === "/stats") {
      return Response.json(await registry.stats(wifiIp, PORT, serverStartTime, store));
    }

    // --- Gallery ---

    if (url.pathname === "/gallery") {
      if (!galleryHtml) return Response.json({ error: "Gallery not available" }, { status: 404 });
      const data = await galleryCached();
      const injected = galleryHtml.replace(
        "<!--__GALLERY_DATA__-->",
        `<script>window.__GALLERY_DATA=${JSON.stringify(data)};</script>`
      );
      return new Response(injected, { headers: { "Content-Type": "text/html" } });
    }

    if (url.pathname === "/gallery/api") {
      const data = await galleryCached();
      return Response.json(data, {
        headers: { "Cache-Control": "public, max-age=15" },
      });
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
        // Serve from R2 cache if available
        const cachedUrl = await getCachedMp4Url(sessionId, store);
        if (cachedUrl) {
          console.log(`[export] Serving cached MP4 for ${sessionId.slice(0, 8)}`);
          return Response.redirect(cachedUrl);
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
console.log(`[relay] Gallery:  http://${wifiIp}:${PORT}/gallery`);
