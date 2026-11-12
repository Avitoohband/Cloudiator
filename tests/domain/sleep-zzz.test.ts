// Patch 1.9, Task 11b (Avi, 2026-11-11): a floating "ZzZ" over every sleeping gladiator in the camp and in the trip replay's
// Resting chapter: small pixel letters (a big Z, a small z, a big Z) rising from the head and fading, in a loop. The loop runs
// on the scene's own clock with a phase fixed per actor, so it is the same for everyone, holds when the scene is paused and never
// moves in step with a neighbour's; with reduced motion it holds still. The letters stay clear of the lying body, and the name
// sits over their whole climb, so nothing shifts as they rise.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { decodePng } from '../../assets/source/tools/png.mjs';
import { loadAssetManifest } from '@/game/assets';
import { NAME_LABEL_STYLE } from '@/game/map-layer';
import {
  SLEEP_NAME_LIFT, ZZZ_CYCLE_MS, ZZZ_FADE_MS, ZZZ_GLYPHS, ZZZ_TEXTURE, ZZZ_TOP, drawZzz, ensureZzzTexture, zzzDebug, zzzLetters, zzzPhase, zzzPixels,
  type ZzzLetter, type ZzzSprites,
} from '@/game/sleep-zzz';

const STEP = 10;
const times = Array.from({ length: ZZZ_CYCLE_MS / STEP }, (_, i) => i * STEP);
const box = (l: ZzzLetter) => ({ left: l.left, right: l.left + ZZZ_GLYPHS[l.glyph].width, top: l.bottom - ZZZ_GLYPHS[l.glyph].height, bottom: l.bottom });

describe('the ZzZ letters', () => {
  it('are three, a big Z, a small z and a big Z, at whole art pixels', () => {
    for (const t of times) {
      const letters = zzzLetters(t, 0, false, false);
      expect(letters.map(l => l.glyph)).toEqual(['Z', 'z', 'Z']);
      for (const l of letters) {
        expect(Number.isInteger(l.left) && Number.isInteger(l.bottom), `${t}`).toBe(true);
        expect(l.alpha).toBeGreaterThanOrEqual(0);
        expect(l.alpha).toBeLessThanOrEqual(1);
      }
    }
  });

  it('loop: each letter rises and drifts toward the feet over its life, fading in at the head and out at the top', () => {
    expect(zzzLetters(1234, 0, false, false)).toEqual(zzzLetters(1234 + ZZZ_CYCLE_MS, 0, false, false));
    expect(zzzLetters(-500, 0, false, false)).toEqual(zzzLetters(ZZZ_CYCLE_MS - 500, 0, false, false));
    // Follow the first letter through one life: born invisible at the head, then up and to the right, then gone.
    const life = times.map(t => zzzLetters(t, 0, false, false)[0]);
    expect(life[0].alpha).toBe(0);
    expect(Math.max(...life.map(l => l.alpha))).toBe(1);
    expect(life.at(-1)!.alpha).toBeLessThan(0.05);
    for (let i = 1; i < life.length; i += 1) {
      expect(life[i].bottom, `${times[i]}`).toBeLessThanOrEqual(life[i - 1].bottom);
      expect(life[i].left, `${times[i]}`).toBeGreaterThanOrEqual(life[i - 1].left);
    }
    expect(life[0].bottom - life.at(-1)!.bottom).toBeGreaterThanOrEqual(15);
    // The three are a third of a life apart: one is always near the head, one halfway, one near the top.
    const now = zzzLetters(0, 0, false, false).map(l => l.bottom).sort((a, b) => a - b);
    expect(now[1] - now[0]).toBeGreaterThanOrEqual(5);
    expect(now[2] - now[1]).toBeGreaterThanOrEqual(5);
  });

  it('are deterministic per actor, out of step between actors, and depend only on the clock given (a paused scene holds them)', () => {
    expect(zzzPhase('glad-1')).toBe(zzzPhase('glad-1'));
    const phases = new Set(Array.from({ length: 12 }, (_, i) => zzzPhase(`glad-${i}`)));
    expect(phases.size).toBeGreaterThan(8);
    for (const p of phases) { expect(p).toBeGreaterThanOrEqual(0); expect(p).toBeLessThan(ZZZ_CYCLE_MS); }
    const phase = zzzPhase('glad-3');
    expect(zzzLetters(4000, phase, false, false)).toEqual(zzzLetters(4000, phase, false, false));
    // Task 21 (it compared a call with itself): the clock and the phase only add up, so another actor shows at 4000 ms what this one
    // shows its phase difference later, and nothing but the clock given moves them.
    const other = zzzPhase('glad-4'), lead = other - phase;
    expect(lead).not.toBe(0);
    expect(zzzLetters(4000 + lead, phase, false, false)).toEqual(zzzLetters(4000, other, false, false));
    expect(zzzLetters(4000, zzzPhase('glad-3'), false, false)).not.toEqual(zzzLetters(4000, zzzPhase('glad-4'), false, false));
  });

  it('mirror with a sleeper facing south-west', () => {
    for (const t of [0, 700, 1900]) {
      const se = zzzLetters(t, 0, false, false);
      const sw = zzzLetters(t, 0, true, false);
      sw.forEach((l, i) => expect({ ...l, left: -l.left - ZZZ_GLYPHS[l.glyph].width }).toEqual(se[i]));
    }
  });

  it('hold still, fully drawn, with reduced motion', () => {
    const still = zzzLetters(0, 0, false, true);
    expect(still.map(l => l.alpha)).toEqual([1, 1, 1]);
    for (const t of [1, 999, 2500, 77_777]) expect(zzzLetters(t, zzzPhase('x'), false, true)).toEqual(still);
    // Read top-down they spell "ZzZ".
    expect([...still].sort((a, b) => a.bottom - b.bottom).map(l => l.glyph).join('')).toBe('ZzZ');
  });

  it('never cover one another', () => {
    for (const t of times) {
      const boxes = zzzLetters(t, 0, false, false).filter(l => l.alpha > 0).map(box);
      for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) {
        // Their fills (inside the 1 px outline) never overlap; the outlines may touch.
        const [a, b] = [boxes[i], boxes[j]];
        const overlap = a.left + 1 < b.right - 1 && b.left + 1 < a.right - 1 && a.top + 1 < b.bottom - 1 && b.top + 1 < a.bottom - 1;
        expect(overlap, `${t}: letters ${i} and ${j}`).toBe(false);
      }
    }
  });
});

describe('the ZzZ pixel glyphs', () => {
  it('are a 5 px Z and a 4 px z in the palette, each with its own 1 px outline', () => {
    expect([ZZZ_GLYPHS.Z.width, ZZZ_GLYPHS.Z.height]).toEqual([7, 7]);
    expect([ZZZ_GLYPHS.z.width, ZZZ_GLYPHS.z.height]).toEqual([6, 6]);
    const manifest = loadAssetManifest();
    for (const glyph of ['Z', 'z'] as const) {
      const { width, height } = ZZZ_GLYPHS[glyph];
      const px = zzzPixels(glyph);
      expect(px).toHaveLength(width * height);
      const at = (x: number, y: number) => (x < 0 || y < 0 || x >= width || y >= height ? null : px[y * width + x]);
      for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
        const p = at(x, y);
        if (p === 'fill') for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) expect(at(x + dx, y + dy), `${glyph} ${x},${y}`).not.toBeNull();
        if (p === 'outline') expect([[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]].some(([dx, dy]) => at(x + dx, y + dy) === 'fill'), `${glyph} ${x},${y}`).toBe(true);
      }
      expect(px.filter(p => p === 'fill').length).toBeGreaterThanOrEqual(glyph === 'Z' ? 13 : 10);
    }
    // The colours are the palette's (the same cream and outline as the camp's names).
    expect(manifest.palette.canvas1).toBeDefined();
    expect(manifest.palette.outline).toBeDefined();
    expect([NAME_LABEL_STYLE.color, NAME_LABEL_STYLE.stroke]).toEqual([manifest.palette.canvas1, manifest.palette.outline]);
  });

  it('are drawn by ensureZzzTexture pixel by pixel in those colours: the fill cream, the outline dark (Task 21)', () => {
    const { palette } = loadAssetManifest();
    const painted: { colour: string; x: number; y: number }[] = [];
    const context = { fillStyle: '', fillRect(x: number, y: number, w: number, h: number) { expect([w, h]).toEqual([1, 1]); painted.push({ colour: this.fillStyle, x, y }); } };
    const canvas = { width: 0, height: 0, getContext: (kind: string) => (kind === '2d' ? context : null) };
    const frames: [string, number, number, number, number, number][] = [];
    const scene = { textures: { exists: () => false, addCanvas: (key: string, source: unknown) => {
      expect([key, source]).toEqual([ZZZ_TEXTURE, canvas]);
      return { add: (...frame: [string, number, number, number, number, number]) => { frames.push(frame); } };
    } } };
    vi.stubGlobal('document', { createElement: (tag: string) => { expect(tag).toBe('canvas'); return canvas; } });
    try { ensureZzzTexture(scene as never, palette); } finally { vi.unstubAllGlobals(); }
    // Both glyphs side by side, every pixel the shape names in its colour, and nothing else painted.
    const expected: typeof painted = [];
    let x0 = 0;
    for (const glyph of ['Z', 'z'] as const) {
      const { width } = ZZZ_GLYPHS[glyph];
      zzzPixels(glyph).forEach((p, i) => { if (p) expected.push({ colour: p === 'fill' ? palette.canvas1 : palette.outline, x: x0 + (i % width), y: Math.floor(i / width) }); });
      x0 += width;
    }
    expect(painted).toEqual(expected);
    expect(new Set(painted.map(p => p.colour))).toEqual(new Set([palette.canvas1, palette.outline]));
    expect([canvas.width, canvas.height]).toEqual([ZZZ_GLYPHS.Z.width + ZZZ_GLYPHS.z.width, ZZZ_GLYPHS.Z.height]);
    expect(frames).toEqual([['Z', 0, 0, 0, ZZZ_GLYPHS.Z.width, ZZZ_GLYPHS.Z.height], ['z', 0, ZZZ_GLYPHS.Z.width, 0, ZZZ_GLYPHS.z.width, ZZZ_GLYPHS.z.height]]);
  });
});

describe('a sleeper who gets up (Task 21)', () => {
  /** Three stand-in letter images that keep what the scene sets on them. */
  const sprites = (id = 'glad-7'): ZzzSprites => {
    const images = ['Z', 'z', 'Z'].map(glyph => {
      const image = { frame: { name: glyph }, x: 0, y: 0, alpha: 1, visible: false,
        setFrame(name: string) { image.frame = { name }; return image; }, setPosition(x: number, y: number) { image.x = x; image.y = y; return image; },
        setAlpha(a: number) { image.alpha = a; return image; }, setVisible(v: boolean) { image.visible = v; return image; } };
      return image;
    });
    return { images: images as never, phase: zzzPhase(id), letters: [], shown: false, fade: null };
  };
  const bed = { x: 300, y: 500 };
  const drawnNow = (z: ZzzSprites) => zzzDebug(z).map(({ glyph, x, y, alpha }) => ({ glyph, x, y, alpha }));

  it('fades the letters out over the time they fade at the top (FADE_OUT of a cycle), where they were, then hides them', () => {
    expect(ZZZ_FADE_MS).toBe(1200);
    const z = sprites();
    drawZzz(z, true, bed, 10_000, true, false);
    const asleep = drawnNow(z);
    expect(asleep.length).toBeGreaterThan(0);
    // Up, and already walking off: the letters stay over the bed, keep rising and fade from where they were.
    drawZzz(z, false, { x: 340, y: 520 }, 10_000, false, false);
    expect(drawnNow(z)).toEqual(asleep);
    for (const elapsed of [300, 600, 900, 1_150]) {
      drawZzz(z, false, { x: 400, y: 560 }, 10_000 + elapsed, false, false);
      const own = zzzLetters(10_000 + elapsed, z.phase, true, false);
      const shown = drawnNow(z);
      expect(shown, `${elapsed} ms`).toEqual(own.flatMap(l => {
        const alpha = l.alpha * (1 - elapsed / ZZZ_FADE_MS);
        return alpha > 0 ? [{ glyph: l.glyph, x: bed.x + l.left, y: bed.y + l.bottom - ZZZ_GLYPHS[l.glyph].height, alpha: expect.closeTo(alpha, 6) }] : [];
      }));
    }
    drawZzz(z, false, bed, 10_000 + ZZZ_FADE_MS, false, false);
    expect(drawnNow(z)).toEqual([]);
    expect(z.images.every(image => !image.visible)).toBe(true);
    // Lying down again shows them whole at once.
    drawZzz(z, true, bed, 20_000, true, false);
    expect(drawnNow(z).length).toBeGreaterThan(0);
  });

  it('hides them at once with reduced motion, and when the scene\'s clock goes back (a replay seeks or leaves the chapter)', () => {
    const still = sprites();
    drawZzz(still, true, bed, 10_000, false, true);
    expect(drawnNow(still)).toHaveLength(3);
    drawZzz(still, false, bed, 10_000, false, true);
    expect(drawnNow(still)).toEqual([]);
    expect(still.images.every(image => !image.visible)).toBe(true);
    const z = sprites();
    drawZzz(z, true, bed, 10_000, false, false);
    drawZzz(z, false, bed, 10_200, false, false);
    expect(drawnNow(z).length).toBeGreaterThan(0);
    drawZzz(z, false, { x: 0, y: 0 }, 0, false, false);
    expect(drawnNow(z)).toEqual([]);
    // A fade under way stops when motion is reduced.
    drawZzz(z, true, bed, 30_000, false, false);
    drawZzz(z, false, bed, 30_100, false, false);
    drawZzz(z, false, bed, 30_200, false, true);
    expect(drawnNow(z)).toEqual([]);
  });
});

describe('where the ZzZ sits', () => {
  const manifest = loadAssetManifest();
  const gladiator = manifest.actors.gladiator;
  const atlas = manifest.atlases[gladiator.atlas];
  const image = decodePng(readFileSync(join(__dirname, '..', '..', 'public', 'assets', atlas.image)));

  it('stays clear of the lying body in every layer and both sleep frames, facing either way', () => {
    // Every opaque pixel of every sleep frame, relative to the frame's own anchor (the sleeper's feet).
    const body: { x: number; y: number }[] = [];
    for (const name of Object.keys(atlas.frames).filter(n => /\/sleep\/se\/\d$/.test(n))) {
      const f = atlas.frames[name];
      for (let y = 0; y < f.h; y += 1) for (let x = 0; x < f.w; x += 1) {
        if (image.rgba[((f.y + y) * image.width + f.x + x) * 4 + 3]) body.push({ x: x - f.anchorX, y: y - f.anchorY });
      }
    }
    expect(body.length).toBeGreaterThan(1000);
    for (const flip of [false, true]) for (const t of times) {
      for (const l of zzzLetters(t, 0, flip, false)) {
        if (l.alpha === 0) continue;
        const b = box(l);
        const hit = body.find(p => (flip ? -p.x : p.x) >= b.left && (flip ? -p.x : p.x) < b.right && p.y >= b.top - 1 && p.y < b.bottom + 1);
        expect(hit, `${flip ? 'sw' : 'se'} ${t}: ${l.glyph} at ${l.left},${l.bottom}`).toBeUndefined();
      }
    }
  });

  it('rises from over the head (its first column of body pixels) and keeps under the name', () => {
    expect(ZZZ_TOP).toBe(Math.min(...times.flatMap(t => [false, true].flatMap(flip => zzzLetters(t, 0, flip, false).map(l => box(l).top))), ...zzzLetters(0, 0, false, true).map(l => box(l).top)));
    // The name's bottom edge sits SLEEP_NAME_LIFT over the feet, with one clear row over the highest letter.
    expect(SLEEP_NAME_LIFT).toBe(-ZZZ_TOP + 2);
    expect(SLEEP_NAME_LIFT).toBeLessThanOrEqual(46);
    const start = zzzLetters(0, 0, false, false)[0];
    expect(box(start).left).toBeLessThan(2);
    expect(box(start).right).toBeGreaterThan(-6);
  });
});
