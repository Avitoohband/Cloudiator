/**
 * Gladiator appearance (the look chosen at creation). One definition shared by the Edge parser, the client and tests; SQL restates
 * the same bounds. Colours are palette indices so a palette can change without rewriting stored rows. A gladiator whose stored
 * appearance is `null` has the legacy look (male body, short hair, colours from its id); that case is the client's, not this module's.
 * Plain TypeScript with no runtime imports: it loads in Deno (Edge) and in the browser alike.
 */
export const BODIES = ['male', 'female'] as const;
export const HAIRS = ['short', 'long', 'ponytail', 'bald'] as const;
export type BodyId = (typeof BODIES)[number];
export type HairId = (typeof HAIRS)[number];
/** The stored shape: exactly these five keys. `skin`, `hairColor` and `cloth` index `SKIN_TONES`, `HAIR_COLOURS` and `CLOTH_COLOURS`. */
export type Appearance = { body: BodyId; hair: HairId; skin: number; hairColor: number; cloth: number };
export type Swatch = { name: string; tint: number };

/** Multiplied over the light base skin. */
export const SKIN_TONES: readonly Swatch[] = [
  { name: 'Light', tint: 0xffffff }, { name: 'Tan', tint: 0xeac3a0 }, { name: 'Olive', tint: 0xcf9a74 },
  { name: 'Brown', tint: 0x9f6e4c }, { name: 'Deep brown', tint: 0x7a5038 },
];
/** Multiplied over the grey hair layers. */
export const HAIR_COLOURS: readonly Swatch[] = [
  { name: 'Brown', tint: 0x5a3418 }, { name: 'Black', tint: 0x2a2024 }, { name: 'Auburn', tint: 0xb8742f },
  { name: 'Blond', tint: 0xe6c06a }, { name: 'Grey', tint: 0x9a9a9a }, { name: 'Red', tint: 0x8a3324 },
];
/** Multiplied over the grey cloth layers. */
export const CLOTH_COLOURS: readonly Swatch[] = [
  { name: 'Teal', tint: 0x22a39d }, { name: 'Red', tint: 0xbd3429 }, { name: 'Gold', tint: 0xf2b43d }, { name: 'Purple', tint: 0x6a4fb8 },
  { name: 'Blue', tint: 0x3c7fd0 }, { name: 'Green', tint: 0x4e8d3b }, { name: 'Orange', tint: 0xe0702a }, { name: 'Cream', tint: 0xf4e8cb },
  { name: 'Slate', tint: 0x4b4b55 }, { name: 'Leather', tint: 0xa8693a }, { name: 'Rose', tint: 0xd9608c }, { name: 'Sky', tint: 0x8edcf4 },
];

const KEYS: readonly string[] = ['body', 'hair', 'skin', 'hairColor', 'cloth'];
const index = (value: unknown, size: number) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < size;

/** True only for exactly `{body, hair, skin, hairColor, cloth}` with a known body and hair and in-range whole palette indices. */
export function validAppearance(value: unknown): value is Appearance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const look = value as Record<string, unknown>;
  return Object.keys(look).length === KEYS.length && KEYS.every(key => Object.hasOwn(look, key))
    && typeof look.body === 'string' && (BODIES as readonly string[]).includes(look.body)
    && typeof look.hair === 'string' && (HAIRS as readonly string[]).includes(look.hair)
    && index(look.skin, SKIN_TONES.length) && index(look.hairColor, HAIR_COLOURS.length) && index(look.cloth, CLOTH_COLOURS.length);
}

/** A uniformly random valid look from `random` (a generator in [0, 1)); the creation dialog opens with one. */
export function randomAppearance(random: () => number): Appearance {
  const pick = (size: number) => Math.min(size - 1, Math.floor(random() * size));
  return { body: BODIES[pick(BODIES.length)], hair: HAIRS[pick(HAIRS.length)], skin: pick(SKIN_TONES.length),
    hairColor: pick(HAIR_COLOURS.length), cloth: pick(CLOTH_COLOURS.length) };
}
