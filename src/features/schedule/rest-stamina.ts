// What a Rest gives back (Patch A item 6). The rule is the server's: a Rest refills stamina to the maximum when its slot ends, and an
// activity is paid when the boundary into its slot is processed (`private.boundary_start`: the debit, "active" and `processedSlotIndex`, in one
// transaction, one to two and a half minutes after the slot's cutoff). So a Rest's gain is the maximum minus the
// stamina it finds, which the Schedule projects from the owner's stamina and the draft day, and My gladiator reads from the stamina now.
// Pure, so the panels only lay the words out. The costs come from `RULES_V1` and the current build's overload through `activityCost`,
// as the server's boundary (`prepareActivityV1`) works them out; nothing here restates a number.
import type { Phase, Schedule } from '@contracts/commands';
import type { OwnerState } from '@contracts/reads';
import { validateBuild } from '@domain/build';
import { nextPhaseStart, slotAt } from '@domain/clock';
import { RULES_V1 } from '@domain/rules-v1';
import { activityCost, deriveStats } from '@domain/stats';
import type { ActivityCosts, ActivityKind } from '@domain/types';

/** The stamina each kind of activity costs a build, as the server's boundary freezes them (the five kinds the boundary prices: a tournament too). */
export type { ActivityCosts };

/**
 * What a Rest gives: the stamina it finds (`before`) and refills to (`maximum`). Null where no number can be told truthfully: a
 * pending build takes effect at or before the Rest (its maximum and its costs are not this build's), or the costs are not known.
 */
export type RestGain = { before: number; maximum: number } | null;

type Stamina = Pick<OwnerState, 'stamina'>;
const SLOT_MS = RULES_V1.clock.slotMs;
const PHASES = RULES_V1.clock.phases;
const KINDS = Object.keys(RULES_V1.activityStamina) as ActivityKind[];
const usable = (value: number) => Number.isFinite(value) && value >= 0;
/** Whether the owner's stamina holds numbers a gain can be told from. */
const known = ({ stamina }: Stamina) => usable(stamina.current) && usable(stamina.maximum);

/**
 * The stamina every kind of activity costs the owner's CURRENT build: the build as the boundary validates it (`validateBuild` against
 * the owner's items, points and level), its overload from `deriveStats`, and `activityCost` of each base cost and that overload. Null
 * when the build does not validate (a piece that is gone, on sale or too high a tier) or the rules cannot derive it: the boundary
 * would then refuse to prepare it, so no cost, and no rest number built on one, is made up. Never throws.
 */
export function activityCosts(owner: Pick<OwnerState, 'currentBuild' | 'inventory' | 'progression'>): ActivityCosts | null {
  try {
    const build = owner.currentBuild;
    const valid = validateBuild({ classId: build.classId, stance: build.stance, allocation: build.allocations, equipment: build.equipment },
      owner.inventory, owner.progression.earnedAttributePoints, owner.progression.level);
    if (!valid.ok) return null;
    const { overload } = deriveStats(valid.snapshot, RULES_V1);
    return Object.fromEntries(KINDS.map(kind => [kind, activityCost(RULES_V1.activityStamina[kind], overload)])) as ActivityCosts;
  } catch { return null; }
}

/**
 * The stamina the Rest of part `phase` (its next occurrence after the slot `nowMs` is in) will find and refill, by walking the parts
 * between: from the slot the clock is in, whose activity is already paid, strictly up to that Rest, each part of the draft `day` in
 * time order.
 * - Start from `owner.stamina.current`, or from the maximum when the running activity is a Rest (it refills when its slot ends).
 * - A Rest sets the maximum; any other part subtracts its cost (`costs[kind]`: Arena's for the evening, which a tournament costs the
 *   same), or, when that is more than what is left, becomes a Rest (the boundary's "Resting (not enough stamina)") and refills to the maximum.
 * - Null when `costs` is null, a time or stamina is not a usable number, the owner's pending build takes effect at or before the
 *   Rest's slot (the walk would cost the new build's parts, and the Rest would refill its maximum), or the slot the clock is in is not
 *   processed yet (`owner.processedSlotIndex` is before it: the stamina read does not include its debit or refill).
 */
export function projectRest(input: { phase: Phase; nowMs: number; owner: Pick<OwnerState, 'stamina' | 'currentActivity' | 'pendingBuild' | 'processedSlotIndex'>; day: Schedule; costs: ActivityCosts | null }): RestGain {
  const { phase, nowMs, owner, day, costs } = input;
  if (!costs || !known(owner) || !usable(nowMs)) return null;
  let running: number, target: number;
  try {
    running = slotAt(Math.floor(nowMs)).index;
    target = nextPhaseStart(phase, Math.floor(nowMs)) / SLOT_MS;
  } catch { return null; }
  if (owner.pendingBuild && owner.pendingBuild.effectiveSlotIndex <= target) return null;
  // The clock moves into a slot at its cutoff, but the server debits that slot's activity (and refills a Rest) only when it processes the
  // boundary, one to two and a half minutes later, setting `processedSlotIndex` in the same transaction. Until the owner read says so, its
  // stamina is not the running part's paid stamina, and no exact number can be told (`activityStatus`'s `behind` test; `<`, so a clock that
  // lags the server is not a slot waiting to be processed).
  if (owner.processedSlotIndex < running) return null;
  const { maximum } = owner.stamina;
  let stamina = owner.currentActivity?.kind === 'rest' ? maximum : owner.stamina.current;
  for (let index = running + 1; index < target; index++) {
    const choice = day[PHASES[index % PHASES.length]];
    if (choice.kind === 'rest') { stamina = maximum; continue; }
    const cost = costs[choice.kind];
    stamina = cost > stamina ? maximum : stamina - cost;
  }
  return { before: stamina, maximum };
}

/**
 * What the Rest running now will give when its slot ends: from the stamina now (a Rest costs nothing, and refills at its end) to the
 * maximum. Null for an activity that is not a Rest, and when a pending build takes effect when the Rest ends or before.
 */
export function restingGain(owner: Pick<OwnerState, 'stamina' | 'currentActivity' | 'pendingBuild'>): RestGain {
  const activity = owner.currentActivity;
  if (activity?.kind !== 'rest' || !known(owner) || !Number.isFinite(activity.endsAtMs)) return null;
  if (owner.pendingBuild && owner.pendingBuild.effectiveSlotIndex * SLOT_MS <= activity.endsAtMs) return null;
  return { before: owner.stamina.current, maximum: owner.stamina.maximum };
}

/** The Schedule's line under a Rest's select. A Rest already at the maximum says it adds nothing, never "+0". */
export function restHint(gain: RestGain): string {
  if (!gain) return 'Refills stamina to full. Costs nothing.';
  if (gain.before >= gain.maximum) return `Stamina will already be full (${gain.maximum}): this rest adds nothing. Costs nothing.`;
  return `Refills stamina to full: +${gain.maximum - gain.before} (${gain.before} → ${gain.maximum}). Costs nothing.`;
}

/** My gladiator's line while a Rest runs. */
export function restingGainText(gain: RestGain): string {
  if (!gain) return 'Stamina refills to full when it ends.';
  if (gain.before >= gain.maximum) return `Stamina is already full (${gain.maximum}): this rest adds nothing`;
  return `Stamina refills to ${gain.maximum} when it ends: +${gain.maximum - gain.before}`;
}
