import type { RevealedStage } from '@contracts/events';
import { parseDungeonFightRef } from '../../lib/api/reads';
import { isActivityId } from '../character/expedition-query';

type FightRef = NonNullable<RevealedStage['fight']>;
type ReplayQuery = { kind: 'party'; ref: FightRef }
  | { kind: 'activity'; activityId: string; stageId: string | null }
  | { kind: 'unavailable' };

export function replayQuery(search: Pick<URLSearchParams, 'get' | 'getAll' | 'has'>): ReplayQuery {
  if (search.has('run') || search.has('fight')) {
    if (search.has('activity') || search.has('stage')) return { kind: 'unavailable' };
    const runs = search.getAll('run'), fights = search.getAll('fight');
    if (runs.length !== 1 || fights.length !== 1 || !/^[1-4]$/.test(fights[0])) return { kind: 'unavailable' };
    const ref = parseDungeonFightRef(runs[0], Number(fights[0]));
    return ref ? { kind: 'party', ref } : { kind: 'unavailable' };
  }
  const activityId = search.get('activity');
  return activityId && isActivityId(activityId) ? { kind: 'activity', activityId, stageId: search.get('stage') } : { kind: 'unavailable' };
}

export function partyReplayHref(ref: FightRef, fixture: boolean): string {
  const params = new URLSearchParams(fixture ? { mode: 'fixture' } : {});
  params.set('run', ref.runId);
  params.set('fight', String(ref.ordinal));
  return `/replay/?${params}`;
}
