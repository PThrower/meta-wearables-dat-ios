/**
 * Connection overlay handlers — spinner, status text, reconnect UI.
 */

const connOverlay = document.getElementById("connectionOverlay")!;
const connSpinner = document.getElementById("connSpinner")!;
const connStatus = document.getElementById("connStatus")!;
const connDetail = document.getElementById("connDetail")!;

export function handleConnectionState(state: string): void {
  switch (state) {
    case "connected":
      connOverlay.classList.add("hidden");
      break;
    case "reconnecting":
      connOverlay.classList.remove("hidden");
      connSpinner.classList.remove("hidden");
      connStatus.textContent = "Reconnecting...";
      connStatus.className = "connection-status";
      connDetail.textContent = "";
      break;
    case "error":
      connOverlay.classList.remove("hidden");
      connSpinner.classList.add("hidden");
      connStatus.textContent = "Connection Error";
      connStatus.className = "connection-status error";
      break;
    case "disconnected":
      // Handled via reconnecting state immediately after
      break;
  }
}

export function handleConnectionStatus(status: string): void {
  if (status === "AUTH REQUIRED") {
    connOverlay.classList.remove("hidden");
    connSpinner.classList.add("hidden");
    connStatus.textContent = "Authentication Required";
    connStatus.className = "connection-status error";
    connDetail.textContent = "Please sign in to access this stream.";
  } else if (status === "ACCESS DENIED") {
    connOverlay.classList.remove("hidden");
    connSpinner.classList.add("hidden");
    connStatus.textContent = "Access Denied";
    connStatus.className = "connection-status error";
    connDetail.textContent = "You do not have permission to view this stream.";
  }
}

/** Re-export overlay elements for message-handler reconnect hint access */
export { connOverlay, connSpinner, connStatus, connDetail };
