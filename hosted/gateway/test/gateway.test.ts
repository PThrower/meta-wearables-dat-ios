/**
 * gateway e2e tests
 *
 * Starts a mock relay server and a real gateway server in-process,
 * then makes HTTP requests through the gateway to verify:
 *   - Static file serving (landing page, gallery SPA, assets)
 *   - Proxy pass-through (query params, method, body preserved)
 *   - Auth endpoints (refresh, logout)
 *   - Health and config endpoints
 *   - Relay unavailability (502)
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createFetchHandler } from "../src/index.js";

// --- Port allocation ---

let relayPort = 0;
let gatewayPort = 0;

// Allocate ports by binding socket then closing
async function allocatePorts(n: number): Promise<number[]> {
  const sockets: any[] = [];
  const ports: number[] = [];
  for (let i = 0; i < n; i++) {
    const { promise, resolve } = Promise.withResolvers<number>();
    const s = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data() {},
        open() {},
        close() {},
        error() {},
      },
    });
    ports.push(s.port);
    s.stop();
  }
  return ports;
}

// --- Mock relay server state ---

interface CapturedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
}

let captured: CapturedRequest | null = null;
let tempDistDir: string;
let relayServer: ReturnType<typeof Bun.serve>;
let gatewayServer: ReturnType<typeof Bun.serve>;

function resetCaptured() {
  captured = null;
}

// Mock relay handler
function mockRelayHandler(req: Request): Response {
  const url = new URL(req.url);
  captured = {
    method: req.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
    headers: Object.fromEntries(req.headers.entries()),
  };

  if (url.pathname === "/gallery/api") return Response.json([]);
  if (url.pathname === "/stats" || url.pathname === "/sessions") return Response.json({ ok: true });
  if (url.pathname === "/apps") return Response.json([{ id: "test-app" }]);
  if (url.pathname.startsWith("/latest/")) return Response.json({ latest: true });
  if (url.pathname.match(/^\/session\/[^/]+\/audio-in$/) && req.method === "POST")
    return Response.json({ ok: true, bytes: 100 });
  if (url.pathname.match(/^\/session\/[^/]+\/thumbnail$/))
    return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { headers: { "Content-Type": "image/jpeg" } });
  if (url.pathname.match(/^\/session\/[^/]+\/video\.mp4$/))
    return new Response("fake-mp4", { headers: { "Content-Type": "video/mp4" } });
  if (url.pathname.match(/^\/session\/[^/]+\/export$/))
    return Response.json({ sessionId: "test", segments: 5 });
  if (url.pathname.match(/^\/session\/[^/]+\/video\//))
    return Response.redirect("https://r2.example.com/video-seg");
  if (url.pathname.match(/^\/session\/[^/]+\/audio\//))
    return Response.redirect("https://r2.example.com/audio-chunk");
  return Response.json({ captured: true });
}

beforeAll(async () => {
  const ports = await allocatePorts(2);
  relayPort = ports[0];
  gatewayPort = ports[1];

  // Create temp viewer dist with fixture files
  tempDistDir = join(import.meta.dir, "__dist_fixture__");
  mkdirSync(join(tempDistDir, "assets"), { recursive: true });
  writeFileSync(join(tempDistDir, "landing.html"), "<html><body>landing</body></html>");
  writeFileSync(join(tempDistDir, "index.html"), "<html><body>spa</body></html>");
  writeFileSync(join(tempDistDir, "assets", "main-D1XAAt4f.js"), "console.log(1);");
  writeFileSync(join(tempDistDir, "assets", "main-DHQaXpJ5.css"), "body{margin:0}");

  // Set env so proxy.ts targets the mock relay (evaluated per-request now)
  process.env.RELAY_PORT = String(relayPort);
  process.env.VIEWER_DIST = tempDistDir;

  // Start mock relay
  relayServer = Bun.serve({ port: relayPort, hostname: "127.0.0.1", fetch: mockRelayHandler });

  // Start gateway (NO_AUTH mode)
  const noAuthHandler = createFetchHandler({ noAuth: true, viewerDist: tempDistDir });
  gatewayServer = Bun.serve({ port: gatewayPort, hostname: "127.0.0.1", fetch: noAuthHandler });
});

afterAll(() => {
  relayServer?.stop?.();
  gatewayServer?.stop?.();
  try { rmSync(tempDistDir, { recursive: true, force: true }); } catch {}
});

afterEach(() => { resetCaptured(); });

const GW = () => `http://127.0.0.1:${gatewayPort}`;

async function gw(path: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(`${GW()}${path}`, opts);
}

// ============================================================
// 1. Config endpoint
// ============================================================

describe("GET /api/config", () => {
  test("returns config JSON with noAuth flag", async () => {
    const res = await gw("/api/config");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.noAuth).toBe(true);
    expect(body.version).toBeDefined();
    expect(body.version.gitCommit).toBeDefined();
    expect(body.version.buildVersion).toBeDefined();
  });

  test("does NOT proxy to relay", async () => {
    await gw("/api/config");
    expect(captured).toBeNull();
  });
});

// ============================================================
// 2. Health endpoint
// ============================================================

describe("GET /health", () => {
  test("returns health JSON", async () => {
    const res = await gw("/health");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(body.timestamp).toBeDefined();
  });

  test("does NOT proxy to relay", async () => {
    await gw("/health");
    expect(captured).toBeNull();
  });
});

// ============================================================
// 3. Static file serving
// ============================================================

describe("Static file serving", () => {
  test("GET / serves landing page (HTML)", async () => {
    const res = await gw("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(captured).toBeNull();
  });

  test("GET /index.html serves landing page", async () => {
    const res = await gw("/index.html");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });

  test("GET /gallery serves SPA index.html", async () => {
    const res = await gw("/gallery");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(captured).toBeNull();
  });

  test("GET /gallery/ serves SPA index.html", async () => {
    const res = await gw("/gallery/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });

  test("GET /assets/*.js serves with correct MIME type and long cache", async () => {
    const res = await gw("/assets/main-D1XAAt4f.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("javascript");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
  });

  test("GET /assets/*.css serves CSS", async () => {
    const res = await gw("/assets/main-DHQaXpJ5.css");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/css");
  });

  test("SPA fallback: unknown routes serve index.html", async () => {
    const res = await gw("/some/deep/unknown/route");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });
});

// ============================================================
// 4. Proxy pass-through
// ============================================================

describe("Proxy pass-through", () => {
  test("GET /stats proxies to relay", async () => {
    const res = await gw("/stats");
    expect(res.status).toBe(200);
    expect(captured!.path).toBe("/stats");
    expect(captured!.method).toBe("GET");
  });

  test("GET /sessions proxies to relay", async () => {
    const res = await gw("/sessions");
    expect(res.status).toBe(200);
    expect(captured!.path).toBe("/sessions");
  });

  test("GET /apps proxies to relay", async () => {
    const res = await gw("/apps");
    expect(res.status).toBe(200);
    const body = await res.json() as any[];
    expect(body).toEqual([{ id: "test-app" }]);
    expect(captured!.path).toBe("/apps");
  });

  test("GET /latest/* proxies to relay", async () => {
    const res = await gw("/latest/video.mp4");
    expect(res.status).toBe(200);
    expect(captured!.path).toBe("/latest/video.mp4");
  });

  test("GET /gallery/api proxies to relay", async () => {
    const res = await gw("/gallery/api");
    expect(res.status).toBe(200);
    expect(captured!.path).toBe("/gallery/api");
  });

  test("query params forwarded to relay", async () => {
    await gw("/gallery/api?foo=bar&baz=qux");
    expect(captured!.query["foo"]).toBe("bar");
    expect(captured!.query["baz"]).toBe("qux");
  });

  test("share query param forwarded", async () => {
    await gw("/session/abc-123/thumbnail?share=shr_abc123");
    expect(captured!.query["share"]).toBe("shr_abc123");
  });

  test("token query param forwarded", async () => {
    await gw("/session/abc-123/video.mp4?audio&token=fake");
    expect(captured!.query["audio"]).toBe("");
    expect(captured!.query["token"]).toBe("fake");
  });

  test("custom headers forwarded through proxy", async () => {
    await gw("/stats", {
      headers: {
        "x-custom-header": "test-value",
        "x-forwarded-for": "1.2.3.4",
      },
    });
    expect(captured!.headers["x-custom-header"]).toBe("test-value");
    expect(captured!.headers["x-forwarded-for"]).toBe("1.2.3.4");
  });
});

// ============================================================
// 5. Session sub-routes
// ============================================================

describe("Session sub-routes", () => {
  test("POST /session/{id}/audio-in proxies to relay", async () => {
    const res = await gw("/session/abc-123/audio-in", {
      method: "POST",
      body: new Uint8Array(100),
    });
    expect(res.status).toBe(200);
    expect(captured!.path).toBe("/session/abc-123/audio-in");
    expect(captured!.method).toBe("POST");
  });

  test("GET /session/{id}/thumbnail proxies to relay", async () => {
    const res = await gw("/session/abc-123/thumbnail");
    expect(res.status).toBe(200);
    expect(captured!.path).toBe("/session/abc-123/thumbnail");
  });

  test("GET /session/{id}/video.mp4 proxies to relay", async () => {
    const res = await gw("/session/abc-123/video.mp4?audio");
    expect(res.status).toBe(200);
    expect(captured!.path).toBe("/session/abc-123/video.mp4");
  });

  test("GET /session/{id}/export proxies to relay", async () => {
    const res = await gw("/session/abc-123/export");
    expect(res.status).toBe(200);
    expect(captured!.path).toBe("/session/abc-123/export");
  });

  test("GET /session/{id}/video/* redirects via relay", async () => {
    const res = await fetch(`${GW()}/session/abc-123/video/seg-0001.mjpeg`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(captured!.path).toBe("/session/abc-123/video/seg-0001.mjpeg");
  });

  test("GET /session/{id}/audio/* redirects via relay", async () => {
    const res = await fetch(`${GW()}/session/abc-123/audio/chunk-0001.pcm`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(captured!.path).toBe("/session/abc-123/audio/chunk-0001.pcm");
  });

  test("POST /session/{id}/audio-in only matches POST", async () => {
    await gw("/session/abc-123/audio-in"); // GET
    expect(captured).toBeNull();
  });
});

// ============================================================
// 6. Auth endpoints
// ============================================================

describe("Auth endpoints", () => {
  test("POST /api/auth/logout returns ok", async () => {
    const res = await gw("/api/auth/logout", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
  });

  test("POST /api/auth/refresh returns 401 without token", async () => {
    const res = await gw("/api/auth/refresh", { method: "POST" });
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error).toContain("Missing token");
  });
});

// ============================================================
// 7. Relay unavailable → 502
// ============================================================

describe("Relay unavailable", () => {
  test("returns 502 when relay is down", async () => {
    relayServer.stop();

    const res = await gw("/stats");
    expect(res.status).toBe(502);
    const body = await res.json() as any;
    expect(body.error).toContain("unavailable");

    // Restart relay
    relayServer = Bun.serve({ port: relayPort, hostname: "127.0.0.1", fetch: mockRelayHandler });
  });
});

// ============================================================
// 8. Route priority and edge cases
// ============================================================

describe("Route priority", () => {
  test("GET /session/{id}/share falls through to SPA fallback", async () => {
    await gw("/session/abc-123/share");
    expect(captured).toBeNull(); // SPA fallback, not proxied
  });

  test("GET /session/{id}/access falls through to SPA fallback", async () => {
    await gw("/session/abc-123/access"); // GET
    expect(captured).toBeNull();
  });
});
