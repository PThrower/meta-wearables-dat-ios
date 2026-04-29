/**
 * caringmind-gateway
 *
 * Gateway that sits between Caddy (TLS terminator) and the relay server.
 * Responsibilities:
 *   1. Serve the web platform SPA (static files from hosted/web-platform/dist/)
 *   2. Proxy HTTP API requests to the relay server on localhost:8080
 *   3. Proxy WebSocket connections to the relay server
 */

import { join, extname } from "node:path";
import { extractToken, mintSessionToken, verifySessionToken, revokeToken } from "./auth.js";
import { proxyRequest } from "./proxy.js";

// --- Config ---

const gatewayStartTime = Date.now();
const PORT = parseInt(process.env.GATEWAY_PORT || "3000");
const RELAY_PORT = process.env.RELAY_PORT || "8080";
const VIEWER_DIST = process.env.VIEWER_DIST || join(import.meta.dir, "../../web-platform/dist");
const NO_AUTH = process.env.GATEWAY_NO_AUTH !== "0";
const GIT_COMMIT = process.env.GIT_COMMIT?.slice(0, 7) ?? "dev";
const BUILD_VERSION = process.env.BUILD_VERSION ?? "dev";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".wasm": "application/wasm",
};

// --- Static file serving ---

function serveStatic(baseDir: string, filePath: string): Response | null {
  const fullPath = join(baseDir, filePath);
  const file = Bun.file(fullPath);
  if (file.size === 0) return null;

  const ext = extname(fullPath);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  return new Response(file, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
    },
  });
}

// --- WS bridge data ---

interface WsBridgeData {
  targetUrl: string;
  upstream?: WebSocket | null;
  pending: (string | ArrayBuffer | Buffer)[];
}

// --- Route handler (exported for testing) ---

export function createFetchHandler(config?: {
  noAuth?: boolean;
  viewerDist?: string;
  gitCommit?: string;
  buildVersion?: string;
}) {
  const _noAuth = config?.noAuth ?? NO_AUTH;
  const _gitCommit = config?.gitCommit ?? GIT_COMMIT;
  const _buildVersion = config?.buildVersion ?? BUILD_VERSION;
  const _viewerDist = config?.viewerDist ?? VIEWER_DIST;

  return async function fetch(req: Request, server: any): Promise<Response> {
    const url = new URL(req.url, `http://${req.headers.get("host") || "localhost"}`);
    const { pathname } = url;

    // --- Auth: refresh session token ---

    if (pathname === "/api/auth/refresh" && req.method === "POST") {
      const token = extractToken(req, url);
      if (!token) return Response.json({ error: "Missing token" }, { status: 401 });

      const user = verifySessionToken(token);
      if (!user) return Response.json({ error: "Invalid or expired session" }, { status: 401 });

      const newToken = mintSessionToken(user.sub, user.email);
      return Response.json({ token: newToken, user: { sub: user.sub, email: user.email } });
    }

    // --- Auth: revoke session token (logout) ---

    if (pathname === "/api/auth/logout" && req.method === "POST") {
      const token = extractToken(req, url);
      if (token) revokeToken(token);
      return Response.json({ ok: true });
    }

    // --- Health (gateway-only, zero I/O, no relay dependency) ---

    if (pathname === "/health") {
      return Response.json({
        ok: true,
        uptimeMs: Date.now() - gatewayStartTime,
        timestamp: new Date().toISOString(),
        gitCommit: _gitCommit,
        buildVersion: _buildVersion,
      });
    }

    // --- Runtime config for SPA ---

    if (pathname === "/api/config") {
      return Response.json({
        noAuth: _noAuth,
        version: { gitCommit: _gitCommit, buildVersion: _buildVersion },
      });
    }

    // --- Static files: landing page at root ---

    if (pathname === "/" || pathname === "/index.html") {
      const resp = serveStatic(_viewerDist, "landing.html") || serveStatic(_viewerDist, "index.html");
      if (resp) return resp;
    }

    // --- Static files: assets with hash ---

    if (pathname.startsWith("/assets/")) {
      const resp = serveStatic(_viewerDist, pathname.slice(1));
      if (resp) return resp;
    }

    // --- Gallery SPA entry ---

    if (pathname === "/gallery" || pathname === "/gallery/") {
      const resp = serveStatic(_viewerDist, "index.html");
      if (resp) return resp;
    }

    // --- AI Telemetry dashboard ---

    if (pathname === "/telemetry" || pathname === "/telemetry/") {
      const resp = serveStatic(_viewerDist, "telemetry.html");
      if (resp) return resp;
    }

    // --- Fleet device management ---

    if (pathname === "/api/registered-devices" && req.method === "GET") {
      return proxyRequest(req, pathname);
    }

    if (pathname === "/api/devices" && req.method === "DELETE") {
      return proxyRequest(req, pathname);
    }

    if (pathname.startsWith("/api/devices/") && pathname.endsWith("/build-history") && req.method === "GET") {
      return proxyRequest(req, pathname);
    }

    if (pathname === "/api/device-token" && req.method === "POST") {
      return proxyRequest(req, pathname);
    }

    // --- APNs wake device ---

    if (pathname === "/api/wake-device" && req.method === "POST") {
      return proxyRequest(req, pathname);
    }

    // --- Gallery API ---

    if (pathname === "/gallery/api") {
      return proxyRequest(req, pathname);
    }

    // --- Stats ---

    if (pathname === "/stats") {
      return proxyRequest(req, pathname);
    }

    // --- Test: G2 glasses display injection ---
    if (pathname === "/test/display" && req.method === "POST") {
      return proxyRequest(req, pathname);
    }

    // --- Sessions ---

    if (pathname === "/sessions") {
      return proxyRequest(req, pathname);
    }

    // --- Apps registry ---

    if (pathname === "/apps") {
      return proxyRequest(req, pathname);
    }

    // --- Primitives (for workflow node palette) ---

    if (pathname === "/primitives") {
      return proxyRequest(req, pathname);
    }

    // --- Node definitions (configSchema for workflow editor) ---

    if (pathname === "/api/node-definitions" && req.method === "GET") {
      return proxyRequest(req, pathname);
    }

    // --- Workflow CRUD ---

    if (pathname === "/workflows") {
      return proxyRequest(req, pathname);
    }

    const wfMatch = pathname.match(/^\/workflows\/([^/]+)(\/activate|\/start-stream|\/stop-stream)?$/);
    if (wfMatch) {
      return proxyRequest(req, pathname);
    }

    // --- AI Telemetry ---

    if (pathname === "/telemetry/ai") {
      return proxyRequest(req, pathname);
    }

    // --- Latest session ---

    if (pathname.startsWith("/latest/")) {
      return proxyRequest(req, pathname);
    }

    // --- Session sub-routes ---

    const audioInMatch = pathname.match(/^\/session\/([^/]+)\/audio-in$/);
    if (audioInMatch && req.method === "POST") {
      return proxyRequest(req, pathname);
    }

    const thumbMatch = pathname.match(/^\/session\/([^/]+)\/thumbnail$/);
    if (thumbMatch) {
      return proxyRequest(req, pathname);
    }

    const mp4Match = pathname.match(/^\/session\/([^/]+)\/video\.mp4$/);
    if (mp4Match) {
      return proxyRequest(req, pathname);
    }

    const exportMatch = pathname.match(/^\/session\/([^/]+)\/export$/);
    if (exportMatch) {
      return proxyRequest(req, pathname);
    }

    const videoSegMatch = pathname.match(/^\/session\/([^/]+)\/video\/(.+)$/);
    if (videoSegMatch) {
      return proxyRequest(req, pathname);
    }

    const audioSegMatch = pathname.match(/^\/session\/([^/]+)\/audio\/(.+)$/);
    if (audioSegMatch) {
      return proxyRequest(req, pathname);
    }

    // --- Guidance history ---

    const guidanceMatch = pathname.match(/^\/session\/([^/]+)\/guidance/);
    if (guidanceMatch) {
      return proxyRequest(req, pathname);
    }

    // --- WebSocket proxy to relay server ---

    if (pathname === "/publish" || pathname === "/view" || pathname === "/tap/audio" || pathname === "/telemetry/ai/log") {
      const targetUrl = `ws://127.0.0.1:${RELAY_PORT}${pathname}${url.search}`;
      server.upgrade(req, { data: { targetUrl, pending: [] } satisfies WsBridgeData });
      return new Response(null, { status: 204 });
    }

    // --- SPA fallback ---

    const staticResp = serveStatic(_viewerDist, "index.html");
    if (staticResp) return staticResp;

    return Response.json({ error: "Not found" }, { status: 404 });
  };
}

// --- WebSocket handler: bridges client ↔ relay server ---

export const wsHandler = {
  open(ws: any) {
    const { targetUrl } = ws.data as WsBridgeData;
    const upstream = new WebSocket(targetUrl);

    upstream.addEventListener("open", () => {
      ws.data.upstream = upstream;
      // Flush any messages that arrived before upstream was ready
      const pending = ws.data.pending as WsBridgeData["pending"];
      ws.data.pending = [];
      for (const msg of pending) {
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.send(msg);
        }
      }
      console.log(`[gateway:ws] bridge open → ${targetUrl} (${pending.length} buffered)`);
    });

    upstream.addEventListener("message", (ev) => {
      try { ws.send(ev.data); } catch {}
    });

    upstream.addEventListener("close", (ev) => {
      try { ws.close(ev.code, ev.reason); } catch {}
    });

    upstream.addEventListener("error", () => {
      try { ws.close(1011, "upstream error"); } catch {}
    });
  },

  message(ws: any, message: string | ArrayBuffer | Buffer) {
    const data = ws.data as WsBridgeData;
    if (data.upstream && data.upstream.readyState === WebSocket.OPEN) {
      data.upstream.send(message);
    } else {
      // Buffer until upstream connects
      data.pending.push(message);
    }
  },

  close(ws: any, code: number, reason: string) {
    const { upstream } = ws.data as WsBridgeData;
    if (upstream) {
      try { upstream.close(code, reason); } catch {}
    }
  },
};

// --- Start server when run directly ---

if (import.meta.main) {
  const handler = createFetchHandler();

  Bun.serve({
    hostname: "0.0.0.0",
    port: PORT,
    fetch: handler,
    websocket: wsHandler,
  });

  console.log(`[gateway] Auth gateway on 0.0.0.0:${PORT}`);
  console.log(`[gateway] Proxying HTTP + WS to 127.0.0.1:${RELAY_PORT}`);
  console.log(`[gateway] Web platform dist: ${VIEWER_DIST}`);
  console.log(`[gateway] No-auth mode: ${NO_AUTH}`);
}
