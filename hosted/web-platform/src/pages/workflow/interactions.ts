/**
 * SVG interactions — node drag, edge drag, keyboard delete.
 * Pointer events (mouse + touch + pen) with long-press tap detection.
 * Canvas controls (pan, zoom, pinch) live in canvas-controls.ts.
 */

import { NODE_W, NODE_H } from "./constants.js";
import {
  getContainer, getWorkflow, getSelectedNodeId,
  getViewX, getViewY, getZoom,
  setDirty, autoSave, nanoid, setSelectedNodeId,
} from "./state.js";
import { getNodeDef } from "./node-defs.js";
import { refreshSVG, updateEdgesForNode } from "./svg-renderer.js";
import { renderConfigPanel } from "./config-panel.js";
import { showNodeActionPopover, hideNodeActionPopover } from "./node-actions.js";
import { wireCanvasControls, resetCanvasControls, isTouchDevice as _isTouchDeviceFn } from "./canvas-controls.js";

// Re-export for consumers
export { isTouchDevice } from "./canvas-controls.js";

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

let _dragState: DragState | null = null;
let _edgeState: EdgeState | null = null;

// --- Touch / pointer state (node interaction) ---

let _longPressTimer: ReturnType<typeof setTimeout> | null = null;
let _longPressNodeId: string | null = null;
let _pointerStartX = 0;
let _pointerStartY = 0;
let _pointerMoved = false;
let _docMoveHandler: ((e: PointerEvent) => void) | null = null;
let _docUpHandler: ((e: PointerEvent) => void) | null = null;

const LONG_PRESS_MS = 500;
const TAP_THRESHOLD_PX = 8;

// --- SVG event wiring ---

export function wireSVGEvents(): void {
  const svg = getContainer()?.querySelector("#wf-svg") as SVGElement | null;
  if (!svg) return;

  // Clean up previous document-level listeners
  if (_docMoveHandler) document.removeEventListener("pointermove", _docMoveHandler);
  if (_docUpHandler) document.removeEventListener("pointerup", _docUpHandler);

  // Wire canvas controls (pan, zoom, pinch)
  wireCanvasControls(svg);

  // Node pointerdown -> select, drag, or long-press
  svg.querySelectorAll(".wf-node").forEach(g => {
    g.addEventListener("pointerdown", (e: Event) => {
      const pe = e as PointerEvent;
      const nodeId = (g as Element).getAttribute("data-id")!;
      const target = pe.target as Element;

      // Port drag (edge creation)
      if (target.classList.contains("wf-port-out")) {
        pe.preventDefault();
        pe.stopPropagation();
        startEdgeDrag(pe, nodeId, svg);
        return;
      }

      // Menu button
      if (target.classList.contains("wf-node-menu-btn") || target.closest(".wf-node-menu-btn")) {
        pe.preventDefault();
        pe.stopPropagation();
        showNodeActionPopover(nodeId);
        return;
      }

      // Don't drag from input port
      if (target.classList.contains("wf-port-in")) {
        pe.preventDefault();
        return;
      }

      pe.preventDefault();

      // Track for tap vs long-press vs drag
      _pointerStartX = pe.clientX;
      _pointerStartY = pe.clientY;
      _pointerMoved = false;
      _longPressNodeId = nodeId;

      if (pe.pointerType === "touch") {
        // Touch: require long-press (500ms) to start drag, tap to select
        _longPressTimer = setTimeout(() => {
          if (_pointerMoved) return;
          _longPressTimer = null;
          _longPressNodeId = null;
          startNodeDrag(_pointerStartX, _pointerStartY, nodeId);
        }, LONG_PRESS_MS);
      } else {
        // Mouse/pen: immediate drag on pointerdown
        setSelectedNodeId(nodeId);
        renderConfigPanel();
        refreshSVG();
        startNodeDrag(pe.clientX, pe.clientY, nodeId);
        _longPressNodeId = null;
      }
    });
  });

  // Node pointermove — detect drag intent on touch (transition from waiting to dragging)
  const onPointerMove = (pe: PointerEvent) => {
    if (_longPressTimer != null && _longPressNodeId != null) {
      const dx = pe.clientX - _pointerStartX;
      const dy = pe.clientY - _pointerStartY;
      if (Math.abs(dx) > TAP_THRESHOLD_PX || Math.abs(dy) > TAP_THRESHOLD_PX) {
        _pointerMoved = true;
        clearTimeout(_longPressTimer);
        _longPressTimer = null;
        const nodeId = _longPressNodeId;
        _longPressNodeId = null;
        // Movement detected — start drag immediately
        startNodeDrag(_pointerStartX, _pointerStartY, nodeId);
      }
    }
  };
  _docMoveHandler = onPointerMove;
  document.addEventListener("pointermove", onPointerMove);

  // Node pointerup — tap detection (touch only, mouse already handled)
  const onPointerUp = (pe: PointerEvent) => {
    if (_longPressTimer != null) {
      clearTimeout(_longPressTimer);
      _longPressTimer = null;

      if (!_pointerMoved && _longPressNodeId) {
        // Short tap — select node + show popover
        const nodeId = _longPressNodeId;
        _longPressNodeId = null;
        setSelectedNodeId(nodeId);
        renderConfigPanel();
        refreshSVG();
        showNodeActionPopover(nodeId);
      }
      _longPressNodeId = null;
    }
  };
  _docUpHandler = onPointerUp;
  document.addEventListener("pointerup", onPointerUp);

  // Edge click -> delete
  svg.querySelectorAll(".wf-edge").forEach(path => {
    path.addEventListener("pointerup", (e: Event) => {
      const pe = e as PointerEvent;
      // Only respond to quick taps, not drags
      if (_pointerMoved) return;
      const workflow = getWorkflow();
      if (!workflow) return;
      const id = (path as Element).getAttribute("data-id")!;
      workflow.edges = workflow.edges.filter(e => e.id !== id);
      setDirty(true);
      autoSave();
      refreshSVG();
    });
  });
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
    hideNodeActionPopover();
    setDirty(true);
    autoSave();
    refreshSVG();
    renderConfigPanel();
  }
}

// --- Node drag ---

function startNodeDrag(startX: number, startY: number, nodeId: string): void {
  const workflow = getWorkflow();
  if (!workflow) return;
  const node = workflow.nodes.find(n => n.id === nodeId);
  if (!node) return;
  _dragState = {
    nodeId,
    startX,
    startY,
    nodeStartX: node.positionX,
    nodeStartY: node.positionY,
  };

  const onMove = (e: PointerEvent) => {
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
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    refreshSVG();
  };

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
}

// --- Edge drag ---

function startEdgeDrag(pe: PointerEvent, sourceNodeId: string, svg: SVGElement): void {
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

  const onMove = (e: PointerEvent) => {
    if (!_edgeState) return;
    const rect = svg.getBoundingClientRect();
    const zoom = getZoom();
    const mx = getViewX() + (e.clientX - rect.left) / rect.width * (1100 / zoom);
    const my = getViewY() + (e.clientY - rect.top) / rect.height * (600 / zoom);
    _edgeState.tempLine.setAttribute("x2", String(mx));
    _edgeState.tempLine.setAttribute("y2", String(my));
  };

  const onUp = (e: PointerEvent) => {
    if (_edgeState?.tempLine.parentNode) {
      _edgeState.tempLine.parentNode.removeChild(_edgeState.tempLine);
    }

    const rect = svg.getBoundingClientRect();
    const zoom = getZoom();
    const mx = getViewX() + (e.clientX - rect.left) / rect.width * (1100 / zoom);
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
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
  };

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
}

/** Reset interaction state (called from page.destroy). */
export function resetInteractions(): void {
  _dragState = null;
  _edgeState = null;
  if (_longPressTimer) clearTimeout(_longPressTimer);
  _longPressTimer = null;
  _longPressNodeId = null;
  resetCanvasControls();
}
