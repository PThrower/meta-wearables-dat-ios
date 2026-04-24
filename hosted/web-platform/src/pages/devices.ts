/**
 * Fleet / Devices page — device registry with search, filters, detail modal.
 * Phase 3: Full implementation with filtering and device detail.
 */

import type { PageModule } from "../router/router.js";
import { fetchDevices, fetchSessions, fetchDeviceBuildHistory, deleteDevices as apiDeleteDevices, esc, formatTime } from "../core/api-client.js";
import type { DeviceInfo, SessionInfo, BuildHistoryEntry } from "../core/api-client.js";

export const page: PageModule = {
  init(container) {
    container.innerHTML = `
      <div class="page devices-page">
        <div class="page-header">
          <h1 class="page-title">Fleet</h1>
          <span class="page-subtitle">Registered devices</span>
        </div>
        <div class="pulse-strip" id="devices-stats"></div>
        <div class="devices-toolbar">
          <input type="search" id="device-search" class="search-input" placeholder="Search devices..." />
          <div class="filter-pills" id="device-filters">
            <button class="filter-pill active" data-filter="all">All</button>
            <button class="filter-pill" data-filter="online">Online</button>
            <button class="filter-pill" data-filter="offline">Offline</button>
          </div>
          <button class="btn btn-sm btn-toggle" id="device-select-toggle">Select</button>
          <button class="btn btn-sm btn-danger hidden" id="device-delete-btn">Delete (0)</button>
          <div class="confirm-bar hidden" id="device-confirm-bar">
            <span class="confirm-text">Remove <strong id="confirm-count">0</strong> devices? They can re-register on reconnect.</span>
            <button class="btn btn-sm btn-danger" id="confirm-yes">Delete</button>
            <button class="btn btn-sm" id="confirm-no">Cancel</button>
          </div>
        </div>
        <div id="devices-grid" class="devices-grid">
          <p class="empty-state">Loading devices...</p>
        </div>
      </div>
      <div id="device-modal" class="modal-overlay hidden">
        <div class="modal-content">
          <div class="modal-header">
            <h3 class="modal-title" id="modal-device-name">Device</h3>
            <button class="modal-close" id="modal-close">&times;</button>
          </div>
          <div class="modal-body" id="modal-body"></div>
        </div>
      </div>
    `;
    loadDevices(container);
    bindFilters(container);
    bindSearch(container);
    bindModal(container);
    bindSelectMode(container);
  },

  destroy() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    if (_escHandler) { document.removeEventListener("keydown", _escHandler); _escHandler = null; }
  },
};

let _pollTimer: ReturnType<typeof setInterval> | null = null;
let _escHandler: ((e: KeyboardEvent) => void) | null = null;
let _allDevices: DeviceInfo[] = [];
let _allSessions: SessionInfo[] = [];
let _currentFilter = "all";
let _searchQuery = "";
let _selectMode = false;
let _selectedIds = new Set<string>();
let _container: HTMLElement | null = null;

async function loadDevices(container: HTMLElement): Promise<void> {
  _container = container;
  const [devices, sessions] = await Promise.all([
    fetchDevices(),
    fetchSessions(),
  ]);

  _allDevices = devices;
  _allSessions = sessions;

  renderStats(container, devices);
  renderGrid(container, devices, sessions);

  if (!_pollTimer) {
    _pollTimer = setInterval(async () => {
      if (!container.isConnected) { clearInterval(_pollTimer!); _pollTimer = null; return; }
      const [d, s] = await Promise.all([fetchDevices(), fetchSessions()]);
      if (!container.isConnected) return;
      _allDevices = d;
      _allSessions = s;
      renderStats(container, d);
      renderGrid(container, d, s);
    }, 20000);
  }
}

function renderStats(container: HTMLElement, devices: DeviceInfo[]): void {
  const el = container.querySelector("#devices-stats");
  if (!el) return;

  const online = devices.filter(d => d.online).length;
  const offline = devices.length - online;
  const avgBattery = devices.length > 0
    ? Math.round(devices.filter(d => d.battery != null).reduce((sum, d) => sum + (d.battery ?? 0), 0) / Math.max(1, devices.filter(d => d.battery != null).length))
    : 0;

  el.innerHTML = `
    <div class="stat-card"><span class="stat-value">${devices.length}</span><span class="stat-label">Total Devices</span></div>
    <div class="stat-card"><span class="stat-value stat-live">${online}</span><span class="stat-label">Online</span></div>
    <div class="stat-card"><span class="stat-value">${offline}</span><span class="stat-label">Offline</span></div>
    <div class="stat-card"><span class="stat-value">${avgBattery > 0 ? avgBattery + "%" : "--"}</span><span class="stat-label">Avg Battery</span></div>
  `;
}

function renderGrid(container: HTMLElement, devices: DeviceInfo[], sessions: SessionInfo[]): void {
  const grid = container.querySelector("#devices-grid");
  if (!grid) return;
  let filtered = devices;

  // Apply filter
  if (_currentFilter === "online") filtered = filtered.filter(d => d.online);
  else if (_currentFilter === "offline") filtered = filtered.filter(d => !d.online);

  // Apply search
  if (_searchQuery) {
    const q = _searchQuery.toLowerCase();
    filtered = filtered.filter(d =>
      (d.deviceName || d.device_id || "").toLowerCase().includes(q) ||
      (d.deviceModel || d.device_model || "").toLowerCase().includes(q)
    );
  }

  if (filtered.length === 0) {
    grid.innerHTML = `<p class="empty-state">${devices.length === 0 ? "No devices registered" : "No devices match filter"}</p>`;
    return;
  }

  grid.innerHTML = filtered.map(d => {
    const deviceSessions = sessions.filter(s => s.device?.deviceName === d.deviceName);
    const liveCount = deviceSessions.filter(s => s.live).length;
    const selected = _selectedIds.has(d.device_id);
    return `
      <div class="device-card${_selectMode ? " select-mode" : ""}${selected ? " selected" : ""}" data-device-id="${esc(d.device_id)}">
        ${_selectMode ? `<input type="checkbox" class="device-card-checkbox" ${selected ? "checked" : ""} />` : ""}
        <div class="device-card-header">
          <span class="device-name">${esc(d.deviceName || d.device_id || "Unknown")}</span>
          <div class="device-card-badges">
            ${liveCount > 0 ? `<span class="device-live-badge">${liveCount} LIVE</span>` : ""}
            <span class="device-status-dot ${d.online ? "online" : "offline"}"></span>
          </div>
        </div>
        <div class="device-card-body">
          <div class="device-meta">
            <span class="device-meta-label">Model</span>
            <span class="device-meta-value">${esc(d.deviceModel || d.device_model || "--")}</span>
          </div>
          ${d.battery != null ? `
            <div class="device-meta">
              <span class="device-meta-label">Battery</span>
              <span class="device-meta-value ${d.battery < 20 ? "value-warning" : ""}">${d.battery}%</span>
            </div>
          ` : ""}
          ${d.signalStrength != null ? `
            <div class="device-meta">
              <span class="device-meta-label">Signal</span>
              <span class="device-meta-value">${d.signalStrength}%</span>
            </div>
          ` : ""}
          <div class="device-meta">
            <span class="device-meta-label">APNs</span>
            <span class="device-meta-value">${d.apnsToken ? "Registered" : "None"}</span>
          </div>
          ${d.appVersion || d.buildNumber ? `
          <div class="device-meta">
            <span class="device-meta-label">Build</span>
            <span class="device-meta-value">${esc(d.appVersion || "--")}${d.buildNumber ? ` (${d.buildNumber})` : ""}</span>
          </div>
          ` : ""}
          <div class="device-meta">
            <span class="device-meta-label">Last Seen</span>
            <span class="device-meta-value">${d.lastSeen ? formatTime(d.lastSeen) : "--"}</span>
          </div>
        </div>
      </div>
    `;
  }).join("");

  // Bind card clicks
  grid.querySelectorAll(".device-card").forEach(card => {
    card.addEventListener("click", (e) => {
      const deviceId = (card as HTMLElement).dataset.deviceId;
      if (!deviceId) return;
      if (_selectMode) {
        // Toggle selection — ignore if click was on checkbox (it handles itself)
        if ((e.target as HTMLElement).classList.contains("device-card-checkbox")) return;
        toggleSelection(deviceId);
      } else {
        openDeviceModal(container, deviceId);
      }
    });
  });

  // Bind checkbox changes
  grid.querySelectorAll<HTMLInputElement>(".device-card-checkbox").forEach(cb => {
    cb.addEventListener("change", (e) => {
      const card = (cb.closest(".device-card") as HTMLElement);
      const deviceId = card?.dataset.deviceId;
      if (!deviceId) return;
      e.stopPropagation();
      toggleSelection(deviceId);
    });
  });
}

function bindFilters(container: HTMLElement): void {
  const filters = container.querySelector("#device-filters");
  if (!filters) return;

  filters.addEventListener("click", (e) => {
    const pill = (e.target as HTMLElement).closest(".filter-pill");
    if (!pill) return;

    filters.querySelectorAll(".filter-pill").forEach(p => p.classList.remove("active"));
    pill.classList.add("active");
    _currentFilter = (pill as HTMLElement).dataset.filter || "all";
    renderGrid(container, _allDevices, _allSessions);
  });
}

function bindSearch(container: HTMLElement): void {
  const input = container.querySelector("#device-search") as HTMLInputElement;
  if (!input) return;

  let debounce: ReturnType<typeof setTimeout>;
  input.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      _searchQuery = input.value.trim();
      renderGrid(container, _allDevices, _allSessions);
    }, 200);
  });
}

function bindModal(container: HTMLElement): void {
  const close = container.querySelector("#modal-close");
  const overlay = container.querySelector("#device-modal");

  close?.addEventListener("click", () => overlay?.classList.add("hidden"));
  overlay?.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.classList.add("hidden");
  });
}

function toggleSelection(deviceId: string): void {
  if (_selectedIds.has(deviceId)) {
    _selectedIds.delete(deviceId);
  } else {
    _selectedIds.add(deviceId);
  }
  updateDeleteButton();
  if (_container) renderGrid(_container, _allDevices, _allSessions);
}

function updateDeleteButton(): void {
  const c = _container;
  if (!c) return;
  const btn = c.querySelector("#device-delete-btn") as HTMLElement;
  const confirmBar = c.querySelector("#device-confirm-bar") as HTMLElement;
  const countEl = c.querySelector("#confirm-count") as HTMLElement;
  if (btn) {
    btn.textContent = `Delete (${_selectedIds.size})`;
    btn.classList.toggle("hidden", !_selectMode || _selectedIds.size === 0);
  }
  if (confirmBar) confirmBar.classList.add("hidden");
  if (countEl) countEl.textContent = String(_selectedIds.size);
}

function enterSelectMode(container: HTMLElement): void {
  _selectMode = true;
  _selectedIds.clear();
  const toggle = container.querySelector("#device-select-toggle") as HTMLElement;
  if (toggle) { toggle.textContent = "Cancel"; toggle.classList.add("active"); }
  updateDeleteButton();
  renderGrid(container, _allDevices, _allSessions);
}

function exitSelectMode(container: HTMLElement): void {
  _selectMode = false;
  _selectedIds.clear();
  const toggle = container.querySelector("#device-select-toggle") as HTMLElement;
  if (toggle) { toggle.textContent = "Select"; toggle.classList.remove("active"); }
  const btn = container.querySelector("#device-delete-btn") as HTMLElement;
  const confirmBar = container.querySelector("#device-confirm-bar") as HTMLElement;
  if (btn) btn.classList.add("hidden");
  if (confirmBar) confirmBar.classList.add("hidden");
  renderGrid(container, _allDevices, _allSessions);
}

function bindSelectMode(container: HTMLElement): void {
  const toggle = container.querySelector("#device-select-toggle");
  const deleteBtn = container.querySelector("#device-delete-btn");
  const confirmBar = container.querySelector("#device-confirm-bar");
  const confirmYes = container.querySelector("#confirm-yes");
  const confirmNo = container.querySelector("#confirm-no");

  toggle?.addEventListener("click", () => {
    if (_selectMode) exitSelectMode(container);
    else enterSelectMode(container);
  });

  deleteBtn?.addEventListener("click", () => {
    if (_selectedIds.size === 0) return;
    const bar = container.querySelector("#device-confirm-bar") as HTMLElement;
    const countEl = container.querySelector("#confirm-count") as HTMLElement;
    const btn = container.querySelector("#device-delete-btn") as HTMLElement;
    if (countEl) countEl.textContent = String(_selectedIds.size);
    if (btn) btn.classList.add("hidden");
    if (bar) bar.classList.remove("hidden");
  });

  confirmYes?.addEventListener("click", async () => {
    const ids = Array.from(_selectedIds);
    if (ids.length === 0) return;
    const yesBtn = container.querySelector("#confirm-yes") as HTMLElement;
    if (yesBtn) { yesBtn.textContent = "Deleting..."; yesBtn.setAttribute("disabled", "true"); }
    try {
      const result = await apiDeleteDevices(ids);
      if (result?.ok) {
        exitSelectMode(container);
        await loadDevices(container);
      } else {
        console.error("[fleet] Delete failed:", result);
        if (yesBtn) { yesBtn.textContent = "Delete"; yesBtn.removeAttribute("disabled"); }
      }
    } catch (err) {
      console.error("[fleet] Delete error:", err);
      if (yesBtn) { yesBtn.textContent = "Delete"; yesBtn.removeAttribute("disabled"); }
    }
  });

  confirmNo?.addEventListener("click", () => {
    const bar = container.querySelector("#device-confirm-bar") as HTMLElement;
    const btn = container.querySelector("#device-delete-btn") as HTMLElement;
    if (bar) bar.classList.add("hidden");
    if (btn) btn.classList.toggle("hidden", _selectedIds.size === 0);
  });

  // Escape key exits select mode
  _escHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape" && _selectMode && _container) {
      exitSelectMode(_container);
    }
  };
  document.addEventListener("keydown", _escHandler);
}

function openDeviceModal(container: HTMLElement, deviceId: string): void {
  const device = _allDevices.find(d => d.device_id === deviceId);
  if (!device) return;

  const nameEl = container.querySelector("#modal-device-name");
  const bodyEl = container.querySelector("#modal-body");
  const overlay = container.querySelector("#device-modal");

  if (nameEl) nameEl.textContent = device.deviceName || device.device_id;
  if (overlay) overlay.classList.remove("hidden");

  const deviceSessions = _allSessions.filter(s =>
    s.device?.deviceName === device.deviceName
  );

  if (bodyEl) {
    bodyEl.innerHTML = `
      <div class="modal-rows">
        <div class="modal-row"><span class="modal-label">Device ID</span><span class="modal-value">${esc(device.device_id)}</span></div>
        <div class="modal-row"><span class="modal-label">Model</span><span class="modal-value">${esc(device.deviceModel || device.device_model || "--")}</span></div>
        ${device.systemVersion ? `<div class="modal-row"><span class="modal-label">iOS</span><span class="modal-value">${esc(device.systemVersion)}</span></div>` : ""}
        <div class="modal-row"><span class="modal-label">Status</span><span class="modal-value"><span class="device-status-dot ${device.online ? "online" : "offline"}"></span> ${device.online ? "Online" : "Offline"}</span></div>
        <div class="modal-row"><span class="modal-label">Build</span><span class="modal-value">${esc(device.appVersion || "--")}${device.buildNumber ? ` (${device.buildNumber})` : ""}</span></div>
        <div class="modal-row"><span class="modal-label">APNs Token</span><span class="modal-value">${device.apnsToken ? "Registered" : "None"}</span></div>
        <div class="modal-row"><span class="modal-label">Last Seen</span><span class="modal-value">${device.lastSeen ? formatTime(device.lastSeen) : "--"}</span></div>
        ${device.battery != null ? `<div class="modal-row"><span class="modal-label">Battery</span><span class="modal-value">${device.battery}%</span></div>` : ""}
      </div>
      <div class="modal-section">
        <h4 class="section-title">Build History</h4>
        <div id="modal-build-history"><p class="empty-state">Loading...</p></div>
      </div>
      <div class="modal-section">
        <h4 class="section-title">Session History</h4>
        ${deviceSessions.length > 0
          ? `<div class="modal-sessions">${deviceSessions.slice(0, 10).map(s => `
              <div class="modal-session-row">
                <span class="activity-dot ${s.live ? "live" : "recorded"}"></span>
                <span class="modal-session-id">${esc(s.sessionId.slice(0, 8))}</span>
                <span class="modal-session-time">${formatTime(s.startedAt)}</span>
                <span class="modal-session-status ${s.live ? "text-live" : "text-muted"}">${s.live ? "LIVE" : "Recorded"}</span>
              </div>
            `).join("")}</div>`
          : '<p class="empty-state">No sessions for this device</p>'
        }
      </div>
    `;

    // Fetch build history asynchronously
    fetchDeviceBuildHistory(deviceId).then(builds => {
      const el = bodyEl.querySelector("#modal-build-history");
      if (!el) return;
      if (builds.length === 0) {
        el.innerHTML = '<p class="empty-state">No build history</p>';
        return;
      }
      el.innerHTML = `<div class="modal-sessions">${builds.map(b => `
        <div class="modal-session-row">
          <span class="modal-session-id">${esc(b.appVersion)} (${esc(b.buildNumber)})</span>
          <span class="modal-session-time">First: ${formatTime(b.firstSeenAt)}</span>
          <span class="modal-session-status text-muted">Last: ${formatTime(b.lastSeenAt)}</span>
        </div>
      `).join("")}</div>`;
    });
  }
}

export default page;
