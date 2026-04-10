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
import { isAudioFrame, isVideoFrame, parseAudioHeader } from "./protocol.js";
import { SessionRegistry } from "./session-registry.js";
import { AudioTapBus } from "./audio-tap.js";
import { verifyToken, extractToken } from "./auth.js";
import {
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

// --- Audio Tap Bus ---
// Pluggable audio dispatch: custom taps subscribe to receive parsed audio frames.
// Built-in taps (fanout, recording) continue via their existing paths.
// Add custom taps via: audioTapBus.subscribe()

const audioTapBus = new AudioTapBus();

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

// --- Load HTML template from Vite build output ---

const VIEWER_DIR = join(import.meta.dir, "../../viewer/dist");
const viewerHtml = await Bun.file(join(VIEWER_DIR, "index.html")).text().catch(() =>
  "<html><body><h1>Viewer HTML not found. Run: cd ../viewer && bun run build</h1></body></html>"
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

// --- Helpers ---

async function findLatestSessionId(): Promise<string | null> {
  const keys = await store.list("sessions/") as string[];
  const metaKeys = keys.filter(k => k.endsWith("/meta.json"));
  if (metaKeys.length === 0) return null;

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
  return latestId;
}

// --- Auth config injection into viewer HTML ---

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const NO_AUTH_FLAG = process.env.RELAY_NO_AUTH === "1";
const VIEWER_GIT_COMMIT = process.env.GIT_COMMIT?.slice(0, 7) ?? "dev";
const VIEWER_BUILD_VERSION = process.env.BUILD_VERSION ?? "dev";

function injectAuthConfig(html: string): string {
  let result = html;
  const authScript = `<script>window.__GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID}";${NO_AUTH_FLAG ? 'document.documentElement.dataset.noAuth="1";' : ''}window.__VIEWER_VERSION={gitCommit:"${VIEWER_GIT_COMMIT}",buildVersion:"${VIEWER_BUILD_VERSION}"};</script>`;
  // Inject right before the closing </head> if not already present
  result = result.replace("</head>", `${authScript}</head>`);
  return result;
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
      const token = extractToken(req, url);
      const user = await verifyToken(token);
      if (!user) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const s = await registry.stats(wifiIp, PORT, serverStartTime, store);
      return Response.json({ ...s, audioTaps: audioTapBus.tapCount() });
    }

    // --- Gallery (redirect to root — unified page) ---

    if (url.pathname === "/gallery") {
      return Response.redirect(`${req.headers.get("x-forwarded-proto") || "https"}://${req.headers.get("host") || url.host}/`);
    }

    if (url.pathname === "/gallery/api") {
      const data = await galleryCached();
      return Response.json(data, {
        headers: { "Cache-Control": "public, max-age=15" },
      });
    }

    // --- Static viewer assets (Vite build output) ---

    if (url.pathname.startsWith("/assets/")) {
      const filePath = join(VIEWER_DIR, url.pathname);
      const file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file);
      }
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

    // --- Serve unified page scoped to a session: /session/<id> ---

    const liveSessionMatch = url.pathname.match(/^\/session\/([^/]+)$/);
    if (liveSessionMatch) {
      const sessionId = liveSessionMatch[1];
      const liveSession = registry.get(sessionId);
      if (!liveSession) {
        const data = await store.get(`sessions/${sessionId}/meta.json`);
        if (!data) return Response.json({ error: "Session not found" }, { status: 404 });
      }
      const gallery = await galleryCached();
      const html = injectAuthConfig(viewerHtml
        .replace("<!--__GALLERY_DATA__-->", `<script>window.__GALLERY_DATA=${JSON.stringify(gallery)};</script>`)
        .replace("</head>", `<script>window.__SESSION_ID = "${sessionId}";</script></head>`));
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }

    // --- Push audio to publisher: POST /session/<id>/audio-in ---

    const audioInMatch = url.pathname.match(/^\/session\/([^/]+)\/audio-in$/);
    if (audioInMatch && req.method === "POST") {
      const sessionId = audioInMatch[1];
      const token = extractToken(req, url);
      const user = await verifyToken(token);
      if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

      const buf = await req.arrayBuffer();
      if (buf.byteLength < 29) return Response.json({ error: "Payload too small" }, { status: 400 });

      const data = new Uint8Array(buf);
      if (!isAudioFrame(data)) return Response.json({ error: "Not a FRAU frame" }, { status: 400 });

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
          const mp4Resp = await fetch(cachedUrl);
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

    // --- Root: unified page (gallery + directory + live player) ---

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const data = await galleryCached();
      const html = injectAuthConfig(viewerHtml.replace(
        "<!--__GALLERY_DATA__-->",
        `<script>window.__GALLERY_DATA=${JSON.stringify(data)};</script>`
      ));
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }

    // --- Audio tap WebSocket: /tap/audio?session=<id> ---

    if (url.pathname === "/tap/audio") {
      const token = extractToken(req, url);
      const user = await verifyToken(token);
      if (!user) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const sessionId = url.searchParams.get("session") || "default";
      const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
        || req.headers.get("x-real-ip")
        || "unknown";
      server.upgrade(req, { data: { role: "audio-tap", clientIp, sessionId, userId: user.sub, email: user.email } });
      return new Response(null, { status: 204 });
    }

    // --- /view as HTML page (browser GET) or WebSocket upgrade ---

    const isPublish = url.pathname === "/publish";
    const isView = url.pathname === "/view";
    if (!isPublish && !isView) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    // Browser navigated to /view?session=<id> — serve the viewer page
    const wsUpgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
    if (isView && !wsUpgrade) {
      const sessionId = registry.resolveSessionId(url);
      const gallery = await galleryCached();
      const html = injectAuthConfig(viewerHtml
        .replace("<!--__GALLERY_DATA__-->", `<script>window.__GALLERY_DATA=${JSON.stringify(gallery)};</script>`)
        .replace("</head>", `<script>window.__SESSION_ID = "${sessionId}";</script></head>`));
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }

    const role = isPublish ? "publish" : "view";
    const sessionId = registry.resolveSessionId(url);
    const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || req.headers.get("x-real-ip")
      || "unknown";

    // Auth check for WebSocket upgrade
    const token = extractToken(req, url);
    const user = await verifyToken(token);
    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    server.upgrade(req, { data: { role, clientIp, sessionId, userId: user.sub, email: user.email } });
    return new Response(null, { status: 204 });
  },
  websocket: {
    open(ws) {
      const { role, clientIp, sessionId } = ws.data;

      if (role === "audio-tap") {
        const unsub = audioTapBus.onFrame((frame) => {
          if (ws.readyState !== WebSocket.OPEN) { unsub(); return; }
          ws.send(JSON.stringify({
            type: "audio",
            codecType: frame.codecType,
            sequence: frame.sequence,
            sampleRate: frame.sampleRate,
            channels: frame.channels,
            bitsPerSample: frame.bitsPerSample,
            timestampMs: frame.timestampMs,
            pcmBase64: Buffer.from(frame.pcm).toString("base64"),
          }));
        });
        ws.data = { ...ws.data, unsub };
        console.log(`[relay] Audio tap connected: session=${sessionId} taps=${audioTapBus.tapCount()}`);
        return;
      }

      if (role === "publish") {
        const err = registry.claimPublisher(sessionId, ws, clientIp, ws.data.userId, ws.data.email);
        if (err) {
          ws.close(err === "session owned by another user" ? 4003 : 4001, err);
          return;
        }
      } else {
        const result = registry.addViewer(sessionId, ws, clientIp, ws.data.userId, ws.data.email);
        if (result.startsWith("error:")) {
          ws.close(4003, result.slice(6));
          return;
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
              session.publisher.deviceId = cmd.deviceId || null;
              session.publisher.deviceName = cmd.deviceName || null;
              session.publisher.wearableId = cmd.wearableId || null;
              session.publisher.wearableType = cmd.wearableType || null;
              session.publisher.deviceModel = cmd.deviceModel || null;
              session.publisher.systemVersion = cmd.systemVersion || null;
              session.publisher.appVersion = cmd.appVersion || null;
              session.publisher.buildNumber = cmd.buildNumber || null;

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
            const audioHdr = parseAudioHeader(buf);
            registry.fanoutAudio(sessionId, buf, audioHdr?.codecType ?? 0, audioHdr?.sampleRate ?? 0);
            session.recorder?.appendAudio(buf);
            audioTapBus.publish(buf);
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
            }
          } catch {}
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
