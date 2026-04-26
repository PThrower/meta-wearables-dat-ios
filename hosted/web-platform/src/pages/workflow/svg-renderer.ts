/**
 * SVG DAG rendering — build, refresh, runtime badges, subtitle resolution,
 * incremental edge updates.
 */

import { esc } from "../../core/api-client.js";
import type { WorkflowNodeDef, WorkflowEdgeDef } from "../../core/api-client.js";
import { NODE_W, NODE_H, NODE_R, FALLBACK_COLOR } from "./constants.js";
import { getContainer, getWorkflow, getSelectedNodeId, getViewBox } from "./state.js";
import { getNodeDef } from "./node-defs.js";
import { wireSVGEvents } from "./interactions.js";

/** Render runtime badge SVG for a node definition. */
export function runtimeBadgeSVG(def: { runtime?: string[] | null } | undefined): string {
  const rt = def?.runtime;
  if (!rt || rt.length === 0) return "";
  const hasMobile = rt.includes("mobile");
  const hasServer = rt.includes("server");
  const mobileColor = "#06b6d4";
  const serverColor = "#8b5cf6";
  if (hasMobile && hasServer) {
    return `
      <rect x="${NODE_W - 70}" y="${NODE_H - 15}" width="30" height="11" rx="2" fill="${mobileColor}" opacity="0.9"/>
      <text x="${NODE_W - 55}" y="${NODE_H - 7}" text-anchor="middle" fill="#fff" font-size="7" font-weight="600">MOB</text>
      <rect x="${NODE_W - 37}" y="${NODE_H - 15}" width="28" height="11" rx="2" fill="${serverColor}" opacity="0.9"/>
      <text x="${NODE_W - 23}" y="${NODE_H - 7}" text-anchor="middle" fill="#fff" font-size="7" font-weight="600">SRV</text>`;
  }
  if (hasMobile) {
    return `
      <rect x="${NODE_W - 40}" y="${NODE_H - 15}" width="30" height="11" rx="2" fill="${mobileColor}" opacity="0.9"/>
      <text x="${NODE_W - 25}" y="${NODE_H - 7}" text-anchor="middle" fill="#fff" font-size="7" font-weight="600">MOB</text>`;
  }
  return `
    <rect x="${NODE_W - 36}" y="${NODE_H - 15}" width="28" height="11" rx="2" fill="${serverColor}" opacity="0.9"/>
    <text x="${NODE_W - 22}" y="${NODE_H - 7}" text-anchor="middle" fill="#fff" font-size="7" font-weight="600">SRV</text>`;
}

/** Resolve a subtitle template string against node config values. */
export function resolveSubtitle(template: string, config: Record<string, unknown>): string {
  if (template === "${_modalities}") {
    return [
      config.video !== false ? "video" : "",
      config.phoneMic !== false ? "phone-mic" : "",
      config.glassesMic === true ? "glasses-mic" : "",
      config.gestures !== false ? "gestures" : "",
    ].filter(Boolean).join(", ") || "none";
  }
  return template.replace(/\$\{(\w+)\}/g, (_, key) => {
    const val = config[key];
    if (val === undefined || val === "") return "";
    return String(val).slice(0, 22);
  });
}

/** Node status dot colors for live status indicators. */
export const NODE_STATUS_DOT_COLORS: Record<string, string> = {
  running: "#50fa7b",
  active: "#50fa7b",
  idle: "#f1fa8c",
  pending: "#f1fa8c",
  waiting: "#38bdf8",
  paused: "#facc15",
  completed: "#60a5fa",
  skipped: "#6b7280",
  errored: "#ff5555",
  unknown: "#9ca3af",
};

/** Processor node types that participate in sequential activation. */
const PROCESSOR_TYPES = new Set(["s2s-live", "s2s-rest", "s2s-e4b", "jepa-vision", "deepgram-stt"]);

/** Compute execution phases for processor nodes from processor→processor edges.
 *  Returns Map<nodeId, phase> where phase 1 = no upstream processor, phase 2+ = chained. */
function computePhases(nodes: WorkflowNodeDef[], edges: WorkflowEdgeDef[]): Map<string, number> {
  const phases = new Map<string, number>();
  const processorIds = new Set(nodes.filter(n => PROCESSOR_TYPES.has(n.type)).map(n => n.id));
  if (processorIds.size === 0) return phases;

  // Build upstream map: processorId -> upstream processorId
  const upstreamOf = new Map<string, string>();
  for (const e of edges) {
    if (processorIds.has(e.sourceNodeId) && processorIds.has(e.targetNodeId)) {
      upstreamOf.set(e.targetNodeId, e.sourceNodeId);
    }
  }

  // BFS from roots (processors with no upstream processor)
  for (const id of processorIds) {
    if (!upstreamOf.has(id)) phases.set(id, 1);
  }

  // Walk chains
  const visited = new Set<string>();
  const resolve = (id: string): number => {
    if (phases.has(id)) return phases.get(id)!;
    if (visited.has(id)) return 1; // cycle guard
    visited.add(id);
    const up = upstreamOf.get(id);
    const phase = up ? resolve(up) + 1 : 1;
    phases.set(id, phase);
    return phase;
  };
  for (const id of processorIds) resolve(id);

  return phases;
}

/** Render phase badge SVG on a processor node (top-left corner). */
function phaseBadgeSVG(phase: number, scale: number): string {
  if (phase <= 1) return ""; // Phase 1 has no badge (runs immediately)
  const bx = 4 * scale;
  const by = 2 * scale;
  const bw = 18 * scale;
  const bh = 14 * scale;
  const br = 3 * scale;
  return `
    <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="${br}" fill="#f59e0b" opacity="0.9"/>
    <text x="${bx + bw / 2}" y="${by + 10 * scale}" text-anchor="middle" fill="#000" font-size="${8 * scale}" font-weight="700">P${phase}</text>`;
}

/**
 * Parameterized SVG builder — accepts explicit data instead of reading singleton state.
 * Used by MiniWorkflowEditor and the full editor.
 */
export function buildSVGFromData(
  workflow: { nodes: WorkflowNodeDef[]; edges: WorkflowEdgeDef[] },
  viewBox: { x: number; y: number; zoom: number },
  selectedId: string | null,
  nodeStates?: Map<string, string>,
  scale = 1,
  svgId = "wf-svg",
): string {
  const nodes = workflow.nodes;
  const edges = workflow.edges;
  const { x: vx, y: vy, zoom } = viewBox;
  const w = NODE_W * scale;
  const h = NODE_H * scale;
  const r = NODE_R * scale;
  const gridId = svgId + "-grid";

  // Compute execution phases for processor nodes
  const phases = computePhases(nodes, edges);

  const nodeSVGs = nodes.map(n => {
    const def = getNodeDef(n.type);
    const c = def?.color ?? FALLBACK_COLOR;
    const configSummary = def ? resolveSubtitle(def.subtitle, n.config) : "";
    const selected = selectedId === n.id;
    const stateColor = nodeStates?.get(n.id);
    const statusDot = stateColor
      ? `<circle cx="${r}" cy="${r}" r="${5 * scale}" fill="${NODE_STATUS_DOT_COLORS[stateColor] ?? "#9ca3af"}" />`
      : "";
    const phaseBadge = phases.has(n.id) ? phaseBadgeSVG(phases.get(n.id)!, scale) : "";
    return `
      <g class="wf-node" data-id="${n.id}" transform="translate(${n.positionX * scale}, ${n.positionY * scale})">
        ${statusDot}
        ${phaseBadge}
        <rect class="wf-node-bg" width="${w}" height="${h}" rx="${r}" fill="${c.fill}" stroke="${selected ? "#fff" : c.stroke}" stroke-width="${selected ? 2 : 1}" />
        <rect class="wf-node-header" width="${w}" height="${24 * scale}" rx="${r}" fill="${c.header}" />
        <rect x="0" y="${r}" width="${w}" height="${(24 * scale) - r}" fill="${c.header}" />
        <text x="${w / 2}" y="${16 * scale}" text-anchor="middle" fill="#fff" font-size="${10 * scale}" font-weight="600">${esc(n.type.replace("-", " "))}</text>
        <text x="${12 * scale}" y="${44 * scale}" fill="#ccc" font-size="${11 * scale}">${esc(n.label || n.type)}</text>
        <text x="${12 * scale}" y="${60 * scale}" fill="#888" font-size="${9 * scale}">${esc(configSummary)}</text>
        <circle class="wf-port wf-port-in" cx="0" cy="${h / 2}" r="${6 * scale}" fill="${c.stroke}" stroke="#0a0a0a" stroke-width="2" />
        <circle class="wf-port wf-port-out" cx="${w}" cy="${h / 2}" r="${6 * scale}" fill="${c.stroke}" stroke="#0a0a0a" stroke-width="2" />
      </g>
    `;
  }).join("");

  // Edge rendering with sequential phase labels
  const edgeSVGs = edges.map(e => {
    const src = nodes.find(n => n.id === e.sourceNodeId);
    const tgt = nodes.find(n => n.id === e.targetNodeId);
    if (!src || !tgt) return "";
    const sx = src.positionX * scale + w;
    const sy = src.positionY * scale + h / 2;
    const tx = tgt.positionX * scale;
    const ty = tgt.positionY * scale + h / 2;
    const mx = (sx + tx) / 2;

    // Processor→processor edge: show phase transition number
    const srcPhase = phases.get(src.id);
    const tgtPhase = phases.get(tgt.id);
    if (srcPhase != null && tgtPhase != null && tgtPhase > srcPhase) {
      const labelX = mx;
      const labelY = (sy + ty) / 2 - (8 * scale);
      const arrowLabel = `${srcPhase}→${tgtPhase}`;
      return `<path class="wf-edge wf-edge-seq" data-id="${e.id}" d="M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ty}, ${tx} ${ty}" fill="none" stroke="#f59e0b" stroke-width="2" stroke-dasharray="6 3" />` +
        `<text x="${labelX}" y="${labelY}" text-anchor="middle" fill="#f59e0b" font-size="${9 * scale}" font-weight="600" pointer-events="none">${arrowLabel}</text>`;
    }
    return `<path class="wf-edge" data-id="${e.id}" d="M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ty}, ${tx} ${ty}" fill="none" stroke="#64748b" stroke-width="2" />`;
  }).join("");

  const grid = `
    <defs>
      <pattern id="${gridId}" width="${20 * scale}" height="${20 * scale}" patternUnits="userSpaceOnUse">
        <path d="M ${20 * scale} 0 L 0 0 0 ${20 * scale}" fill="none" stroke="rgba(255,255,255,0.04)" stroke-width="0.5" />
      </pattern>
    </defs>
    <rect x="-5000" y="-5000" width="10000" height="10000" fill="url(#${gridId})" />
  `;

  const vbW = 1100 * scale / zoom;
  const vbH = 600 * scale / zoom;
  return `<svg class="wf-canvas-svg" id="${svgId}" viewBox="${vx} ${vy} ${vbW} ${vbH}" xmlns="http://www.w3.org/2000/svg">${grid}${edgeSVGs}${nodeSVGs}</svg>`;
}

/** Build the full SVG string for nodes + edges + grid (singleton state wrapper). */
export function buildSVG(): string {
  const workflow = getWorkflow();
  if (!workflow) return "";
  return buildSVGFromData(workflow, getViewBox(), getSelectedNodeId());
}

/** Re-inject SVG and re-wire events. */
export function refreshSVG(): void {
  const wrap = getContainer()?.querySelector("#wf-canvas-wrap");
  if (!wrap) return;
  wrap.innerHTML = buildSVG();
  wireSVGEvents();
}

/** Update SVG edge paths connected to a moved node without full rebuild. */
export function updateEdgesForNode(svgEl: Element, node: WorkflowNodeDef, edges: WorkflowEdgeDef[], nodes: WorkflowNodeDef[]): void {
  for (const e of edges) {
    if (e.sourceNodeId !== node.id && e.targetNodeId !== node.id) continue;
    const pathEl = svgEl.querySelector(`[data-id="${e.id}"]`);
    if (!pathEl) continue;
    const src = nodes.find(n => n.id === e.sourceNodeId);
    const tgt = nodes.find(n => n.id === e.targetNodeId);
    if (!src || !tgt) continue;
    const sx = src.positionX + NODE_W;
    const sy = src.positionY + NODE_H / 2;
    const tx = tgt.positionX;
    const ty = tgt.positionY + NODE_H / 2;
    const mx = (sx + tx) / 2;
    pathEl.setAttribute("d", `M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ty}, ${tx} ${ty}`);
  }
}
