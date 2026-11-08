// Engine-generated, public fight rows and per-member timelines. Regenerate with
// UPDATE_DUNGEON_FIXTURES=1 and tests/domain/dungeon-fixtures.test.ts; never run combat in the preview.
import type { DungeonId } from '../../supabase/functions/_shared/contracts/commands';
import type { ActivitySummary, PartyBattleLog, PublicActivitySummary, RevealedStage, RevealedTimeline } from '../../supabase/functions/_shared/contracts/events';
import fullVictory from './dungeons/full-victory.json';
import soloMajorLost from './dungeons/solo-major-lost.json';
import roomLost from './dungeons/room-lost.json';
import memberFell from './dungeons/member-fell-party-cleared.json';

export type DungeonFightRow = { run_id: string; ordinal: NonNullable<RevealedStage['fight']>['ordinal']; reveal_at_ms: number; log: PartyBattleLog };
type DungeonFixture = {
  activityId: string; dungeonId: DungeonId; runId: string; startsAtMs: number; gladiatorId: string; name: string; level: number;
  timeline: RevealedTimeline & { summary: ActivitySummary; completion: PublicActivitySummary };
  fights: DungeonFightRow[];
};

const sample = (json: unknown) => json as DungeonFixture;
export const DUNGEON_FIXTURES = {
  'full-victory': sample(fullVictory), 'solo-major-lost': sample(soloMajorLost), 'room-lost': sample(roomLost),
  'member-fell-party-cleared': sample(memberFell),
};
export type DungeonFixtureKey = keyof typeof DUNGEON_FIXTURES;

const LABELS: Record<DungeonFixtureKey, string> = {
  'full-victory': 'Wolf Den: party clears', 'solo-major-lost': 'Raider Stronghold: lost at the boss',
  'room-lost': 'Troll Hall: lost in room 3', 'member-fell-party-cleared': 'Wolf Den: party clears after a knockout',
};
export const DUNGEON_SAMPLES = (Object.keys(DUNGEON_FIXTURES) as DungeonFixtureKey[]).map(key => ({
  activityId: DUNGEON_FIXTURES[key].activityId, label: LABELS[key],
}));

export const DUNGEON_BY_ACTIVITY = new Map(Object.values(DUNGEON_FIXTURES).map(fixture => [fixture.activityId, fixture]));
export const DUNGEON_BY_RUN = new Map(Object.values(DUNGEON_FIXTURES).map(fixture => [fixture.runId, fixture]));
