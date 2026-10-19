// Task 22.5: the client's replay retention rules, which agree with the server's (14-operations.sql): an activity's replay
// is kept while its summary says `available` and its expiry is after the server time; a tournament bout's replay is kept
// for `RULES_V1.retention.replayMs` after the tournament ends, when cleanup compacts its log to the fight summary.
import { describe, expect, it } from 'vitest';
import { RULES_V1 } from '@domain/rules-v1';
import { replayKept, tournamentEndsAtMs, tournamentReplayKept } from '@/lib/replay-retention';

const SLOT_MS = 4_800_000;

describe('replay retention by server time', () => {
  it('keeps a replay while its expiry is after the server time, and never once its summary says expired', () => {
    expect(replayKept({ state: 'available', expiresAtMs: 1000 }, 999)).toBe(true);
    expect(replayKept({ state: 'available', expiresAtMs: 1000 }, 1000)).toBe(false);
    expect(replayKept({ state: 'expired' }, 0)).toBe(false);
    // A server time that is not a number never keeps a replay.
    expect(replayKept({ state: 'available', expiresAtMs: 1000 }, Number.NaN)).toBe(false);
  });

  it('keeps a tournament bout replay until seven days after the tournament ends', () => {
    expect(RULES_V1.retention.replayMs).toBe(604_800_000);
    const end = 372_830 * SLOT_MS;
    expect(tournamentReplayKept(end, end)).toBe(true);
    expect(tournamentReplayKept(end, end + 604_800_000 - 1)).toBe(true);
    expect(tournamentReplayKept(end, end + 604_800_000)).toBe(false);
    expect(tournamentReplayKept(end, Number.NaN)).toBe(false);
  });

  it('reads when a tournament ends from its id or one of its bout ids: the end of its slot', () => {
    expect(tournamentEndsAtMs('tournament:372829:silver')).toBe(372_830 * SLOT_MS);
    expect(tournamentEndsAtMs('tournament:372829:silver:2:0')).toBe(372_830 * SLOT_MS);
    for (const bad of ['tournament:x:silver', 'tournament:1:platinum', 'tournament:1:silver:1', 'tournament:1:silver,id.neq.x', '', null]) {
      expect(tournamentEndsAtMs(bad as string), String(bad)).toBeNull();
    }
  });
});
