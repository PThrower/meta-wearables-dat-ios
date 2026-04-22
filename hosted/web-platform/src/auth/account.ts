/**
 * Account UI — renders #userInfo, manages loginOverlay.
 * All DOM manipulation for auth lives here.
 * OAuth / Google GIS disabled.
 */

import {
  getUserEmail, getToken, isNoAuth, escHtml, dispatchAuthLogin, dispatchAuthLogout,
  setToken, clearToken, startRefreshTimer, stopRefreshTimer,
} from "./core.js";
import { getConfig } from "../config.js";
import { fetchGallery } from "../core/api-client.js";
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

async function toggleProfileModal(): Promise<void> {
  const existing = document.getElementById("profileModal");
  if (existing) { existing.remove(); return; }

  const sessions = await fetchGallery();
  const live = sessions.filter(s => s.live).length;
  const recorded = sessions.length - live;
  const totalDuration = sessions.reduce((acc, s) => acc + (s.durationMs ?? 0), 0);
  const hasVideo = sessions.filter(s => (s.segments ?? 0) > 0).length;

  // Group wearables — only actual wearables (glasses), not host device (iPhone)
  const wearableMap = new Map<string, { models: Set<string>; count: number; live: number }>();
  for (const s of sessions) {
    const wt = s.device?.wearableType;
    if (!wt) continue; // skip sessions with no wearable connected
    const model = s.device?.deviceModel || "";
    const entry = wearableMap.get(wt) ?? { models: new Set<string>(), count: 0, live: 0 };
    if (model) entry.models.add(model);
    entry.count++;
    if (s.live) entry.live++;
    wearableMap.set(wt, entry);
  }
  const wearables = [...wearableMap.entries()];

  let versionStr = "--";
  try {
    const cfg = getConfig();
    versionStr = cfg.version.buildVersion || cfg.version.gitCommit.slice(0, 8);
  } catch {}

  const fmtDuration = (ms: number): string => {
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ${sec % 60}s`;
    const hr = Math.floor(min / 60);
    return `${hr}h ${min % 60}m`;
  };

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
        <span class="profile-modal-badge">Viewer</span>
      </div>

      <div class="profile-section">
        <div class="profile-section-title">Sessions</div>
        <div class="profile-stats">
          <div class="profile-stat">
            <span class="profile-stat-value">${sessions.length}</span>
            <span class="profile-stat-label">Total</span>
          </div>
          <div class="profile-stat">
            <span class="profile-stat-value">${live}</span>
            <span class="profile-stat-label">Live</span>
          </div>
          <div class="profile-stat">
            <span class="profile-stat-value">${recorded}</span>
            <span class="profile-stat-label">Recorded</span>
          </div>
          <div class="profile-stat">
            <span class="profile-stat-value">${hasVideo}</span>
            <span class="profile-stat-label">With Video</span>
          </div>
        </div>
      </div>

      ${wearables.length > 0 ? `
      <div class="profile-section">
        <div class="profile-section-title">Wearables</div>
        ${wearables.map(([type, info]) => `
          <div class="profile-wearable">
            <div class="profile-wearable-icon">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
              </svg>
            </div>
            <div class="profile-wearable-info">
              <span class="profile-wearable-type">${escHtml(type)}</span>
              <span class="profile-wearable-detail">
                ${info.models.size > 0 ? [...info.models].map(m => escHtml(m)).join(", ") : ""}
                ${info.live > 0 ? `<span class="profile-wearable-live">${info.live} live</span>` : ""}
              </span>
              <div class="profile-wearable-fleet">
                <span>Battery --</span>
                <span>Signal --</span>
                <span>Firmware --</span>
              </div>
            </div>
            <span class="profile-wearable-count">${info.count}</span>
          </div>
        `).join("")}
      </div>` : ""}

      ${totalDuration > 0 ? `
      <div class="profile-section">
        <div class="profile-section-title">Total Duration</div>
        <span class="profile-duration">${fmtDuration(totalDuration)}</span>
      </div>` : ""}

      <div class="profile-section">
        <div class="profile-section-title">Team</div>
        <div class="profile-org-row">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
          <span class="profile-org-label">Organization</span>
          <span class="profile-org-value">Personal</span>
        </div>
        <div class="profile-org-row">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          <span class="profile-org-label">Role</span>
          <span class="profile-org-value">Member</span>
        </div>
        <div class="profile-placeholder">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          <span>Team roster available with organizations</span>
        </div>
      </div>

      <div class="profile-section">
        <div class="profile-section-title">Settings</div>
        <div class="profile-setting">
          <span>Auto-refresh</span>
          <span class="profile-setting-value">30s</span>
        </div>
        <div class="profile-setting">
          <span>Quality</span>
          <select id="profile-quality" class="profile-select">
            <option value="high">High (30 FPS)</option>
            <option value="medium">Medium (15 FPS)</option>
            <option value="low">Low (8 FPS)</option>
            <option value="mini">Mini (4 FPS)</option>
          </select>
        </div>
      </div>

      <div class="profile-footer">
        <div class="profile-version">v${escHtml(versionStr)}</div>
        <button class="profile-modal-close">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // Sync quality select with current value
  const qualitySelect = modal.querySelector("#profile-quality") as HTMLSelectElement | null;
  const mainQuality = document.getElementById("quality-select") as HTMLSelectElement | null;
  if (qualitySelect && mainQuality) {
    qualitySelect.value = mainQuality.value;
    qualitySelect.addEventListener("change", () => {
      mainQuality.value = qualitySelect.value;
      mainQuality.dispatchEvent(new Event("change"));
    });
  }

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
