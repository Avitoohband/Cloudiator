// Painter's-order depth for props. A single sort key cannot be right for both an actor in front of
// a tent's face and one behind it, so wide props draw as 32px vertical slices, each sorted at the
// footprint's front edge under it; arena wall segments ship explicit slices from the generator.
// Actors stand on tile centres, which fall exactly on slice centres. Slices sort half a pixel
// earlier than the edge so an actor exactly on the edge line draws in front (actors win ties).
// Mirrors assets/source/tools/depth.mjs (used by the offline renderers); tests check they agree.

export const SLICE_WIDTH = 32;
export const TIE_BIAS = 0.5;
const FLOOR = -1_000_000;
const FOREGROUND = 1_000_000;

export type PropFootprint = { w: number; d: number };
/** Horizontal range relative to the prop anchor, sorted at anchor screen y + depthOffset. */
export type DepthSlice = { left: number; width: number; depthOffset: number };
export type SliceableProp = { w: number; d: number; layer: 'floor' | 'object' | 'foreground'; sortY: number; slices?: DepthSlice[] };

/** Screen y (relative to the anchor) of the footprint's front edge at horizontal offset `u`. */
export function frontEdgeY(footprint: PropFootprint, u: number): number {
  const { w, d } = footprint;
  const clamped = Math.min(32 * w, Math.max(-32 * d, u));
  const south = 32 * (w - d);
  return clamped <= south ? 16 * d + (clamped + 32 * d) / 2 : 16 * (w + d) - (clamped - south) / 2;
}

/** True when a prop needs slicing (more than one tile in either direction). */
export function needsSlices(footprint: PropFootprint, layer: string): boolean {
  return layer === 'object' && footprint.w + footprint.d > 2;
}

/** Slices covering an image spanning [imageLeft, imageLeft + imageWidth) relative to the anchor. */
export function propSlices(footprint: PropFootprint, imageLeft: number, imageWidth: number): DepthSlice[] {
  const slices: DepthSlice[] = [];
  const first = Math.floor((imageLeft + SLICE_WIDTH / 2) / SLICE_WIDTH);
  const last = Math.ceil((imageLeft + imageWidth - SLICE_WIDTH / 2) / SLICE_WIDTH);
  for (let k = first; k <= last; k += 1) {
    const centre = k * SLICE_WIDTH;
    const left = Math.max(imageLeft, centre - SLICE_WIDTH / 2);
    const right = Math.min(imageLeft + imageWidth, centre + SLICE_WIDTH / 2);
    if (right > left) slices.push({ left, width: right - left, depthOffset: frontEdgeY(footprint, centre) - TIE_BIAS });
  }
  return slices;
}

/** Ranges and depth offsets for drawing one placed prop (floor/foreground use large offsets). */
export function drawSlices(prop: SliceableProp, frame: { w: number; anchorX: number }): DepthSlice[] {
  const whole = (depthOffset: number): DepthSlice[] => [{ left: -frame.anchorX, width: frame.w, depthOffset }];
  if (prop.layer === 'floor') return whole(FLOOR);
  if (prop.layer === 'foreground') return whole(FOREGROUND);
  if (prop.slices?.length) return prop.slices;
  if (needsSlices(prop, prop.layer)) return propSlices(prop, -frame.anchorX, frame.w);
  return whole(prop.sortY);
}

/** Points relative to an actor's feet that stand for its visible body (a 64px frame, anchor 32,58). */
export const BODY_SAMPLES: readonly { dx: number; dy: number }[] = [-5, 0, 5].flatMap(dx => [-38, -30, -22, -14, -6].map(dy => ({ dx, dy })));

/** A placed prop image in screen space, with its drawn slices as absolute column ranges and sort depths. */
export type PlacedImage = { left: number; top: number; width: number; height: number; slices: { x0: number; x1: number; depth: number }[] };

/**
 * True when an opaque pixel of the prop, in a slice drawn after the actor, covers part of the actor's
 * body. `alphaAt` reads the prop frame's alpha at image-local pixel coordinates.
 */
export function hidesActor(prop: PlacedImage, alphaAt: (x: number, y: number) => number, feet: { x: number; y: number }): boolean {
  for (const { dx, dy } of BODY_SAMPLES) {
    const x = Math.floor(feet.x + dx);
    const y = Math.floor(feet.y + dy);
    if (x < prop.left || x >= prop.left + prop.width || y < prop.top || y >= prop.top + prop.height) continue;
    const slice = prop.slices.find(s => x >= s.x0 && x < s.x1);
    if (slice && slice.depth > feet.y && alphaAt(x - prop.left, y - prop.top) > 0) return true;
  }
  return false;
}
