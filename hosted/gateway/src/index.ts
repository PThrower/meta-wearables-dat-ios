/**
 * caringmind-gateway
 *
 * Auth gateway that sits between Caddy (TLS terminator) and the relay server.
 * Responsibilities:
 *   1. Serve the viewer SPA (static files from hosted/viewer/dist/)
 *   2. Verify Google JWT tokens on protected HTTP routes
 *   3. Inject trusted headers (X-User-Id, X-User-Email) for the relay server
 *   4. Proxy HTTP API requests to the relay server on localhost:8080
 *
 * WebSocket connections (/publish, /view, /tap/audio) are routed directly to
 * the relay server by Caddy — the relay server handles WS auth via deferred
 * hello messages. Future iteration will add WS proxying through the gateway.
 */

import { join, extname } from "node:path";
import { verifyToken, extractToken, extractShareToken, mintSessionToken, verifySessionToken, shouldRefreshSession, revokeToken } from "./auth.js";
import { proxyRequest } from "./proxy.js";
import type { AuthUser } from "./types.js";

// --- Config ---

const PORT = parseInt(process.env.GATEWAY_PORT || "3000");
const RELAY_PORT = process.env.RELAY_PORT || "8080";
const VIEWER_DIST = process.env.VIEWER_DIST || join(import.meta.dir, "../../viewer/dist");
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const NO_AUTH = process.env.GATEWAY_NO_AUTH === "1";
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

function serveStatic(filePath: string): Response | null {
  const fullPath = join(VIEWER_DIST, filePath);
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

// --- Auth helpers ---

async function requireAuth(req: Request, url: URL): Promise<{ user: AuthUser } | Response> {
  const token = extractToken(req, url);
  const user = await verifyToken(token);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return { user };
}

async function optionalAuth(req: Request, url: URL): Promise<AuthUser | null> {
  const token = extractToken(req, url);
  if (!token) return null;
  return verifyToken(token);
}

// --- Route handler (exported for testing) ---

export function createFetchHandler(config?: {
  noAuth?: boolean;
  googleClientId?: string;
  viewerDist?: string;
  gitCommit?: string;
  buildVersion?: string;
}) {
  const _noAuth = config?.noAuth ?? NO_AUTH;
  const _clientId = config?.googleClientId ?? GOOGLE_CLIENT_ID;
  const _gitCommit = config?.gitCommit ?? GIT_COMMIT;
  const _buildVersion = config?.buildVersion ?? BUILD_VERSION;
  const _viewerDist = config?.viewerDist ?? VIEWER_DIST;

  // Closure over config so tests can override
  const _verifyToken = (token: string | null | undefined) => {
    if (_noAuth) return Promise.resolve({ sub: "dev", email: "dev@localhost" } as AuthUser);
    return verifyToken(token);
  };

  // Static file serving (closure over _viewerDist)
  function _serveStatic(filePath: string): Response | null {
    const fullPath = join(_viewerDist, filePath);
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

  async function _requireAuth(req: Request, url: URL): Promise<{ user: AuthUser } | Response> {
    const token = extractToken(req, url);
    const user = await _verifyToken(token);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return { user };
  }

  async function _optionalAuth(req: Request, url: URL): Promise<AuthUser | null> {
    const token = extractToken(req, url);
    if (!token) {
      if (_noAuth) return { sub: "dev", email: "dev@localhost" } as AuthUser;
      return null;
    }
    return _verifyToken(token);
  }

  return async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url, `http://${req.headers.get("host") || "localhost"}`);
    const { pathname } = url;

    // --- Auth: exchange Google JWT for session token ---

    if (pathname === "/api/auth/exchange" && req.method === "POST") {
      try {
        const body = await req.json() as { credential?: string };
        const credential = body.credential;
        if (!credential) return Response.json({ error: "Missing credential" }, { status: 400 });

        // Verify the Google JWT via google-auth-library
        const user = await verifyToken(credential);
        if (!user) return Response.json({ error: "Invalid credential" }, { status: 401 });

        // Mint a long-lived session token
        const token = mintSessionToken(user.sub, user.email);
        return Response.json({ token, user: { sub: user.sub, email: user.email } });
      } catch {
        return Response.json({ error: "Invalid request" }, { status: 400 });
      }
    }

    // --- Auth: refresh session token ---

    if (pathname === "/api/auth/refresh" && req.method === "POST") {
      const token = extractToken(req, url);
      if (!token) return Response.json({ error: "Missing token" }, { status: 401 });

      // Only refresh valid (not expired) session tokens
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

    // --- Runtime config for SPA ---

    if (pathname === "/api/config") {
      return Response.json({
        googleClientId: _clientId,
        noAuth: _noAuth,
        version: { gitCommit: _gitCommit, buildVersion: _buildVersion },
      });
    }

    // --- Static files: landing page at root ---

    if (pathname === "/" || pathname === "/index.html") {
      const resp = _serveStatic("landing.html") || _serveStatic("index.html");
      if (resp) return resp;
    }

    // --- Static files: assets with hash ---

    if (pathname.startsWith("/assets/")) {
      const resp = _serveStatic(pathname.slice(1));
      if (resp) return resp;
    }

    // --- Gallery SPA entry ---

    if (pathname === "/gallery" || pathname === "/gallery/") {
      const resp = _serveStatic("index.html");
      if (resp) return resp;
    }

    // --- Gallery API ---

    if (pathname === "/gallery/api") {
      const token = extractToken(req, url);
      const user = token
        ? await _verifyToken(token)
        : (_noAuth ? await _verifyToken(null) : null);
      if (token && !user && !_noAuth) {
        return Response.json({ error: "token expired" }, { status: 401 });
      }
      return proxyRequest(req, pathname, user || undefined);
    }

    // --- Stats ---

    if (pathname === "/stats") {
      const authResult = await _requireAuth(req, url);
      if (authResult instanceof Response) return authResult;
      return proxyRequest(req, pathname, authResult.user);
    }

    // --- Sessions ---

    if (pathname === "/sessions") {
      const authResult = await _requireAuth(req, url);
      if (authResult instanceof Response) return authResult;
      return proxyRequest(req, pathname, authResult.user);
    }

    // --- Apps registry ---
    // Intentionally public: iOS client needs app discovery before login.

    if (pathname === "/apps") {
      return proxyRequest(req, pathname);
    }

    // --- Latest session (auth required) ---

    if (pathname.startsWith("/latest/")) {
      const authResult = await _requireAuth(req, url);
      if (authResult instanceof Response) return authResult;
      return proxyRequest(req, pathname, authResult.user);
    }

    // --- Session sub-routes ---

    const shareCreateMatch = pathname.match(/^\/session\/([^/]+)\/share$/);
    if (shareCreateMatch && req.method === "POST") {
      const authResult = await _requireAuth(req, url);
      if (authResult instanceof Response) return authResult;
      return proxyRequest(req, pathname, authResult.user);
    }

    const shareRevokeMatch = pathname.match(/^\/session\/([^/]+)\/share\/(shr_[^/]+)$/);
    if (shareRevokeMatch && req.method === "DELETE") {
      const authResult = await _requireAuth(req, url);
      if (authResult instanceof Response) return authResult;
      return proxyRequest(req, pathname, authResult.user);
    }

    const shareListMatch = pathname.match(/^\/session\/([^/]+)\/shares$/);
    if (shareListMatch && req.method === "GET") {
      const authResult = await _requireAuth(req, url);
      if (authResult instanceof Response) return authResult;
      return proxyRequest(req, pathname, authResult.user);
    }

    const accessMatch = pathname.match(/^\/session\/([^/]+)\/access$/);
    if (accessMatch && req.method === "PATCH") {
      const authResult = await _requireAuth(req, url);
      if (authResult instanceof Response) return authResult;
      return proxyRequest(req, pathname, authResult.user);
    }

    const audioInMatch = pathname.match(/^\/session\/([^/]+)\/audio-in$/);
    if (audioInMatch && req.method === "POST") {
      const authResult = await _requireAuth(req, url);
      if (authResult instanceof Response) return authResult;
      return proxyRequest(req, pathname, authResult.user);
    }

    // Session thumbnail
    const thumbMatch = pathname.match(/^\/session\/([^/]+)\/thumbnail$/);
    if (thumbMatch) {
      const shareTok = extractShareToken(url);
      const user = await _optionalAuth(req, url);
      if (!user && !shareTok && !_noAuth) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      return proxyRequest(req, pathname, user || undefined);
    }

    // Session video export
    const mp4Match = pathname.match(/^\/session\/([^/]+)\/video\.mp4$/);
    if (mp4Match) {
      const shareTok = extractShareToken(url);
      const user = await _optionalAuth(req, url);
      if (!user && !shareTok && !_noAuth) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      return proxyRequest(req, pathname, user || undefined);
    }

    // Session export metadata
    const exportMatch = pathname.match(/^\/session\/([^/]+)\/export$/);
    if (exportMatch) {
      const shareTok = extractShareToken(url);
      const user = await _optionalAuth(req, url);
      if (!user && !shareTok && !_noAuth) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      return proxyRequest(req, pathname, user || undefined);
    }

    // S3 retrieval (share token OR user auth required)
    const videoSegMatch = pathname.match(/^\/session\/([^/]+)\/video\/(.+)$/);
    if (videoSegMatch) {
      const shareTok = extractShareToken(url);
      const user = await _optionalAuth(req, url);
      if (!user && !shareTok && !_noAuth) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      return proxyRequest(req, pathname, user || undefined);
    }

    const audioSegMatch = pathname.match(/^\/session\/([^/]+)\/audio\/(.+)$/);
    if (audioSegMatch) {
      const shareTok = extractShareToken(url);
      const user = await _optionalAuth(req, url);
      if (!user && !shareTok && !_noAuth) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      return proxyRequest(req, pathname, user || undefined);
    }

    // --- SPA fallback ---

    const staticResp = _serveStatic("index.html");
    if (staticResp) return staticResp;

    return Response.json({ error: "Not found" }, { status: 404 });
  };
}

// --- Start server when run directly ---

if (import.meta.main) {
  const handler = createFetchHandler();

  Bun.serve({
    hostname: "0.0.0.0",
    port: PORT,
    fetch: handler,
  });

  console.log(`[gateway] Auth gateway on 0.0.0.0:${PORT}`);
  console.log(`[gateway] Proxying HTTP API to 127.0.0.1:${RELAY_PORT}`);
  console.log(`[gateway] Viewer dist: ${VIEWER_DIST}`);
  console.log(`[gateway] No-auth mode: ${NO_AUTH}`);
}
