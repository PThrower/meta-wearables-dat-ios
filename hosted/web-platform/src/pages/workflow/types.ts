/**
 * Editor-specific types — used only within the workflow editor.
 *
 * Centralized from scattered inline definitions across:
 *   interactions.ts  (DragState, EdgeState)
 *   canvas-controls.ts  (PanState)
 *   svg-renderer.ts  (NodeStateVisual)
 *   editor-preview.ts  (NodePreviewState, PreviewChangeListener)
 *   editor-view.ts  (PaletteSubcategory, PaletteCategory)
 *   node-availability.ts  (AvailabilityStatus, UnavailabilityReason, AvailabilityEntry)
 *   shared-config.ts  (WorkflowLike, FlowConfigCallbacks, ConfigFieldCallbacks,
 *                       GraphContext, SettingsCallbacks)
 */

import type {
  WorkflowNodeDef,
  FlowExecutionConfig,
  WorkflowSettings,
  ConfigFieldSchema,
  ConnectionCondition,
} from "../../core/workflow-types.js";

// ── Interaction state ──

/** Active node drag state on the canvas. */
export interface DragState {
  nodeId: string;
  startX: number;
  startY: number;
  nodeStartX: number;
  nodeStartY: number;
}

/** Active edge-creation drag state. */
export interface EdgeState {
  sourceNodeId: string;
  tempLine: SVGLineElement;
}

// ── Canvas state ──

/** Active canvas pan state. */
export interface PanState {
  startX: number;
  startY: number;
  viewX: number;
  viewY: number;
}

// ── Node visual state ──

/** Visual properties for a node's SVG representation based on execution state. */
export interface NodeStateVisual {
  color: string;       // primary state color
  glow: number;        // SVG filter stdDeviation (0 = no glow)
  borderWidth: number; // node border stroke-width
  opacity: number;     // glow border opacity (0-1)
  anim: string;        // CSS animation class (empty = none)
}

// ── Live preview ──

/** Per-node execution state + output from live preview WebSocket. */
export interface NodePreviewState {
  nodeId: string;
  nodeType: string;
  label: string;
  executionState: string;
  error?: string;
  lastText?: string;
  lastTextTime?: number;
  numerics: Map<string, { value: number; unit: string; time: number }>;
  thumbnails?: Array<{ dataUrl: string; label: string; confidence: number }>;
  updated: number;
}

export type PreviewChangeListener = () => void;

// ── Palette ──

/** Subcategory within a palette category. */
export interface PaletteSubcategory {
  label: string;
  match: (d: import("../../core/workflow-types.js").NodeDefinition) => boolean;
}

/** Top-level palette category in the sidebar. */
export interface PaletteCategory {
  label: string;
  accent: string;
  match: (d: import("../../core/workflow-types.js").NodeDefinition) => boolean;
  subcategories?: PaletteSubcategory[];
}

// ── Node availability ──

export type AvailabilityStatus = "available" | "unavailable";

/** Availability reason shown as tooltip on locked nodes. */
export type UnavailabilityReason = string;

export interface AvailabilityEntry {
  status: "unavailable";
  reason: UnavailabilityReason;
}

// ── Config panel callbacks ──

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

/** Graph context for connection-conditional config fields. */
export interface GraphContext {
  edges: Array<{ sourceNodeId: string; targetNodeId: string }>;
  nodes: Array<{ id: string; type: string }>;
}

/** Callbacks for workflow settings panel events. */
export interface SettingsCallbacks {
  getWorkflow: () => { settings?: WorkflowSettings | null } | null;
  setSettings: (settings: WorkflowSettings) => void;
  setDirty: () => void;
  autoSave: () => void;
  onBack?: () => void;
}
