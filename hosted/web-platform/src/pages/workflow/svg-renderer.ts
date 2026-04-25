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

/** Build the full SVG string for nodes + edges + grid. */
export function buildSVG(): string {
  const workflow = getWorkflow();
  if (!workflow) return "";
  const nodes = workflow.nodes;
  const edges = workflow.edges;
  const { x: vx, y: vy, zoom } = getViewBox();

  const nodeSVGs = nodes.map(n => {
    const def = getNodeDef(n.type);
    const c = def?.color ?? FALLBACK_COLOR;
    const configSummary = def ? resolveSubtitle(def.subtitle, n.config) : "";
    const selected = getSelectedNodeId() === n.id;
    return `
      <g class="wf-node" data-id="${n.id}" transform="translate(${n.positionX}, ${n.positionY})">
        <rect class="wf-node-bg" width="${NODE_W}" height="${NODE_H}" rx="${NODE_R}" fill="${c.fill}" stroke="${selected ? "#fff" : c.stroke}" stroke-width="${selected ? 2 : 1}" />
        <rect class="wf-node-header" width="${NODE_W}" height="24" rx="${NODE_R}" fill="${c.header}" />
        <rect x="0" y="${NODE_R}" width="${NODE_W}" height="${24 - NODE_R}" fill="${c.header}" />
        <text x="${NODE_W / 2}" y="16" text-anchor="middle" fill="#fff" font-size="10" font-weight="600">${esc(n.type.replace("-", " "))}</text>
        <text x="12" y="44" fill="#ccc" font-size="11">${esc(n.label || n.type)}</text>
        <text x="12" y="60" fill="#888" font-size="9">${esc(configSummary)}</text>
        ${runtimeBadgeSVG(def)}
        <circle class="wf-port wf-port-in" cx="0" cy="${NODE_H / 2}" r="6" fill="${c.stroke}" stroke="#0a0a0a" stroke-width="2" />
        <circle class="wf-port wf-port-out" cx="${NODE_W}" cy="${NODE_H / 2}" r="6" fill="${c.stroke}" stroke="#0a0a0a" stroke-width="2" />
      </g>
    `;
  }).join("");

  const edgeSVGs = edges.map(e => {
    const src = nodes.find(n => n.id === e.sourceNodeId);
    const tgt = nodes.find(n => n.id === e.targetNodeId);
    if (!src || !tgt) return "";
    const sx = src.positionX + NODE_W;
    const sy = src.positionY + NODE_H / 2;
    const tx = tgt.positionX;
    const ty = tgt.positionY + NODE_H / 2;
    const mx = (sx + tx) / 2;
    return `<path class="wf-edge" data-id="${e.id}" d="M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ty}, ${tx} ${ty}" fill="none" stroke="#64748b" stroke-width="2" />`;
  }).join("");

  const grid = `
    <defs>
      <pattern id="wf-grid" width="20" height="20" patternUnits="userSpaceOnUse">
        <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(255,255,255,0.04)" stroke-width="0.5" />
      </pattern>
    </defs>
    <rect x="-5000" y="-5000" width="10000" height="10000" fill="url(#wf-grid)" />
  `;

  return `<svg class="wf-canvas-svg" id="wf-svg" viewBox="${vx} ${vy} ${1100 / zoom} ${600 / zoom}" xmlns="http://www.w3.org/2000/svg">${grid}${edgeSVGs}${nodeSVGs}</svg>`;
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
