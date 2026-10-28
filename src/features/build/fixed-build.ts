// A build's class and attribute points are fixed once it is the current build (Avi, 2026-10-28; respec and class changes come back
// later as paid options). The server refuses a class change or an attribute below the CURRENT build's value as `invalid`
// (`lockedChange`), so every command the client builds from a saved build starts from this: the current class and no attribute
// below the current build's. Only a build queued before the release can differ (a class change or a respec); its old change is
// dropped the next time the player changes the build or the gear. The Build form and the gear view both use it.
import type { Attributes, ClassId } from '@contracts/commands';
import type { BuildView } from '@contracts/reads';

const ATTRIBUTES = ['strength', 'agility', 'vitality', 'endurance', 'precision'] as const;

/** The class and the attribute points a change based on `build` starts from, given the `current` (active) build. */
export function fixedClassAndPoints(build: BuildView, current: BuildView): { classId: ClassId; allocations: Attributes } {
  return {
    classId: current.classId,
    allocations: Object.fromEntries(ATTRIBUTES.map(key => [key, Math.max(build.allocations[key], current.allocations[key])])) as Attributes,
  };
}
