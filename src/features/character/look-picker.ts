// The look step of the creation dialog (gladiator appearance, Task 6): the pure rules behind the picker and its live preview.
// The preview draws what the camp draws for a gladiator with no gear (`lookFor`), cropped from the same atlas and tinted the same way.
import type { CSSProperties } from 'react';
import {
  BODIES, CLOTH_COLOURS, HAIRS, HAIR_COLOURS, SKIN_TONES, randomAppearance, validAppearance, type Appearance, type BodyId, type HairId, type Swatch,
} from '@domain/appearance';
import rawManifest from '../../../public/assets/manifest.json';
import { lookFor } from '../../game/actors';

declare global {
  interface Window { __cloudiatorLookRandom?: () => number }
}
/**
 * The generator behind "a random look" (the dialog's opening look, a version-1 draft's look and the Random look button): Math.random.
 * Fixture builds only (NEXT_PUBLIC_FIXTURE_ENABLED, like the other browser-test hooks): a test may pin it with
 * `window.__cloudiatorLookRandom`, so the look it opens with is known (pinning Math.random itself would break the Phaser camp).
 */
export function lookRandom(): number {
  if (process.env.NEXT_PUBLIC_FIXTURE_ENABLED === 'true' && typeof window !== 'undefined' && window.__cloudiatorLookRandom) return window.__cloudiatorLookRandom();
  return Math.random();
}

/** The idle loop of the preview: four frames facing south-east, 260 ms each, as in the approved mockup. */
export const PREVIEW_FRAME_COUNT = 4;
export const PREVIEW_FRAME_MS = 260;
/** Art pixels to screen pixels: a whole number, so the pixel art stays sharp. */
export const PREVIEW_SCALE = 3;
/** Where the art's anchor (the feet) is, in a 64 px frame; the same as every actor (manifest `actors.gladiator.anchor`). */
export const PREVIEW_ANCHOR = { x: 32, y: 58 } as const;

export const BODY_NAMES: Record<BodyId, string> = { male: 'Male', female: 'Female' };
export const HAIR_NAMES: Record<HairId, string> = { short: 'Short', long: 'Long', ponytail: 'Ponytail', bald: 'Bald' };
export const BODY_OPTIONS: readonly BodyId[] = BODIES;
export const HAIR_OPTIONS: readonly HairId[] = HAIRS;

/** The three colour groups, by the key of the stored appearance they set. */
export type ColourGroup = 'skin' | 'hairColor' | 'cloth';
const GROUPS: Record<ColourGroup, { title: string; palette: readonly Swatch[] }> = {
  skin: { title: 'Skin tone', palette: SKIN_TONES },
  hairColor: { title: 'Hair colour', palette: HAIR_COLOURS },
  cloth: { title: 'Clothes colour', palette: CLOTH_COLOURS },
};
/** The dominant skin shade of the body art (palette `skin2`): a skin tone is multiplied over it, so a swatch is shown the same way. */
const SKIN_BASE = 0xe0a273;

const lower = (text: string) => text.toLowerCase();
/** A tint as a CSS colour: `0x22a39d` is `#22a39d`. */
export const hexColour = (value: number) => `#${(value & 0xffffff).toString(16).padStart(6, '0')}`;
const hex = hexColour;

/** What a screen reader hears for the decorative preview: "Female, ponytail, olive skin, red hair, teal clothes". Bald shows no hair colour. */
export function lookSummary(look: Appearance): string {
  const hair = look.hair === 'bald' ? 'bald' : look.hair === 'ponytail' ? 'ponytail' : `${look.hair} hair`;
  const parts = [BODY_NAMES[look.body], hair, `${lower(SKIN_TONES[look.skin].name)} skin`];
  if (look.hair !== 'bald') parts.push(`${lower(HAIR_COLOURS[look.hairColor].name)} hair`);
  parts.push(`${lower(CLOTH_COLOURS[look.cloth].name)} clothes`);
  return parts.join(', ');
}

/** Each colour group's label, naming the current choice: "Skin tone · Olive". */
export function groupLabels(look: Appearance): Record<ColourGroup, string> {
  const label = (group: ColourGroup) => `${GROUPS[group].title} · ${GROUPS[group].palette[look[group]].name}`;
  return { skin: label('skin'), hairColor: label('hairColor'), cloth: label('cloth') };
}

/** A swatch's accessible name: "Skin tone Olive". */
export const swatchName = (group: ColourGroup, index: number) => `${GROUPS[group].title} ${GROUPS[group].palette[index].name}`;

/** The colour a swatch is drawn in. Hair and clothes show their tint; a skin tone is shown over the base skin, so Light is not white. */
export function swatchColour(group: ColourGroup, tint: number): string {
  if (group !== 'skin') return hex(tint);
  const channel = (shift: number) => Math.round((((SKIN_BASE >> shift) & 0xff) * ((tint >> shift) & 0xff)) / 255);
  return hex((channel(16) << 16) | (channel(8) << 8) | channel(0));
}

/** The swatches of one group, in palette order: the index it sets, its accessible name and the colour it is drawn in. */
export function swatchesOf(group: ColourGroup): { index: number; name: string; label: string; colour: string }[] {
  return GROUPS[group].palette.map(({ name, tint }, index) => ({ index, name, label: swatchName(group, index), colour: swatchColour(group, tint) }));
}

/** The look with one field changed; a value the options do not allow leaves the look as it was. */
export function choose<K extends keyof Appearance>(look: Appearance, key: K, value: Appearance[K]): Appearance {
  const next = { ...look, [key]: value };
  return validAppearance(next) ? next : look;
}

/** "Random look": a valid look that differs from the current one (the generator is asked a few times, then one field is flipped). */
export function rerollLook(current: Appearance, random: () => number): Appearance {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const next = randomAppearance(random);
    if ((Object.keys(next) as (keyof Appearance)[]).some(key => next[key] !== current[key])) return next;
  }
  return choose(current, 'body', current.body === 'male' ? 'female' : 'male');
}

/** A saved draft's look when it is valid (as a copy); otherwise (a version-1 draft, or damaged data) a random valid one. */
export function lookFromDraft(value: unknown, random: () => number): Appearance {
  return validAppearance(value) ? { ...value } : randomAppearance(random);
}

/** One layer of the preview and the colour it is multiplied by (`null`: drawn as it is). */
export type PreviewLayer = { id: string; tint: number | null };
const TINT_KEY = new Map((rawManifest as unknown as { actors: { gladiator: { layers: { id: string; tint?: 'skin' | 'cloth' | 'hair' }[] } } })
  .actors.gladiator.layers.map(layer => [layer.id, layer.tint ?? null]));

/**
 * The layers the dialog draws, in manifest order: the camp's look for a fresh gladiator with no gear (body, clothes, the accent sash,
 * and any hair), each tinted by the colour its manifest entry names, exactly as the scenes do. The `held` layer is left out: it
 * only holds what is carried, and every idle frame of it is empty.
 */
export function previewLayers(look: Appearance): PreviewLayer[] {
  const { layers, tint } = lookFor(look, 'preview', []);
  return layers.filter(id => id !== 'held').map(id => {
    const key = TINT_KEY.get(id) ?? null;
    return { id, tint: key ? tint[key] : null };
  });
}

/** The atlas frame of a layer's idle animation (facing south-east). */
export const frameId = (layer: string, index: number) => `${layer}/idle/se/${index}`;

/**
 * The style of one preview layer: the frame cropped from the atlas at `PREVIEW_SCALE`. A tinted layer is multiplied over its tint
 * with `background-blend-mode`, and a mask of the same frame keeps its shape (a transparent pixel of the art stays transparent).
 */
export function layerStyle(layer: PreviewLayer, frame: { x: number; y: number }, atlas: { w: number; h: number }, imageUrl: string): CSSProperties {
  const size = `${atlas.w * PREVIEW_SCALE}px ${atlas.h * PREVIEW_SCALE}px`;
  const position = `${-frame.x * PREVIEW_SCALE}px ${-frame.y * PREVIEW_SCALE}px`;
  const image = `url(${imageUrl})`;
  const style: CSSProperties = {
    width: 64 * PREVIEW_SCALE, height: 64 * PREVIEW_SCALE, backgroundImage: image, backgroundSize: size, backgroundPosition: position,
  };
  if (layer.tint === null) return style;
  return {
    ...style, backgroundColor: hex(layer.tint), backgroundBlendMode: 'multiply',
    maskImage: image, maskSize: size, maskPosition: position,
    WebkitMaskImage: image, WebkitMaskSize: size, WebkitMaskPosition: position,
  };
}

/** The frame after `frame`; a still first frame when motion is reduced. */
export const nextFrame = (frame: number, reducedMotion: boolean) => (reducedMotion ? 0 : (frame + 1) % PREVIEW_FRAME_COUNT);
