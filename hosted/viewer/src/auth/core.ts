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

// --- Token accessors ---

export function getToken(): string | null {
  return localStorage.getItem("relay_token");
}

export function getTokenPayload(): JwtPayload | null {
  const token = getToken();
  if (!token) return null;
  return decodeJwtPayload(token);
}

// --- Config helpers ---

export function isNoAuth(): boolean {
  try { return getConfig().noAuth; } catch { return false; }
}

// --- Auth gate (pure logic — returns boolean, dispatches events) ---

export function requireAuth(): boolean {
  if (isNoAuth()) return false;
  const token = getToken();
  if (!token) {
    window.dispatchEvent(new CustomEvent("auth:unauthenticated"));
    return true;
  }
  const payload = decodeJwtPayload(token);
  if (payload?.exp && payload.exp * 1000 < Date.now()) {
    localStorage.removeItem("relay_token");
    window.dispatchEvent(new CustomEvent("auth:unauthenticated"));
    return true;
  }
  return false;
}

// --- Auth-aware fetch ---

export async function authFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...(opts.headers as Record<string, string> || {}),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401) {
    localStorage.removeItem("relay_token");
    window.dispatchEvent(new CustomEvent("auth:unauthenticated"));
    window.dispatchEvent(new CustomEvent("auth:logout"));
  }
  return res;
}

// --- URL token appending (for <img>, <video> src) ---

export function authUrl(url: string): string {
  const token = getToken();
  if (!token) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

// --- User info ---

export function getUserEmail(): string | null {
  const token = getToken();
  if (!token) return null;
  return decodeJwtPayload(token)?.email ?? null;
}

// --- Event dispatchers ---

export function dispatchAuthLogin(): void {
  window.dispatchEvent(new CustomEvent("auth:login"));
}

export function dispatchAuthLogout(): void {
  window.dispatchEvent(new CustomEvent("auth:logout"));
}
