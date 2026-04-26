/**
 * SVG DAG rendering — build, refresh, runtime badges, subtitle resolution,
 * incremental edge updates, flow-colored edges.
 */

import { esc } from "../../core/api-client.js";
import type { WorkflowNodeDef, WorkflowEdgeDef, DetectedFlow } from "../../core/api-client.js";
import { NODE_W, NODE_H, NODE_R, FALLBACK_COLOR } from "./constants.js";
import { getContainer, getWorkflow, getSelectedNodeId, getViewBox } from "./state.js";
import { getNodeDef } from "./node-defs.js";
import { wireSVGEvents } from "./interactions.js";
import { detectFlows, DEFAULT_EDGE_COLOR } from "./flow-detection.js";

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
): string {
  const nodes = workflow.nodes;
  const edges = workflow.edges;
  const { x: vx, y: vy, zoom } = viewBox;
  const w = NODE_W * scale;
  const h = NODE_H * scale;
  const r = NODE_R * scale;
  const gridId = svgId + "-grid";

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

  const nodeSVGs = nodes.map(n => {
    const def = getNodeDef(n.type);
    const c = def?.color ?? FALLBACK_COLOR;
    const configSummary = def ? resolveSubtitle(def.subtitle, n.config) : "";
    const selected = selectedId === n.id;
    const stateColor = nodeStates?.get(n.id);
    const statusDot = stateColor
      ? `<circle cx="${r}" cy="${r}" r="${5 * scale}" fill="${NODE_STATUS_DOT_COLORS[stateColor] ?? "#9ca3af"}" />`
      : "";
    // Flow indicator badge (small colored dot in top-left, only when multi-flow)
    const flowColor = nodeFlowColor.get(n.id);
    const flowDot = multiFlow && flowColor
      ? `<circle class="wf-flow-dot" data-flow-id="${detectedFlows.find(f => f.nodeIds.includes(n.id))?.flowId ?? ""}" cx="${8 * scale}" cy="${8 * scale}" r="${4 * scale}" fill="${flowColor}" stroke="#0a0a0a" stroke-width="1" style="cursor:pointer" />`
      : "";
    const flowAttr = multiFlow && flowColor ? ` data-flow-id="${detectedFlows.find(f => f.nodeIds.includes(n.id))?.flowId ?? ""}"` : "";
    return `
      <g class="wf-node" data-id="${n.id}"${flowAttr} transform="translate(${n.positionX * scale}, ${n.positionY * scale})">
        ${statusDot}
        ${flowDot}
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

  // Edge rendering with flow coloring and timeline step numbers
  const edgeSVGs = edges.map(e => {
    const src = nodes.find(n => n.id === e.sourceNodeId);
    const tgt = nodes.find(n => n.id === e.targetNodeId);
    if (!src || !tgt) return "";
    const sx = src.positionX * scale + w;
    const sy = src.positionY * scale + h / 2;
    const tx = tgt.positionX * scale;
    const ty = tgt.positionY * scale + h / 2;
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
