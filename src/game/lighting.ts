// Phase lighting: a gentle full-screen tint plus torch glow. Overlays stay light enough that
// characters, nameplates and controls remain readable in every phase.
import type { Phase } from '@contracts/commands';

export type Lighting = { overlayColor: number; overlayAlpha: number; torchIntensity: number };

const PHASES: Record<Phase, Lighting> = {
  morning: { overlayColor: 0xffc98a, overlayAlpha: 0.12, torchIntensity: 0.25 },
  afternoon: { overlayColor: 0xfff4e0, overlayAlpha: 0.04, torchIntensity: 0.1 },
  evening: { overlayColor: 0x2e2a6b, overlayAlpha: 0.32, torchIntensity: 1 },
};
const ORDER: Phase[] = ['morning', 'afternoon', 'evening'];
export const SLOT_MS = 4_800_000;
const BLEND_MS = 180_000;

export function phaseLighting(phase: Phase): Lighting {
  return PHASES[phase];
}

export function phaseOfSlot(slotIndex: number): Phase {
  return ORDER[((slotIndex % 3) + 3) % 3];
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
function mixColor(a: number, b: number, t: number): number {
  const ch = (c: number, s: number) => (c >> s) & 255;
  return (Math.round(mix(ch(a, 16), ch(b, 16), t)) << 16) | (Math.round(mix(ch(a, 8), ch(b, 8), t)) << 8) | Math.round(mix(ch(a, 0), ch(b, 0), t));
}

/** Lighting at a server time, blending into the next phase during the last three minutes of a slot. */
export function lightingAt(nowMs: number): Lighting {
  const slot = Math.floor(nowMs / SLOT_MS);
  const current = PHASES[phaseOfSlot(slot)];
  const intoSlot = nowMs - slot * SLOT_MS;
  const t = Math.max(0, (intoSlot - (SLOT_MS - BLEND_MS)) / BLEND_MS);
  if (t <= 0) return current;
  const next = PHASES[phaseOfSlot(slot + 1)];
  return {
    overlayColor: mixColor(current.overlayColor, next.overlayColor, t),
    overlayAlpha: mix(current.overlayAlpha, next.overlayAlpha, t),
    torchIntensity: mix(current.torchIntensity, next.torchIntensity, t),
  };
}
