/**
 * Mini editor interactions — pan, zoom, node drag, edge drag, edge deletion, keyboard delete.
 * Parameterized via MiniEditorState interface so it doesn't depend on singleton state.
 * Reads viewBox dimensions from the SVG element at runtime (no hardcoded base dimensions).
 */

import { NODE_W, NODE_H } from "../pages/workflow/constants.js";
import type { WorkflowDetail, WorkflowNodeDef, WorkflowEdgeDef } from "../core/api-client.js";
import { getNodeDef } from "../pages/workflow/node-defs.js";

export interface MiniEditorState {
  getWorkflow: () => WorkflowDetail | null;
  getSelectedNodeId: () => string | null;
  setSelectedNodeId: (id: string | null) => void;
  getViewBox: () => { x: number; y: number; zoom: number };
  setViewBox: (v: { x: number; y: number; zoom: number }) => void;
  markDirty: () => void;
  render: () => void;
  renderConfig: () => void;
}

interface DragState {
  nodeId: string;
  startX: number;
  startY: number;
  nodeStartX: number;
  nodeStartY: number;
}

interface EdgeDragState {
  sourceNodeId: string;
  tempLine: SVGLineElement;
}

interface PanState {
  startX: number;
  startY: number;
  viewX: number;
  viewY: number;
}

let _dragState: DragState | null = null;
let _edgeState: EdgeDragState | null = null;
let _panState: PanState | null = null;

/** Parse the viewBox attribute of the SVG element into {x, y, w, h}. */
function parseSVGViewBox(svg: SVGElement): { x: number; y: number; w: number; h: number } {
  const vb = svg.getAttribute("viewBox");
  if (!vb) return { x: 0, y: 0, w: 900, h: 600 };
  const parts = vb.split(/[\s,]+/).map(Number);
  return { x: parts[0] ?? 0, y: parts[1] ?? 0, w: parts[2] ?? 900, h: parts[3] ?? 600 };
}

/** Convert screen coordinates to SVG coordinates using the current viewBox. */
function screenToSVG(svg: SVGElement, clientX: number, clientY: number): { x: number; y: number } {
  const rect = svg.getBoundingClientRect();
  const vb = parseSVGViewBox(svg);
  return {
    x: vb.x + (clientX - rect.left) / rect.width * vb.w,
    y: vb.y + (clientY - rect.top) / rect.height * vb.h,
  };
}

/** Wire all SVG interaction events on the mini editor canvas. */
export function wireMiniInteractions(
  canvas: HTMLElement,
  state: MiniEditorState,
): () => void {
  const docHandlers: Array<[string, EventListener]> = [];

  function addDocEvt(event: string, fn: EventListener) {
    document.addEventListener(event, fn);
    docHandlers.push([event, fn]);
  }

  // --- SVG event wiring (called after each render) ---
  function wireSVG() {
    const svg = canvas.querySelector(".wf-canvas-svg") as SVGElement | null;
    if (!svg) return;

    // Remove old svg-specific listeners by replacing clone
    const clone = svg.cloneNode(true) as SVGElement;
    svg.parentNode!.replaceChild(clone, svg);

    // Node mousedown
    clone.querySelectorAll(".wf-node").forEach(g => {
      g.addEventListener("mousedown", (e: Event) => {
        const me = e as MouseEvent;
        const nodeId = (g as Element).getAttribute("data-id")!;
        const target = me.target as Element;

        // Port drag (edge creation)
        if (target.classList.contains("wf-port-out")) {
          me.preventDefault();
          me.stopPropagation();
          startEdgeDrag(me, nodeId, clone, state);
          return;
        }

        // Select node
        state.setSelectedNodeId(state.getSelectedNodeId() === nodeId ? null : nodeId);
        state.renderConfig();

        // Node drag (unless clicking port)
        if (!target.classList.contains("wf-port-in")) {
          startNodeDrag(me, nodeId, state);
        }
      });
    });

    // Edge click -> delete
    clone.querySelectorAll(".wf-edge").forEach(path => {
      path.addEventListener("click", (e: Event) => {
        e.stopPropagation();
        const wf = state.getWorkflow();
        if (!wf) return;
        const id = (path as Element).getAttribute("data-id")!;
        wf.edges = wf.edges.filter(ed => ed.id !== id);
        state.markDirty();
        state.render();
      });
    });

    // Canvas pan (middle click or ctrl+drag on background)
    clone.addEventListener("mousedown", (e: Event) => {
      const me = e as MouseEvent;
      if (me.target === clone || (me.target as Element).tagName === "rect") {
        if (me.button === 1 || me.ctrlKey || me.metaKey) {
          e.preventDefault();
          const vb = state.getViewBox();
          _panState = { startX: me.clientX, startY: me.clientY, viewX: vb.x, viewY: vb.y };
        } else {
          // Click background -> deselect
          state.setSelectedNodeId(null);
          state.renderConfig();
          state.render();
        }
      }
    });

    // Zoom — scale the viewBox dimensions around the cursor point
    clone.addEventListener("wheel", (e: Event) => {
      e.preventDefault();
      const we = e as WheelEvent;
      const vb = parseSVGViewBox(clone);
      const delta = we.deltaY > 0 ? 1.1 : 0.9; // zoom out/in
      const newW = vb.w * delta;
      const newH = vb.h * delta;
      // Zoom towards cursor
      const rect = clone.getBoundingClientRect();
      const cx = (we.clientX - rect.left) / rect.width;
      const cy = (we.clientY - rect.top) / rect.height;
      const newX = vb.x + (vb.w - newW) * cx;
      const newY = vb.y + (vb.h - newH) * cy;
      clone.setAttribute("viewBox", `${newX} ${newY} ${newW} ${newH}`);
      // Update state zoom (ratio relative to initial fit)
      const initialW = (canvas as any).__initialVbW ?? vb.w;
      state.setViewBox({ x: newX, y: newY, zoom: initialW / newW });
    }, { passive: false });
  }

  // --- Document-level move/up handlers (shared for drag, edge, pan) ---

  const onMouseMove = (e: MouseEvent) => {
    if (_dragState) {
      const wf = state.getWorkflow();
      if (!wf) return;
      const svg = canvas.querySelector(".wf-canvas-svg");
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const vb = parseSVGViewBox(svg as SVGElement);
      // Convert screen pixel delta to SVG unit delta
      const scale = vb.w / rect.width;
      const dx = (e.clientX - _dragState.startX) * scale;
      const dy = (e.clientY - _dragState.startY) * scale;
      const n = wf.nodes.find(nd => nd.id === _dragState!.nodeId);
      if (n) {
        n.positionX = Math.round(_dragState.nodeStartX + dx);
        n.positionY = Math.round(_dragState.nodeStartY + dy);
        state.markDirty();
        const g = svg.querySelector(`[data-id="${_dragState.nodeId}"]`);
        if (g) {
          g.setAttribute("transform", `translate(${n.positionX}, ${n.positionY})`);
          updateMiniEdges(svg, n, wf.edges, wf.nodes);
        }
      }
      return;
    }

    if (_edgeState) {
      const svg = canvas.querySelector(".wf-canvas-svg") as SVGElement | null;
      if (!svg) return;
      const pt = screenToSVG(svg, e.clientX, e.clientY);
      _edgeState.tempLine.setAttribute("x2", String(pt.x));
      _edgeState.tempLine.setAttribute("y2", String(pt.y));
      return;
    }

    if (_panState) {
      const svg = canvas.querySelector(".wf-canvas-svg") as SVGElement | null;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const vb = parseSVGViewBox(svg);
      const scale = vb.w / rect.width;
      const dx = (e.clientX - _panState.startX) * scale;
      const dy = (e.clientY - _panState.startY) * scale;
      const newX = _panState.viewX - dx;
      const newY = _panState.viewY - dy;
      state.setViewBox({ x: newX, y: newY, zoom: state.getViewBox().zoom });
      svg.setAttribute("viewBox", `${newX} ${newY} ${vb.w} ${vb.h}`);
      return;
    }
  };

  const onMouseUp = (e: MouseEvent) => {
    if (_dragState) {
      _dragState = null;
      state.render();
      return;
    }

    if (_edgeState) {
      if (_edgeState.tempLine.parentNode) {
        _edgeState.tempLine.parentNode.removeChild(_edgeState.tempLine);
      }
      const wf = state.getWorkflow();
      const svg = canvas.querySelector(".wf-canvas-svg") as SVGElement | null;
      if (svg && wf) {
        const pt = screenToSVG(svg, e.clientX, e.clientY);
        const target = wf.nodes.find(n =>
          pt.x >= n.positionX && pt.x <= n.positionX + NODE_W &&
          pt.y >= n.positionY && pt.y <= n.positionY + NODE_H &&
          n.id !== _edgeState!.sourceNodeId
        );
        if (target) {
          const sourceNode = wf.nodes.find(n => n.id === _edgeState!.sourceNodeId);
          const sourceDef = sourceNode ? getNodeDef(sourceNode.type) : null;
          const targetDef = getNodeDef(target.type);
          const allowedDirect = sourceDef ? sourceDef.allowedTargets.includes(target.type) : false;
          const allowedBySinkRole = sourceDef && targetDef && targetDef.role === "sink" && sourceDef.allowedTargets.includes("<sink>");
          const allowedByTriggerRole = sourceDef && targetDef && targetDef.role === "trigger" && sourceDef.allowedTargets.includes("<trigger>");
          if (allowedDirect || allowedBySinkRole || allowedByTriggerRole) {
            const exists = wf.edges.some(ed =>
              ed.sourceNodeId === _edgeState!.sourceNodeId && ed.targetNodeId === target.id
            );
            if (!exists) {
              wf.edges.push({
                id: `e_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
                sourceNodeId: _edgeState!.sourceNodeId,
                targetNodeId: target.id,
              });
              state.markDirty();
              state.render();
            }
          }
        }
      }
      _edgeState = null;
      return;
    }

    if (_panState) {
      _panState = null;
      state.render();
      return;
    }
  };

  // Keyboard delete
  const onKeyDown = (e: KeyboardEvent) => {
    const selectedId = state.getSelectedNodeId();
    const wf = state.getWorkflow();
    if ((e.key === "Delete" || e.key === "Backspace") && selectedId && wf) {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      e.preventDefault();
      wf.nodes = wf.nodes.filter(n => n.id !== selectedId);
      wf.edges = wf.edges.filter(ed => ed.sourceNodeId !== selectedId && ed.targetNodeId !== selectedId);
      state.setSelectedNodeId(null);
      state.markDirty();
      state.render();
      state.renderConfig();
    }
  };

  addDocEvt("mousemove", onMouseMove as EventListener);
  addDocEvt("mouseup", onMouseUp as EventListener);
  addDocEvt("keydown", onKeyDown as EventListener);

  // Store wireSVG for re-call after renders
  (canvas as any).__wireMiniSVG = wireSVG;

  // Initial wire
  wireSVG();

  // Return cleanup function
  return () => {
    _dragState = null;
    _edgeState = null;
    _panState = null;
    for (const [event, fn] of docHandlers) {
      document.removeEventListener(event, fn);
    }
    delete (canvas as any).__wireMiniSVG;
  };
}

/** Re-wire SVG events after a render. */
export function rewireMiniSVG(canvas: HTMLElement): void {
  const fn = (canvas as any).__wireMiniSVG as (() => void) | undefined;
  if (fn) fn();
}

// --- Internal helpers ---

function startNodeDrag(me: MouseEvent, nodeId: string, state: MiniEditorState): void {
  const wf = state.getWorkflow();
  if (!wf) return;
  const node = wf.nodes.find(n => n.id === nodeId);
  if (!node) return;
  _dragState = {
    nodeId,
    startX: me.clientX,
    startY: me.clientY,
    nodeStartX: node.positionX,
    nodeStartY: node.positionY,
  };
}

function startEdgeDrag(me: MouseEvent, sourceNodeId: string, svg: SVGElement, state: MiniEditorState): void {
  const wf = state.getWorkflow();
  const source = wf?.nodes.find(n => n.id === sourceNodeId);
  if (!source) return;

  const sx = source.positionX + NODE_W;
  const sy = source.positionY + NODE_H / 2;

  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", String(sx));
  line.setAttribute("y1", String(sy));
  line.setAttribute("x2", String(sx));
  line.setAttribute("y2", String(sy));
  line.setAttribute("stroke", "#94a3b3");
  line.setAttribute("stroke-width", "2");
  line.setAttribute("stroke-dasharray", "4");
  svg.appendChild(line);

  _edgeState = { sourceNodeId, tempLine: line };
}

function updateMiniEdges(svgEl: Element, node: WorkflowNodeDef, edges: WorkflowEdgeDef[], nodes: WorkflowNodeDef[]): void {
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
