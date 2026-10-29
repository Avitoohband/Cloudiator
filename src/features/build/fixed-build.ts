// A build's class and attribute points are fixed once it is the current build (Avi, 2026-10-28; respec and class changes come back
// later as paid options). The server refuses a class change or an attribute below the CURRENT build's value as `invalid`
// (`lockedChange`), so every command the client builds from a saved build starts from this: the current class and no attribute
// below the current build's. Only a build queued before the release can differ (a class change or a respec); its old change is
// dropped the next time the player changes the build or the gear. The Build form and the gear view both use it.
import type { Attributes, ClassId } from '@contracts/commands';
import type { BuildView } from '@contracts/reads';
import type { BuildInput } from '@domain/types';

const ATTRIBUTES = ['strength', 'agility', 'vitality', 'endurance', 'precision'] as const;

/** The class and the attribute points a change based on `build` starts from, given the `current` (active) build. */
export function fixedClassAndPoints(build: BuildView, current: BuildView): { classId: ClassId; allocations: Attributes } {
  return {
    classId: current.classId,
    allocations: Object.fromEntries(ATTRIBUTES.map(key => [key, Math.max(build.allocations[key], current.allocations[key])])) as Attributes,
  };
}

/**
 * What fixes a draft, as a string: the current build's class and attribute points. Compare it, never the build object: every owner
 * read brings a new one, and `private.apply_pending_build` moves the current build without moving the build version.
 */
export const fixedKey = (current: BuildView): string => JSON.stringify([current.classId, ...ATTRIBUTES.map(key => current.allocations[key])]);

/**
 * A draft after the current build moved under it (the boundary applied a pending build while the form was open): the new current
 * class, and no attribute below the new current build's. The rest of the draft (stance, gear, points above the floor) is kept, so
 * an unsent edit is not lost. A draft already at the floor comes back the same in content.
 */
export function refloored(draft: BuildInput, current: BuildView): BuildInput {
  const { classId, allocations } = fixedClassAndPoints({ ...current, allocations: draft.allocation }, current);
  return { ...draft, classId, allocation: allocations };
}
