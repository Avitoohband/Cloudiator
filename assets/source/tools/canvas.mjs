// Palette-locked pixel canvas and shape masks used by every generator.
// Shapes are painted with their own 1px outline so overlapping parts stay readable.
import { PALETTE, hexToRgba } from './palette.mjs';

const RGBA_CACHE = new Map();
function rgbaOf(name) {
  if (!RGBA_CACHE.has(name)) {
    const hex = PALETTE[name];
    if (!hex) throw new Error(`Unknown palette color: ${name}`);
    RGBA_CACHE.set(name, hexToRgba(hex));
  }
  return RGBA_CACHE.get(name);
}
const NAME_BY_KEY = new Map(Object.entries(PALETTE).map(([name, hex]) => [hex.toLowerCase(), name]));

export class Mask {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.bits = new Uint8Array(width * height);
  }
  inside(x, y) { return x >= 0 && y >= 0 && x < this.width && y < this.height; }
  add(x, y) { x = Math.round(x); y = Math.round(y); if (this.inside(x, y)) this.bits[y * this.width + x] = 1; return this; }
  remove(x, y) { if (this.inside(x, y)) this.bits[y * this.width + x] = 0; return this; }
  has(x, y) { return this.inside(x, y) && this.bits[y * this.width + x] === 1; }
  isEmpty() { return !this.bits.some(Boolean); }
  clone() { const m = new Mask(this.width, this.height); m.bits.set(this.bits); return m; }
  union(other) { for (let i = 0; i < this.bits.length; i += 1) this.bits[i] |= other.bits[i]; return this; }
  subtract(other) { for (let i = 0; i < this.bits.length; i += 1) if (other.bits[i]) this.bits[i] = 0; return this; }
  intersect(other) { for (let i = 0; i < this.bits.length; i += 1) this.bits[i] &= other.bits[i]; return this; }
  forEach(fn) {
    for (let y = 0; y < this.height; y += 1) for (let x = 0; x < this.width; x += 1) if (this.bits[y * this.width + x]) fn(x, y);
  }
  bounds() {
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    this.forEach((x, y) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); });
    return { minX, minY, maxX, maxY };
  }
  /** Grow by one pixel; diagonal=true uses 8-neighbourhood. */
  dilate(diagonal = false) {
    const out = this.clone();
    const n4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const n8 = [...n4, [1, 1], [1, -1], [-1, 1], [-1, -1]];
    this.forEach((x, y) => { for (const [dx, dy] of diagonal ? n8 : n4) out.add(x + dx, y + dy); });
    return out;
  }
  rect(x, y, w, h) {
    for (let yy = Math.round(y); yy < Math.round(y + h); yy += 1) for (let xx = Math.round(x); xx < Math.round(x + w); xx += 1) this.add(xx, yy);
    return this;
  }
  ellipse(cx, cy, rx, ry) {
    for (let y = Math.floor(cy - ry - 1); y <= Math.ceil(cy + ry + 1); y += 1) {
      for (let x = Math.floor(cx - rx - 1); x <= Math.ceil(cx + rx + 1); x += 1) {
        const dx = (x + 0.5 - cx) / rx;
        const dy = (y + 0.5 - cy) / ry;
        if (dx * dx + dy * dy <= 1) this.add(x, y);
      }
    }
    return this;
  }
  polygon(points) {
    const xs = points.map(p => p[0]);
    const ys = points.map(p => p[1]);
    for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y += 1) {
      for (let x = Math.floor(Math.min(...xs)); x <= Math.ceil(Math.max(...xs)); x += 1) {
        const px = x + 0.5;
        const py = y + 0.5;
        let inside = false;
        for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
          const [xi, yi] = points[i];
          const [xj, yj] = points[j];
          if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
        }
        if (inside) this.add(x, y);
      }
    }
    return this;
  }
  /** Line stamped with a square brush of the given thickness. */
  line(x0, y0, x1, y1, thickness = 1) {
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
    const offset = Math.floor((thickness - 1) / 2);
    for (let i = 0; i <= steps; i += 1) {
      const x = Math.round(x0 + ((x1 - x0) * i) / steps);
      const y = Math.round(y0 + ((y1 - y0) * i) / steps);
      for (let dy = 0; dy < thickness; dy += 1) for (let dx = 0; dx < thickness; dx += 1) this.add(x + dx - offset, y + dy - offset);
    }
    return this;
  }
  /** Tapered limb: thickness interpolates from t0 to t1. */
  limb(x0, y0, x1, y1, t0, t1) {
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
    for (let i = 0; i <= steps; i += 1) {
      const f = i / steps;
      const x = x0 + (x1 - x0) * f;
      const y = y0 + (y1 - y0) * f;
      const r = (t0 + (t1 - t0) * f) / 2;
      this.ellipse(x, y, Math.max(0.6, r), Math.max(0.6, r));
    }
    return this;
  }
  /** Mask of pixels within a quadratic curve band (used for bows, crescents, roofs). */
  curve(points, thickness = 1) {
    for (let i = 0; i < points.length - 1; i += 1) this.line(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1], thickness);
    return this;
  }
}

export class PixelCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
  }
  mask() { return new Mask(this.width, this.height); }
  inside(x, y) { return x >= 0 && y >= 0 && x < this.width && y < this.height; }
  set(x, y, name) {
    x = Math.round(x); y = Math.round(y);
    if (!this.inside(x, y)) return;
    this.data.set(rgbaOf(name), (y * this.width + x) * 4);
  }
  clearPixel(x, y) { if (this.inside(x, y)) this.data.fill(0, (y * this.width + x) * 4, (y * this.width + x) * 4 + 4); }
  get(x, y) {
    if (!this.inside(x, y)) return null;
    const i = (y * this.width + x) * 4;
    if (this.data[i + 3] === 0) return null;
    const hex = `#${[this.data[i], this.data[i + 1], this.data[i + 2]].map(v => v.toString(16).padStart(2, '0')).join('')}`;
    return NAME_BY_KEY.get(hex) ?? hex;
  }
  opaque(x, y) { return this.inside(x, y) && this.data[(y * this.width + x) * 4 + 3] > 0; }
  /** fill: palette name or (x, y, mask) => palette name | null */
  paint(mask, fill) {
    mask.forEach((x, y) => {
      const name = typeof fill === 'function' ? fill(x, y, mask) : fill;
      if (name) this.set(x, y, name);
    });
    return this;
  }
  /** Paint shape with its own outline ring first, so later shapes separate cleanly from earlier ones. */
  stamp(mask, fill, outline = 'outline', diagonal = false) {
    if (outline) this.paint(mask.dilate(diagonal).subtract(mask), outline);
    return this.paint(mask, fill);
  }
  /** Top-left light: highlight pixels on the lit rim, shade the far rim. */
  static shade(light, mid, dark, opts = {}) {
    const depth = opts.depth ?? 1;
    return (x, y, mask) => {
      if (!mask.has(x - 1, y) || !mask.has(x, y - 1)) return light;
      for (let d = 1; d <= depth; d += 1) if (!mask.has(x + d, y) || !mask.has(x, y + d)) return dark;
      return mid;
    };
  }
  blit(src, dx, dy, opts = {}) {
    for (let y = 0; y < src.height; y += 1) {
      for (let x = 0; x < src.width; x += 1) {
        const si = (y * src.width + x) * 4;
        if (src.data[si + 3] === 0) continue;
        const tx = dx + (opts.flipX ? src.width - 1 - x : x);
        const ty = dy + y;
        if (!this.inside(tx, ty)) continue;
        this.data.set(src.data.subarray(si, si + 4), (ty * this.width + tx) * 4);
      }
    }
    return this;
  }
  /** Copy a sub-rectangle into a new canvas. */
  crop(x, y, w, h) {
    const out = new PixelCanvas(w, h);
    for (let yy = 0; yy < h; yy += 1) {
      for (let xx = 0; xx < w; xx += 1) {
        if (!this.inside(x + xx, y + yy)) continue;
        const si = ((y + yy) * this.width + x + xx) * 4;
        out.data.set(this.data.subarray(si, si + 4), (yy * w + xx) * 4);
      }
    }
    return out;
  }
  /** Add a 1px outline around all opaque pixels (used for composed props). */
  outlineAll(name = 'outline', diagonal = false) {
    const m = this.mask();
    for (let y = 0; y < this.height; y += 1) for (let x = 0; x < this.width; x += 1) if (this.opaque(x, y)) m.add(x, y);
    this.paint(m.dilate(diagonal).subtract(m), name);
    return this;
  }
  opaqueMask() {
    const m = this.mask();
    for (let y = 0; y < this.height; y += 1) for (let x = 0; x < this.width; x += 1) if (this.opaque(x, y)) m.add(x, y);
    return m;
  }
  /** Erase pixels inside the mask. */
  erase(mask) { mask.forEach((x, y) => this.clearPixel(x, y)); return this; }
  isBlank() { for (let i = 3; i < this.data.length; i += 4) if (this.data[i]) return false; return true; }
}
