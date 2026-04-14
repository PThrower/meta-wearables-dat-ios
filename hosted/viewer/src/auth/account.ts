/**
 * Account UI — renders #userInfo, manages loginOverlay, Google GIS button.
 * All DOM manipulation for auth lives here.
 */

import { getUserEmail, isNoAuth, escHtml, dispatchAuthLogin, dispatchAuthLogout, isTokenExpired } from "./core.js";

const loginOverlay = document.getElementById("loginOverlay")!;

export { loginOverlay };

// --- User info rendering ---

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
  dispatchAuthLogout();
}

// --- Google GIS callback ---

export function handleGoogleLogin(response: { credential: string }): void {
  const token = response.credential;
  localStorage.setItem("relay_token", token);
  loginOverlay.classList.add("hidden");
  updateUserInfo();
  dispatchAuthLogin();
}

// --- Overlay helpers ---

export function showLoginOverlay(): void {
  loginOverlay.classList.remove("hidden");
}

export function hideLoginOverlay(): void {
  loginOverlay.classList.add("hidden");
}

// --- Init account UI (called once from initAuth) ---

export function initAccountUI(clientId?: string): void {
  // Set up Google GIS
  if (clientId) {
    const google = (window as any).google;
    if (google?.accounts?.id) {
      google.accounts.id.initialize({
        client_id: clientId,
        callback: handleGoogleLogin,
      });
      google.accounts.id.renderButton(
        document.getElementById("g_id_signin"),
        { type: "standard", size: "large", theme: "filled_black", text: "sign_in_with", shape: "rectangular", logo_alignment: "left" },
      );
    }
  }

  // Set up global handler for GIS callback
  (window as any).handleGoogleLogin = handleGoogleLogin;

  // Listen for auth events
  window.addEventListener("auth:login", () => {
    updateUserInfo();
  });

  window.addEventListener("auth:logout", () => {
    updateUserInfo();
  });

  window.addEventListener("auth:unauthenticated", () => {
    showLoginOverlay();
    updateUserInfo();
    // Auto-prompt One Tap for returning users
    const google = (window as any).google;
    if (google?.accounts?.id) {
      google.accounts.id.prompt();
    }
  });

  // Restore user info if already logged in (page reload)
  updateUserInfo();
}
