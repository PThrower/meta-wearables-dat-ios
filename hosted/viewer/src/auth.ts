/**
 * Authentication — Google OAuth via GIS
 *
 * Centralized auth module: JWT decode, token lifecycle, auth-aware fetch,
 * user info display, logout.
 */

import { loadConfig, getConfig } from "./config.js";

const loginOverlay = document.getElementById("loginOverlay")!;

export { loginOverlay };

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

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- Token accessors ---

export function getToken(): string | null {
  return localStorage.getItem("relay_token");
}

// --- Config helpers ---

export function isNoAuth(): boolean {
  try { return getConfig().noAuth; } catch { return false; }
}

// --- Auth gate ---

export function requireAuth(): boolean {
  if (isNoAuth()) return false;
  const token = getToken();
  if (!token) {
    loginOverlay.classList.remove("hidden");
    return true;
  }
  // Check expiry — proactively prompt re-login before server rejects
  const payload = decodeJwtPayload(token);
  if (payload?.exp && payload.exp * 1000 < Date.now()) {
    localStorage.removeItem("relay_token");
    updateUserInfo();
    loginOverlay.classList.remove("hidden");
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
    loginOverlay.classList.remove("hidden");
    updateUserInfo();
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

function updateUserInfo(): void {
  const el = document.getElementById("userInfo");
  if (!el) return;
  const email = getUserEmail();
  if (email) {
    el.innerHTML = `<span class="user-email">${escHtml(email)}</span><button id="logoutBtn" class="logout-btn">Logout</button>`;
    document.getElementById("logoutBtn")?.addEventListener("click", logout);
  } else if (!isNoAuth()) {
    el.innerHTML = `<button id="signinBtn" class="signin-btn">Sign in</button>`;
    document.getElementById("signinBtn")?.addEventListener("click", () => {
      loginOverlay.classList.remove("hidden");
    });
  } else {
    el.innerHTML = "";
  }
}

// --- Logout ---

export function logout(): void {
  localStorage.removeItem("relay_token");
  loginOverlay.classList.remove("hidden");
  updateUserInfo();
  window.dispatchEvent(new CustomEvent("auth:logout"));
}

// --- Google GIS callback ---

export function handleGoogleLogin(response: { credential: string }): void {
  const token = response.credential;
  localStorage.setItem("relay_token", token);
  loginOverlay.classList.add("hidden");
  updateUserInfo();
  window.dispatchEvent(new CustomEvent("auth:login"));
}

// --- Init ---

export async function initAuth(): Promise<void> {
  const cfg = await loadConfig();
  const clientId = cfg.googleClientId;
  if (clientId) {
    const onload = document.getElementById("g_id_onload");
    if (onload) onload.setAttribute("data-client_id", clientId);
    document.querySelectorAll("[data-client_id]").forEach(el => el.setAttribute("data-client_id", clientId));
  }
  (window as any).handleGoogleLogin = handleGoogleLogin;
  // Restore user info if already logged in (page reload)
  updateUserInfo();
}
