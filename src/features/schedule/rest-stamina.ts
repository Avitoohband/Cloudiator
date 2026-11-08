// What a Rest gives back (Patch A item 6). The rule is the server's: a Rest refills stamina to the maximum when its slot ends, and an
// activity is paid when the boundary into its slot is processed (`private.boundary_start`: the debit, "active" and `processedSlotIndex`, in one
// transaction, one to two and a half minutes after the slot's cutoff). So a Rest's gain is the maximum minus the
// stamina it finds, which the Schedule projects from the owner's stamina and the draft day, and My gladiator reads from the stamina now.
// Pure, so the panels only lay the words out. The costs come from the rules given (`RULES_V1` by default; the active rules' since Patch
// 1.6) and the current build's overload through `activityCost`, as the server's boundary (`prepareActivity`) works them out; nothing here
// restates a number.
import type { ActivityChoice, Phase, Schedule } from '@contracts/commands';
import type { OwnerState } from '@contracts/reads';
import { validateBuild } from '@domain/build';
import { nextPhaseStart, slotAt } from '@domain/clock';
import { trainingDailyLimit } from '@domain/economy';
import { RULES_V1 } from '@domain/rules-v1';
import { activityCost, deriveStats } from '@domain/stats';
import { isTournamentSlot } from '@domain/tournament-slot';
import type { ActivityCosts, Rules } from '@domain/types';

/** The stamina each activity supported by the active rules costs a build, as the server's boundary freezes it. */
export type { ActivityCosts };

/**
 * What a Rest gives: the stamina it finds (`before`) and refills to (`maximum`). Null where no number can be told truthfully: a
 * pending build takes effect at or before the Rest (its maximum and its costs are not this build's), or the costs are not known.
 */
export type RestGain = { before: number; maximum: number } | null;

type Stamina = Pick<OwnerState, 'stamina'>;
const SLOT_MS = RULES_V1.clock.slotMs;
const PHASES = RULES_V1.clock.phases;
const usable = (value: number) => Number.isFinite(value) && value >= 0;
/** Whether the owner's stamina holds numbers a gain can be told from. */
const known = ({ stamina }: Stamina) => usable(stamina.current) && usable(stamina.maximum);

/**
 * The stamina every kind of activity costs the owner's CURRENT build under `rules`: the build as the boundary validates it
 * (`validateBuild` against the owner's items, points and level), its overload from `deriveStats`, and `activityCost` of each base cost
 * and that overload (v2 prices dungeons and keeps tournament entry free, even overloaded). Null when the build does not validate (a piece that is gone, on sale
 * or too high a tier) or the rules cannot derive it: the boundary would then refuse to prepare it, so no cost, and no rest number built
 * on one, is made up. Never throws.
 */
export function activityCosts(owner: Pick<OwnerState, 'currentBuild' | 'inventory' | 'progression'>, rules: Rules = RULES_V1): ActivityCosts | null {
  try {
    const build = owner.currentBuild;
    const valid = validateBuild({ classId: build.classId, stance: build.stance, allocation: build.allocations, equipment: build.equipment },
      owner.inventory, owner.progression.earnedAttributePoints, owner.progression.level, rules);
    if (!valid.ok) return null;
    const { overload } = deriveStats(valid.snapshot, rules);
    return Object.fromEntries(Object.entries(rules.activityStamina).map(([kind, cost]) => [kind, activityCost(cost, overload)])) as ActivityCosts;
  } catch { return null; }
}

/** One way the walk may have gone so far: the stamina left and the actual Trainings of the game day being walked (counted up to the limit). */
type Walk = { stamina: number; trainings: number };

/**
 * The actual Trainings of the running slot's game day up to and including the running slot, as the ways they may have gone (Patch 1.6:
 * only v2's daily limit needs them). The running slot's own is the paid activity's (`currentActivity`, the resolved kind, when it is the
 * running slot's); the day's earlier slots are history this client does not read, so each may or may not have been a Training. A walk
 * that starts a new game day needs none.
 */
function trainingsSoFar(running: number, owner: Pick<OwnerState, 'currentActivity'>, limit: number): number[] {
  if ((running + 1) % PHASES.length === 0) return [0];
  const activity = owner.currentActivity;
  let own: number | null = null;
  try { if (activity && slotAt(Math.floor(activity.startsAtMs)).index === running) own = activity.kind === 'training' ? 1 : 0; } catch { own = null; }
  const earlier = running % PHASES.length;
  const low = own ?? 0, high = (own ?? 1) + earlier;
  return Array.from({ length: Math.min(high, limit) - Math.min(low, limit) + 1 }, (_, i) => Math.min(low, limit) + i);
}

/**
 * The ways one part may go from `walk`, as the boundary resolves it under `rules` (whose daily Training `limit` is null in v1):
 * - Rest refills to the maximum; so does a v2 Training request past the day's limit (an ordinary Rest, which costs no Training stamina
 *   and is not counted), and any part whose cost is more than what is left ("Resting (not enough stamina)", not counted either).
 * - A Training that runs costs its stamina and counts, at the point cap too (the cap only changes the points it gives).
 * - On a tournament evening an Arena that is not opted out (`optIn` false) may be a formed bracket, which costs `costs.tournament`
 *   (v2's free entry; v1's equals Arena's, so both ways agree), or regular Arena at its cost: the walk keeps both.
 */
function step(walk: Walk, choice: ActivityChoice, slot: number, input: { costs: ActivityCosts; maximum: number; limit: number | null; rules: Rules; optIn: boolean | undefined }): Walk[] {
  const { costs, maximum, limit, rules, optIn } = input;
  const rest = { stamina: maximum, trainings: walk.trainings };
  const paid = (cost: number, counts = false): Walk => (cost > walk.stamina ? rest : { stamina: walk.stamina - cost, trainings: walk.trainings + (counts ? 1 : 0) });
  switch (choice.kind) {
    case 'rest': return [rest];
    case 'training': return [limit !== null && walk.trainings >= limit ? rest : paid(costs.training, true)];
    case 'expedition': return [paid(costs.expedition)];
    case 'dungeon': return costs.dungeon === undefined ? [] : [paid(costs.dungeon)];
    case 'arena': {
      const regular = paid(costs.arena);
      if (optIn === false || !isTournamentSlot(slotAt(slot * SLOT_MS), rules)) return [regular];
      return [regular, costs.tournament > walk.stamina ? regular : { stamina: walk.stamina - costs.tournament, trainings: walk.trainings }];
    }
  }
}

/**
 * The stamina the Rest of part `phase` (its next occurrence after the slot `nowMs` is in) will find and refill, by walking the parts
 * between: from the slot the clock is in, whose activity is already paid, strictly up to that Rest, each part of the draft `day` in
 * time order, as the boundary resolves them under `rules` (`RULES_V1` by default; the active rules' since Patch 1.6).
 * - Start from `owner.stamina.current`, or from the maximum when the running activity is a Rest (it refills when its slot ends).
 * - A Rest sets the maximum; any other part subtracts its cost (`costs[kind]`), or, when that is more than what is left, becomes a Rest
 *   (the boundary's "Resting (not enough stamina)") and refills to the maximum (`step`).
 * - Patch 1.6, v2: a Training request past the day's two actual Trainings is an ordinary Rest; a tournament evening's opted-in Arena
 *   (`tournamentOptIn` true, or not given: unknown) may be a free bracket or a paid Arena. The day's Training before the running slot is
 *   history this client does not read, and the draft's parts already played never stand for it: every way it may have gone is walked,
 *   and the number is told only when they all agree.
 * - Null when `costs` is null, a time or stamina is not a usable number, the owner's pending build takes effect at or before the
 *   Rest's slot (the walk would cost the new build's parts, and the Rest would refill its maximum), the slot the clock is in is not
 *   processed yet (`owner.processedSlotIndex` is before it: the stamina read does not include its debit or refill) or the clock is behind
 *   the processed slot (the walk would charge a part the server has already paid, Patch 1.6), the gladiator rests at home (an idle rest:
 *   no current activity, or `restingUntilSlot` set; its slots are not the draft's), or the ways the walk may go disagree.
 */
export function projectRest(input: {
  phase: Phase; nowMs: number; owner: Pick<OwnerState, 'stamina' | 'currentActivity' | 'pendingBuild' | 'processedSlotIndex'> & Partial<Pick<OwnerState, 'restingUntilSlot'>>;
  day: Schedule; costs: ActivityCosts | null; rules?: Rules; tournamentOptIn?: boolean;
}): RestGain {
  const { phase, nowMs, owner, day, costs, rules = RULES_V1, tournamentOptIn } = input;
  if (!costs || !known(owner) || !usable(nowMs)) return null;
  let running: number, target: number;
  try {
    running = slotAt(Math.floor(nowMs)).index;
    target = nextPhaseStart(phase, Math.floor(nowMs)) / SLOT_MS;
  } catch { return null; }
  if (owner.pendingBuild && owner.pendingBuild.effectiveSlotIndex <= target) return null;
  // The clock moves into a slot at its cutoff, but the server debits that slot's activity (and refills a Rest) only when it processes the
  // boundary, one to two and a half minutes later, setting `processedSlotIndex` in the same transaction. Until the owner read says so, its
  // stamina is not the running part's paid stamina, and no exact number can be told (`activityStatus`'s `behind` test).
  if (owner.processedSlotIndex < running) return null;
  // A clock behind the server's processed slot (held, or not yet synced): the stamina read already holds the debit of a slot the walk
  // would charge again (Patch 1.6, spec "Rest projections").
  if (owner.processedSlotIndex > running) return null;
  // Resting at home (the idle rest, Task 23.8): no activity runs, and the slots until it is back are not the draft's.
  if (owner.currentActivity === null || (owner.restingUntilSlot ?? null) !== null) return null;
  const { maximum } = owner.stamina;
  const limit = trainingDailyLimit(rules);
  const start = owner.currentActivity.kind === 'rest' ? maximum : owner.stamina.current;
  let walks: Walk[] = (limit === null ? [0] : trainingsSoFar(running, owner, limit)).map(trainings => ({ stamina: start, trainings }));
  for (let index = running + 1; index < target; index++) {
    // A new game day (its morning) starts the day's count again.
    if (index % PHASES.length === 0) walks = walks.map(walk => ({ ...walk, trainings: 0 }));
    const next = walks.flatMap(walk => step(walk, day[PHASES[index % PHASES.length]], index, { costs, maximum, limit, rules, optIn: tournamentOptIn }));
    walks = [...new Map(next.map(walk => [`${walk.stamina}:${walk.trainings}`, walk] as const)).values()];
  }
  const found = new Set(walks.map(walk => walk.stamina));
  return found.size === 1 ? { before: walks[0].stamina, maximum } : null;
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
