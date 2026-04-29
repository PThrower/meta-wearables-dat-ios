/**
 * SVG DAG rendering — build, refresh, runtime badges, subtitle resolution,
 * incremental edge updates, flow-colored edges, live output, status glow,
 * touch-friendly targets, menu triggers.
 */

import { esc } from "../../core/api-client.js";
import type { WorkflowNodeDef, WorkflowEdgeDef, DetectedFlow } from "../../core/api-client.js";
import { NODE_W, NODE_H, NODE_R, FALLBACK_COLOR } from "./constants.js";
import { getContainer, getWorkflow, getSelectedNodeId, getViewBox } from "./state.js";
import { getNodeDef } from "./node-defs.js";
import { wireSVGEvents } from "./interactions.js";
import { isTouchDevice } from "./interactions.js";
import { detectFlows, DEFAULT_EDGE_COLOR } from "./flow-detection.js";
import type { NodePreviewState } from "./editor-preview.js";

/** Render runtime badge SVG for a node definition. */
export function runtimeBadgeSVG(def: { runtime?: string[] | null } | undefined, scale = 1): string {
  const rt = def?.runtime;
  if (!rt || rt.length === 0) return "";
  const hasMobile = rt.includes("mobile");
  const hasServer = rt.includes("server");
  const mobileColor = "#06b6d4";
  const serverColor = "#8b5cf6";
  if (hasMobile && hasServer) {
    return `
      <rect x="${NODE_W * scale - 70 * scale}" y="${NODE_H * scale - 15 * scale}" width="${30 * scale}" height="${11 * scale}" rx="${2 * scale}" fill="${mobileColor}" opacity="0.9"/>
      <text x="${NODE_W * scale - 55 * scale}" y="${NODE_H * scale - 7 * scale}" text-anchor="middle" fill="#fff" font-size="${7 * scale}" font-weight="600">MOB</text>
      <rect x="${NODE_W * scale - 37 * scale}" y="${NODE_H * scale - 15 * scale}" width="${28 * scale}" height="${11 * scale}" rx="${2 * scale}" fill="${serverColor}" opacity="0.9"/>
      <text x="${NODE_W * scale - 23 * scale}" y="${NODE_H * scale - 7 * scale}" text-anchor="middle" fill="#fff" font-size="${7 * scale}" font-weight="600">SRV</text>`;
  }
  if (hasMobile) {
    return `
      <rect x="${NODE_W * scale - 40 * scale}" y="${NODE_H * scale - 15 * scale}" width="${30 * scale}" height="${11 * scale}" rx="${2 * scale}" fill="${mobileColor}" opacity="0.9"/>
      <text x="${NODE_W * scale - 25 * scale}" y="${NODE_H * scale - 7 * scale}" text-anchor="middle" fill="#fff" font-size="${7 * scale}" font-weight="600">MOB</text>`;
  }
  return `
    <rect x="${NODE_W * scale - 36 * scale}" y="${NODE_H * scale - 15 * scale}" width="${28 * scale}" height="${11 * scale}" rx="${2 * scale}" fill="${serverColor}" opacity="0.9"/>
    <text x="${NODE_W * scale - 22 * scale}" y="${NODE_H * scale - 7 * scale}" text-anchor="middle" fill="#fff" font-size="${7 * scale}" font-weight="600">SRV</text>`;
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

/**
 * Node execution state visual config.
 * Each state maps to a color + animation class + glow intensity + border width.
 * Colors chosen for semantic clarity:
 *   queue (pending/waiting) = amber   — staged, not yet executing
 *   runtime (running/active) = green  — actively processing
 *   success (completed) = cyan/blue   — finished OK
 *   failure (errored) = red           — error
 *   skip = gray                       — bypassed
 *   idle = muted yellow               — no activity
 */
export interface NodeStateVisual {
  color: string;       // primary state color
  glow: number;        // SVG filter stdDeviation (0 = no glow)
  borderWidth: number; // node border stroke-width
  opacity: number;     // glow border opacity (0-1)
  anim: string;        // CSS animation class (empty = none)
}

export const NODE_STATE_VISUALS: Record<string, NodeStateVisual> = {
  running:   { color: "#50fa7b", glow: 5, borderWidth: 2, opacity: 0.6, anim: "wf-anim-running" },
  active:    { color: "#50fa7b", glow: 4, borderWidth: 2, opacity: 0.5, anim: "wf-anim-running" },
  pending:   { color: "#f59e0b", glow: 3, borderWidth: 1.5, opacity: 0.4, anim: "wf-anim-pending" },
  waiting:   { color: "#f59e0b", glow: 2, borderWidth: 1.5, opacity: 0.3, anim: "wf-anim-pending" },
  paused:    { color: "#facc15", glow: 2, borderWidth: 1.5, opacity: 0.35, anim: "" },
  completed: { color: "#22d3ee", glow: 4, borderWidth: 2, opacity: 0.5, anim: "wf-anim-completed" },
  skipped:   { color: "#6b7280", glow: 0, borderWidth: 1, opacity: 0.15, anim: "" },
  errored:   { color: "#ef4444", glow: 6, borderWidth: 2.5, opacity: 0.7, anim: "wf-anim-errored" },
  idle:      { color: "#f1fa8c", glow: 0, borderWidth: 1, opacity: 0, anim: "" },
  unknown:   { color: "#9ca3af", glow: 0, borderWidth: 1, opacity: 0, anim: "" },
};

/** Compute topological depth for all nodes from edges.
 *  Root nodes (no incoming edges) → depth 0.
 *  Each subsequent node → max(parent depths) + 1.
 *  Parallel branches naturally share depth values — this is the execution timeline. */
function computeDepth(nodes: WorkflowNodeDef[], edges: WorkflowEdgeDef[]): Map<string, number> {
  const depth = new Map<string, number>();
  const nodeIds = new Set(nodes.map(n => n.id));
  if (nodeIds.size === 0) return depth;

  const incomingOf = new Map<string, string[]>();
  for (const id of nodeIds) incomingOf.set(id, []);
  for (const e of edges) {
    if (nodeIds.has(e.sourceNodeId) && nodeIds.has(e.targetNodeId)) {
      incomingOf.get(e.targetNodeId)!.push(e.sourceNodeId);
    }
  }

  const resolving = new Set<string>();
  const resolve = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (resolving.has(id)) return 0; // cycle guard
    resolving.add(id);
    const parents = incomingOf.get(id) ?? [];
    const d = parents.length === 0 ? 0 : Math.max(...parents.map(resolve)) + 1;
    depth.set(id, d);
    resolving.delete(id);
    return d;
  };

  for (const id of nodeIds) resolve(id);
  return depth;
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
  flows?: DetectedFlow[],
  testingMode = false,
  previews?: Map<string, NodePreviewState>,
): string {
  const nodes = workflow.nodes;
  const edges = workflow.edges;
  const { x: vx, y: vy, zoom } = viewBox;
  const w = NODE_W * scale;
  const baseH = NODE_H * scale;
  const r = NODE_R * scale;
  const gridId = svgId + "-grid";
  const touch = isTouchDevice();
  const portR = touch ? 10 * scale : 6 * scale;
  const portHitR = touch ? 22 * scale : 0;
  const nodeH = testingMode ? baseH + 30 * scale : baseH;

  // Auto-detect flows if not provided
  const detectedFlows = flows ?? detectFlows(nodes, edges);
  const multiFlow = detectedFlows.length > 1;

  // Build lookup: nodeId -> flow color
  const nodeFlowColor = new Map<string, string>();
  if (multiFlow) {
    for (const f of detectedFlows) {
      for (const nid of f.nodeIds) nodeFlowColor.set(nid, f.color);
    }
  }

  // Build lookup: edgeId -> flow color
  const edgeFlowColor = new Map<string, string>();
  if (multiFlow) {
    for (const f of detectedFlows) {
      for (const eid of f.edgeIds) edgeFlowColor.set(eid, f.color);
    }
  }

  // Compute topological depth (execution timeline) for all nodes
  const depths = computeDepth(nodes, edges);

  // SVG filters for per-state glow effects
  const filterDefs = (() => {
    // Collect unique states that need glow filters
    const stateSet = new Set<string>();
    for (const n of nodes) {
      const s = nodeStates?.get(n.id);
      if (s) stateSet.add(s);
    }
    if (stateSet.size === 0) return "";
    let filters = "<defs>";
    for (const s of stateSet) {
      const vis = NODE_STATE_VISUALS[s];
      if (!vis || vis.glow === 0) continue;
      filters += `<filter id="wf-glow-${s}" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="${vis.glow}" result="blur" />
        <feFlood flood-color="${vis.color}" flood-opacity="0.4" result="color" />
        <feComposite in="color" in2="blur" operator="in" result="colored-blur" />
        <feMerge><feMergeNode in="colored-blur" /><feMergeNode in="SourceGraphic" /></feMerge>
      </filter>`;
    }
    filters += "</defs>";
    return filters;
  })();

  // Replace old glowFilter reference
  const glowFilter = filterDefs;

  const nodeSVGs = nodes.map(n => {
    const def = getNodeDef(n.type);
    const c = def?.color ?? FALLBACK_COLOR;
    const configSummary = def ? resolveSubtitle(def.subtitle, n.config) : "";
    const selected = selectedId === n.id;
    const stateStr = nodeStates?.get(n.id);
    const preview = previews?.get(n.id);
    const vis = stateStr ? (NODE_STATE_VISUALS[stateStr] ?? NODE_STATE_VISUALS.unknown) : null;

    // State-colored border: replace default stroke when node has a state
    const borderStroke = selected ? "#fff" : (vis ? vis.color : c.stroke);
    const borderStrokeWidth = selected ? 2 : (vis ? vis.borderWidth : 1);

    // Status dot — colored circle with per-state animation
    const statusDot = vis
      ? `<circle class="wf-status-dot ${vis.anim}" cx="${r}" cy="${r}" r="${5 * scale}" fill="${vis.color}" />`
      : "";

    // State glow border — always visible when node has non-idle state
    const statusGlow = vis && vis.glow > 0
      ? `<rect x="${-2 * scale}" y="${-2 * scale}" width="${w + 4 * scale}" height="${nodeH + 4 * scale}" rx="${r + 2 * scale}" fill="none" stroke="${vis.color}" stroke-width="${vis.borderWidth}" opacity="${vis.opacity}" filter="url(#wf-glow-${stateStr})" pointer-events="none" />`
      : vis && vis.opacity > 0
        ? `<rect x="${-2 * scale}" y="${-2 * scale}" width="${w + 4 * scale}" height="${nodeH + 4 * scale}" rx="${r + 2 * scale}" fill="none" stroke="${vis.color}" stroke-width="1" opacity="${vis.opacity}" pointer-events="none" />`
        : "";

    // Flow indicator badge (small colored dot in top-left, only when multi-flow)
    const flowColor = nodeFlowColor.get(n.id);
    const flowDot = multiFlow && flowColor
      ? `<circle class="wf-flow-dot" data-flow-id="${detectedFlows.find(f => f.nodeIds.includes(n.id))?.flowId ?? ""}" cx="${8 * scale}" cy="${8 * scale}" r="${4 * scale}" fill="${flowColor}" stroke="#0a0a0a" stroke-width="1" style="cursor:pointer" />`
      : "";
    const flowAttr = multiFlow && flowColor ? ` data-flow-id="${detectedFlows.find(f => f.nodeIds.includes(n.id))?.flowId ?? ""}"` : "";

    // Live output text (testing mode)
    const liveOutput = testingMode && preview?.lastText
      ? `<text class="wf-node-output" x="${12 * scale}" y="${nodeH - 8 * scale}" fill="#50fa7b" font-size="${9 * scale}" font-family="'SF Mono',monospace">${esc(preview.lastText.slice(0, 28))}</text>`
      : "";

    // Menu trigger circle (testing mode, top-right)
    const menuBtn = testingMode
      ? `<g class="wf-node-menu-btn" style="cursor:pointer">
           <circle cx="${w - 10 * scale}" cy="${10 * scale}" r="${touch ? 10 * scale : 7 * scale}" fill="transparent" />
           <circle cx="${w - 10 * scale}" cy="${10 * scale}" r="${2 * scale}" fill="#9ca3af" />
           <circle cx="${w - 10 * scale}" cy="${15 * scale}" r="${2 * scale}" fill="#9ca3af" />
           <circle cx="${w - 10 * scale}" cy="${20 * scale}" r="${2 * scale}" fill="#9ca3af" />
         </g>`
      : "";

    // Port circles with optional hit area for touch
    const portIn = touch
      ? `<circle class="wf-port-hit wf-port-in-hit" cx="0" cy="${nodeH / 2}" r="${portHitR}" fill="transparent" pointer-events="all" />
         <circle class="wf-port wf-port-in" cx="0" cy="${nodeH / 2}" r="${portR}" fill="${c.stroke}" stroke="#0a0a0a" stroke-width="2" />`
      : `<circle class="wf-port wf-port-in" cx="0" cy="${nodeH / 2}" r="${portR}" fill="${c.stroke}" stroke="#0a0a0a" stroke-width="2" />`;

    const portOut = touch
      ? `<circle class="wf-port-hit wf-port-out-hit" cx="${w}" cy="${nodeH / 2}" r="${portHitR}" fill="transparent" pointer-events="all" />
         <circle class="wf-port wf-port-out" cx="${w}" cy="${nodeH / 2}" r="${portR}" fill="${c.stroke}" stroke="#0a0a0a" stroke-width="2" />`
      : `<circle class="wf-port wf-port-out" cx="${w}" cy="${nodeH / 2}" r="${portR}" fill="${c.stroke}" stroke="#0a0a0a" stroke-width="2" />`;

    return `
      <g class="wf-node" data-id="${n.id}" data-state="${stateStr ?? ""}"${flowAttr} transform="translate(${n.positionX * scale}, ${n.positionY * scale})">
        ${statusGlow}
        ${statusDot}
        ${flowDot}
        <rect class="wf-node-bg" width="${w}" height="${nodeH}" rx="${r}" fill="${c.fill}" stroke="${borderStroke}" stroke-width="${borderStrokeWidth}" />
        <rect class="wf-node-header" width="${w}" height="${24 * scale}" rx="${r}" fill="${c.header}" />
        <rect x="0" y="${r}" width="${w}" height="${(24 * scale) - r}" fill="${c.header}" />
        <text x="${w / 2}" y="${16 * scale}" text-anchor="middle" fill="#fff" font-size="${10 * scale}" font-weight="600">${esc(n.type.replace("-", " "))}</text>
        <text x="${12 * scale}" y="${44 * scale}" fill="#ccc" font-size="${11 * scale}">${esc(n.label || n.type)}</text>
        <text x="${12 * scale}" y="${60 * scale}" fill="#888" font-size="${9 * scale}">${esc(configSummary)}</text>
        ${liveOutput}
        ${menuBtn}
        ${runtimeBadgeSVG(def, scale)}
        ${portIn}
        ${portOut}
      </g>
    `;
  }).join("");

  // Edge rendering with flow coloring and timeline step numbers
  const edgeSVGs = edges.map(e => {
    const src = nodes.find(n => n.id === e.sourceNodeId);
    const tgt = nodes.find(n => n.id === e.targetNodeId);
    if (!src || !tgt) return "";
    const sx = src.positionX * scale + w;
    const sy = src.positionY * scale + nodeH / 2;
    const tx = tgt.positionX * scale;
    const ty = tgt.positionY * scale + nodeH / 2;
    const mx = (sx + tx) / 2;
    const midY = (sy + ty) / 2;

    // Edge color: flow color when multi-flow, otherwise default gray
    const edgeColor = multiFlow ? (edgeFlowColor.get(e.id) ?? DEFAULT_EDGE_COLOR) : DEFAULT_EDGE_COLOR;

    // Step label from topological depth (skip depth 0 roots)
    const tgtDepth = depths.get(tgt.id);
    const stepLabel = (tgtDepth != null && tgtDepth > 0)
      ? `<circle cx="${mx}" cy="${midY}" r="${7 * scale}" fill="#1e293b" stroke="#475569" stroke-width="1" pointer-events="none" class="wf-step" />` +
        `<text x="${mx}" y="${midY + 3 * scale}" text-anchor="middle" fill="#94a3b8" font-size="${7 * scale}" font-weight="600" pointer-events="none">${tgtDepth}</text>`
      : "";

    return `<path class="wf-edge" data-id="${e.id}" d="M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ty}, ${tx} ${ty}" fill="none" stroke="${edgeColor}" stroke-width="2" />${stepLabel}`;
  }).join("");

  const grid = `
    <defs>
      <pattern id="${gridId}" width="${20 * scale}" height="${20 * scale}" patternUnits="userSpaceOnUse">
        <path d="M ${20 * scale} 0 L 0 0 0 ${20 * scale}" fill="none" stroke="rgba(255,255,255,0.04)" stroke-width="0.5" />
      </pattern>
    </defs>
    <rect class="wf-grid-bg" x="-5000" y="-5000" width="10000" height="10000" fill="url(#${gridId})" />
  `;

  const vbW = 1100 * scale / zoom;
  const vbH = 600 * scale / zoom;
  return `<svg class="wf-canvas-svg" id="${svgId}" viewBox="${vx} ${vy} ${vbW} ${vbH}" xmlns="http://www.w3.org/2000/svg" ${touch ? 'data-touch="true"' : ''}>${glowFilter}${grid}${edgeSVGs}${nodeSVGs}</svg>`;
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
