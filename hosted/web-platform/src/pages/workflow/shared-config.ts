/**
 * Shared config rendering and event wiring — used by both the full workflow editor
 * config panel and the mini editor config panel. All functions are prefix-parameterized
 * or callback-driven for dependency inversion.
 */

import { esc } from "../../core/api-client.js";
import type { WorkflowNodeDef, ConfigFieldSchema, FlowExecutionConfig, FlowExecutionMode, FlowTrigger, FlowTriggerType, DetectedFlow, WorkflowSettings } from "../../core/api-client.js";
import { DEFAULT_WORKFLOW_SETTINGS } from "../../core/api-client.js";
import { buildDefaultFlowConfig } from "./flow-detection.js";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

/* ── Callback interfaces ── */

/** Minimal workflow shape needed by flow config wiring. */
export interface WorkflowLike {
  flowConfig?: FlowExecutionConfig | null;
  nodes: Array<{ id: string; type?: string; label?: string }>;
  edges: Array<{ id: string; sourceNodeId: string; targetNodeId: string }>;
}

/** Callbacks for flow config panel events — no coupling to either editor's state. */
export interface FlowConfigCallbacks {
  getWorkflow: () => WorkflowLike | null;
  setFlowConfig: (config: FlowExecutionConfig) => void;
  setDirty: () => void;
  autoSave: () => void;
  rerender: () => void;
  onBack?: () => void;
  getSVGContainer?: () => Element | null;
}

/** Callbacks for config field change events. */
export interface ConfigFieldCallbacks {
  getWorkflow: () => { nodes: WorkflowNodeDef[] } | null;
  getSelectedNodeId: () => string | null;
  setDirty: () => void;
  autoSave: () => void;
  refreshSVG: () => void;
}

/* ── Config field rendering ── */

/** Render a single config field based on its schema kind. */
export function renderConfigField(field: ConfigFieldSchema, node: WorkflowNodeDef, prefix: string): string {
  switch (field.kind) {
    case "text": {
      const val = field.key === "label" ? node.label : String(node.config[field.key] ?? "");
      const dataField = field.key === "label" ? "label" : `config.${field.key}`;
      return `<div class="${prefix}-field"><label>${esc(field.label)}</label><input type="text" class="${prefix}-input" data-field="${dataField}" value="${esc(val)}" ${field.placeholder ? `placeholder="${esc(field.placeholder)}"` : ""} /></div>`;
    }
    case "textarea": {
      const val = String(node.config[field.key] ?? "");
      return `<div class="${prefix}-field"><label>${esc(field.label)}</label><textarea class="${prefix}-input ${prefix}-textarea" data-field="config.${field.key}" rows="${field.rows ?? 4}" ${field.placeholder ? `placeholder="${esc(field.placeholder)}"` : ""}>${esc(val)}</textarea></div>`;
    }
    case "select": {
      const val = String(node.config[field.key] ?? "");
      const options = field.options.map(o => `<option value="${esc(o.value)}" ${val === o.value ? "selected" : ""}>${esc(o.label)}</option>`).join("");
      return `<div class="${prefix}-field"><label>${esc(field.label)}</label><select class="${prefix}-input" data-field="config.${field.key}">${options}</select></div>`;
    }
    case "range": {
      const val = (node.config[field.key] as number) ?? field.min;
      return `<div class="${prefix}-field"><label>${esc(field.label)}: ${val}${field.unit ?? ""}</label><input type="range" min="${field.min}" max="${field.max}" step="${field.step}" data-field="config.${field.key}" value="${val}" /></div>`;
    }
    case "checkbox": {
      const checked = node.config[field.key] === true;
      return `<div class="${prefix}-field"><label><input type="checkbox" data-field="config.${field.key}" ${checked ? "checked" : ""} /> ${esc(field.label)}</label></div>`;
    }
    case "checkbox-group": {
      const checks = field.fields.map(f => {
        const checked = node.config[f.key] !== false;
        return `<label><input type="checkbox" data-field="config.${f.key}" ${checked ? "checked" : ""} /> ${esc(f.label)}</label>`;
      }).join("");
      return `<div class="${prefix}-field"><label>${esc(field.label)}</label><div class="${prefix}-checks">${checks}</div></div>`;
    }
    case "number": {
      const val = (node.config[field.key] as number) ?? 0;
      return `<div class="${prefix}-field"><label>${esc(field.label)}</label><input type="number" class="${prefix}-input" data-field="config.${field.key}" min="${field.min ?? ""}" max="${field.max ?? ""}" step="${field.step ?? 1}" value="${val}" /></div>`;
    }
    case "geofence-map": {
      return renderGeofenceMapField(field, node, prefix);
    }
    case "section": {
      const inner = field.fields.map(f => renderConfigField(f, node, prefix)).join("");
      return `<div class="${prefix}-field" style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #333;"><label style="font-weight: 600; margin-bottom: 6px; display: block;">${esc(field.label)}</label>${inner}</div>`;
    }
  }
}

/* ── Geofence Map (modal with Leaflet) ── */

interface GeofenceItem {
  id: string;
  latitude: number;
  longitude: number;
  radius: number;
  label: string;
  notifyOnEntry: boolean;
  notifyOnExit: boolean;
}

const GEOFENCE_COLORS = ["#00d4aa", "#ff6b6b", "#6495ed", "#ffaa32", "#c084fc", "#f472b6", "#34d399", "#fbbf24"];
const GEOFENCE_MODAL_ID = "wf-geofence-modal";

/** Render geofence field as a trigger button + hidden modal. */
function renderGeofenceMapField(field: ConfigFieldSchema & { kind: "geofence-map" }, node: WorkflowNodeDef, prefix: string): string {
  const geofences = parseGeofences(node.config[field.key]);
  const count = geofences.length;
  const hiddenVal = JSON.stringify(geofences);

  return `<div class="${prefix}-field wf-geofence-section" data-geofence-section>
    <input type="hidden" class="${prefix}-input" data-field="config.geofences" value="${esc(hiddenVal)}" />
    <div class="wf-gf-trigger-row">
      <span class="wf-gf-count">${count} geofence${count !== 1 ? "s" : ""}</span>
      <button class="wf-gf-open-btn" type="button">Open Map</button>
    </div>
  </div>`;
}

/** Parse geofences from config value (array or JSON string). */
function parseGeofences(val: unknown): GeofenceItem[] {
  if (Array.isArray(val)) return val.map(normalizeGeofence);
  if (typeof val === "string") {
    try { return JSON.parse(val).map(normalizeGeofence); } catch { return []; }
  }
  return [];
}

function normalizeGeofence(gf: any): GeofenceItem {
  return {
    id: gf.id ?? crypto.randomUUID(),
    latitude: Number(gf.latitude) || 0,
    longitude: Number(gf.longitude) || 0,
    radius: Number(gf.radius) || 100,
    label: String(gf.label ?? ""),
    notifyOnEntry: gf.notifyOnEntry !== false,
    notifyOnExit: gf.notifyOnExit !== false,
  };
}

/** Render the full modal HTML (appended to body once). */
function renderGeofenceModal(): string {
  return `<div id="${GEOFENCE_MODAL_ID}" class="wf-gf-modal-overlay" style="display:none;">
    <div class="wf-gf-modal">
      <aside class="wf-gf-sidebar">
        <div class="wf-gf-sidebar-header">
          <h1><span class="wf-gf-dot"></span> Geofence Map</h1>
          <p>Click the map to place geofence regions. Drag markers to reposition.</p>
        </div>
        <div class="wf-gf-sidebar-section">
          <div class="wf-gf-section-title">Cursor Position</div>
          <div class="wf-gf-coord-display" id="wf-gf-cursor-coords">
            <span class="wf-gf-coord-label">Lat</span> &mdash;<br>
            <span class="wf-gf-coord-label">Lng</span> &mdash;<br>
            <span class="wf-gf-coord-label">Zoom</span> &mdash;
          </div>
        </div>
        <div class="wf-gf-sidebar-section">
          <div class="wf-gf-section-title">Geofences (<span id="wf-gf-card-count">0</span>)</div>
          <div id="wf-gf-cards-list" class="wf-gf-cards-list"></div>
        </div>
        <div class="wf-gf-sidebar-section wf-gf-sidebar-footer">
          <div class="wf-gf-btn-row">
            <button class="wf-gf-btn wf-gf-btn-accent" id="wf-gf-fit-btn">Fit All</button>
            <button class="wf-gf-btn" id="wf-gf-clear-btn">Clear All</button>
          </div>
          <button class="wf-gf-btn wf-gf-btn-done" id="wf-gf-done-btn">Done</button>
        </div>
      </aside>
      <div class="wf-gf-map-area">
        <div id="wf-gf-map" class="wf-gf-map"></div>
      </div>
    </div>
  </div>`;
}

/** Render a single geofence card for the modal sidebar. */
function renderGeofenceCard(gf: GeofenceItem, index: number): string {
  const color = GEOFENCE_COLORS[index % GEOFENCE_COLORS.length];
  return `<div class="wf-gf-card" data-gf-id="${gf.id}" style="border-left: 3px solid ${color}">
    <div class="wf-gf-card-header">
      <div class="wf-gf-card-pin" style="background: ${color}20; color: ${color};">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
      </div>
      <input type="text" class="wf-gf-card-label" data-gf-field="label" value="${esc(gf.label)}" placeholder="Label (e.g. Home)" />
      <button class="wf-gf-card-delete" title="Remove geofence">&times;</button>
    </div>
    <div class="wf-gf-card-row">
      <span class="wf-gf-coord-inline">Lat: <input type="number" class="wf-gf-num" data-gf-field="latitude" value="${gf.latitude}" step="any" /></span>
      <span class="wf-gf-coord-inline">Lon: <input type="number" class="wf-gf-num" data-gf-field="longitude" value="${gf.longitude}" step="any" /></span>
    </div>
    <div class="wf-gf-card-row">
      <label class="wf-gf-slider-label">Radius: <strong>${gf.radius}m</strong></label>
      <input type="range" class="wf-gf-radius" data-gf-field="radius" min="10" max="5000" step="10" value="${gf.radius}" />
    </div>
    <div class="wf-gf-card-row">
      <label><input type="checkbox" data-gf-field="notifyOnEntry" ${gf.notifyOnEntry ? "checked" : ""} /> Entry</label>
      <label><input type="checkbox" data-gf-field="notifyOnExit" ${gf.notifyOnExit ? "checked" : ""} /> Exit</label>
    </div>
  </div>`;
}

/** Ensure the modal DOM exists (append once to body). */
function ensureModal(): HTMLElement {
  let modal = document.getElementById(GEOFENCE_MODAL_ID);
  if (!modal) {
    document.body.insertAdjacentHTML("beforeend", renderGeofenceModal());
    modal = document.getElementById(GEOFENCE_MODAL_ID)!;
  }
  return modal;
}

/** Wire geofence map interactions. Called from wireConfigFieldInputs after DOM is ready. */
export function wireGeofenceMap(container: Element, callbacks: ConfigFieldCallbacks): void {
  const section = container.querySelector("[data-geofence-section]") as HTMLElement | null;
  if (!section) return;

  // Prevent double-init
  if (section.dataset.gfWired === "true") return;
  section.dataset.gfWired = "true";

  const hiddenInput = section.querySelector('[data-field="config.geofences"]') as HTMLInputElement;

  // Update the count badge whenever config changes
  const updateCount = () => {
    const gfs = parseGeofences(hiddenInput.value);
    const badge = section.querySelector(".wf-gf-count");
    if (badge) badge.textContent = `${gfs.length} geofence${gfs.length !== 1 ? "s" : ""}`;
  };


  // Open modal button
  const openBtn = section.querySelector(".wf-gf-open-btn");
  if (!openBtn) return;

  let leafletMap: L.Map | null = null;
  const mapItems = new Map<string, { circle: L.Circle; marker: L.Marker }>();

  openBtn.addEventListener("click", () => {
    const modal = ensureModal();
    modal.style.display = "flex";

    // Initialize or reset map
    const mapEl = document.getElementById("wf-gf-map")!;
    if (!leafletMap) {
      leafletMap = L.map(mapEl, { zoomControl: true, attributionControl: false }).setView([37.7749, -122.4194], 12);
      L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        maxZoom: 19,
        subdomains: "abcd",
      }).addTo(leafletMap);

      // Cursor coordinate tracking
      const coordDisplay = document.getElementById("wf-gf-cursor-coords")!;
      leafletMap.on("mousemove", (e: L.LeafletMouseEvent) => {
        coordDisplay.innerHTML =
          `<span class="wf-gf-coord-label">Lat</span> ${e.latlng.lat.toFixed(6)}<br>` +
          `<span class="wf-gf-coord-label">Lng</span> ${e.latlng.lng.toFixed(6)}<br>` +
          `<span class="wf-gf-coord-label">Zoom</span> ${leafletMap!.getZoom()}`;
      });
      leafletMap.on("zoomend", () => {
        const lines = coordDisplay.innerHTML.split("<br>");
        if (lines.length >= 3) {
          lines[2] = `<span class="wf-gf-coord-label">Zoom</span> ${leafletMap!.getZoom()}`;
          coordDisplay.innerHTML = lines.join("<br>");
        }
      });

      // Map click → add geofence
      leafletMap.on("click", (e: L.LeafletMouseEvent) => {
        const gf: GeofenceItem = {
          id: crypto.randomUUID(),
          latitude: Math.round(e.latlng.lat * 1000000) / 1000000,
          longitude: Math.round(e.latlng.lng * 1000000) / 1000000,
          radius: 100,
          label: "",
          notifyOnEntry: true,
          notifyOnExit: true,
        };
        const currentGfs = parseGeofences(hiddenInput.value);
        currentGfs.push(gf);
        hiddenInput.value = JSON.stringify(currentGfs);
        const idx = currentGfs.length - 1;
        addMapItem(leafletMap!, mapItems, gf, idx);
        appendCard(gf, idx, leafletMap!, mapItems, hiddenInput, callbacks);
        syncModalConfig(hiddenInput, section, callbacks);
        updateCount();
        showToast(`Placed geofence at ${gf.latitude.toFixed(4)}, ${gf.longitude.toFixed(4)}`);
      });

      // Fit All button
      document.getElementById("wf-gf-fit-btn")?.addEventListener("click", () => {
        const gfs = parseGeofences(hiddenInput.value);
        if (gfs.length === 0) return;
        const bounds = gfs.map(g => [g.latitude, g.longitude] as L.LatLngExpression);
        leafletMap!.fitBounds(L.latLngBounds(bounds).pad(0.3));
      });

      // Clear All button
      document.getElementById("wf-gf-clear-btn")?.addEventListener("click", () => {
        mapItems.forEach(item => {
          leafletMap!.removeLayer(item.circle);
          leafletMap!.removeLayer(item.marker);
        });
        mapItems.clear();
        hiddenInput.value = "[]";
        const cardsList = document.getElementById("wf-gf-cards-list")!;
        cardsList.innerHTML = '<span class="wf-gf-empty-msg">Click the map to add geofences...</span>';
        syncModalConfig(hiddenInput, section, callbacks);
        updateCount();
        showToast("All geofences cleared");
      });

      // Done button
      document.getElementById("wf-gf-done-btn")?.addEventListener("click", () => {
        modal.style.display = "none";
      });
    }

    // Reset map items
    mapItems.forEach(item => {
      leafletMap!.removeLayer(item.circle);
      leafletMap!.removeLayer(item.marker);
    });
    mapItems.clear();

    // Load existing geofences
    const geofences = parseGeofences(hiddenInput.value);
    const cardsList = document.getElementById("wf-gf-cards-list")!;
    if (geofences.length === 0) {
      cardsList.innerHTML = '<span class="wf-gf-empty-msg">Click the map to add geofences...</span>';
    } else {
      cardsList.innerHTML = geofences.map((gf, i) => renderGeofenceCard(gf, i)).join("");
    }
    for (let i = 0; i < geofences.length; i++) {
      addMapItem(leafletMap!, mapItems, geofences[i], i);
    }
    // Wire card events
    cardsList.querySelectorAll(".wf-gf-card").forEach(card => {
      const gfId = (card as HTMLElement).dataset.gfId!;
      wireModalCardEvents(card, gfId, leafletMap!, mapItems, hiddenInput, section, callbacks, updateCount);
    });

    document.getElementById("wf-gf-card-count")!.textContent = String(geofences.length);

    if (geofences.length > 0) {
      const bounds = geofences.map(gf => [gf.latitude, gf.longitude] as L.LatLngExpression);
      leafletMap.fitBounds(L.latLngBounds(bounds).pad(0.3));
    }

    requestAnimationFrame(() => {
      leafletMap!.invalidateSize();
    });
  });
}

/** Create a colored div icon for a geofence center marker. */
function createMarkerIcon(colorIndex: number): L.DivIcon {
  const color = GEOFENCE_COLORS[colorIndex % GEOFENCE_COLORS.length];
  return L.divIcon({
    className: "",
    html: `<div style="width:20px;height:20px;background:${color};border:3px solid #fff;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,0.4),0 0 0 2px ${color}40;cursor:grab;"></div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
}

/** Add circle + draggable marker to map for a geofence. */
function addMapItem(map: L.Map, mapItems: Map<string, { circle: L.Circle; marker: L.Marker }>, gf: GeofenceItem, index: number): void {
  const color = GEOFENCE_COLORS[index % GEOFENCE_COLORS.length];
  const circle = L.circle([gf.latitude, gf.longitude], {
    radius: gf.radius,
    color,
    fillColor: color,
    fillOpacity: 0.12,
    weight: 2,
    bubblingMouseEvents: false,
  }).addTo(map);

  const marker = L.marker([gf.latitude, gf.longitude], {
    icon: createMarkerIcon(index),
    draggable: true,
  }).addTo(map);

  marker.bindPopup(`<strong>${gf.label || "Geofence"}</strong><br><span style="font-family:monospace;font-size:11px;color:#8b8fa3;">${gf.latitude.toFixed(6)}, ${gf.longitude.toFixed(6)}</span>`);

  // Drag: update circle + hidden input
  marker.on("dragend", () => {
    const pos = marker.getLatLng();
    const updated = parseGeofences((document.querySelector('[data-field="config.geofences"]') as HTMLInputElement)?.value || "[]");
    const match = updated.find(g => g.id === gf.id);
    if (match) {
      match.latitude = Math.round(pos.lat * 1000000) / 1000000;
      match.longitude = Math.round(pos.lng * 1000000) / 1000000;
      circle.setLatLng(pos);
      marker.setPopupContent(`<strong>${match.label || "Geofence"}</strong><br><span style="font-family:monospace;font-size:11px;color:#8b8fa3;">${match.latitude.toFixed(6)}, ${match.longitude.toFixed(6)}</span>`);
      // Update card inputs
      const card = document.querySelector(`.wf-gf-card[data-gf-id="${gf.id}"]`);
      if (card) {
        const latInput = card.querySelector('[data-gf-field="latitude"]') as HTMLInputElement;
        const lonInput = card.querySelector('[data-gf-field="longitude"]') as HTMLInputElement;
        if (latInput) latInput.value = String(match.latitude);
        if (lonInput) lonInput.value = String(match.longitude);
      }
      const hiddenInput = document.querySelector('[data-field="config.geofences"]') as HTMLInputElement;
      if (hiddenInput) hiddenInput.value = JSON.stringify(updated);
      // Sync to workflow
      const section = document.querySelector("[data-geofence-section]");
      if (section) syncModalConfig(hiddenInput, section, null!);
    }
  });

  mapItems.set(gf.id, { circle, marker });
}

/** Append a geofence card to the sidebar and wire its events. */
function appendCard(gf: GeofenceItem, index: number, map: L.Map, mapItems: Map<string, { circle: L.Circle; marker: L.Marker }>, hiddenInput: HTMLInputElement, callbacks: ConfigFieldCallbacks): void {
  const cardsList = document.getElementById("wf-gf-cards-list")!;
  // Remove empty message if present
  const emptyMsg = cardsList.querySelector(".wf-gf-empty-msg");
  if (emptyMsg) emptyMsg.remove();
  cardsList.insertAdjacentHTML("beforeend", renderGeofenceCard(gf, index));
  const card = cardsList.lastElementChild!;
  wireModalCardEvents(card, gf.id, map, mapItems, hiddenInput, null!, callbacks, () => {});
  const countEl = document.getElementById("wf-gf-card-count");
  if (countEl) countEl.textContent = String(cardsList.querySelectorAll(".wf-gf-card").length);
}

/** Wire events for a single geofence card inside the modal. */
function wireModalCardEvents(
  card: Element, gfId: string, map: L.Map, mapItems: Map<string, { circle: L.Circle; marker: L.Marker }>,
  hiddenInput: HTMLInputElement, _section: Element, callbacks: ConfigFieldCallbacks, updateCount: () => void
): void {
  const section = document.querySelector("[data-geofence-section]");

  // Delete
  card.querySelector(".wf-gf-card-delete")?.addEventListener("click", () => {
    const item = mapItems.get(gfId);
    if (item) {
      map.removeLayer(item.circle);
      map.removeLayer(item.marker);
      mapItems.delete(gfId);
    }
    card.remove();
    syncModalConfig(hiddenInput, section!, callbacks);
    if (updateCount) updateCount();
    const cardsList = document.getElementById("wf-gf-cards-list");
    const countEl = document.getElementById("wf-gf-card-count");
    if (cardsList && countEl) {
      const remaining = cardsList.querySelectorAll(".wf-gf-card").length;
      countEl.textContent = String(remaining);
      if (remaining === 0) cardsList.innerHTML = '<span class="wf-gf-empty-msg">Click the map to add geofences...</span>';
    }
    showToast("Geofence removed");
  });

  // Field changes
  card.querySelectorAll("[data-gf-field]").forEach(input => {
    input.addEventListener("change", () => {
      syncModalConfig(hiddenInput, section!, callbacks);
      const item = mapItems.get(gfId);
      if (!item) return;
      const gf = parseGeofences(hiddenInput.value).find(g => g.id === gfId);
      if (!gf) return;
      item.circle.setLatLng([gf.latitude, gf.longitude]);
      item.circle.setRadius(gf.radius);
      item.marker.setLatLng([gf.latitude, gf.longitude]);
      item.marker.setPopupContent(`<strong>${gf.label || "Geofence"}</strong><br><span style="font-family:monospace;font-size:11px;color:#8b8fa3;">${gf.latitude.toFixed(6)}, ${gf.longitude.toFixed(6)}</span>`);
      // Update radius display
      const sliderLabel = card.querySelector(".wf-gf-slider-label strong");
      if (sliderLabel && (input as HTMLElement).dataset.gfField === "radius") {
        sliderLabel.textContent = `${gf.radius}m`;
      }
      if (updateCount) updateCount();
    });
    // Also listen to 'input' for range slider live update
    if ((input as HTMLInputElement).type === "range") {
      input.addEventListener("input", () => {
        const sliderLabel = card.querySelector(".wf-gf-slider-label strong");
        if (sliderLabel) sliderLabel.textContent = `${(input as HTMLInputElement).value}m`;
        const item = mapItems.get(gfId);
        if (item) item.circle.setRadius(parseFloat((input as HTMLInputElement).value));
      });
    }
  });
}

/** Read all cards from modal DOM and sync to hidden input + auto-save. */
function syncModalConfig(hiddenInput: HTMLInputElement, section: Element, callbacks: ConfigFieldCallbacks): void {
  const cards = document.querySelectorAll(`#${GEOFENCE_MODAL_ID} .wf-gf-card`);
  const geofences: GeofenceItem[] = [];
  cards.forEach(card => {
    const el = card as HTMLElement;
    geofences.push({
      id: el.dataset.gfId ?? crypto.randomUUID(),
      latitude: parseFloat((el.querySelector('[data-gf-field="latitude"]') as HTMLInputElement)?.value) || 0,
      longitude: parseFloat((el.querySelector('[data-gf-field="longitude"]') as HTMLInputElement)?.value) || 0,
      radius: parseFloat((el.querySelector('[data-gf-field="radius"]') as HTMLInputElement)?.value) || 100,
      label: (el.querySelector('[data-gf-field="label"]') as HTMLInputElement)?.value ?? "",
      notifyOnEntry: (el.querySelector('[data-gf-field="notifyOnEntry"]') as HTMLInputElement)?.checked !== false,
      notifyOnExit: (el.querySelector('[data-gf-field="notifyOnExit"]') as HTMLInputElement)?.checked !== false,
    });
  });
  hiddenInput.value = JSON.stringify(geofences);

  // Update count badge in config panel
  const badge = section?.querySelector(".wf-gf-count");
  if (badge) badge.textContent = `${geofences.length} geofence${geofences.length !== 1 ? "s" : ""}`;

  if (callbacks?.getWorkflow && callbacks?.getSelectedNodeId) {
    const wf = callbacks.getWorkflow();
    const selId = callbacks.getSelectedNodeId();
    if (wf && selId) {
      const n = wf.nodes.find(n => n.id === selId);
      if (n) {
        n.config.geofences = geofences;
        callbacks.setDirty();
        callbacks.autoSave();
      }
    }
  }
}

/** Toast notification inside the modal. */
let toastTimeout: ReturnType<typeof setTimeout>;
function showToast(msg: string): void {
  let toast = document.getElementById("wf-gf-toast");
  if (!toast) {
    document.getElementById(GEOFENCE_MODAL_ID)?.insertAdjacentHTML("beforeend",
      '<div class="wf-gf-toast" id="wf-gf-toast"></div>');
    toast = document.getElementById("wf-gf-toast");
  }
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove("show"), 2200);
}

/* ── Workflow settings callbacks ── */

/** Callbacks for workflow settings panel events. */
export interface SettingsCallbacks {
  getWorkflow: () => { settings?: WorkflowSettings | null } | null;
  setSettings: (settings: WorkflowSettings) => void;
  setDirty: () => void;
  autoSave: () => void;
  onBack?: () => void;
}

/* ── Workflow settings schema ── */

const WORKFLOW_SETTINGS_SCHEMA: ConfigFieldSchema[] = [
  {
    kind: "section", label: "Lifecycle Policy", fields: [
      { kind: "select", key: "onDisconnect", label: "On Disconnect", options: [
        { value: "stop", label: "Stop session" },
        { value: "pause", label: "Pause session" },
        { value: "continue", label: "Continue running" },
      ] },
      { kind: "select", key: "onReconnect", label: "On Reconnect", options: [
        { value: "restart", label: "Restart session" },
        { value: "resume", label: "Resume paused" },
        { value: "noop", label: "No action" },
      ] },
      { kind: "number", key: "autoDeactivateMin", label: "Auto-Deactivate (min, 0 = never)", min: 0, max: 480, step: 5 },
    ],
  },
  {
    kind: "section", label: "Session Limits", fields: [
      { kind: "number", key: "maxSessionDuration", label: "Max Duration (min, 0 = unlimited)", min: 0, max: 1440, step: 5 },
    ],
  },
  {
    kind: "section", label: "Access & Privacy", fields: [
      { kind: "select", key: "viewerAccess", label: "Viewer Access", options: [
        { value: "owner", label: "Owner only" },
        { value: "team", label: "Team members" },
        { value: "public", label: "Public" },
      ] },
      { kind: "checkbox", key: "recordingEnabled", label: "Enable Recording" },
    ],
  },
  {
    kind: "section", label: "Telemetry", fields: [
      { kind: "number", key: "telemetryIntervalSec", label: "Interval (seconds)", min: 1, max: 60, step: 1 },
    ],
  },
  {
    kind: "section", label: "Device Wake & Stream", fields: [
      { kind: "checkbox", key: "wakeOnActivate", label: "Push notification on activate (APNs wake)" },
      { kind: "checkbox", key: "autoStartStream", label: "Auto-start stream when publisher connects" },
      { kind: "select", key: "targetDeviceId", label: "Target Device", options: [
        { value: "", label: "Auto-detect" },
      ] },
    ],
  },
];

/** Update the targetDeviceId select options from fleet devices. */
export function updateDeviceOptions(devices: Array<{ id: string; name: string | null; model: string | null }>): void {
  const deviceSection = WORKFLOW_SETTINGS_SCHEMA.find(s => s.kind === "section" && s.label === "Device Wake & Stream");
  if (!deviceSection || deviceSection.kind !== "section") return;
  const field = deviceSection.fields.find(f => f.kind === "select" && "key" in f && f.key === "targetDeviceId");
  if (!field || field.kind !== "select") return;
  field.options = [
    { value: "", label: "Auto-detect" },
    ...devices.map(d => ({
      value: d.id,
      label: `${d.name || d.model || d.id.slice(0, 8)}`,
    })),
  ];
}

/** Render workflow settings HTML using the synthetic-node trick. */
export function renderWorkflowSettingsHTML(settings: WorkflowSettings | null): string {
  const merged = { ...DEFAULT_WORKFLOW_SETTINGS, ...settings };
  // Synthetic node where config = settings object — reuses renderConfigField()
  const syntheticNode: WorkflowNodeDef = {
    id: "__settings__",
    type: "__settings__",
    label: "",
    config: merged as unknown as Record<string, unknown>,
    positionX: 0,
    positionY: 0,
  };
  const fieldsHtml = WORKFLOW_SETTINGS_SCHEMA.map(field => renderConfigField(field, syntheticNode, "wf-settings")).join("");
  return `<div class="wf-settings-panel">
    <div class="wf-flow-config-header">
      <span class="wf-flow-config-title">Workflow Settings</span>
      <span class="wf-flow-config-count">Global</span>
    </div>
    ${fieldsHtml}
    <button class="wf-flow-back" id="wf-settings-back">&larr; Back</button>
  </div>`;
}

/** Wire workflow settings field inputs. */
export function wireSettingsFieldInputs(container: Element, callbacks: SettingsCallbacks): void {
  container.querySelectorAll("[data-field]").forEach(input => {
    input.addEventListener("change", () => {
      const wf = callbacks.getWorkflow();
      if (!wf) return;
      const current = { ...DEFAULT_WORKFLOW_SETTINGS, ...wf.settings };
      const el = input as HTMLInputElement;
      const field = el.dataset.field!;
      if (!field.startsWith("config.")) return;
      const key = field.slice(7);

      if (el.type === "checkbox") (current as any)[key] = el.checked;
      else if (el.type === "number") (current as any)[key] = el.value === "" ? null : parseFloat(el.value);
      else (current as any)[key] = el.value;

      callbacks.setSettings(current);
      callbacks.setDirty();
      callbacks.autoSave();
    });
  });

  // Back button
  container.querySelector("#wf-settings-back")?.addEventListener("click", () => callbacks.onBack?.());
}

/* ── Flow config rendering ── */

/** Render flow config HTML. Both editors share wf-flow-* CSS classes. */
export function renderFlowConfigHTML(
  flows: DetectedFlow[],
  config: FlowExecutionConfig | null,
  prefix: string,
  opts?: { showBack?: boolean },
): string {
  const effectiveConfig = config ?? buildDefaultFlowConfig(flows);
  const mode: FlowExecutionMode = effectiveConfig?.mode ?? "parallel";
  const flowOrder: string[] = effectiveConfig?.flowOrder ?? flows.map(f => f.flowId);
  const flowTriggers = effectiveConfig?.flowTriggers ?? {};

  const flowList = flowOrder.map(fid => {
    const f = flows.find(fl => fl.flowId === fid);
    if (!f) return "";
    const triggerRow = mode === "event-driven"
      ? renderFlowTriggerField(fid, flows, flowTriggers[fid])
      : "";
    return `<div class="wf-flow-order-item" data-flow-id="${f.flowId}" draggable="${mode === "sequential"}">
      <span class="wf-flow-drag-handle">${mode === "sequential" ? "⋮⋮" : "●"}</span>
      <span class="wf-flow-color-dot" style="background:${f.color}"></span>
      <span class="wf-flow-label">${esc(f.label)}</span>
      ${triggerRow}
    </div>`;
  }).join("");

  return `<div class="wf-flow-config">
    <div class="wf-flow-config-header">
      <span class="wf-flow-config-title">Flows</span>
      <span class="wf-flow-config-count">${flows.length} found</span>
    </div>
    <div class="wf-flow-mode-selector">
      <button class="wf-flow-mode-btn ${mode === "parallel" ? "active" : ""}" data-mode="parallel">Parallel</button>
      <button class="wf-flow-mode-btn ${mode === "sequential" ? "active" : ""}" data-mode="sequential">Sequential</button>
      <button class="wf-flow-mode-btn ${mode === "event-driven" ? "active" : ""}" data-mode="event-driven">Event-Driven</button>
    </div>
    <div class="wf-flow-order ${mode === "parallel" ? "disabled" : ""}" id="${prefix}-flow-order">
      ${flowList}
    </div>
    ${opts?.showBack ? `<button class="wf-flow-back" id="wf-flow-back">&larr; Back</button>` : ""}
  </div>`;
}

/** Render trigger config for a single flow in event-driven mode */
function renderFlowTriggerField(flowId: string, flows: DetectedFlow[], trigger?: FlowTrigger): string {
  const triggerType = trigger?.type ?? "";
  const otherFlows = flows.filter(f => f.flowId !== flowId);

  const typeOptions = [
    { value: "", label: "Start immediately" },
    { value: "on_flow_complete", label: "On flow complete" },
    { value: "on_condition", label: "On condition" },
    { value: "on_timer", label: "On timer" },
    { value: "on_jepa_event", label: "On JEPA event" },
  ].map(o => `<option value="${o.value}" ${triggerType === o.value ? "selected" : ""}>${o.label}</option>`).join("");

  let subFields = "";

  if (triggerType === "on_flow_complete" || triggerType === "on_condition") {
    const sourceFlowOptions = otherFlows.map(f =>
      `<option value="${f.flowId}" ${trigger?.sourceFlowId === f.flowId || trigger?.condition?.sourceFlowId === f.flowId ? "selected" : ""}>${esc(f.label)}</option>`
    ).join("");
    subFields += `<select class="wf-trigger-subfield" data-trigger-field="sourceFlowId" data-flow-id="${flowId}">
      <option value="">Select source flow</option>${sourceFlowOptions}
    </select>`;
  }

  if (triggerType === "on_condition") {
    const cond = trigger?.condition;
    const operators = [
      { value: "gt", label: ">" }, { value: "gte", label: ">=" },
      { value: "lt", label: "<" }, { value: "lte", label: "<=" },
      { value: "eq", label: "==" }, { value: "neq", label: "!=" },
    ].map(o => `<option value="${o.value}" ${cond?.operator === o.value ? "selected" : ""}>${o.label}</option>`).join("");

    subFields += `<input type="text" class="wf-trigger-subfield" data-trigger-field="conditionField" data-flow-id="${flowId}" placeholder="Field name" value="${esc(cond?.field ?? "")}" />`;
    subFields += `<select class="wf-trigger-subfield" data-trigger-field="conditionOperator" data-flow-id="${flowId}">${operators}</select>`;
    subFields += `<input type="number" class="wf-trigger-subfield" data-trigger-field="conditionValue" data-flow-id="${flowId}" placeholder="Value" value="${cond?.value ?? ""}" step="any" />`;
  }

  if (triggerType === "on_timer") {
    subFields += `<input type="number" class="wf-trigger-subfield" data-trigger-field="intervalSec" data-flow-id="${flowId}" placeholder="Interval (seconds)" value="${trigger?.intervalSec ?? ""}" min="1" step="1" />`;
  }

  if (triggerType === "on_jepa_event") {
    const eventOptions = [
      { value: "any", label: "Any event" },
      { value: "anomaly", label: "Anomaly" },
      { value: "action", label: "Action" },
    ].map(o => `<option value="${o.value}" ${trigger?.jepaEvent === o.value ? "selected" : ""}>${o.label}</option>`).join("");
    subFields += `<select class="wf-trigger-subfield" data-trigger-field="jepaEvent" data-flow-id="${flowId}">${eventOptions}</select>`;
    subFields += `<input type="number" class="wf-trigger-subfield" data-trigger-field="jepaConfidenceThreshold" data-flow-id="${flowId}" placeholder="Min confidence" value="${trigger?.jepaConfidenceThreshold ?? ""}" min="0" max="1" step="0.1" />`;
  }

  return `<div class="wf-flow-trigger-row" data-flow-id="${flowId}">
    <select class="wf-trigger-type" data-flow-id="${flowId}">${typeOptions}</select>
    ${subFields ? `<div class="wf-trigger-subfields">${subFields}</div>` : ""}
  </div>`;
}

/* ── Flow config event wiring ── */

/** Wire flow config panel events — mode toggle, drag reorder, hover highlight, trigger config, back button. */
export function wireFlowConfigEvents(panel: Element, flows: DetectedFlow[], callbacks: FlowConfigCallbacks): void {
  // Mode toggle
  panel.querySelectorAll(".wf-flow-mode-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const mode = (btn as HTMLElement).dataset.mode as FlowExecutionMode;
      const workflow = callbacks.getWorkflow();
      if (!workflow) return;
      const currentConfig = workflow.flowConfig ?? buildDefaultFlowConfig(flows);
      callbacks.setFlowConfig({
        mode,
        flowOrder: currentConfig?.flowOrder ?? flows.map(f => f.flowId),
        flowTriggers: mode === "event-driven" ? (currentConfig as any)?.flowTriggers ?? {} : undefined,
      });
      callbacks.setDirty();
      callbacks.autoSave();
      callbacks.rerender();
    });
  });

  // Trigger type dropdown change — re-render sub-fields
  wireFlowTriggerEvents(panel, flows, callbacks);

  // Back button (optional — only rendered when showBack is true)
  panel.querySelector("#wf-flow-back")?.addEventListener("click", () => callbacks.onBack?.());

  // Drag-and-drop reorder
  const orderEl = panel.querySelector(".wf-flow-order");
  if (orderEl) {
    let draggedId: string | null = null;

    orderEl.querySelectorAll(".wf-flow-order-item").forEach(item => {
      item.addEventListener("dragstart", (e) => {
        draggedId = (item as HTMLElement).dataset.flowId ?? null;
        item.classList.add("dragging");
        (e as DragEvent).dataTransfer!.effectAllowed = "move";
      });

      item.addEventListener("dragend", () => {
        item.classList.remove("dragging");
        draggedId = null;
        if (callbacks.getSVGContainer) clearFlowHighlight(callbacks);
      });

      item.addEventListener("dragover", (e) => {
        e.preventDefault();
        (e as DragEvent).dataTransfer!.dropEffect = "move";
      });

      item.addEventListener("drop", (e) => {
        e.preventDefault();
        const targetId = (item as HTMLElement).dataset.flowId;
        if (!draggedId || !targetId || draggedId === targetId) return;
        const workflow = callbacks.getWorkflow();
        if (!workflow?.flowConfig) return;
        const order = [...workflow.flowConfig.flowOrder];
        const fromIdx = order.indexOf(draggedId);
        const toIdx = order.indexOf(targetId);
        if (fromIdx < 0 || toIdx < 0) return;
        order.splice(fromIdx, 1);
        order.splice(toIdx, 0, draggedId);
        callbacks.setFlowConfig({ ...workflow.flowConfig, flowOrder: order });
        callbacks.setDirty();
        callbacks.autoSave();
        callbacks.rerender();
      });

      // Hover highlighting (only when SVG container provided)
      if (callbacks.getSVGContainer) {
        item.addEventListener("mouseenter", () => {
          const flowId = (item as HTMLElement).dataset.flowId;
          if (flowId) highlightFlow(flowId, flows, callbacks);
        });

        item.addEventListener("mouseleave", () => {
          clearFlowHighlight(callbacks);
        });
      }
    });
  }
}

/** Highlight a flow's nodes/edges on the SVG canvas, dimming everything else. */
function highlightFlow(flowId: string, flows: DetectedFlow[], callbacks: FlowConfigCallbacks): void {
  const svgEl = callbacks.getSVGContainer?.();
  if (!svgEl) return;
  const flow = flows.find(f => f.flowId === flowId);
  if (!flow) return;
  const nodeIds = new Set(flow.nodeIds);
  const edgeIds = new Set(flow.edgeIds);

  svgEl.classList.add("wf-flow-highlight-active");

  svgEl.querySelectorAll(".wf-node[data-flow-id]").forEach(node => {
    if (nodeIds.has((node as HTMLElement).dataset.flowId!)) {
      (node as HTMLElement).style.opacity = "1";
    }
  });

  svgEl.querySelectorAll(".wf-edge").forEach(edge => {
    if (edgeIds.has((edge as HTMLElement).dataset.id!)) {
      (edge as HTMLElement).style.opacity = "1";
    }
  });
}

/** Clear flow highlight from SVG canvas. */
function clearFlowHighlight(callbacks: FlowConfigCallbacks): void {
  const svgEl = callbacks.getSVGContainer?.();
  if (!svgEl) return;
  svgEl.classList.remove("wf-flow-highlight-active");
  svgEl.querySelectorAll(".wf-node, .wf-edge").forEach(el => {
    (el as HTMLElement).style.opacity = "";
  });
}

/* ── Config field event wiring ── */

/** Wire config field change events. */
export function wireConfigFieldInputs(container: Element, callbacks: ConfigFieldCallbacks): void {
  container.querySelectorAll("[data-field]").forEach(input => {
    input.addEventListener("change", () => {
      const wf = callbacks.getWorkflow();
      const selId = callbacks.getSelectedNodeId();
      if (!wf || !selId) return;
      const n = wf.nodes.find(n => n.id === selId);
      if (!n) return;
      const field = (input as HTMLElement).dataset.field!;
      const el = input as HTMLInputElement;
      if (field.startsWith("config.")) {
        const key = field.slice(7);
        // Geofences are handled by the map component — skip default textarea parsing
        if (key === "geofences") {
          try { n.config[key] = JSON.parse(el.value); } catch { n.config[key] = []; }
        } else if (el.type === "range") n.config[key] = parseFloat(el.value);
        else if (el.type === "checkbox") n.config[key] = el.checked;
        else if (el.type === "number") n.config[key] = parseFloat(el.value);
        else n.config[key] = el.value;
      } else {
        (n as any)[field] = el.value;
      }
      callbacks.setDirty();
      callbacks.autoSave();
      callbacks.refreshSVG();
    });
  });

  // Wire geofence map (if present)
  wireGeofenceMap(container, callbacks);
}

/* ── Flow trigger event wiring ── */

/** Wire trigger type dropdown and sub-field change events */
function wireFlowTriggerEvents(panel: Element, flows: DetectedFlow[], callbacks: FlowConfigCallbacks): void {
  // Trigger type dropdown
  panel.querySelectorAll(".wf-trigger-type").forEach(sel => {
    sel.addEventListener("change", () => {
      const flowId = (sel as HTMLElement).dataset.flowId!;
      const triggerType = (sel as HTMLSelectElement).value as FlowTriggerType | "";
      const workflow = callbacks.getWorkflow();
      if (!workflow?.flowConfig) return;

      const currentTriggers = { ...(workflow.flowConfig as any).flowTriggers };

      if (!triggerType) {
        delete currentTriggers[flowId];
      } else {
        currentTriggers[flowId] = { type: triggerType };
      }

      callbacks.setFlowConfig({
        ...workflow.flowConfig,
        flowTriggers: currentTriggers,
      });
      callbacks.setDirty();
      callbacks.autoSave();
      callbacks.rerender();
    });
  });

  // Trigger sub-field changes
  panel.querySelectorAll(".wf-trigger-subfield").forEach(input => {
    input.addEventListener("change", () => {
      const el = input as HTMLInputElement | HTMLSelectElement;
      const flowId = el.dataset.flowId!;
      const field = el.dataset.triggerField!;
      const workflow = callbacks.getWorkflow();
      if (!workflow?.flowConfig) return;

      const currentTriggers = { ...((workflow.flowConfig as any).flowTriggers ?? {}) };
      const currentTrigger: FlowTrigger = currentTriggers[flowId] ?? { type: "" as FlowTriggerType };
      currentTriggers[flowId] = currentTrigger;

      switch (field) {
        case "sourceFlowId":
          currentTrigger.sourceFlowId = el.value;
          break;
        case "conditionField":
          if (!currentTrigger.condition) currentTrigger.condition = { sourceFlowId: "", field: "", operator: "gt", value: 0 };
          currentTrigger.condition.field = el.value;
          break;
        case "conditionOperator":
          if (!currentTrigger.condition) currentTrigger.condition = { sourceFlowId: "", field: "", operator: "gt", value: 0 };
          currentTrigger.condition.operator = el.value as FlowTrigger["condition"] extends infer C | undefined ? C extends { operator: infer O } ? O : never : never;
          break;
        case "conditionValue":
          if (!currentTrigger.condition) currentTrigger.condition = { sourceFlowId: "", field: "", operator: "gt", value: 0 };
          currentTrigger.condition.value = parseFloat(el.value) || 0;
          break;
        case "intervalSec":
          currentTrigger.intervalSec = parseFloat(el.value) || 1;
          break;
        case "jepaEvent":
          currentTrigger.jepaEvent = el.value as "anomaly" | "action" | "any";
          break;
        case "jepaConfidenceThreshold":
          currentTrigger.jepaConfidenceThreshold = parseFloat(el.value) || 0;
          break;
      }

      callbacks.setFlowConfig({
        ...workflow.flowConfig,
        flowTriggers: currentTriggers,
      });
      callbacks.setDirty();
      callbacks.autoSave();
    });
  });
}
