/**
 * apns.ts — Direct APNs HTTP/2 push notification client
 *
 * Uses .p8 JWT signing (ES256) to send silent and visible push
 * notifications to iOS devices. No Firebase dependency.
 *
 * Environment variables:
 *   APNS_KEY_ID      — Apple Key ID from developer portal
 *   APNS_TEAM_ID     — Apple Team ID
 *   APNS_KEY_PATH    — Path to .p8 key file
 *   APNS_BUNDLE_ID   — App bundle ID (e.g. com.mwdat-ios)
 *   APNS_PRODUCTION  — "true" for production, anything else for sandbox
 */

import { createSign } from "node:crypto";
import http2 from "node:http2";

// --- Configuration ---

const KEY_ID = process.env.APNS_KEY_ID || "";
const TEAM_ID = process.env.APNS_TEAM_ID || "";
const KEY_PEM = process.env.APNS_KEY_PEM || ""; // .p8 key content (from Doppler)
const BUNDLE_ID = process.env.APNS_BUNDLE_ID || "ebowwa.caringmind";
const IS_PRODUCTION = process.env.APNS_PRODUCTION === "true";

const APNS_HOST = IS_PRODUCTION
  ? "https://api.push.apple.com"
  : "https://api.sandbox.push.apple.com";

const TOKEN_TTL_MS = 50 * 60 * 1000; // 50 minutes (Apple max 1hr)

// --- JWT Provider Token ---

let cachedToken: string | null = null;
let tokenIssuedAt = 0;

function loadKey(): string {
  // Prefer APNS_KEY_B64 (plain base64 body, no escaping issues)
  const b64Body = process.env.APNS_KEY_B64?.trim();
  if (b64Body && b64Body.length > 20) {
    const lines: string[] = [];
    for (let i = 0; i < b64Body.length; i += 64) {
      lines.push(b64Body.slice(i, i + 64));
    }
    const key = `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
    console.log(`[apns] Built PEM from APNS_KEY_B64 (${b64Body.length} chars, ${lines.length} lines)`);
    return key;
  }

  // Fallback: try to parse APNS_KEY_PEM
  if (!KEY_PEM) throw new Error("[apns] APNS_KEY_B64 or APNS_KEY_PEM must be configured");
  throw new Error("[apns] APNS_KEY_PEM has escaping issues — use APNS_KEY_B64 instead");
}

/** Generate ES256 JWT for APNs authentication */
function generateProviderToken(): string {
  const now = Math.floor(Date.now() / 1000);

  // Reuse cached token if still valid
  if (cachedToken && (Date.now() - tokenIssuedAt) < TOKEN_TTL_MS) {
    return cachedToken;
  }

  if (!KEY_ID || !TEAM_ID) {
    throw new Error("[apns] APNS_KEY_ID and APNS_TEAM_ID must be configured");
  }

  const header = btoa(JSON.stringify({ alg: "ES256", kid: KEY_ID }))
    .replace(/=/g, "");
  const payload = btoa(JSON.stringify({ iss: TEAM_ID, iat: now }))
    .replace(/=/g, "");

  const sign = createSign("SHA256");
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(loadKey());

  cachedToken = `${header}.${payload}.${signature.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")}`;
  tokenIssuedAt = Date.now();
  return cachedToken;
}

// --- Check if APNs is configured ---

export function isApnsConfigured(): boolean {
  const b64 = process.env.APNS_KEY_B64?.trim();
  return !!(KEY_ID && TEAM_ID && b64 && b64.length > 20);
}

// --- Send Push ---

interface ApnsResponse {
  reason?: string;
  [key: string]: unknown;
}

/**
 * Send a raw APNs push notification via HTTP/2 (node:http2)
 *
 * Bun's fetch() doesn't handle Apple's HTTP/2 responses correctly,
 * so we use Node's native http2 client for APNs requests.
 */
function sendPushHttp2(
  deviceToken: string,
  payload: Record<string, unknown>,
  pushType: "background" | "alert" = "background",
): Promise<{ status: number; body: ApnsResponse | null }> {
  return new Promise((resolve, reject) => {
    if (!isApnsConfigured()) {
      console.log("[apns] Not configured — skipping push");
      return resolve({ status: 0, body: null });
    }

    const jwt = generateProviderToken();
    const host = IS_PRODUCTION ? "api.push.apple.com" : "api.sandbox.push.apple.com";
    const path = `/3/device/${deviceToken}`;
    const bodyStr = JSON.stringify(payload);

    const client = http2.connect(`https://${host}`);
    client.setTimeout(10_000);

    client.on("error", (err) => {
      console.error("[apns] HTTP/2 connection error:", err.message);
      client.close();
      reject(err);
    });

    const req = client.request({
      ":method": "POST",
      ":path": path,
      "authorization": `bearer ${jwt}`,
      "apns-topic": BUNDLE_ID,
      "apns-push-type": pushType,
      "content-type": "application/json",
    });

    req.on("response", (headers) => {
      const status = headers[":status"] as number;
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        client.close();

        if (status === 200) {
          console.log(`[apns] Push delivered (HTTP ${status})`);
          return resolve({ status, body: null });
        }

        let parsed: ApnsResponse | null = null;
        try { parsed = JSON.parse(raw); } catch { /* empty body */ }

        if (status === 410 || parsed?.reason === "Unregistered" || parsed?.reason === "BadDeviceToken") {
          console.warn(`[apns] Device token invalid: ${parsed?.reason}`);
        } else if (status >= 400) {
          console.error(`[apns] Push failed: ${status} ${parsed?.reason || "unknown"}`);
        }

        resolve({ status, body: parsed });
      });
    });

    req.on("error", (err) => {
      client.close();
      reject(err);
    });

    req.end(bodyStr);
  });
}

/** @deprecated Use sendPushHttp2 instead — Bun fetch doesn't support HTTP/2 APNs */
async function sendPush(
  deviceToken: string,
  payload: Record<string, unknown>,
): Promise<ApnsResponse | null> {
  const { status, body } = await sendPushHttp2(deviceToken, payload, "background");
  return body;
}

// --- High-level API ---

/**
 * Send a silent push to wake the app in background.
 *
 * content-available:1 causes iOS to wake the app silently with ~30s background time.
 */
export async function sendSilentWake(
  deviceToken: string,
  sessionId?: string,
): Promise<{ success: boolean; reason?: string }> {
  const payload: Record<string, unknown> = {
    aps: {
      "content-available": 1,
    },
    wake: "standby",
  };

  if (sessionId) {
    payload.sessionId = sessionId;
  }

  const result = await sendPush(deviceToken, payload);

  if (!result) {
    return { success: true };
  }

  if (result.reason === "Unregistered" || result.reason === "BadDeviceToken") {
    return { success: false, reason: result.reason };
  }

  return { success: false, reason: result.reason || "unknown" };
}

/**
 * Send a visible push notification as a fallback when silent push fails.
 *
 * User tapping the notification will launch the app.
 */
export async function sendVisibleWake(
  deviceToken: string,
  sessionId?: string,
): Promise<{ success: boolean; reason?: string }> {
  const payload: Record<string, unknown> = {
    aps: {
      alert: {
        title: "Stream Ready",
        body: "Tap to connect your glasses.",
      },
      sound: "default",
    },
    wake: "standby",
  };

  if (sessionId) {
    payload.sessionId = sessionId;
  }

  // Visible notifications use "alert" push type
  if (isApnsConfigured()) {
    const { status, body } = await sendPushHttp2(deviceToken, payload, "alert");

    if (status === 200) {
      return { success: true };
    }

    return { success: false, reason: body?.reason || "unknown" };
  }

  console.log("[apns] Not configured — skipping visible push");
  return { success: false, reason: "not_configured" };
}
