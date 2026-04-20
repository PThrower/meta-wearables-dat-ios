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
  if (!KEY_PEM) throw new Error("[apns] APNS_KEY_PEM not configured");
  let key = KEY_PEM.trim();

  // The env var may have the key in various formats:
  // 1. With literal \n:  "-----BEGIN PRIVATE KEY-----\nMIG...\n-----END..."
  // 2. With bare n:      "-----BEGIN PRIVATE KEY-----nMIG...n-----END..."  (shell ate the backslash)
  // 3. With actual newlines (multi-line env value)
  // Reconstruct a clean PEM by extracting the base64 body between markers.

  const beginMatch = key.match(/-----BEGIN PRIVATE KEY-----/);
  const endMatch = key.match(/-----END PRIVATE KEY-----/);
  if (!beginMatch || !endMatch) {
    throw new Error("[apns] APNS_KEY_PEM does not contain valid PEM markers");
  }

  // Extract the base64 content between the markers
  const afterBegin = key.slice(beginMatch.index! + beginMatch[0].length);
  const beforeEnd = afterBegin.slice(0, afterBegin.indexOf("-----END"));

  // Clean the base64 body: remove all whitespace, backslashes, and bare 'n' artifacts
  let body = beforeEnd
    .replace(/\\n/g, "")   // remove literal \n sequences
    .replace(/[\s\n\r]/g, ""); // remove whitespace

  // The body is base64. Re-wrap at 64 chars per line.
  const lines: string[] = [];
  for (let i = 0; i < body.length; i += 64) {
    lines.push(body.slice(i, i + 64));
  }

  key = `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
  console.log(`[apns] Reconstructed PEM key (${key.length} bytes, ${lines.length} body lines)`);
  return key;
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
  return !!(KEY_ID && TEAM_ID && KEY_PEM);
}

// --- Send Push ---

interface ApnsResponse {
  reason?: string;
  [key: string]: unknown;
}

/**
 * Send a raw APNs push notification via HTTP/2
 *
 * Returns the response body from Apple, or throws on network errors.
 */
async function sendPush(
  deviceToken: string,
  payload: Record<string, unknown>,
): Promise<ApnsResponse | null> {
  if (!isApnsConfigured()) {
    console.log("[apns] Not configured — skipping push");
    return null;
  }

  const token = generateProviderToken();

  const url = `${APNS_HOST}/3/device/${deviceToken}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "authorization": `bearer ${token}`,
      "apns-topic": BUNDLE_ID,
      "apns-push-type": "background",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (res.status === 200) {
    return null; // Success, no body
  }

  const body = await res.json() as ApnsResponse;

  if (res.status === 410 || body.reason === "Unregistered" || body.reason === "BadDeviceToken") {
    console.warn(`[apns] Device token invalid: ${body.reason} — should be cleared`);
  } else if (res.status >= 400) {
    console.error(`[apns] Push failed: ${res.status} ${body.reason || "unknown"}`);
  }

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
    const token = generateProviderToken();
    const url = `${APNS_HOST}/3/device/${deviceToken}`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "authorization": `bearer ${token}`,
        "apns-topic": BUNDLE_ID,
        "apns-push-type": "alert",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (res.status === 200) {
      return { success: true };
    }

    const body = await res.json() as ApnsResponse;
    return { success: false, reason: body.reason || "unknown" };
  }

  console.log("[apns] Not configured — skipping visible push");
  return { success: false, reason: "not_configured" };
}
