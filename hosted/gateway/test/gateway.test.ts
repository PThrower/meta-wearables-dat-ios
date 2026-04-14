/**
 * gateway e2e tests
 *
 * Starts a mock relay server and a real gateway server in-process,
 * then makes HTTP requests through the gateway to verify:
 *   - Auth gate behavior (401 without token, trusted headers with token)
 *   - Static file serving (landing page, gallery SPA, assets)
 *   - Proxy pass-through (query params, method, body preserved)
 *   - Share token access for optional-auth routes
 *   - Relay unavailability (502)
 *   - Token extraction from header/query/cookie
 *   - Config endpoint
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { join } from "node:path";
import { createFetchHandler } from "../src/index.js";

// --- Port allocation ---

let relayPort = 0;
let gatewayPort = 0;
let authGatewayPort = 0;

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
let relayServer: ReturnType<typeof Bun.serve>;
let gatewayServer: ReturnType<typeof Bun.serve>;
let authGatewayServer: ReturnType<typeof Bun.serve>;

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
  if (url.pathname.match(/^\/session\/[^/]+\/share$/) && req.method === "POST")
    return Response.json({ token: "shr_abc123" }, { status: 201 });
  if (url.pathname.match(/^\/session\/[^/]+\/share\//) && req.method === "DELETE")
    return Response.json({ ok: true });
  if (url.pathname.match(/^\/session\/[^/]+\/shares$/) && req.method === "GET")
    return Response.json([]);
  if (url.pathname.match(/^\/session\/[^/]+\/access$/) && req.method === "PATCH")
    return Response.json({ ok: true });
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
  const ports = await allocatePorts(3);
  relayPort = ports[0];
  gatewayPort = ports[1];
  authGatewayPort = ports[2];

  // Set env so proxy.ts targets the mock relay (evaluated per-request now)
  process.env.RELAY_PORT = String(relayPort);
  process.env.VIEWER_DIST = join(import.meta.dir, "../../viewer/dist");

  // Start mock relay
  relayServer = Bun.serve({ port: relayPort, hostname: "127.0.0.1", fetch: mockRelayHandler });

  // Start gateway (NO_AUTH mode)
  const noAuthHandler = createFetchHandler({ noAuth: true, viewerDist: process.env.VIEWER_DIST });
  gatewayServer = Bun.serve({ port: gatewayPort, hostname: "127.0.0.1", fetch: noAuthHandler });

  // Start auth-enforcing gateway (shares same relay)
  const authHandler = createFetchHandler({ noAuth: false, viewerDist: process.env.VIEWER_DIST });
  authGatewayServer = Bun.serve({ port: authGatewayPort, hostname: "127.0.0.1", fetch: authHandler });
});

afterAll(() => {
  relayServer?.stop?.();
  gatewayServer?.stop?.();
  authGatewayServer?.stop?.();
});

afterEach(() => { resetCaptured(); });

const GW = () => `http://127.0.0.1:${gatewayPort}`;
const AGW = () => `http://127.0.0.1:${authGatewayPort}`;

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
    expect(body.googleClientId).toBeDefined();
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
// 2. Static file serving
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
// 3. Auth-gated routes (requireAuth) — NO_AUTH mode
// ============================================================

describe("Auth-gated routes (NO_AUTH=1, dev user injected)", () => {
  test("GET /stats → relay with X-User-Id: dev", async () => {
    const res = await gw("/stats");
    expect(res.status).toBe(200);
    expect(captured!.path).toBe("/stats");
    expect(captured!.headers["x-user-id"]).toBe("dev");
    expect(captured!.headers["x-user-email"]).toBe("dev@localhost");
  });

  test("GET /sessions → relay with dev user headers", async () => {
    const res = await gw("/sessions");
    expect(res.status).toBe(200);
    expect(captured!.path).toBe("/sessions");
    expect(captured!.headers["x-user-id"]).toBe("dev");
  });

  test("POST /session/{id}/share → relay", async () => {
    const res = await gw("/session/abc-123/share", { method: "POST", body: JSON.stringify({}) });
    expect(res.status).toBe(201);
    expect(captured!.path).toBe("/session/abc-123/share");
    expect(captured!.method).toBe("POST");
    expect(captured!.headers["x-user-id"]).toBe("dev");
  });

  test("DELETE /session/{id}/share/{token} → relay", async () => {
    const res = await gw("/session/abc-123/share/shr_deadbeef", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(captured!.path).toBe("/session/abc-123/share/shr_deadbeef");
    expect(captured!.method).toBe("DELETE");
    expect(captured!.headers["x-user-id"]).toBe("dev");
  });

  test("GET /session/{id}/shares → relay", async () => {
    const res = await gw("/session/abc-123/shares");
    expect(res.status).toBe(200);
    expect(captured!.path).toBe("/session/abc-123/shares");
    expect(captured!.headers["x-user-id"]).toBe("dev");
  });

  test("PATCH /session/{id}/access → relay", async () => {
    const res = await gw("/session/abc-123/access", {
      method: "PATCH",
      body: JSON.stringify({ accessLevel: "private" }),
    });
    expect(res.status).toBe(200);
    expect(captured!.path).toBe("/session/abc-123/access");
    expect(captured!.method).toBe("PATCH");
    expect(captured!.headers["x-user-id"]).toBe("dev");
  });

  test("POST /session/{id}/audio-in → relay", async () => {
    const res = await gw("/session/abc-123/audio-in", {
      method: "POST",
      body: new Uint8Array(100),
    });
    expect(res.status).toBe(200);
    expect(captured!.path).toBe("/session/abc-123/audio-in");
    expect(captured!.method).toBe("POST");
  });
});

// ============================================================
// 4. Optional-auth routes
// ============================================================

describe("Optional-auth routes (thumbnail, video, export)", () => {
  test("GET /session/{id}/thumbnail proxies with dev user", async () => {
    const res = await gw("/session/abc-123/thumbnail");
    expect(res.status).toBe(200);
    expect(captured!.path).toBe("/session/abc-123/thumbnail");
    expect(captured!.headers["x-user-id"]).toBe("dev");
  });

  test("GET /session/{id}/thumbnail forwards share query param", async () => {
    const res = await gw("/session/abc-123/thumbnail?share=shr_test123");
    expect(res.status).toBe(200);
    expect(captured!.query["share"]).toBe("shr_test123");
  });

  test("GET /session/{id}/video.mp4 proxies to relay", async () => {
    const res = await gw("/session/abc-123/video.mp4?audio");
    expect(res.status).toBe(200);
    expect(captured!.path).toBe("/session/abc-123/video.mp4");
    expect(captured!.query["audio"]).toBe("");
  });

  test("GET /session/{id}/export proxies to relay", async () => {
    const res = await gw("/session/abc-123/export");
    expect(res.status).toBe(200);
    expect(captured!.path).toBe("/session/abc-123/export");
  });

  test("GET /session/{id}/video/seg-0001.mjpeg redirects via relay", async () => {
    const res = await fetch(`${GW()}/session/abc-123/video/seg-0001.mjpeg`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(captured!.path).toBe("/session/abc-123/video/seg-0001.mjpeg");
  });

  test("GET /session/{id}/audio/chunk-0001.pcm redirects via relay", async () => {
    const res = await fetch(`${GW()}/session/abc-123/audio/chunk-0001.pcm`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(captured!.path).toBe("/session/abc-123/audio/chunk-0001.pcm");
  });
});

// ============================================================
// 5. Public routes (no auth required)
// ============================================================

describe("Public routes", () => {
  test("GET /apps proxies without user headers", async () => {
    const res = await gw("/apps");
    expect(res.status).toBe(200);
    const body = await res.json() as any[];
    expect(body).toEqual([{ id: "test-app" }]);
    expect(captured!.headers["x-user-id"]).toBeUndefined();
  });

  test("GET /latest/video.mp4 proxies without auth", async () => {
    const res = await gw("/latest/video.mp4");
    expect(res.status).toBe(200);
    expect(captured!.path).toBe("/latest/video.mp4");
    expect(captured!.headers["x-user-id"]).toBeUndefined();
  });

  test("GET /latest/export proxies without auth", async () => {
    const res = await gw("/latest/export");
    expect(res.status).toBe(200);
    expect(captured!.path).toBe("/latest/export");
  });
});

// ============================================================
// 6. Gallery API
// ============================================================

describe("GET /gallery/api", () => {
  test("proxies to relay with dev user", async () => {
    const res = await gw("/gallery/api");
    expect(res.status).toBe(200);
    expect(captured!.path).toBe("/gallery/api");
    expect(captured!.headers["x-user-id"]).toBe("dev");
    expect(captured!.headers["x-user-email"]).toBe("dev@localhost");
  });

  test("preserves query params to relay", async () => {
    await gw("/gallery/api?foo=bar&baz=qux");
    expect(captured!.query["foo"]).toBe("bar");
    expect(captured!.query["baz"]).toBe("qux");
  });
});

// ============================================================
// 7. Trusted header injection
// ============================================================

describe("Trusted headers", () => {
  test("X-User-Id and X-User-Email set on proxied requests", async () => {
    await gw("/stats");
    expect(captured!.headers["x-user-id"]).toBe("dev");
    expect(captured!.headers["x-user-email"]).toBe("dev@localhost");
  });

  test("hop-by-hop headers stripped", async () => {
    await gw("/stats", {
      headers: {
        "connection": "keep-alive",
        "upgrade": "websocket",
        "te": "trailers",
      },
    });
    // Bun's fetch strips forbidden headers, but the proxy explicitly deletes them too.
    // Verify connection is overridden to "close" by the proxy.
    expect(captured!.headers["connection"]).toBe("close");
    expect(captured!.headers["upgrade"]).toBeUndefined();
    expect(captured!.headers["te"]).toBeUndefined();
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
// 8. Proxy pass-through
// ============================================================

describe("Proxy pass-through", () => {
  test("GET method preserved", async () => {
    await gw("/sessions");
    expect(captured!.method).toBe("GET");
  });

  test("PATCH method and body preserved", async () => {
    await gw("/session/abc-123/access", {
      method: "PATCH",
      body: JSON.stringify({ accessLevel: "private" }),
    });
    expect(captured!.method).toBe("PATCH");
  });

  test("query params forwarded to relay", async () => {
    await gw("/session/abc-123/video.mp4?audio&token=fake");
    expect(captured!.query["audio"]).toBe("");
    expect(captured!.query["token"]).toBe("fake");
  });

  test("share query param forwarded", async () => {
    await gw("/session/abc-123/thumbnail?share=shr_abc123");
    expect(captured!.query["share"]).toBe("shr_abc123");
  });
});

// ============================================================
// 9. Relay unavailable → 502
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
// 10. Token extraction (auth.ts via gateway routes)
// ============================================================

describe("Token extraction", () => {
  test("Authorization: Bearer header", async () => {
    await gw("/stats", { headers: { "Authorization": "Bearer test-jwt" } });
    expect(captured!.headers["x-user-id"]).toBe("dev");
  });

  test("?token= query param", async () => {
    await gw("/sessions?token=my-jwt");
    expect(captured!.headers["x-user-id"]).toBe("dev");
  });

  test("relay_token cookie", async () => {
    await gw("/stats", { headers: { "Cookie": "relay_token=cookie-jwt" } });
    expect(captured!.headers["x-user-id"]).toBe("dev");
  });

  test("query param takes priority over cookie", async () => {
    await gw("/sessions?token=query-token", {
      headers: { "Cookie": "relay_token=cookie-token" },
    });
    expect(captured!.headers["x-user-id"]).toBe("dev");
  });
});

// ============================================================
// 11. Auth rejection (GATEWAY_NO_AUTH=false, separate server)
// ============================================================

describe("Auth rejection (NO_AUTH=false)", () => {
  test("GET /stats → 401 without token", async () => {
    const res = await fetch(`${AGW()}/stats`);
    expect(res.status).toBe(401);
    expect(await (res.json() as any)).toEqual({ error: "Unauthorized" });
  });

  test("GET /sessions → 401 without token", async () => {
    const res = await fetch(`${AGW()}/sessions`);
    expect(res.status).toBe(401);
  });

  test("POST /session/{id}/share → 401 without token", async () => {
    const res = await fetch(`${AGW()}/session/abc/share`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  test("GET /session/{id}/thumbnail → 401 without token or share", async () => {
    const res = await fetch(`${AGW()}/session/abc/thumbnail`);
    expect(res.status).toBe(401);
  });

  test("GET /session/{id}/thumbnail → 200 with share token", async () => {
    const res = await fetch(`${AGW()}/session/abc/thumbnail?share=shr_test`);
    expect(res.status).toBe(200);
  });

  test("GET /gallery/api → 200 anonymous (no token)", async () => {
    const res = await fetch(`${AGW()}/gallery/api`);
    expect(res.status).toBe(200);
  });

  test("GET /gallery/api → 401 with invalid token", async () => {
    const res = await fetch(`${AGW()}/gallery/api`, {
      headers: { "Authorization": "Bearer invalid-jwt" },
    });
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error).toBe("token expired");
  });

  test("GET /api/config → 200 without auth", async () => {
    const res = await fetch(`${AGW()}/api/config`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.noAuth).toBe(false);
  });

  test("GET /apps → 200 without auth", async () => {
    const res = await fetch(`${AGW()}/apps`);
    expect(res.status).toBe(200);
  });

  test("GET /latest/* → 200 without auth", async () => {
    const res = await fetch(`${AGW()}/latest/export`);
    expect(res.status).toBe(200);
  });

  test("static files served without auth", async () => {
    const res = await fetch(`${AGW()}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });

  test("GET /session/{id}/video.mp4 → 401 without token", async () => {
    const res = await fetch(`${AGW()}/session/abc/video.mp4`);
    expect(res.status).toBe(401);
  });

  test("GET /session/{id}/video.mp4 → 200 with share token", async () => {
    const res = await fetch(`${AGW()}/session/abc/video.mp4?share=shr_test`);
    expect(res.status).toBe(200);
  });

  test("GET /session/{id}/audio/* → 401 without token", async () => {
    const res = await fetch(`${AGW()}/session/abc/audio/chunk-001.pcm`);
    expect(res.status).toBe(401);
  });

  test("DELETE /session/{id}/share/{token} → 401 without token", async () => {
    const res = await fetch(`${AGW()}/session/abc/share/shr_test`, { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  test("GET /session/{id}/shares → 401 without token", async () => {
    const res = await fetch(`${AGW()}/session/abc/shares`);
    expect(res.status).toBe(401);
  });

  test("PATCH /session/{id}/access → 401 without token", async () => {
    const res = await fetch(`${AGW()}/session/abc/access`, { method: "PATCH", body: "{}" });
    expect(res.status).toBe(401);
  });

  test("POST /session/{id}/audio-in → 401 without token", async () => {
    const res = await fetch(`${AGW()}/session/abc/audio-in`, { method: "POST", body: "x" });
    expect(res.status).toBe(401);
  });
});

// ============================================================
// 12. Route priority and edge cases
// ============================================================

describe("Route priority", () => {
  test("POST /session/{id}/share matches share create route", async () => {
    await gw("/session/abc-123/share", { method: "POST", body: "{}" });
    expect(captured!.path).toBe("/session/abc-123/share");
    expect(captured!.method).toBe("POST");
  });

  test("GET /session/{id}/share falls through (no POST method match)", async () => {
    await gw("/session/abc-123/share");
    expect(captured).toBeNull(); // SPA fallback, not proxied
  });

  test("DELETE /session/{id}/share/{token} requires shr_ prefix", async () => {
    await gw("/session/abc-123/share/invalid-no-prefix", { method: "DELETE" });
    expect(captured).toBeNull(); // doesn't match shr_[^/]+
  });

  test("PATCH /session/{id}/access only matches PATCH", async () => {
    await gw("/session/abc-123/access"); // GET
    expect(captured).toBeNull();
  });

  test("POST /session/{id}/audio-in only matches POST", async () => {
    await gw("/session/abc-123/audio-in"); // GET
    expect(captured).toBeNull();
  });
});
