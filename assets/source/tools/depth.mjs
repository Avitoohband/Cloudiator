// Painter's-order depth for props, shared by the offline renderers. src/game/depth.ts mirrors
// this logic for the game and tests/assets checks the two agree.
// Actors sort at the screen y of their feet; slices and one-tile props sort half a pixel earlier so
// actors win ties.

export const SLICE_WIDTH = 32;
export const TIE_BIAS = 0.5;

/** Screen y (relative to the anchor) of a W x D footprint's front edge at horizontal offset `u`. */
export function frontEdgeY({ w, d }, u) {
  const clamped = Math.min(32 * w, Math.max(-32 * d, u));
  const south = 32 * (w - d);
  return clamped <= south ? 16 * d + (clamped + 32 * d) / 2 : 16 * (w + d) - (clamped - south) / 2;
}

export function needsSlices({ w, d }, layer) {
  return layer === 'object' && w + d > 2;
}

/** 32px slices covering [imageLeft, imageLeft + imageWidth) relative to the anchor. */
export function propSlices(footprint, imageLeft, imageWidth) {
  const slices = [];
  const first = Math.floor((imageLeft + SLICE_WIDTH / 2) / SLICE_WIDTH);
  const last = Math.ceil((imageLeft + imageWidth - SLICE_WIDTH / 2) / SLICE_WIDTH);
  for (let k = first; k <= last; k += 1) {
    const left = Math.max(imageLeft, k * SLICE_WIDTH - SLICE_WIDTH / 2);
    const right = Math.min(imageLeft + imageWidth, k * SLICE_WIDTH + SLICE_WIDTH / 2);
    if (right > left) slices.push({ left, width: right - left, depthOffset: frontEdgeY(footprint, k * SLICE_WIDTH) - TIE_BIAS });
  }
  return slices;
}

const FLOOR = -1_000_000;
const FOREGROUND = 1_000_000;

/**
 * How to draw one placed prop: a list of horizontal ranges (relative to the anchor) and their
 * depth offsets from the anchor's screen y. Floor and foreground props use large offsets.
 */
export function drawSlices(prop, frame) {
  const whole = depthOffset => [{ left: -frame.anchorX, width: frame.w, depthOffset }];
  if (prop.layer === 'floor') return whole(FLOOR);
  if (prop.layer === 'foreground') return whole(FOREGROUND);
  if (prop.slices?.length) return prop.slices;
  if (needsSlices({ w: prop.w, d: prop.d }, prop.layer)) return propSlices({ w: prop.w, d: prop.d }, -frame.anchorX, frame.w);
  return whole(prop.sortY - TIE_BIAS);
}
