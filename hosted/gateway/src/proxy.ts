/**
 * proxy.ts — HTTP proxy to the relay server
 *
 * Proxies HTTP requests to the relay server on localhost:8080 with trusted headers.
 * The relay server reads user identity from X-User-Id, X-User-Email headers.
 */

import type { AuthUser } from "./types.js";

function getRelayOrigin(): string {
  return `http://127.0.0.1:${process.env.RELAY_PORT || "8080"}`;
}

/**
 * Proxy an HTTP request to the relay server, injecting trusted auth headers.
 */
export async function proxyRequest(req: Request, path: string, user?: AuthUser): Promise<Response> {
  const target = new URL(path, getRelayOrigin());
  // Preserve query params from original request
  const originalUrl = new URL(req.url, "http://dummy");
  originalUrl.searchParams.forEach((v, k) => target.searchParams.set(k, v));

  const headers = new Headers(req.headers);
  // Remove hop-by-hop headers
  headers.delete("host");
  headers.delete("connection");
  headers.delete("keep-alive");
  headers.delete("transfer-encoding");
  headers.delete("te");
  headers.delete("trailer");
  headers.delete("upgrade");
  headers.set("connection", "close");

  // Inject trusted user headers
  if (user) {
    headers.set("X-User-Id", user.sub);
    headers.set("X-User-Email", user.email);
  }

  try {
    const hasBody = req.body != null && !["GET", "HEAD"].includes(req.method);
    // Read body as ArrayBuffer to avoid ReadableStream locking issues
    const bodyBuffer = hasBody ? await req.arrayBuffer() : undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      return await fetch(target.toString(), {
        method: req.method,
        headers,
        body: bodyBuffer,
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    console.error("[gateway:proxy] relay fetch failed:", err);
    return Response.json({ error: "Relay server unavailable" }, { status: 502 });
  }
}
