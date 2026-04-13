/**
 * Auth barrel — re-exports from split modules + initAuth() orchestrator.
 * Zero breaking changes for existing imports.
 */

// Re-export from core (pure logic — zero DOM)
export { getToken, isNoAuth, requireAuth, authFetch, authUrl, getUserEmail, escHtml } from "./auth/core.js";

// Re-export from account (UI — all DOM)
export { loginOverlay, logout, handleGoogleLogin } from "./auth/account.js";

// Internal imports for initAuth orchestrator
import { loadConfig } from "./config.js";
import { initAccountUI } from "./auth/account.js";

export async function initAuth(): Promise<void> {
  const cfg = await loadConfig();
  initAccountUI(cfg.googleClientId);
}
