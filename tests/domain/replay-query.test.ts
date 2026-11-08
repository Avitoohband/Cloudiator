import { describe, expect, it } from 'vitest';
import { partyReplayHref, replayQuery } from '@/features/dungeon/replay-query';

const activityId = 'a1d0c2e4-5f60-4b7a-9c3d-1e2f3a4b5c61';
const runId = 'dungeon:373237:wolf-den:1';
const query = (text: string) => replayQuery(new URLSearchParams(text));

describe('the fixed replay address', () => {
  it('preserves the legacy activity and stage without naming a party fight', () => {
    expect(query(`activity=${activityId}&stage=encounter-2`)).toEqual({ kind: 'activity', activityId, stageId: 'encounter-2' });
  });

  it('round-trips exactly one canonical party fight without naming an activity', () => {
    const ref = { runId, ordinal: 4 } as const;
    const href = partyReplayHref(ref, true);
    expect(href).toBe('/replay/?mode=fixture&run=dungeon%3A373237%3Awolf-den%3A1&fight=4');
    expect(replayQuery(new URL(`http://localhost${href}`).searchParams)).toEqual({ kind: 'party', ref });
  });

  it('rejects malformed or mixed replay addresses before a route can choose a reader', () => {
    for (const text of [
      `run=${runId}`, 'fight=3', 'run=unknown&fight=3', `run=${runId}&fight=0`, `run=${runId}&fight=5`,
      `run=${runId}&fight=01`, `run=${runId}&fight=1.0`, `run=${runId}&fight=1&fight=2`,
      `run=${runId}&run=${runId}&fight=2`, `run=${runId}&fight=2&activity=${activityId}`, `run=${runId}&fight=2&stage=s1`,
    ]) expect(query(text), text).toEqual({ kind: 'unavailable' });
  });
});
