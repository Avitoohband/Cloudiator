// Patch 1.9, Task 11b (Avi, 2026-11-11, with the approved "sleep straight on the bed" picture): a floating "ZzZ" over every
// sleeping gladiator in the camp (src/game/camp-scene.ts) and in the trip replay's Resting chapter (src/game/trip-camp-scene.ts).
// Three small pixel letters, a big Z, a small z and a big Z, rise from over the head and drift toward the feet, fading in at the
// head and out at the top, one every third of a cycle. Each letter is pixel art in the palette (the names' cream and outline)
// with its own 1 px outline, drawn at whole art pixels.
//
// The loop runs on the scene's own clock (the camp's display time, the replay chapter's elapsed time) with a phase fixed per
// actor (`zzzPhase`), so it is the same for every viewer, holds while the scene is paused and never moves in step with a
// neighbour's; with reduced motion the three letters hold still. They stay clear of the lying body (the sleep frames reach 16 px
// over the feet), and a sleeper's name sits SLEEP_NAME_LIFT over its feet, over the letters' whole climb, so nothing shifts as
// they rise. Positions are art px from the sleeper's feet (its station's tile centre, the sleep frames' own anchor); a
// sleeper facing south-west is mirrored, as its sprite is.
import type * as PhaserNS from 'phaser';
import { hashString } from './actors';

export type ZzzGlyph = 'Z' | 'z';
/** One letter as drawn now: its glyph, its box's left edge and bottom edge (art px from the feet), and its opacity. */
export type ZzzLetter = { glyph: ZzzGlyph; left: number; bottom: number; alpha: number };

/** One letter's life, from the head to the top; a new letter starts every third of it. */
export const ZZZ_CYCLE_MS = 3000;
/** The glyphs' fill, row by row ('#'); each is drawn with a 1 px outline around it, so it is 2 px wider and taller. */
const SHAPES: Record<ZzzGlyph, readonly string[]> = {
  Z: ['#####', '...#.', '..#..', '.#...', '#####'],
  z: ['####', '..#.', '.#..', '####'],
};
export const ZZZ_GLYPHS: Record<ZzzGlyph, { width: number; height: number }> = {
  Z: { width: SHAPES.Z[0].length + 2, height: SHAPES.Z.length + 2 },
  z: { width: SHAPES.z[0].length + 2, height: SHAPES.z.length + 2 },
};
/** The three letters, oldest first: the stream reads Z z Z. */
const ORDER: readonly ZzzGlyph[] = ['Z', 'z', 'Z'];
/** Where a letter is born: its centre over the head, its bottom edge one clear row over the body's top (16 px over the feet). */
const EMIT = { x: -1, bottom: -17 };
/** How far a letter climbs and drifts toward the feet over its life (art px): six rows between letters, so they never touch. */
const RISE = 18;
const DRIFT = 6;
/** A letter fades in over the first 15% of its life and out over the last 40%. */
const FADE_IN = 0.15;
const FADE_OUT = 0.4;
/** With reduced motion: the three letters held at a sixth, a half and five sixths of their climb, fully drawn. */
const STILL = [5 / 6, 1 / 2, 1 / 6];

/** The highest any letter's box reaches over the feet (art px, negative is up). */
export const ZZZ_TOP = EMIT.bottom - RISE - Math.max(ZZZ_GLYPHS.Z.height, ZZZ_GLYPHS.z.height);
/** A sleeper's name sits this far over its feet (its bottom edge): one clear row over the ZzZ's highest letter. */
export const SLEEP_NAME_LIFT = -ZZZ_TOP + 2;
/** The camp's and the trip camp's ZzZ draw over the evening light and the torch glows (2_000_001), under the names (2_000_002). */
export const ZZZ_DEPTH = 2_000_001.2;
/** The ZzZ texture's key in a scene's texture manager. */
export const ZZZ_TEXTURE = 'zzz';

/** An actor's fixed phase in the loop (ms), from its id. */
export function zzzPhase(id: string): number {
  return hashString(`zzz:${id}`) % ZZZ_CYCLE_MS;
}

/** One letter at `t` (0 to 1) of its life. */
function letterAt(glyph: ZzzGlyph, t: number, alpha: number, flip: boolean, out: ZzzLetter): ZzzLetter {
  const { width } = ZZZ_GLYPHS[glyph];
  const left = Math.floor(EMIT.x + DRIFT * t - width / 2);
  out.glyph = glyph;
  out.left = flip ? -left - width : left;
  out.bottom = Math.round(EMIT.bottom - RISE * t);
  out.alpha = alpha;
  return out;
}

/**
 * The three letters at `timeMs` on the scene's clock for an actor with loop phase `phaseMs`, oldest first. `flip` mirrors them
 * for a sleeper facing south-west; `reduced` holds them still. Fills and returns `out` (reused by the scenes every frame).
 */
export function zzzLetters(timeMs: number, phaseMs: number, flip: boolean, reduced: boolean, out: ZzzLetter[] = []): ZzzLetter[] {
  for (let k = 0; k < ORDER.length; k += 1) {
    const letter = out[k] ?? (out[k] = { glyph: 'Z', left: 0, bottom: 0, alpha: 0 });
    if (reduced) { letterAt(ORDER[k], STILL[k], 1, flip, letter); continue; }
    const local = (((timeMs + phaseMs - (k * ZZZ_CYCLE_MS) / ORDER.length) % ZZZ_CYCLE_MS) + ZZZ_CYCLE_MS) % ZZZ_CYCLE_MS;
    const t = local / ZZZ_CYCLE_MS;
    const alpha = t < FADE_IN ? t / FADE_IN : t > 1 - FADE_OUT ? (1 - t) / FADE_OUT : 1;
    letterAt(ORDER[k], t, Math.min(1, Math.max(0, alpha)), flip, letter);
  }
  out.length = ORDER.length;
  return out;
}

/** A glyph's pixels, row by row: its fill, the 1 px outline around it (diagonals too), or nothing. */
export function zzzPixels(glyph: ZzzGlyph): ('fill' | 'outline' | null)[] {
  const shape = SHAPES[glyph];
  const { width, height } = ZZZ_GLYPHS[glyph];
  const filled = (x: number, y: number) => shape[y - 1]?.[x - 1] === '#';
  const out: ('fill' | 'outline' | null)[] = [];
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    let near = false;
    for (let dy = -1; dy <= 1 && !near; dy += 1) for (let dx = -1; dx <= 1 && !near; dx += 1) near = filled(x + dx, y + dy);
    out.push(filled(x, y) ? 'fill' : near ? 'outline' : null);
  }
  return out;
}

/** Adds the ZzZ texture to `scene` once (both glyphs side by side, frames 'Z' and 'z'), in the palette's cream and outline. */
export function ensureZzzTexture(scene: PhaserNS.Scene, palette: Record<string, string>): void {
  if (scene.textures.exists(ZZZ_TEXTURE)) return;
  const canvas = document.createElement('canvas');
  canvas.width = ZZZ_GLYPHS.Z.width + ZZZ_GLYPHS.z.width;
  canvas.height = Math.max(ZZZ_GLYPHS.Z.height, ZZZ_GLYPHS.z.height);
  const g = canvas.getContext('2d')!;
  let x0 = 0;
  for (const glyph of ['Z', 'z'] as const) {
    const { width, height } = ZZZ_GLYPHS[glyph];
    zzzPixels(glyph).forEach((p, i) => {
      if (!p) return;
      g.fillStyle = p === 'fill' ? palette.canvas1 : palette.outline;
      g.fillRect(x0 + (i % width), Math.floor(i / width), 1, 1);
    });
    x0 += width;
  }
  const texture = scene.textures.addCanvas(ZZZ_TEXTURE, canvas)!;
  texture.add('Z', 0, 0, 0, ZZZ_GLYPHS.Z.width, ZZZ_GLYPHS.Z.height);
  texture.add('z', 0, ZZZ_GLYPHS.Z.width, 0, ZZZ_GLYPHS.z.width, ZZZ_GLYPHS.z.height);
}

/** One sleeper's three letter images, its phase, and the letters drawn last (reused every frame). */
export type ZzzSprites = { images: PhaserNS.GameObjects.Image[]; phase: number; letters: ZzzLetter[]; shown: boolean };

/** Three hidden letter images for the actor `id` (call `ensureZzzTexture` first). */
export function createZzz(scene: PhaserNS.Scene, id: string): ZzzSprites {
  const images = ORDER.map(glyph => scene.add.image(0, 0, ZZZ_TEXTURE, glyph).setOrigin(0, 1).setDepth(ZZZ_DEPTH).setVisible(false));
  return { images, phase: zzzPhase(id), letters: [], shown: false };
}

/** Draws the letters over feet `feet` (world px) at `timeMs`, or hides them (`shown` false). */
export function drawZzz(z: ZzzSprites, shown: boolean, feet: { x: number; y: number }, timeMs: number, flip: boolean, reduced: boolean): void {
  if (!shown) {
    if (z.shown) for (const image of z.images) image.setVisible(false);
    z.shown = false;
    return;
  }
  z.shown = true;
  zzzLetters(timeMs, z.phase, flip, reduced, z.letters);
  z.letters.forEach((l, i) => {
    const image = z.images[i];
    if (image.frame.name !== l.glyph) image.setFrame(l.glyph);
    image.setPosition(feet.x + l.left, feet.y + l.bottom);
    if (image.alpha !== l.alpha) image.setAlpha(l.alpha);
    const visible = l.alpha > 0;
    if (image.visible !== visible) image.setVisible(visible);
  });
}

/** The letters drawn now, as world-space boxes with their opacity (debug state for the browser tests); empty when hidden. */
export function zzzDebug(z: ZzzSprites | null | undefined): { glyph: ZzzGlyph; x: number; y: number; width: number; height: number; alpha: number }[] {
  if (!z?.shown) return [];
  return z.letters.flatMap((l, i) => {
    const image = z.images[i];
    if (!image.visible) return [];
    const { width, height } = ZZZ_GLYPHS[l.glyph];
    return [{ glyph: l.glyph, x: image.x, y: image.y - height, width, height, alpha: image.alpha }];
  });
}

export function destroyZzz(z: ZzzSprites | null | undefined): void {
  if (z) for (const image of z.images) image.destroy();
}
