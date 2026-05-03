/**
 * Auth barrel — re-exports from split modules + initAuth() orchestrator.
 * Zero breaking changes for existing imports.
 */

// Re-export from core (pure logic — zero DOM)
export {
  getToken, setToken, clearToken, isNoAuth, requireAuth, authFetch, authUrl,
  getUserEmail, escHtml, isTokenExpired,
  // exchangeCredential, // OAuth disabled
  startRefreshTimer, stopRefreshTimer, startCrossTabSync,
  dispatchAuthLogin, dispatchAuthLogout,
} from "./auth/core.js";

// Re-export from account (UI — all DOM)
export { loginOverlay, logout } from "./auth/account.js";
// OAuth disabled — export { handleGoogleLogin } from "./auth/account.js";

// Internal imports for initAuth orchestrator
import { loadConfig } from "./config.js";
import { initAccountUI } from "./auth/account.js";
import { startRefreshTimer, stopRefreshTimer, startCrossTabSync } from "./auth/core.js";

export async function initAuth(): Promise<void> {
  const cfg = await loadConfig();
  initAccountUI(); // cfg.googleClientId removed — OAuth disabled

  // Auth disabled — skip cross-tab sync and refresh timer
  // startCrossTabSync();
  // const existingToken = localStorage.getItem("relay_token");
  // if (existingToken) startRefreshTimer();

  // Never show login overlay while auth is disabled
  const overlay = document.getElementById("loginOverlay");
  if (overlay) overlay.classList.add("hidden");
}
