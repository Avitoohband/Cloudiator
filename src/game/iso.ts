// Isometric projection shared by every scene: tile (x, y) north vertex sits at
// screen ((x - y) * 32, (x + y) * 16). Actors stand at tile centres (x + 0.5, y + 0.5).
export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; width: number; height: number };

export const TILE_WIDTH = 64;
export const TILE_HEIGHT = 32;
const HALF_W = TILE_WIDTH / 2;
const HALF_H = TILE_HEIGHT / 2;

export function worldToScreen(x: number, y: number): Point {
  return { x: (x - y) * HALF_W, y: (x + y) * HALF_H };
}

export function screenToWorld(x: number, y: number): Point {
  const a = x / HALF_W;
  const b = y / HALF_H;
  return { x: (a + b) / 2, y: (b - a) / 2 };
}

/** Screen-space bounding box of a width x height tile map diamond. */
export function mapScreenBounds(width: number, height: number): Rect {
  return { x: -height * HALF_W, y: 0, width: (width + height) * HALF_W, height: (width + height) * HALF_H };
}

/** Screen position of a tile centre. */
export function tileCentre(x: number, y: number): Point {
  return worldToScreen(x + 0.5, y + 0.5);
}
