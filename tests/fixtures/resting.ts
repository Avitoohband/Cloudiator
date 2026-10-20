// Task 23.9 fixtures for the idle rest (Task 23.8, RULES_V1.idle): a gladiator resting at home in the fixture preview's
// world, and for `?mode=fixture&as=resting` the owner resting in its current slot. Public fields only for the world actor.
import type { OwnerState, PublicActor, PublicProfile } from '../../supabase/functions/_shared/contracts/reads.ts';
import { worldFixture } from './domain.ts';
import { ARENA_OWNER } from './arena-build.ts';
import { fixtureUuid } from './arena-ids.ts';

/** How a resting gladiator reads in the public world (PublicActor.resting): at home, with no activity, times or stage. */
export function restingActor(actor: PublicActor): PublicActor {
  return { ...actor, location: 'camp', activityId: null, activityStatus: 'idle', startsAtMs: null, endsAtMs: null, visibleStage: null, resting: true };
}

/** Otho, whose owner has sent no activity signal for 14 days: listed among the gladiators, not drawn in the camp. */
export const RESTING_ACTOR: PublicActor = restingActor({
  gladiatorId: fixtureUuid('resting-gladiator-otho'), name: 'Otho', classId: 'berserker', equipmentSilhouettes: ['weapon-axe', 'offhand-shield', 'armor-light'],
  league: 'bronze', level: 5, phase: worldFixture.actors[0].phase, location: 'camp', activityId: null, activityStatus: 'idle',
  startsAtMs: null, endsAtMs: null, visibleStage: null, resting: true,
});
/** Otho's public profile (no standings row: a resting gladiator has not played this season). */
export const RESTING_PROFILE: PublicProfile = { actor: RESTING_ACTOR, combatStrength: 433, rating: 1000, prestige: [] };

/**
 * The fixture owner resting at home in the current slot (its checkpoint is that slot, so it has no current activity),
 * before its owner's presence: `restingUntilSlot` is null until a presence is answered (the fixture gateway then serves
 * `processedSlotIndex + 1`, as the server would).
 */
export const RESTING_OWNER: OwnerState = { ...ARENA_OWNER, currentActivity: null, processedSlotIndex: worldFixture.slotIndex, restingUntilSlot: null };
