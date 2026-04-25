/**
 * Toast notifications and status pill helpers.
 */

export function showToast(message: string, kind: "info" | "warn" | "error" = "info"): void {
  const container = document.getElementById("toastContainer");
  if (!container) return;
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

export function setPill(el: HTMLElement, text: string, cls: string): void {
  el.textContent = text;
  el.className = `status-pill ${cls}`;
}
