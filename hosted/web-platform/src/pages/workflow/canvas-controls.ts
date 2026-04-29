/**
 * Canvas controls — pan, zoom, pinch-to-zoom for the SVG workflow canvas.
 * Extracted from interactions.ts as a separate concern.
 */

import {
  getContainer,
  getViewX, getViewY, getZoom, setZoom, setViewX, setViewY,
  setSelectedNodeId,
} from "./state.js";
import { refreshSVG } from "./svg-renderer.js";
import { renderConfigPanel } from "./config-panel.js";
import { hideNodeActionPopover } from "./node-actions.js";

// --- State ---

interface PanState {
  startX: number;
  startY: number;
  viewX: number;
  viewY: number;
}

let _panState: PanState | null = null;
let _activePointers = new Map<number, PointerEvent>();
let _initialPinchDistance: number | null = null;
let _pinchZoomStart: number | null = null;
let _isTouchDevice = false;

/** Whether the device supports touch. */
export function isTouchDevice(): boolean { return _isTouchDevice; }

/** Wire pan, zoom, and pinch-to-zoom event handlers on the SVG canvas. */
export function wireCanvasControls(svg: SVGElement): void {
  svg.style.touchAction = "none";

  // --- Pan / background tap ---

  svg.addEventListener("pointerdown", (e: Event) => {
    const pe = e as PointerEvent;
    if (pe.pointerType === "touch") _isTouchDevice = true;

    // Track multi-touch for pinch zoom
    _activePointers.set(pe.pointerId, pe);

    if (_activePointers.size === 2) {
      // Start pinch — cancel any ongoing pan
      _panState = null;
      const pts = [..._activePointers.values()];
      _initialPinchDistance = Math.hypot(pts[1].clientX - pts[0].clientX, pts[1].clientY - pts[0].clientY);
      _pinchZoomStart = getZoom();
      return;
    }

    if (pe.target === svg || (pe.target as Element).tagName === "rect" ||
        (pe.target as Element).classList.contains("wf-grid-bg")) {
      pe.preventDefault();
      hideNodeActionPopover();

      // Click on background -> deselect (defer refreshSVG to avoid destroying SVG mid-gesture)
      if (pe.button === 0) {
        setSelectedNodeId(null);
        renderConfigPanel();
      }

      // Pan: left drag or middle drag on background
      if (pe.button === 0 || pe.button === 1) {
        _panState = { startX: pe.clientX, startY: pe.clientY, viewX: getViewX(), viewY: getViewY() };
        svg.setPointerCapture(pe.pointerId);

        const onPanMove = (ev: PointerEvent) => {
          if (!_panState) return;
          const zoom = getZoom();
          const dx = (ev.clientX - _panState.startX) / zoom;
          const dy = (ev.clientY - _panState.startY) / zoom;
          const vx = _panState.viewX - dx;
          const vy = _panState.viewY - dy;
          const svgEl = getContainer()?.querySelector("#wf-svg");
          if (svgEl) {
            svgEl.setAttribute("viewBox", `${vx} ${vy} ${1100 / zoom} ${600 / zoom}`);
          }
        };

        const onPanUp = (ev: PointerEvent) => {
          if (_panState) {
            const zoom = getZoom();
            const dx = (ev.clientX - _panState.startX) / zoom;
            const dy = (ev.clientY - _panState.startY) / zoom;
            setViewX(_panState.viewX - dx);
            setViewY(_panState.viewY - dy);
          }
          _panState = null;
          svg.removeEventListener("pointermove", onPanMove);
          svg.removeEventListener("pointerup", onPanUp);
          refreshSVG();
        };

        svg.addEventListener("pointermove", onPanMove);
        svg.addEventListener("pointerup", onPanUp);
      }
    }
  });

  // --- Multi-touch release ---

  svg.addEventListener("pointerup", (e: Event) => {
    const pe = e as PointerEvent;
    _activePointers.delete(pe.pointerId);
    if (_activePointers.size < 2) {
      _initialPinchDistance = null;
      _pinchZoomStart = null;
    }
  });

  // --- Pinch-to-zoom ---

  svg.addEventListener("pointermove", (e: Event) => {
    const pe = e as PointerEvent;
    _activePointers.set(pe.pointerId, pe);

    if (_activePointers.size === 2 && _initialPinchDistance != null && _pinchZoomStart != null) {
      pe.preventDefault();
      const pts = [..._activePointers.values()];
      const dist = Math.hypot(pts[1].clientX - pts[0].clientX, pts[1].clientY - pts[0].clientY);
      if (dist < 1) return;
      const ratio = dist / _initialPinchDistance;
      const newZoom = Math.max(0.3, Math.min(3, _pinchZoomStart * ratio));
      setZoom(newZoom);
      const svgEl = getContainer()?.querySelector("#wf-svg");
      if (svgEl) {
        svgEl.setAttribute("viewBox", `${getViewX()} ${getViewY()} ${1100 / newZoom} ${600 / newZoom}`);
      }
    }
  });

  // --- Mouse wheel zoom ---

  svg.addEventListener("wheel", (e: Event) => {
    e.preventDefault();
    const we = e as WheelEvent;
    const delta = we.deltaY > 0 ? 0.9 : 1.1;
    const newZoom = Math.max(0.3, Math.min(3, getZoom() * delta));
    setZoom(newZoom);
    svg.setAttribute("viewBox", `${getViewX()} ${getViewY()} ${1100 / newZoom} ${600 / newZoom}`);
  }, { passive: false });

  // Mark SVG with touch flag for CSS targeting
  if (_isTouchDevice) {
    svg.setAttribute("data-touch", "true");
  }
}

/** Reset canvas control state (called from page.destroy). */
export function resetCanvasControls(): void {
  _panState = null;
  _activePointers.clear();
  _initialPinchDistance = null;
  _pinchZoomStart = null;
}
