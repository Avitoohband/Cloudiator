// Packs named frames into a sheet. Fixed-size frames go on a grid (actors, tiles);
// variable-size frames use shelf packing (props, icons). Output is deterministic.
import { PixelCanvas } from './canvas.mjs';

/**
 * @param {{ name: string, canvas: PixelCanvas, anchorX: number, anchorY: number }[]} frames
 * @param {{ columns?: number, padding?: number, maxWidth?: number }} opts
 */
export function packAtlas(frames, opts = {}) {
  const padding = opts.padding ?? 0;
  const uniform = frames.every(f => f.canvas.width === frames[0].canvas.width && f.canvas.height === frames[0].canvas.height);
  const placements = [];
  let width = 0;
  let height = 0;
  if (uniform) {
    const fw = frames[0].canvas.width;
    const fh = frames[0].canvas.height;
    const columns = opts.columns ?? Math.max(1, Math.min(frames.length, Math.floor((opts.maxWidth ?? 2048) / (fw + padding))));
    frames.forEach((f, i) => {
      const x = (i % columns) * (fw + padding);
      const y = Math.floor(i / columns) * (fh + padding);
      placements.push({ f, x, y });
    });
    width = Math.min(frames.length, columns) * (fw + padding) - padding;
    height = Math.ceil(frames.length / columns) * (fh + padding) - padding;
  } else {
    const maxWidth = opts.maxWidth ?? 1024;
    let x = 0;
    let y = 0;
    let shelf = 0;
    for (const f of frames) {
      if (x > 0 && x + f.canvas.width > maxWidth) { x = 0; y += shelf + padding; shelf = 0; }
      placements.push({ f, x, y });
      x += f.canvas.width + padding;
      shelf = Math.max(shelf, f.canvas.height);
      width = Math.max(width, x - padding);
    }
    height = y + shelf;
  }
  const sheet = new PixelCanvas(width, height);
  const out = {};
  for (const { f, x, y } of placements) {
    sheet.blit(f.canvas, x, y);
    out[f.name] = { x, y, w: f.canvas.width, h: f.canvas.height, anchorX: f.anchorX, anchorY: f.anchorY };
  }
  return { sheet, frames: out };
}

/** Phaser JSON-hash atlas document with an extra ground-contact anchor per frame. */
export function phaserAtlasJson(image, sheet, frames) {
  return {
    frames: Object.fromEntries(Object.entries(frames).map(([name, r]) => [name, {
      frame: { x: r.x, y: r.y, w: r.w, h: r.h },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: r.w, h: r.h },
      sourceSize: { w: r.w, h: r.h },
      // Phaser reads `anchor` or `pivot` as a normalized origin, so the pixel anchor lives in `anchorPx`.
      pivot: { x: r.anchorX / r.w, y: r.anchorY / r.h },
      anchorPx: { x: r.anchorX, y: r.anchorY },
    }])),
    meta: { app: 'cloudiator assets/source/build-assets.mjs', image, format: 'RGBA8888', size: { w: sheet.width, h: sheet.height }, scale: '1' },
  };
}
