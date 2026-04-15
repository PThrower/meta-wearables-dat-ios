/**
 * Auth core — pure token logic, JWT decode, auth-aware fetch.
 * Zero DOM — all UI lives in account.ts.
 */

import { getConfig } from "../config.js";

// --- JWT decode (client-side only — UX, not security boundary) ---

interface JwtPayload {
  exp?: number;
  email?: string;
  sub?: string;
  [key: string]: unknown;
}

function decodeJwtPayload(token: string): JwtPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
      atob(b64).split("").map(c => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2)).join(""),
    );
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// --- HTML escape ---

export function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- Constants ---

const TOKEN_KEY = "relay_token";
const EXPIRY_BUFFER_MS = 300_000; // 5 minutes — single source of truth

// --- Token accessors ---

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  syncTokenCookie(token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  syncTokenCookie(null);
}

export function getTokenPayload(): JwtPayload | null {
  const token = getToken();
  if (!token) return null;
  return decodeJwtPayload(token);
}

// --- Cookie sync (keeps relay_token cookie in sync for media requests) ---

function syncTokenCookie(token: string | null): void {
  if (token) {
    document.cookie = `${TOKEN_KEY}=${encodeURIComponent(token)}; path=/; SameSite=Strict; max-age=${7 * 24 * 60 * 60}`;
  } else {
    document.cookie = `${TOKEN_KEY}=; path=/; SameSite=Strict; max-age=0`;
  }
}

// --- Config helpers ---

export function isNoAuth(): boolean {
  try { return getConfig().noAuth; } catch { return false; }
}

// --- Unified token expiry check (single source of truth) ---

const EXPIRY_BUFFER_SEC = EXPIRY_BUFFER_MS / 1000;

export function isTokenExpired(): boolean {
  const token = getToken();
  if (!token) return true;
  const payload = decodeJwtPayload(token);
  if (!payload?.exp) return true;
  return payload.exp < Math.floor(Date.now() / 1000) + EXPIRY_BUFFER_SEC;
}

// --- Auth gate (pure logic — returns boolean, dispatches events) ---

export function requireAuth(): boolean {
  if (isNoAuth()) return false;
  if (isTokenExpired()) {
    clearToken();
    window.dispatchEvent(new CustomEvent("auth:unauthenticated"));
    return true;
  }
  return false;
}

// --- Auth-aware fetch (single 401 handler) ---

export async function authFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...(opts.headers as Record<string, string> || {}),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new CustomEvent("auth:unauthenticated"));
    window.dispatchEvent(new CustomEvent("auth:logout"));
  }
  return res;
}

// --- URL token appending (fallback for media — cookie is preferred) ---

export function authUrl(url: string): string {
  // Cookie-based auth is preferred; authUrl is a fallback for cross-origin cases
  return url;
}

// --- User info ---

export function getUserEmail(): string | null {
  const token = getToken();
  if (!token) return null;
  return decodeJwtPayload(token)?.email ?? null;
}

// --- Session token exchange (DISABLED — OAuth removed) ---
// export async function exchangeCredential(credential: string): Promise<{ token: string; email: string } | null> {
//   try {
//     const res = await fetch("/api/auth/exchange", {
//       method: "POST",
//       headers: { "Content-Type": "application/json" },
//       body: JSON.stringify({ credential }),
//     });
//     if (!res.ok) return null;
//     const data = await res.json();
//     if (!data.token || !data.user?.email) return null;
//     return { token: data.token, email: data.user.email };
//   } catch (err) {
//     console.warn("[auth] credential exchange failed:", err);
//     return null;
//   }
// }

// --- Token refresh ---

let refreshTimer: ReturnType<typeof setInterval> | null = null;

export function startRefreshTimer(): void {
  stopRefreshTimer();
  // Check every 60 seconds
  refreshTimer = setInterval(async () => {
    const token = getToken();
    if (!token) return;

    const payload = decodeJwtPayload(token);
    if (!payload?.exp) return;

    const remaining = payload.exp - Math.floor(Date.now() / 1000);
    // Refresh if < 24h remaining
    if (remaining > 0 && remaining < 24 * 60 * 60) {
      try {
        const res = await fetch("/api/auth/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json();
          if (data.token) {
            setToken(data.token);
            console.log("[auth] session token refreshed");
          }
        }
      } catch {
        // Silent fail — next interval will retry
      }
    }
  }, 60_000);
}

export function stopRefreshTimer(): void {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

// --- Cross-tab synchronization ---

let storageListenerActive = false;

export function startCrossTabSync(): void {
  if (storageListenerActive) return;
  storageListenerActive = true;

  window.addEventListener("storage", (e: StorageEvent) => {
    if (e.key !== TOKEN_KEY) return;
    if (e.newValue === null) {
      // Token removed (logout in another tab)
      window.dispatchEvent(new CustomEvent("auth:logout"));
      window.dispatchEvent(new CustomEvent("auth:unauthenticated"));
    } else if (e.newValue && e.oldValue !== e.newValue) {
      // Token changed (login or refresh in another tab)
      syncTokenCookie(e.newValue);
      window.dispatchEvent(new CustomEvent("auth:login"));
    }
  });
}

// --- Event dispatchers ---

export function dispatchAuthLogin(): void {
  window.dispatchEvent(new CustomEvent("auth:login"));
}

export function dispatchAuthLogout(): void {
  window.dispatchEvent(new CustomEvent("auth:logout"));
}
