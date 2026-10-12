// Painter's-order depth for props wider than one tile. A single sort key cannot be right for
// both an actor standing in front of a tent's left face and one standing behind it, so wide
// props are drawn as 32px vertical slices, each sorted at the footprint's front edge under it.
// Actors stand on tile centres, which fall exactly on slice centres (multiples of 32px).

export const SLICE_WIDTH = 32;

export type PropFootprint = { w: number; d: number };
/** Slice in screen pixels relative to the prop anchor (north vertex of its first tile). */
export type DepthSlice = { left: number; width: number; depthOffset: number };

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

/**
 * Slices covering an image that spans [imageLeft, imageLeft + imageWidth) relative to the anchor.
 * Slice edges sit halfway between actor columns so each actor column falls inside one slice.
 */
export function propSlices(footprint: PropFootprint, imageLeft: number, imageWidth: number): DepthSlice[] {
  const slices: DepthSlice[] = [];
  const first = Math.floor((imageLeft + SLICE_WIDTH / 2) / SLICE_WIDTH);
  const last = Math.ceil((imageLeft + imageWidth - SLICE_WIDTH / 2) / SLICE_WIDTH);
  for (let k = first; k <= last; k += 1) {
    const centre = k * SLICE_WIDTH;
    const left = Math.max(imageLeft, centre - SLICE_WIDTH / 2);
    const right = Math.min(imageLeft + imageWidth, centre + SLICE_WIDTH / 2);
    if (right > left) slices.push({ left, width: right - left, depthOffset: frontEdgeY(footprint, centre) });
  }
  return slices;
}
