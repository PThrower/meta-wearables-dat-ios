/**
 * SVG interactions — node drag, edge drag, pan, zoom, keyboard delete.
 */

import { NODE_W, NODE_H } from "./constants.js";
import {
  getContainer, getWorkflow, getSelectedNodeId,
  getViewX, getViewY, getZoom, setZoom,
  setDirty, autoSave, nanoid, setSelectedNodeId,
} from "./state.js";
import { getNodeDef } from "./node-defs.js";
import { refreshSVG, updateEdgesForNode } from "./svg-renderer.js";
import { renderConfigPanel } from "./config-panel.js";

// --- Drag state ---

interface DragState {
  nodeId: string;
  startX: number;
  startY: number;
  nodeStartX: number;
  nodeStartY: number;
}

interface EdgeState {
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
let _edgeState: EdgeState | null = null;
let _panState: PanState | null = null;

// --- SVG event wiring ---

export function wireSVGEvents(): void {
  const svg = getContainer()?.querySelector("#wf-svg") as SVGElement | null;
  if (!svg) return;

  // Node click -> select
  svg.querySelectorAll(".wf-node").forEach(g => {
    g.addEventListener("mousedown", (e: Event) => {
      const me = e as MouseEvent;
      const nodeId = (g as Element).getAttribute("data-id")!;
      const target = me.target as Element;

      // Port drag (edge creation)
      if (target.classList.contains("wf-port-out")) {
        startEdgeDrag(me, nodeId, svg);
        return;
      }

      setSelectedNodeId(nodeId);
      renderConfigPanel();
      refreshSVG();

      // Node drag (unless clicking port)
      if (!target.classList.contains("wf-port-in")) {
        startNodeDrag(me, nodeId);
      }
    });
  });

  // Edge click -> delete
  svg.querySelectorAll(".wf-edge").forEach(path => {
    path.addEventListener("click", () => {
      const workflow = getWorkflow();
      if (!workflow) return;
      const id = (path as Element).getAttribute("data-id")!;
      workflow.edges = workflow.edges.filter(e => e.id !== id);
      setDirty(true);
      autoSave();
      refreshSVG();
    });
  });

  // Canvas pan (middle click or ctrl+drag on background)
  svg.addEventListener("mousedown", (e: Event) => {
    const me = e as MouseEvent;
    if (me.target === svg || (me.target as Element).tagName === "rect") {
      if (me.button === 1 || me.ctrlKey || me.metaKey) {
        e.preventDefault();
        _panState = { startX: me.clientX, startY: me.clientY, viewX: getViewX(), viewY: getViewY() };
      } else {
        // Click on background -> deselect
        setSelectedNodeId(null);
        renderConfigPanel();
        refreshSVG();
      }
    }
  });

  // Zoom
  svg.addEventListener("wheel", (e: Event) => {
    e.preventDefault();
    const we = e as WheelEvent;
    const delta = we.deltaY > 0 ? 0.9 : 1.1;
    const newZoom = Math.max(0.3, Math.min(3, getZoom() * delta));
    setZoom(newZoom);
    svg.setAttribute("viewBox", `${getViewX()} ${getViewY()} ${900 / newZoom} ${600 / newZoom}`);
  }, { passive: false });
}

// --- Keyboard ---

export function onKeyDown(e: KeyboardEvent): void {
  const selectedId = getSelectedNodeId();
  const workflow = getWorkflow();
  if ((e.key === "Delete" || e.key === "Backspace") && selectedId && workflow) {
    if ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "TEXTAREA") return;
    e.preventDefault();
    workflow.nodes = workflow.nodes.filter(n => n.id !== selectedId);
    workflow.edges = workflow.edges.filter(e => e.sourceNodeId !== selectedId && e.targetNodeId !== selectedId);
    setSelectedNodeId(null);
    setDirty(true);
    autoSave();
    refreshSVG();
    renderConfigPanel();
  }
}

// --- Node drag ---

function startNodeDrag(me: MouseEvent, nodeId: string): void {
  const workflow = getWorkflow();
  if (!workflow) return;
  const node = workflow.nodes.find(n => n.id === nodeId);
  if (!node) return;
  _dragState = {
    nodeId,
    startX: me.clientX,
    startY: me.clientY,
    nodeStartX: node.positionX,
    nodeStartY: node.positionY,
  };

  const onMove = (e: MouseEvent) => {
    if (!_dragState) return;
    const wf = getWorkflow();
    if (!wf) return;
    const zoom = getZoom();
    const dx = (e.clientX - _dragState.startX) / zoom;
    const dy = (e.clientY - _dragState.startY) / zoom;
    const n = wf.nodes.find(n => n.id === _dragState!.nodeId);
    if (n) {
      n.positionX = Math.round(_dragState.nodeStartX + dx);
      n.positionY = Math.round(_dragState.nodeStartY + dy);
      setDirty(true);
      autoSave();
      const svgEl = getContainer()?.querySelector("#wf-svg");
      const g = svgEl?.querySelector(`[data-id="${_dragState.nodeId}"]`);
      if (g) {
        g.setAttribute("transform", `translate(${n.positionX}, ${n.positionY})`);
        updateEdgesForNode(svgEl!, n, wf.edges, wf.nodes);
      }
    }
  };

  const onUp = () => {
    _dragState = null;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    refreshSVG();
  };

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

// --- Edge drag ---

function startEdgeDrag(me: MouseEvent, sourceNodeId: string, svg: SVGElement): void {
  const workflow = getWorkflow();
  const source = workflow?.nodes.find(n => n.id === sourceNodeId);
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

  const onMove = (e: MouseEvent) => {
    if (!_edgeState) return;
    const rect = svg.getBoundingClientRect();
    const zoom = getZoom();
    const mx = getViewX() + (e.clientX - rect.left) / rect.width * (900 / zoom);
    const my = getViewY() + (e.clientY - rect.top) / rect.height * (600 / zoom);
    _edgeState.tempLine.setAttribute("x2", String(mx));
    _edgeState.tempLine.setAttribute("y2", String(my));
  };

  const onUp = (e: MouseEvent) => {
    if (_edgeState?.tempLine.parentNode) {
      _edgeState.tempLine.parentNode.removeChild(_edgeState.tempLine);
    }

    const rect = svg.getBoundingClientRect();
    const zoom = getZoom();
    const mx = getViewX() + (e.clientX - rect.left) / rect.width * (900 / zoom);
    const my = getViewY() + (e.clientY - rect.top) / rect.height * (600 / zoom);
    const target = workflow?.nodes.find(n =>
      mx >= n.positionX && mx <= n.positionX + NODE_W &&
      my >= n.positionY && my <= n.positionY + NODE_H &&
      n.id !== _edgeState!.sourceNodeId
    );

    if (target && workflow) {
      const sourceNode = workflow.nodes.find(n => n.id === _edgeState!.sourceNodeId);
      const sourceDef = sourceNode ? getNodeDef(sourceNode.type) : null;
      const targetDef = getNodeDef(target.type);
      const allowedDirect = sourceDef ? sourceDef.allowedTargets.includes(target.type) : false;
      const allowedBySinkRole = sourceDef && targetDef && targetDef.role === "sink" && sourceDef.allowedTargets.includes("<sink>");
      const allowedByTriggerRole = sourceDef && targetDef && targetDef.role === "trigger" && sourceDef.allowedTargets.includes("<trigger>");
      const allowedBySourceRole = sourceDef && targetDef && targetDef.role === "source" && sourceDef.allowedTargets.includes("<source>");
      if (!allowedDirect && !allowedBySinkRole && !allowedByTriggerRole && !allowedBySourceRole) { _edgeState = null; return; }

      const exists = workflow.edges.some(e =>
        e.sourceNodeId === _edgeState!.sourceNodeId && e.targetNodeId === target.id
      );
      if (!exists) {
        workflow.edges.push({
          id: nanoid(),
          sourceNodeId: _edgeState!.sourceNodeId,
          targetNodeId: target.id,
        });
        setDirty(true);
        autoSave();
        refreshSVG();
      }
    }

    _edgeState = null;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

/** Reset interaction state (called from page.destroy). */
export function resetInteractions(): void {
  _dragState = null;
  _edgeState = null;
  _panState = null;
}
