// Renderer-independent camera rules: zoom limits, bounds clamping and pointer-anchored zoom.
// The Phaser scene mirrors this state with camera.centerOn(centerX, centerY) and setZoom(zoom).
import type { Point, Rect } from './iso';

export type ViewState = { centerX: number; centerY: number; zoom: number; viewWidth: number; viewHeight: number };

export const ZOOM_LIMITS = { min: 0.5, max: 3 } as const;
export const ZOOM_STEP = 1.25;

/**
 * Pointer travel (CSS px) up to which a press is a click; further is a drag. The camp scene (which selects what was
 * clicked) and the shell (which closes its menus on a camp click) share it, so a press is a click for both or neither.
 */
export const CLICK_TRAVEL_PX = 6;
/** Whether a press that travelled (dx, dy) between down and up is a click rather than a drag. */
export const isClick = (dx: number, dy: number) => Math.hypot(dx, dy) <= CLICK_TRAVEL_PX;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(ZOOM_LIMITS.max, Math.max(ZOOM_LIMITS.min, zoom));
}

/** Zoom levels are powers of ZOOM_STEP; snap to the nearest level, then move `steps` levels. */
export function stepZoom(zoom: number, steps: number): number {
  const level = Math.round(Math.log(clampZoom(zoom)) / Math.log(ZOOM_STEP));
  return clampZoom(ZOOM_STEP ** (level + steps));
}

function clampAxis(center: number, half: number, min: number, size: number): number {
  if (half * 2 >= size) return min + size / 2;
  return Math.min(min + size - half, Math.max(min + half, center));
}

/** Keep the visible world rectangle inside bounds; centre the map when it is smaller than the view. */
export function clampView(view: ViewState, bounds: Rect): ViewState {
  const zoom = clampZoom(view.zoom);
  const halfW = view.viewWidth / 2 / zoom;
  const halfH = view.viewHeight / 2 / zoom;
  return {
    ...view,
    zoom,
    centerX: clampAxis(view.centerX, halfW, bounds.x, bounds.width),
    centerY: clampAxis(view.centerY, halfH, bounds.y, bounds.height),
  };
}

/** Multiply zoom by `factor`, keeping the world point under the screen `anchor` fixed. */
export function zoomAround(view: ViewState, factor: number, anchor: Point, bounds: Rect): ViewState {
  const zoom = clampZoom(view.zoom * factor);
  const dx = anchor.x - view.viewWidth / 2;
  const dy = anchor.y - view.viewHeight / 2;
  const worldX = view.centerX + dx / view.zoom;
  const worldY = view.centerY + dy / view.zoom;
  return clampView({ ...view, zoom, centerX: worldX - dx / zoom, centerY: worldY - dy / zoom }, bounds);
}

/** Pan by a screen-space drag delta. */
export function panBy(view: ViewState, dxScreen: number, dyScreen: number, bounds: Rect): ViewState {
  return clampView({ ...view, centerX: view.centerX - dxScreen / view.zoom, centerY: view.centerY - dyScreen / view.zoom }, bounds);
}
