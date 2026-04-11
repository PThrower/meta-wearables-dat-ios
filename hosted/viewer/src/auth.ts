/**
 * Authentication — Google OAuth via GIS
 */

const loginOverlay = document.getElementById("loginOverlay")!;
const NO_AUTH = document.documentElement.dataset.noAuth === "1";

export { loginOverlay, NO_AUTH };

export function requireAuth(): boolean {
  if (NO_AUTH) return false;
  const token = localStorage.getItem("relay_token");
  if (!token) {
    loginOverlay.classList.remove("hidden");
    return true;
  }
  return false;
}

export function handleGoogleLogin(response: { credential: string }): void {
  const token = response.credential;
  localStorage.setItem("relay_token", token);
  loginOverlay.classList.add("hidden");
  // Dispatch event for main.ts to handle post-login flow
  window.dispatchEvent(new CustomEvent("auth:login"));
}

export function initAuth(): void {
  const clientId = (window as any).__GOOGLE_CLIENT_ID || "";
  if (clientId) {
    const onload = document.getElementById("g_id_onload");
    if (onload) onload.setAttribute("data-client_id", clientId);
    document.querySelectorAll("[data-client_id]").forEach(el => el.setAttribute("data-client_id", clientId));
  }
  // Expose globally for GIS callback
  (window as any).handleGoogleLogin = handleGoogleLogin;
}
