/**
 * BottomPanel — tabbed panel at the bottom of the split layout.
 * Tabs: Transcription, Debug, Telemetry.
 */

export class BottomPanel {
  private tabBar: HTMLElement;
  private debugLog: HTMLElement;
  private telemetryGrid: HTMLElement;

  constructor() {
    this.tabBar = document.getElementById("bottomTabBar")!;
    this.debugLog = document.getElementById("debugLog")!;
    this.telemetryGrid = document.getElementById("telemetryGrid")!;

    this.bindEvents();
    this.renderTelemetryGrid();
  }

  private bindEvents(): void {
    this.tabBar.addEventListener("click", (e) => {
      const tab = (e.target as HTMLElement).closest(".bottom-tab") as HTMLElement | null;
      if (!tab?.dataset.tab) return;

      // Update tab active state
      this.tabBar.querySelectorAll(".bottom-tab").forEach((t) => {
        (t as HTMLElement).classList.toggle("active", t === tab);
      });

      // Show/hide tab content
      document.querySelectorAll<HTMLElement>(".bottom-tab-content").forEach((el) => {
        el.classList.toggle("hidden", el.dataset.tab !== tab.dataset.tab);
      });
    });
  }

  /** Push a debug entry from a source */
  pushDebug(source: string, content: string): void {
    const entry = document.createElement("div");
    entry.className = "debug-entry";
    entry.innerHTML = `<span class="debug-source">${escapeHtml(source)}</span>${escapeHtml(content)}`;
    this.debugLog.appendChild(entry);
    // Keep max 200 entries
    while (this.debugLog.children.length > 200) {
      this.debugLog.removeChild(this.debugLog.firstChild!);
    }
    // Auto-scroll
    this.debugLog.scrollTop = this.debugLog.scrollHeight;
  }

  /** Update telemetry values from message-handler data */
  updateTelemetry(metrics: Record<string, string>): void {
    for (const [id, value] of Object.entries(metrics)) {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
      // Also update the corresponding telemetry card
      const card = this.telemetryGrid.querySelector(`[data-metric="${id}"] .telemetry-card-value`);
      if (card) card.textContent = value;
    }
  }

  /** Switch to a specific tab */
  switchTab(tab: string): void {
    const tabBtn = this.tabBar.querySelector(`[data-tab="${tab}"]`) as HTMLElement;
    if (tabBtn) tabBtn.click();
  }

  private renderTelemetryGrid(): void {
    const metrics = [
      { id: "p-fps", label: "FPS" },
      { id: "p-size", label: "Resolution" },
      { id: "p-latency", label: "Latency" },
      { id: "p-audio", label: "Audio Source" },
      { id: "t-battery", label: "Battery" },
      { id: "t-link-state", label: "BT Link" },
      { id: "t-relay-fps", label: "Relay FPS" },
      { id: "t-relay-rtt", label: "RTT" },
      { id: "t-throughput", label: "Throughput" },
      { id: "t-cpu", label: "CPU" },
      { id: "t-memory", label: "Memory" },
      { id: "t-thermal", label: "Thermal" },
    ];

    this.telemetryGrid.innerHTML = metrics.map((m) =>
      `<div class="telemetry-card" data-metric="${m.id}">
        <div class="telemetry-card-label">${m.label}</div>
        <div class="telemetry-card-value" id="tm-${m.id}">--</div>
      </div>`
    ).join("");
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
