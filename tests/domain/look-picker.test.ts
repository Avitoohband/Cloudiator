import { afterEach, describe, expect, it, vi } from 'vitest';
import { BODIES, CLOTH_COLOURS, HAIRS, HAIR_COLOURS, SKIN_TONES, randomAppearance, validAppearance, type Appearance } from '@domain/appearance';
import { seededRandom } from '@domain/random';
import gladiatorsAtlas from '../../public/assets/actors/gladiators.json';
import rawManifest from '../../public/assets/manifest.json';
import { CLOTH_TINTS, HAIR_TINTS, SKIN_TINTS, lookFor } from '@/game/actors';
import {
  PREVIEW_FRAME_COUNT, PREVIEW_FRAME_MS, PREVIEW_SCALE, choose, frameId, groupLabels, layerStyle, lookFromDraft, lookRandom, lookSummary, nextFrame,
  previewLayers, rerollLook, swatchColour, swatchName, swatchesOf,
} from '@/features/character/look-picker';

// The look step of the creation dialog (Task 6 of the gladiator appearance change): the pure rules behind the picker and its
// live preview. The preview draws exactly what the camp draws for a gladiator with no gear, so it is built on `lookFor`.
const base: Appearance = { body: 'male', hair: 'short', skin: 0, hairColor: 0, cloth: 0 };
const every: Appearance[] = BODIES.flatMap(body => HAIRS.map(hair => ({ ...base, body, hair, skin: 2, hairColor: 5, cloth: 11 })));
const frames = (gladiatorsAtlas as unknown as { frames: Record<string, { frame: { x: number; y: number; w: number; h: number } }> }).frames;
const atlasSize = (gladiatorsAtlas as unknown as { meta: { size: { w: number; h: number } } }).meta.size;

describe('lookSummary (the text a screen reader gets for the decorative preview)', () => {
  it('names body, hair style, skin, hair colour and clothes', () => {
    expect(lookSummary({ body: 'female', hair: 'ponytail', skin: 2, hairColor: 5, cloth: 0 })).toBe('Female, ponytail, olive skin, red hair, teal clothes');
    expect(lookSummary({ body: 'male', hair: 'short', skin: 4, hairColor: 1, cloth: 7 })).toBe('Male, short hair, deep brown skin, black hair, cream clothes');
  });

  it('says "long hair" for the long style and leaves the hair colour out when bald (nothing of it is seen)', () => {
    expect(lookSummary({ body: 'female', hair: 'long', skin: 0, hairColor: 3, cloth: 10 })).toBe('Female, long hair, light skin, blond hair, rose clothes');
    expect(lookSummary({ body: 'male', hair: 'bald', skin: 1, hairColor: 5, cloth: 2 })).toBe('Male, bald, tan skin, gold clothes');
  });

  it('is different for every body and hair style', () => {
    expect(new Set(every.map(lookSummary)).size).toBe(every.length);
  });
});

describe('group labels and swatch names', () => {
  it('names the current choice of each colour group, as the design quotes them', () => {
    expect(groupLabels({ body: 'male', hair: 'short', skin: 2, hairColor: 5, cloth: 0 })).toEqual({
      skin: 'Skin tone · Olive', hairColor: 'Hair colour · Red', cloth: 'Clothes colour · Teal',
    });
    expect(groupLabels({ ...base, skin: 4 }).skin).toBe('Skin tone · Deep brown');
  });

  it('names a swatch by its group and colour', () => {
    expect(swatchName('skin', 2)).toBe('Skin tone Olive');
    expect(swatchName('hairColor', 3)).toBe('Hair colour Blond');
    expect(swatchName('cloth', 9)).toBe('Clothes colour Leather');
  });

  it('lists every palette entry once, in palette order, with a unique name', () => {
    expect(swatchesOf('skin').map(s => s.colour)).toHaveLength(SKIN_TONES.length);
    expect(swatchesOf('hairColor')).toHaveLength(HAIR_COLOURS.length);
    expect(swatchesOf('cloth')).toHaveLength(CLOTH_COLOURS.length);
    for (const group of ['skin', 'hairColor', 'cloth'] as const) {
      const list = swatchesOf(group);
      expect(list.map(s => s.index)).toEqual(list.map((_, i) => i));
      expect(new Set(list.map(s => s.label)).size).toBe(list.length);
      expect(list.every(s => /^#[0-9a-f]{6}$/.test(s.colour))).toBe(true);
    }
    expect(swatchesOf('cloth')[0]).toMatchObject({ index: 0, label: 'Clothes colour Teal', colour: '#22a39d' });
  });

  it('shows a skin swatch as the tint over the base skin of the art, so Light is not white', () => {
    expect(swatchColour('hairColor', 0x5a3418)).toBe('#5a3418');
    expect(swatchColour('cloth', 0x22a39d)).toBe('#22a39d');
    expect(swatchColour('skin', 0xffffff)).toBe('#e0a273');
    expect(swatchColour('skin', 0x7a5038)).toBe('#6b3319');
  });
});

describe('choose and rerollLook', () => {
  it('changes one field and leaves the rest', () => {
    const look: Appearance = { body: 'female', hair: 'long', skin: 3, hairColor: 2, cloth: 6 };
    expect(choose(look, 'hair', 'bald')).toEqual({ ...look, hair: 'bald' });
    expect(choose(look, 'skin', 0)).toEqual({ ...look, skin: 0 });
    expect(choose(look, 'body', 'male')).toEqual({ ...look, body: 'male' });
    expect(look).toEqual({ body: 'female', hair: 'long', skin: 3, hairColor: 2, cloth: 6 });
  });

  it('keeps the hair colour when bald is chosen, and the hair style when the colour changes', () => {
    const bald = choose({ ...base, hairColor: 4 }, 'hair', 'bald');
    expect(bald).toMatchObject({ hair: 'bald', hairColor: 4 });
    expect(choose(bald, 'hairColor', 1)).toEqual({ ...bald, hairColor: 1 });
  });

  it('refuses a value that would make the look invalid', () => {
    expect(choose(base, 'skin', 5)).toEqual(base);
    expect(choose(base, 'cloth', -1)).toEqual(base);
    expect(choose(base, 'hair', 'mohawk' as never)).toEqual(base);
    expect(choose(base, 'hairColor', 1.5)).toEqual(base);
  });

  it('rolls a valid look that differs from the current one, and always changes something', () => {
    const random = seededRandom('look-picker-reroll');
    let look = randomAppearance(random);
    for (let i = 0; i < 200; i++) {
      const next = rerollLook(look, random);
      expect(validAppearance(next)).toBe(true);
      expect(next).not.toEqual(look);
      look = next;
    }
  });

  it('still returns a valid look when the generator keeps returning the same value', () => {
    const next = rerollLook(base, () => 0);
    expect(validAppearance(next)).toBe(true);
  });
});

describe('lookFromDraft (a saved draft keeps a valid look, otherwise a random one)', () => {
  const chosen: Appearance = { body: 'female', hair: 'ponytail', skin: 3, hairColor: 4, cloth: 8 };
  it('keeps a valid saved look as it is', () => {
    expect(lookFromDraft(chosen, () => 0.5)).toEqual(chosen);
  });

  it('gives a random valid look for a version-1 draft (no look), or anything invalid', () => {
    const random = () => 0.3;
    const expected = randomAppearance(random);
    for (const value of [undefined, null, 'female', 7, [], {}, { ...chosen, skin: 5 }, { ...chosen, hair: 'mohawk' }, { ...chosen, extra: 1 },
      { ...chosen, cloth: '3' }, { body: 'female' }]) {
      const look = lookFromDraft(value, random);
      expect(look, JSON.stringify(value)).toEqual(expected);
      expect(validAppearance(look)).toBe(true);
    }
  });

  it('returns a copy, so editing it never changes the saved draft', () => {
    const saved = { ...chosen };
    const look = lookFromDraft(saved, () => 0);
    expect(look).not.toBe(saved);
  });
});

describe('previewLayers (what the dialog draws)', () => {
  it('is what the camp draws for a gladiator with no gear, minus the held layer that idle frames leave empty', () => {
    for (const look of every) {
      const camp = lookFor(look, 'preview', []);
      expect(previewLayers(look).map(layer => layer.id), JSON.stringify(look)).toEqual(camp.layers.filter(id => id !== 'held'));
    }
    for (let i = 0; i < 4; i++) expect(frames[`held/idle/se/${i}`]).toBeDefined();
  });

  it('uses the female body and clothes, never the male ones, for a female look', () => {
    const ids = previewLayers({ ...base, body: 'female', hair: 'ponytail' }).map(layer => layer.id);
    expect(ids).toEqual(['body-female', 'cloth-female', 'hair-ponytail', 'accent']);
    const male = previewLayers({ ...base, body: 'male', hair: 'short' }).map(layer => layer.id);
    expect(male).toEqual(['body', 'cloth', 'hair', 'accent']);
  });

  it('draws each hair style with its own layer and no hair layer when bald', () => {
    for (const [hair, layer] of [['short', 'hair'], ['long', 'hair-long'], ['ponytail', 'hair-ponytail']] as const) {
      expect(previewLayers({ ...base, hair }).map(l => l.id)).toContain(layer);
    }
    expect(previewLayers({ ...base, hair: 'bald' }).map(l => l.id).some(id => id.startsWith('hair'))).toBe(false);
  });

  it('tints each layer by the colour its manifest entry names, from the chosen palette indices', () => {
    const look: Appearance = { body: 'female', hair: 'long', skin: 3, hairColor: 2, cloth: 6 };
    const tints = Object.fromEntries(previewLayers(look).map(layer => [layer.id, layer.tint]));
    expect(tints).toEqual({
      'body-female': SKIN_TINTS[3], 'cloth-female': CLOTH_TINTS[6], accent: CLOTH_TINTS[6], 'hair-long': HAIR_TINTS[2],
    });
    // The same rule as the scenes: the manifest's tint key of each layer.
    const layers = (rawManifest as unknown as { actors: { gladiator: { layers: { id: string; tint?: string }[] } } }).actors.gladiator.layers;
    for (const layer of previewLayers(look)) expect(layers.find(l => l.id === layer.id)?.tint).toBeDefined();
  });

  it('follows the layer tint keys of the manifest for every look', () => {
    const keyOf = new Map((rawManifest as unknown as { actors: { gladiator: { layers: { id: string; tint?: 'skin' | 'cloth' | 'hair' }[] } } })
      .actors.gladiator.layers.map(l => [l.id, l.tint ?? null]));
    for (const look of every) {
      const camp = lookFor(look, 'preview', []);
      for (const layer of previewLayers(look)) {
        const key = keyOf.get(layer.id);
        expect(layer.tint, `${look.body} ${look.hair} ${layer.id}`).toBe(key ? camp.tint[key] : null);
      }
    }
  });
});

describe('the sprite geometry', () => {
  it('names the idle frames facing south-east, four of them, 260 ms each', () => {
    expect(frameId('body-female', 2)).toBe('body-female/idle/se/2');
    expect(PREVIEW_FRAME_COUNT).toBe(4);
    expect(PREVIEW_FRAME_MS).toBe(260);
  });

  it('finds every drawn layer of every look in the atlas, four 64 x 64 frames each', () => {
    for (const look of every) for (const layer of previewLayers(look)) for (let i = 0; i < PREVIEW_FRAME_COUNT; i++) {
      const f = frames[frameId(layer.id, i)];
      expect(f, `${layer.id} ${i}`).toBeDefined();
      expect([f.frame.w, f.frame.h]).toEqual([64, 64]);
    }
  });

  it('crops one frame of the atlas at an integer scale, pixelated, with nothing smoothed', () => {
    const rect = frames[frameId('body', 1)].frame;
    const style = layerStyle({ id: 'body', tint: null }, rect, atlasSize, '/assets/actors/gladiators.png');
    expect(PREVIEW_SCALE).toBeGreaterThanOrEqual(2);
    expect(Number.isInteger(PREVIEW_SCALE)).toBe(true);
    expect(style).toMatchObject({
      width: 64 * PREVIEW_SCALE, height: 64 * PREVIEW_SCALE,
      backgroundImage: 'url(/assets/actors/gladiators.png)',
      backgroundSize: `${atlasSize.w * PREVIEW_SCALE}px ${atlasSize.h * PREVIEW_SCALE}px`,
      backgroundPosition: `${-rect.x * PREVIEW_SCALE}px ${-rect.y * PREVIEW_SCALE}px`,
    });
  });

  it('tints a layer by multiply over a mask of the same frame, and leaves an untinted layer plain', () => {
    const rect = frames[frameId('hair-long', 0)].frame;
    const tinted = layerStyle({ id: 'hair-long', tint: 0x8a3324 }, rect, atlasSize, '/a.png');
    expect(tinted).toMatchObject({
      backgroundColor: '#8a3324', backgroundBlendMode: 'multiply',
      maskImage: 'url(/a.png)', WebkitMaskImage: 'url(/a.png)',
      maskPosition: tinted.backgroundPosition, WebkitMaskPosition: tinted.backgroundPosition,
      maskSize: tinted.backgroundSize, WebkitMaskSize: tinted.backgroundSize,
    });
    const plain = layerStyle({ id: 'held', tint: null }, rect, atlasSize, '/a.png');
    for (const key of ['backgroundColor', 'backgroundBlendMode', 'maskImage', 'WebkitMaskImage']) expect(plain).not.toHaveProperty(key);
  });

  it('shows a different frame region for each of the four frames', () => {
    const positions = new Set([0, 1, 2, 3].map(i => layerStyle({ id: 'body', tint: null }, frames[frameId('body', i)].frame, atlasSize, '/a.png').backgroundPosition));
    expect(positions.size).toBe(4);
  });
});

describe('nextFrame (the idle loop, and its still frame under reduced motion)', () => {
  it('loops through the four frames', () => {
    let frame = 0;
    const seen: number[] = [];
    for (let i = 0; i < 9; i++) { seen.push(frame); frame = nextFrame(frame, false); }
    expect(seen).toEqual([0, 1, 2, 3, 0, 1, 2, 3, 0]);
  });

  it('stays on the first frame when motion is reduced', () => {
    for (const frame of [0, 1, 2, 3]) expect(nextFrame(frame, true)).toBe(0);
  });
});

describe('lookRandom (the generator behind a random look)', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('is Math.random, in production and in any page that sets no hook', () => {
    const value = lookRandom();
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(1);
    vi.stubGlobal('window', { __cloudiatorLookRandom: () => 0.3 });
    expect(lookRandom()).not.toBe(0.3);
  });

  it('follows the test hook in a fixture build only', () => {
    vi.stubEnv('NEXT_PUBLIC_FIXTURE_ENABLED', 'true');
    vi.stubGlobal('window', { __cloudiatorLookRandom: () => 0.3 });
    expect(lookRandom()).toBe(0.3);
    expect(randomAppearance(lookRandom)).toEqual({ body: 'male', hair: 'long', skin: 1, hairColor: 1, cloth: 3 });
    vi.stubEnv('NEXT_PUBLIC_FIXTURE_ENABLED', 'false');
    expect(lookRandom()).not.toBe(0.3);
  });
});
