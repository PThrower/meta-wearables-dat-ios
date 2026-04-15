/**
 * Account UI — renders #userInfo, manages loginOverlay.
 * All DOM manipulation for auth lives here.
 * OAuth / Google GIS disabled.
 */

import {
  getUserEmail, getToken, isNoAuth, escHtml, dispatchAuthLogin, dispatchAuthLogout,
  setToken, clearToken, startRefreshTimer, stopRefreshTimer,
} from "./core.js";
// OAuth disabled — import { exchangeCredential } from "./core.js";

const loginOverlay = document.getElementById("loginOverlay")!;

export { loginOverlay };

// --- User info rendering ---

function updateUserInfo(): void {
  const el = document.getElementById("userInfo");
  if (!el) return;
  // Auth disabled — show placeholder account chip (no login/logout)
  // Restore the real branch below when re-enabling OAuth.
  // const email = getUserEmail();
  // if (email) {
  //   el.innerHTML = `<span class="user-email">${escHtml(email)}</span><button id="logoutBtn" class="logout-btn">Logout</button>`;
  //   document.getElementById("logoutBtn")?.addEventListener("click", logout);
  // } else if (!isNoAuth()) {
  //   el.innerHTML = `<button id="signinBtn" class="signin-btn">Sign in</button>`;
  //   document.getElementById("signinBtn")?.addEventListener("click", () => {
  //     loginOverlay.classList.remove("hidden");
  //   });
  // } else {
  //   el.innerHTML = "";
  // }
  el.innerHTML = `<span class="user-email user-info-trigger">guest@local</span><div class="profile-icon user-info-trigger"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>`;
  el.querySelectorAll(".user-info-trigger").forEach(t =>
    t.addEventListener("click", toggleProfileModal)
  );
}

// --- Profile modal ---

function toggleProfileModal(): void {
  const existing = document.getElementById("profileModal");
  if (existing) { existing.remove(); return; }

  const modal = document.createElement("div");
  modal.id = "profileModal";
  modal.className = "profile-modal";
  modal.innerHTML = `
    <div class="profile-modal-backdrop"></div>
    <div class="profile-modal-content">
      <div class="profile-modal-header">
        <div class="profile-modal-avatar">
          <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        </div>
        <span class="profile-modal-email">guest@local</span>
      </div>
      <div class="profile-modal-body">
        <p class="profile-modal-note">Account management coming soon.</p>
      </div>
      <div class="profile-modal-footer">
        <button class="profile-modal-close">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // Close handlers
  modal.querySelector(".profile-modal-backdrop")!.addEventListener("click", () => modal.remove());
  modal.querySelector(".profile-modal-close")!.addEventListener("click", () => modal.remove());
}

// --- Logout ---

export function logout(): void {
  // Revoke token server-side (fire-and-forget)
  const token = getToken();
  if (token) {
    fetch("/api/auth/logout", {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}` },
    }).catch(() => {});
  }
  clearToken();
  stopRefreshTimer();
  loginOverlay.classList.remove("hidden");
  updateUserInfo();
  dispatchAuthLogout();
}

// --- Google GIS callback (DISABLED — OAuth removed) ---
// export async function handleGoogleLogin(response: { credential: string }): Promise<void> {
//   const result = await exchangeCredential(response.credential);
//   if (result) {
//     setToken(result.token);
//     startRefreshTimer();
//   } else {
//     console.warn("[auth] session exchange failed, falling back to direct Google JWT");
//     setToken(response.credential);
//     startRefreshTimer();
//   }
//   loginOverlay.classList.add("hidden");
//   updateUserInfo();
//   dispatchAuthLogin();
// }

// --- Overlay helpers ---

export function showLoginOverlay(): void {
  loginOverlay.classList.remove("hidden");
}

export function hideLoginOverlay(): void {
  loginOverlay.classList.add("hidden");
}

// --- Init account UI (called once from initAuth) ---

export function initAccountUI(_clientId?: string): void {
  // OAuth disabled — Google GIS setup commented out
  // if (clientId) {
  //   const google = (window as any).google;
  //   if (google?.accounts?.id) {
  //     google.accounts.id.initialize({
  //       client_id: clientId,
  //       callback: handleGoogleLogin,
  //     });
  //     google.accounts.id.renderButton(
  //       document.getElementById("g_id_signin"),
  //       { type: "standard", size: "large", theme: "filled_black", text: "sign_in_with", shape: "rectangular", logo_alignment: "left" },
  //     );
  //   }
  // }

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
    // Auto-prompt One Tap for returning users — OAuth disabled
    // const google = (window as any).google;
    // if (google?.accounts?.id) {
    //   google.accounts.id.prompt();
    // }
  });

  // Restore user info if already logged in (page reload)
  updateUserInfo();
}
