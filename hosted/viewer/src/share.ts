/**
 * share.ts — share dialog for session access tokens
 */

const dialog = document.getElementById("shareDialog")!;
const shareLinkInput = document.getElementById("shareLink") as HTMLInputElement;
const expirySelect = document.getElementById("shareExpiry") as HTMLSelectElement;
const createBtn = document.getElementById("shareCreateBtn")!;
const copyBtn = document.getElementById("shareCopyBtn")!;
const tokenList = document.getElementById("shareTokenList")!;
const closeShareBtn = document.getElementById("closeShareDialog")!;

let currentSessionId: string | null = null;

function getToken(): string | null {
  return localStorage.getItem("relay_token");
}

async function apiFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string> || {}) };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return fetch(path, { ...opts, headers });
}

/** Open the share dialog for a session */
export async function openShareDialog(sessionId: string): Promise<void> {
  currentSessionId = sessionId;
  dialog.classList.remove("hidden");
  shareLinkInput.value = "";
  await refreshTokenList();
}

/** Close the share dialog */
export function closeShareDialog(): void {
  dialog.classList.add("hidden");
  currentSessionId = null;
}

/** Create a new share token */
async function createShareLink(): Promise<void> {
  if (!currentSessionId) return;
  const expiryHours = parseInt(expirySelect.value) || 168;
  const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000).toISOString();

  const res = await apiFetch(`/session/${currentSessionId}/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expiresAt }),
  });

  if (!res.ok) {
    shareLinkInput.value = `Error: ${res.status}`;
    return;
  }

  const data = await res.json();
  const proto = location.protocol;
  const host = location.host;
  const shareUrl = `${proto}//${host}/session/${currentSessionId}?share=${data.token}`;
  shareLinkInput.value = shareUrl;
  await refreshTokenList();
}

/** Copy share link to clipboard */
async function copyShareLink(): Promise<void> {
  if (!shareLinkInput.value) return;
  await navigator.clipboard.writeText(shareLinkInput.value);
  copyBtn.textContent = "Copied!";
  setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000);
}

/** Revoke a share token */
async function revokeToken(token: string): Promise<void> {
  if (!currentSessionId) return;
  await apiFetch(`/session/${currentSessionId}/share/${token}`, { method: "DELETE" });
  await refreshTokenList();
}

/** Refresh the token list in the dialog */
async function refreshTokenList(): Promise<void> {
  if (!currentSessionId) return;
  tokenList.innerHTML = "Loading...";

  const res = await apiFetch(`/session/${currentSessionId}/shares`);
  if (!res.ok) {
    tokenList.innerHTML = "Failed to load tokens";
    return;
  }

  const tokens = await res.json();
  if (tokens.length === 0) {
    tokenList.innerHTML = '<div class="share-token-empty">No active share links</div>';
    return;
  }

  tokenList.innerHTML = tokens.map((t: { token: string; expiresAt: string; createdAt: string }) => {
    const expires = new Date(t.expiresAt);
    const isExpiringSoon = expires.getTime() - Date.now() < 24 * 60 * 60 * 1000;
    const expiryClass = isExpiringSoon ? "token-expiring" : "";
    return `<div class="share-token-item ${expiryClass}">
      <span class="share-token-value">${escHtml(t.token.slice(0, 16))}...</span>
      <span class="share-token-expiry">Expires: ${expires.toLocaleDateString()}</span>
      <button class="share-token-revoke" data-action="revoke" data-token="${escAttr(t.token)}">Revoke</button>
    </div>`;
  }).join("");
}

/** Escape for HTML attribute context (inside double quotes) */
function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape for HTML text content */
function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Event delegation for revoke buttons
tokenList.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest("[data-action='revoke']") as HTMLElement | null;
  if (btn) revokeToken(btn.dataset.token ?? "");
});

// Expose openShareDialog only (revokeToken now via delegation)
(window as any).openShareDialog = openShareDialog;

// Event listeners
createBtn.addEventListener("click", createShareLink);
copyBtn.addEventListener("click", copyShareLink);
closeShareBtn.addEventListener("click", closeShareDialog);
