import { describe, expect, it } from 'vitest';
import { BODIES, CLOTH_COLOURS, HAIRS, HAIR_COLOURS, SKIN_TONES, randomAppearance, validAppearance, type Appearance } from '@domain/appearance.ts';
import { seededRandom } from '@domain/random.ts';
import { CLOTH_TINTS, HAIR_TINTS, SKIN_TINTS } from '@/game/actors';

const base: Appearance = { body: 'male', hair: 'short', skin: 0, hairColor: 0, cloth: 0 };

describe('appearance options', () => {
  it('lists exactly the body and hair styles of the design, in order', () => {
    expect(BODIES).toEqual(['male', 'female']);
    expect(HAIRS).toEqual(['short', 'long', 'ponytail', 'bald']);
  });

  it('names and tints the palettes as today, so existing looks do not change', () => {
    expect(SKIN_TONES.map(({ name }) => name)).toEqual(['Light', 'Tan', 'Olive', 'Brown', 'Deep brown']);
    expect(HAIR_COLOURS.map(({ name }) => name)).toEqual(['Brown', 'Black', 'Auburn', 'Blond', 'Grey', 'Red']);
    expect(CLOTH_COLOURS.map(({ name }) => name)).toEqual(['Teal', 'Red', 'Gold', 'Purple', 'Blue', 'Green', 'Orange', 'Cream', 'Slate', 'Leather', 'Rose', 'Sky']);
    // Literal copies of the values the game shipped with: the client lists must derive from the module, not drift from them.
    const skin = [0xffffff, 0xeac3a0, 0xcf9a74, 0x9f6e4c, 0x7a5038];
    const hair = [0x5a3418, 0x2a2024, 0xb8742f, 0xe6c06a, 0x9a9a9a, 0x8a3324];
    const cloth = [0x22a39d, 0xbd3429, 0xf2b43d, 0x6a4fb8, 0x3c7fd0, 0x4e8d3b, 0xe0702a, 0xf4e8cb, 0x4b4b55, 0xa8693a, 0xd9608c, 0x8edcf4];
    expect(SKIN_TONES.map(({ tint }) => tint)).toEqual(skin);
    expect(HAIR_COLOURS.map(({ tint }) => tint)).toEqual(hair);
    expect(CLOTH_COLOURS.map(({ tint }) => tint)).toEqual(cloth);
    expect([...SKIN_TINTS]).toEqual(skin);
    expect([...HAIR_TINTS]).toEqual(hair);
    expect([...CLOTH_TINTS]).toEqual(cloth);
  });
});

describe('validAppearance', () => {
  it('accepts the corners of every combination', () => {
    for (const body of BODIES) for (const hair of HAIRS) for (const [skin, hairColor, cloth] of [[0, 0, 0], [4, 5, 11], [0, 5, 0], [4, 0, 11], [2, 3, 7]])
      expect(validAppearance({ body, hair, skin, hairColor, cloth }), `${body} ${hair} ${skin} ${hairColor} ${cloth}`).toBe(true);
  });

  it('accepts every palette index and nothing past either end', () => {
    for (let skin = 0; skin < SKIN_TONES.length; skin++) expect(validAppearance({ ...base, skin })).toBe(true);
    for (let hairColor = 0; hairColor < HAIR_COLOURS.length; hairColor++) expect(validAppearance({ ...base, hairColor })).toBe(true);
    for (let cloth = 0; cloth < CLOTH_COLOURS.length; cloth++) expect(validAppearance({ ...base, cloth })).toBe(true);
    expect([SKIN_TONES.length, HAIR_COLOURS.length, CLOTH_COLOURS.length]).toEqual([5, 6, 12]);
  });

  it('refuses out-of-range, fractional, non-numeric and unknown values', () => {
    for (const bad of [{ ...base, skin: 5 }, { ...base, skin: -1 }, { ...base, cloth: -1 }, { ...base, cloth: 12 }, { ...base, hairColor: 6 },
      { ...base, hairColor: 1.5 }, { ...base, skin: Number.NaN }, { ...base, cloth: Infinity }, { ...base, skin: 1e100 },
      { ...base, skin: '1' }, { ...base, hairColor: '0' }, { ...base, cloth: null }, { ...base, skin: true },
      { ...base, hair: 'mohawk' }, { ...base, body: 'other' }, { ...base, body: 'Male' }, { ...base, hair: 7 }, { ...base, body: undefined }])
      expect(validAppearance(bad), JSON.stringify(bad)).toBe(false);
  });

  it('refuses a missing key, an extra key and a non-object', () => {
    const { cloth: _cloth, ...missing } = base;
    expect(validAppearance(missing)).toBe(false);
    expect(validAppearance({ ...base, extra: 1 })).toBe(false);
    expect(validAppearance({ ...base, ownerId: 'x' })).toBe(false);
    // Same key count with one key swapped: exact shape, not just a count.
    const { hairColor: _hairColor, ...swapped } = base;
    expect(validAppearance({ ...swapped, haircolor: 0 })).toBe(false);
    for (const bad of [null, undefined, 0, 1, 'male', true, [], [base], () => base]) expect(validAppearance(bad)).toBe(false);
  });

  it('does not accept keys inherited from a prototype', () => {
    expect(validAppearance(Object.create(base))).toBe(false);
  });
});

describe('randomAppearance', () => {
  it('always yields a valid look and covers every option over 500 seeded draws', () => {
    const random = seededRandom('appearance-coverage');
    const seen = { body: new Set<string>(), hair: new Set<string>(), skin: new Set<number>(), hairColor: new Set<number>(), cloth: new Set<number>() };
    for (let i = 0; i < 500; i++) {
      const look = randomAppearance(random);
      expect(validAppearance(look)).toBe(true);
      seen.body.add(look.body); seen.hair.add(look.hair); seen.skin.add(look.skin); seen.hairColor.add(look.hairColor); seen.cloth.add(look.cloth);
    }
    expect([...seen.body].sort()).toEqual([...BODIES].sort());
    expect([...seen.hair].sort()).toEqual([...HAIRS].sort());
    expect([...seen.skin].sort()).toEqual([0, 1, 2, 3, 4]);
    expect([...seen.hairColor].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect([...seen.cloth].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('stays valid at the ends of the generator range, including a value just under 1', () => {
    for (const value of [0, Number.EPSILON, 0.5, 1 - Number.EPSILON]) {
      const look = randomAppearance(() => value);
      expect(validAppearance(look), String(value)).toBe(true);
    }
    expect(randomAppearance(() => 0)).toEqual({ body: 'male', hair: 'short', skin: 0, hairColor: 0, cloth: 0 });
    expect(randomAppearance(() => 1 - Number.EPSILON)).toEqual({ body: 'female', hair: 'bald', skin: 4, hairColor: 5, cloth: 11 });
  });

  it('is deterministic for a seeded generator and returns exactly the five stored keys', () => {
    expect(randomAppearance(seededRandom('same'))).toEqual(randomAppearance(seededRandom('same')));
    expect(Object.keys(randomAppearance(seededRandom('keys'))).sort()).toEqual(['body', 'cloth', 'hair', 'hairColor', 'skin']);
  });
});
