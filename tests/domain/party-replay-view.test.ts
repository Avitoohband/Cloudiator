import { expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PartyAttack, PartyBattleLog } from '@contracts/events';
import { PartyFightReplay, PartyReplayView } from '@/features/dungeon/PartyReplay';
import cleared from '../fixtures/dungeons/member-fell-party-cleared.json';
import lost from '../fixtures/dungeons/room-lost.json';
import full from '../fixtures/dungeons/full-victory.json';

const logOf = (fixture: typeof cleared | typeof lost | typeof full, ordinal: number) =>
  fixture.fights[ordinal - 1].log as unknown as PartyBattleLog;
const noop = () => undefined;
const view = (log: PartyBattleLog, positionMs = 0) => renderToStaticMarkup(createElement(PartyReplayView, {
  log, positionMs, playing: false, speed: 'normal', onToggle: noop, onSeek: noop, onSpeed: noop, onRestart: noop, onSkip: noop,
})).replaceAll('<!-- -->', '');

it('names playback controls and shows six recorded health meters before the first attack', () => {
  const html = view(logOf(full, 1));
  expect(html).toContain('aria-label="Party replay controls"');
  for (const label of ['Play', 'Speed 1×', 'Restart', 'Skip to the result', 'Replay position']) {
    expect(html).toContain(`aria-label="${label}"`);
  }
  expect(html.match(/role="meter"/g)).toHaveLength(6);
  expect(html).toMatch(/aria-label="Aster health"[^>]*aria-valuemax="110"[^>]*aria-valuenow="110"/);
  expect(html).not.toMatch(/Party victory|Party defeat/);
});

it('keeps the knockout meter and party result distinct, and leaves the fallen member out of the next fight', () => {
  const room = logOf(cleared, 2);
  const after = view(room, room.durationMs);
  expect(after).toMatch(/aria-label="Aster health"[^>]*aria-valuenow="0"/);
  expect(after).toContain('Party victory');
  expect(after).toContain('Aster knocked out');
  expect(after).toContain('aria-label="Bot">BOT');
  expect(after).not.toContain('Hired');
  const next = view(logOf(cleared, 3));
  expect(next).not.toContain('Aster');
  expect(next).toMatch(/aria-label="Varro health"[^>]*aria-valuenow="291"/);
});

it('withholds the logged loss until the end of the losing room replay', () => {
  const room = logOf(lost, 3);
  expect(view(room, room.durationMs - 1)).not.toContain('Party defeat');
  expect(view(room, room.durationMs)).toContain('Party defeat');
});

it('shows the major’s sweep and every recorded health change at the same timestamp', () => {
  const major = logOf(full, 4);
  expect(view(major, 5_199)).not.toContain('Sweep · simultaneous hits');
  const sweep = view(major, 5_200);
  expect(sweep).toContain('Alpha of the Den');
  expect(sweep).toContain('Sweep · simultaneous hits');
  expect(sweep).toMatch(/aria-label="Aster health"[^>]*aria-valuenow="64"/);
  expect(sweep).toMatch(/aria-label="Varro health"[^>]*aria-valuenow="169"/);
  expect(sweep).toMatch(/aria-label="Cassia health"[^>]*aria-valuenow="104"/);
});

it('shows a decisive sweep together with the recorded result at the final timestamp', () => {
  const major = logOf(full, 4);
  const sweep = major.events.filter((event): event is PartyAttack => event.elapsedMs === 5_200 && event.kind === 'attack');
  const decisive: PartyBattleLog = {
    ...major, durationMs: 5_200, winnerSide: 1, finalHp: [0, 0, 0, 754],
    events: [...sweep.map((event, sequence) => {
      const healthBefore = major.participants.find(unit => unit.id === event.defenderId)!.initialHealth;
      return { ...event, sequence, damage: healthBefore, healthBefore, healthAfter: 0 };
    }),
      { kind: 'victory', sequence: sweep.length, elapsedMs: 5_200, winnerSide: 1, reason: 'defeat' }],
  };
  const end = view(decisive, decisive.durationMs);
  expect(end).toContain('Sweep · simultaneous hits');
  expect(end).toContain('Party defeat');
});

it('identifies a logged hireling and explains a zero-HP tiebreak using the declared winner', () => {
  const major = logOf(full, 4);
  const tied: PartyBattleLog = { ...major, participants: [
    { ...major.participants[0], role: 'hireling', gladiatorId: null, name: 'Hired Guard' }, major.participants[3],
  ], events: [{ kind: 'victory', sequence: 0, elapsedMs: major.durationMs, winnerSide: 1, reason: 'tie-break' }],
  finalHp: [0, 0], winnerSide: 1, victoryReason: 'tie-break', tieBreakReason: 'simultaneous-defeat' };
  const html = view(tied, tied.durationMs);
  expect(html).toMatch(/Hired Guard.*?>Hired</);
  expect(html).toContain('Party defeat');
  expect(html).toContain('Both sides fell together');
});

it('keeps the caller’s Back control available while the fight is loading', () => {
  const html = renderToStaticMarkup(createElement(PartyFightReplay, {
    gateway: { dungeonFight: async () => logOf(full, 1) },
    fight: { runId: full.runId, ordinal: 1 }, onBack: noop, backLabel: 'Back to run', headingLevel: 2,
  }));
  expect(html).toContain('Back to run');
  expect(html).toContain('Loading the fight replay');
  expect(html).not.toContain('Party victory');
});
