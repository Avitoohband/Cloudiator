import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TOURNAMENT_BOUT_ID, TOURNAMENT_ID, tournamentLookupId, tournamentLookupIdOrNull, tournamentRound, tournamentSlotOf } from '@/lib/tournament-id';

const imports = (path: string) => [...readFileSync(path, 'utf8').matchAll(/^import[^;]*?from '([^']+)'/gm)].map(m => m[1]);

describe('tournament lookup ids (a pure module)', () => {
  it('imports neither the API layer nor Supabase, and the stage core takes its lookup id from it', () => {
    expect(imports('src/lib/tournament-id.ts').filter(from => /lib\/api|supabase/.test(from) && !from.startsWith('@contracts/'))).toEqual([]);
    const stage = imports('src/game/tournament-stage.ts');
    expect(stage.filter(from => /lib\/api|@supabase/.test(from))).toEqual([]);
    expect(stage).toContain('../lib/tournament-id');
  });

  it('builds Task 19’s graph id and refuses an invalid slot or league', () => {
    expect(tournamentLookupId(301, 'gold')).toBe('tournament:301:gold');
    expect(TOURNAMENT_ID.test('tournament:301:gold')).toBe(true);
    for (const [slot, league] of [[-1, 'gold'], [1.5, 'gold'], [Number.NaN, 'gold'], [1e16, 'gold'], [301, 'platinum'], [301, '']] as const) {
      expect(() => tournamentLookupId(slot, league as never), `${slot} ${league}`).toThrow(RangeError);
      expect(tournamentLookupIdOrNull(slot, league), `${slot} ${league}`).toBeNull();
    }
    expect(tournamentLookupIdOrNull(301, 'champion')).toBe('tournament:301:champion');
    expect(tournamentLookupIdOrNull('301', 'gold')).toBeNull();
  });

  it('reads the slot of a tournament id and recognises bout ids', () => {
    expect(tournamentSlotOf('tournament:373387:bronze')).toBe(373387);
    for (const id of ['tournament:x:bronze', 'tournament:301:platinum', 'tournament:301:bronze:1:0', '']) expect(tournamentSlotOf(id), id).toBeNull();
    expect(TOURNAMENT_BOUT_ID.test('tournament:301:bronze:1:0')).toBe(true);
    for (const id of ['tournament:301:bronze', 'tournament:301:bronze:1:0,id.neq.x', 'tournament:301:bronze:x:0', 'tournament:301:bronze:1']) {
      expect(TOURNAMENT_BOUT_ID.test(id), id).toBe(false);
    }
  });

  it('names the round a tournament bout’s stage label is about, and nothing for any other label', () => {
    // The server writes `<round>: <victory|defeat>` for each bout of a run (10-tournament-results.sql: Final, Semifinal, Quarterfinal, Round r).
    expect(tournamentRound('Final: victory')).toBe('Final');
    expect(tournamentRound('Semifinal: defeat')).toBe('Semifinal');
    expect(tournamentRound('Quarterfinal: victory')).toBe('Quarterfinal');
    expect(tournamentRound('Round 2: defeat')).toBe('Round 2');
    expect(tournamentRound('Round 12: victory')).toBe('Round 12');
    // An Arena bout, an unknown round, a label with no result word or a different case is no round.
    for (const label of ['Bout: victory', 'Bout: defeat', 'Final', 'Final: draw', 'final: victory', 'Semifinals: victory', 'Round: victory', 'Round 0: victory',
      'Round 02: victory', 'Round 1000: victory', 'Round x: victory', ' Final: victory', 'Final: victory ', 'Final: victory\nFinal: defeat', 'Tournament staging', '']) {
      expect(tournamentRound(label), JSON.stringify(label)).toBeNull();
    }
    expect(tournamentRound(undefined as never)).toBeNull();
    expect(tournamentRound(7 as never)).toBeNull();
  });
});
