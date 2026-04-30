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

/* ── Geofence Map (intercepted from textarea with key "geofences") ── */

interface GeofenceItem {
  id: string;
  latitude: number;
  longitude: number;
  radius: number;
  label: string;
  notifyOnEntry: boolean;
  notifyOnExit: boolean;
}

const GEOFENCE_COLORS = ["#06b6d4", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#ec4899", "#f97316", "#14b8a6"];
const GEOFENCE_MAP_ID = "wf-geofence-map-container";

/** Render geofence map + card list instead of textarea. */
function renderGeofenceMapField(field: ConfigFieldSchema & { kind: "geofence-map" }, node: WorkflowNodeDef, prefix: string): string {
  const geofences = parseGeofences(node.config[field.key]);
  const mapId = `${prefix}-geofence-map`;
  const cardsHtml = geofences.map((gf, i) => renderGeofenceCard(gf, i, prefix)).join("");
  const hiddenVal = JSON.stringify(geofences);

  return `<div class="${prefix}-field wf-geofence-section" data-geofence-section style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #333;">
    <label style="font-weight: 600; margin-bottom: 6px; display: block;">Geofences</label>
    <div class="wf-geofence-map-wrap">
      <div id="${mapId}" class="wf-geofence-map"></div>
      <p class="wf-geofence-hint">Click map to place a geofence</p>
    </div>
    <div class="wf-geofence-cards">${cardsHtml}</div>
    <input type="hidden" class="${prefix}-input" data-field="config.geofences" value="${esc(hiddenVal)}" />
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

/** Render a single geofence card. */
function renderGeofenceCard(gf: GeofenceItem, index: number, prefix: string): string {
  const color = GEOFENCE_COLORS[index % GEOFENCE_COLORS.length];
  return `<div class="wf-geofence-card" data-gf-id="${gf.id}" style="border-left: 3px solid ${color}">
    <div class="wf-geofence-card-header">
      <input type="text" class="wf-gf-label" data-gf-field="label" value="${esc(gf.label)}" placeholder="Label (e.g. Home)" />
      <button class="wf-gf-delete" title="Remove geofence">&times;</button>
    </div>
    <div class="wf-geofence-card-row">
      <span class="wf-gf-coord">Lat: <input type="number" class="wf-gf-num" data-gf-field="latitude" value="${gf.latitude}" step="any" /></span>
      <span class="wf-gf-coord">Lon: <input type="number" class="wf-gf-num" data-gf-field="longitude" value="${gf.longitude}" step="any" /></span>
    </div>
    <div class="wf-geofence-card-row">
      <label class="wf-gf-slider-label">Radius: <strong>${gf.radius}m</strong></label>
      <input type="range" class="wf-gf-radius" data-gf-field="radius" min="10" max="5000" step="10" value="${gf.radius}" />
    </div>
    <div class="wf-geofence-card-row">
      <label><input type="checkbox" data-gf-field="notifyOnEntry" ${gf.notifyOnEntry ? "checked" : ""} /> Entry</label>
      <label><input type="checkbox" data-gf-field="notifyOnExit" ${gf.notifyOnExit ? "checked" : ""} /> Exit</label>
    </div>
  </div>`;
}

/** Wire geofence map interactions. Called from wireConfigFieldInputs after DOM is ready. */
export function wireGeofenceMap(container: Element, callbacks: ConfigFieldCallbacks): void {
  const mapEl = container.querySelector(".wf-geofence-map") as HTMLElement | null;
  if (!mapEl) return;

  // Prevent double-init
  if (mapEl.dataset.initialized === "true") return;
  mapEl.dataset.initialized = "true";

  const hiddenInput = container.querySelector('[data-field="config.geofences"]') as HTMLInputElement;
  if (!hiddenInput) return;

  // Initialize Leaflet map
  const map = L.map(mapEl, { zoomControl: true, attributionControl: false }).setView([37.7749, -122.4194], 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);

  // Dark theme filter on tiles
  const tileLayer = mapEl.querySelector(".leaflet-tile-pane") as HTMLElement;
  if (tileLayer) tileLayer.style.filter = "invert(1) hue-rotate(180deg) brightness(0.8) contrast(1.2)";

  // Track circles by geofence id
  const circles = new Map<string, L.Circle>();

  // Load existing geofences
  const geofences = parseGeofences(hiddenInput.value);
  for (const gf of geofences) {
    addCircleToMap(map, circles, gf, geofences.indexOf(gf));
  }
  if (geofences.length > 0) {
    const bounds = geofences.map(gf => [gf.latitude, gf.longitude] as L.LatLngExpression);
    map.fitBounds(L.latLngBounds(bounds).pad(0.3));
  }

  // Invalidate size after DOM paint
  requestAnimationFrame(() => map.invalidateSize());

  // Map click → add geofence
  map.on("click", (e: L.LeafletMouseEvent) => {
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

    const cardsContainer = container.querySelector(".wf-geofence-cards");
    if (cardsContainer) {
      cardsContainer.insertAdjacentHTML("beforeend", renderGeofenceCard(gf, currentGfs.length - 1, "wf-config"));
      wireGeofenceCardEvents(cardsContainer.lastElementChild!, gf.id, map, circles, hiddenInput, container, callbacks);
    }

    addCircleToMap(map, circles, gf, currentGfs.length - 1);
    syncConfig(hiddenInput, container, callbacks);
  });

  // Wire existing cards
  container.querySelectorAll(".wf-geofence-card").forEach(card => {
    const gfId = (card as HTMLElement).dataset.gfId!;
    wireGeofenceCardEvents(card, gfId, map, circles, hiddenInput, container, callbacks);
  });

  // Conditional visibility: show/hide based on mode select
  const modeSelect = container.querySelector('[data-field="config.mode"]') as HTMLSelectElement | null;
  const section = container.querySelector("[data-geofence-section]") as HTMLElement | null;
  if (modeSelect && section) {
    const updateVisibility = () => {
      section.style.display = modeSelect.value === "geofence" ? "" : "none";
    };
    updateVisibility();
    modeSelect.addEventListener("change", updateVisibility);
  }
}

/** Add a draggable circle to the map for a geofence. */
function addCircleToMap(map: L.Map, circles: Map<string, L.Circle>, gf: GeofenceItem, index: number): void {
  const color = GEOFENCE_COLORS[index % GEOFENCE_COLORS.length];
  const circle = L.circle([gf.latitude, gf.longitude], {
    radius: gf.radius,
    color,
    fillColor: color,
    fillOpacity: 0.15,
    weight: 2,
    bubblingMouseEvents: false,
  }).addTo(map);

  // Center marker (draggable)
  const marker = L.circleMarker([gf.latitude, gf.longitude], {
    radius: 4,
    color,
    fillColor: color,
    fillOpacity: 0.9,
    weight: 1,
  }).addTo(map);

  // Store circle + marker together
  (circle as any)._gfMarker = marker;
  (circle as any)._gfId = gf.id;
  circles.set(gf.id, circle);
}

/** Wire events for a single geofence card. */
function wireGeofenceCardEvents(
  card: Element, gfId: string, map: L.Map, circles: Map<string, L.Circle>,
  hiddenInput: HTMLInputElement, container: Element, callbacks: ConfigFieldCallbacks
): void {
  // Delete button
  card.querySelector(".wf-gf-delete")?.addEventListener("click", () => {
    const circle = circles.get(gfId);
    if (circle) {
      const marker = (circle as any)._gfMarker as L.CircleMarker;
      map.removeLayer(circle);
      if (marker) map.removeLayer(marker);
      circles.delete(gfId);
    }
    card.remove();
    syncConfig(hiddenInput, container, callbacks);
  });

  // Field changes (label, lat, lon, radius, checkboxes)
  card.querySelectorAll("[data-gf-field]").forEach(input => {
    input.addEventListener("change", () => {
      syncConfig(hiddenInput, container, callbacks);
      // Update circle on map
      const circle = circles.get(gfId);
      if (!circle) return;
      const gf = findGeofence(hiddenInput, gfId);
      if (!gf) return;
      circle.setLatLng([gf.latitude, gf.longitude]);
      circle.setRadius(gf.radius);
      const marker = (circle as any)._gfMarker as L.CircleMarker;
      if (marker) marker.setLatLng([gf.latitude, gf.longitude]);
      // Update radius display
      const sliderLabel = card.querySelector(".wf-gf-slider-label strong");
      if (sliderLabel && (input as HTMLElement).dataset.gfField === "radius") {
        sliderLabel.textContent = `${gf.radius}m`;
      }
    });
  });
}

/** Read all cards from DOM and sync to hidden input + auto-save. */
function syncConfig(hiddenInput: HTMLInputElement, container: Element, callbacks: ConfigFieldCallbacks): void {
  const cards = container.querySelectorAll(".wf-geofence-card");
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

  // Trigger auto-save
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

/** Find a single geofence by id from the hidden input. */
function findGeofence(hiddenInput: HTMLInputElement, gfId: string): GeofenceItem | undefined {
  return parseGeofences(hiddenInput.value).find(gf => gf.id === gfId);
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
