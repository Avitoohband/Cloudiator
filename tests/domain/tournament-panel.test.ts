import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TournamentView } from '@contracts/reads';
import { renderTournament } from '@/game/tournament-stage';
import { RegistrationView, TournamentBracketView, TournamentScheduleView, type BracketModel, type RegistrationModel } from '@/features/tournaments/TournamentPanel';
import { viewerText } from '@/features/tournaments/tournament-text';
import { BattleReplay } from '@/features/arena/BattleReplay';
import { ARENA_GLADIATORS } from '../fixtures/arena-ids';
import { ownerFixture, worldFixture } from '../fixtures/domain';
import { TOURNAMENT_SAMPLE_KEYS, TOURNAMENT_SAMPLES, TOURNAMENT_VIEWS, TOURNAMENTS, tournamentAsOf, tournamentId, type TournamentKey } from '../fixtures/tournaments';

const MIN = 60_000;
const noop = () => {};
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, '\'').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
const ASTER = ARENA_GLADIATORS.aster.id;

function bracket(key: TournamentKey, minute: number, overrides: Partial<BracketModel> = {}, view: TournamentView = TOURNAMENT_VIEWS[key]): string {
  const state = renderTournament(view, TOURNAMENTS[key].startsAtMs + minute * MIN, { viewerId: ASTER });
  const model: BracketModel = { state, round: state.currentRound, replayBoutId: null, viewerId: ASTER, timeZone: 'UTC', ...overrides };
  return renderToStaticMarkup(createElement(TournamentBracketView, { model, onRound: noop, onWatch: noop, onCloseReplay: noop }));
}
function registration(now: number, overrides: Partial<RegistrationModel> = {}): string {
  const model: RegistrationModel = { optIn: ownerFixture.tournamentOptIn, busy: false, message: null, displayNowMs: now, timeZone: 'UTC',
    owner: { afternoon: ownerFixture.schedule.afternoon, stamina: ownerFixture.stamina.current }, ...overrides };
  return renderToStaticMarkup(createElement(RegistrationView, { model, onToggle: noop }));
}

describe('tournament registration', () => {
  it('shows the owner’s opt-in, the entry rules and what a change applies to before the cutoff', () => {
    const html = registration(worldFixture.serverNowMs);
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*>/);
    expect(/<input[^>]*type="checkbox"[^>]*>/.exec(html)![0]).not.toContain('checked');
    const words = text(html);
    expect(words).toContain('Automatically enter tournaments');
    for (const rule of ['automatic entry switched on', 'Arena scheduled for the afternoon', 'at least 25 stamina at the cutoff',
      'With automatic entry off, an Arena afternoon stays a normal Arena bout', 'A change made after a tournament’s cutoff applies from the next tournament']) {
      expect(words).toContain(rule);
    }
    expect(words).toContain('A change now applies to the next tournament, Sat 10 Oct, 17:20 UTC, if it is saved before that cutoff.');
    // The owner's own checklist: off, an Expedition afternoon, stamina now.
    expect(words).toContain('Automatic entry Off');
    expect(words).toContain('Afternoon schedule Expedition: Woodland Path (not Arena)');
    expect(words).toContain('Stamina now 104 (25 needed at the cutoff)');
    expect(/<input[^>]*checked/.test(registration(worldFixture.serverNowMs, { optIn: true }))).toBe(true);
  });

  it('says a toggle during a running tournament applies only from the next one', () => {
    const running = TOURNAMENTS.opening.startsAtMs + 5 * MIN;
    const words = text(registration(running));
    expect(words).toContain('Entries for the tournament running now were fixed at its 17:20 UTC cutoff.');
    expect(words).toContain('A change now applies from the next tournament, Sat 10 Oct, 17:20 UTC.');
  });

  it('shows a result message and disables the box while a change is being sent or without a gladiator', () => {
    const html = registration(worldFixture.serverNowMs, { busy: true, message: { kind: 'status', text: 'Registration changes are unavailable in this preview. Your setting is unchanged.' } });
    expect(/<input[^>]*type="checkbox"[^>]*>/.exec(html)![0]).toContain('disabled');
    expect(html).toContain('role="status"');
    expect(text(html)).toContain('unavailable in this preview');
    const signedOut = registration(worldFixture.serverNowMs, { optIn: null, owner: null });
    expect(/<input[^>]*type="checkbox"[^>]*>/.exec(signedOut)![0]).toContain('disabled');
    expect(text(signedOut)).toContain('Create a gladiator to register');
  });
});

describe('tournament schedule', () => {
  it('counts down to the next tournament in local time with the UTC time beside it', () => {
    const words = text(renderToStaticMarkup(createElement(TournamentScheduleView, { now: worldFixture.serverNowMs, timeZone: 'Europe/Berlin' })));
    expect(words).toContain('Next tournament Sat 10 Oct, 19:20 GMT+2 (Sat 10 Oct, 17:20 UTC) Starts in 16 h 40 min');
    const running = text(renderToStaticMarkup(createElement(TournamentScheduleView, { now: TOURNAMENTS.opening.startsAtMs + 5 * MIN, timeZone: 'Europe/Berlin' })));
    expect(running).toContain('A tournament is running now: it started Wed 7 Oct, 19:20 GMT+2 (Wed 7 Oct, 17:20 UTC) and settles at minute 80.');
    expect(running).toContain('Next tournament Sat 10 Oct, 19:20 GMT+2');
  });
});

describe('tournament bracket', () => {
  it('shows entrants and the bracket shape at the start, with one Result preparing and no winner before round 1', () => {
    const html = bracket('opening', 5);
    const words = text(html);
    expect(count(words, 'Result preparing')).toBe(1);
    expect(html).not.toContain('data-winner-id');
    expect(words).toContain('8-slot bracket · 3 rounds · 0 byes');
    expect(words).toContain('Entrants (8)');
    for (const name of ['Aster', 'Bellator', 'Cassia', 'Corvina', 'Nerva', 'Severus', 'Titus', 'Varro']) expect(words).toContain(name);
    expect(words).toContain('Pairings are revealed with the round');
    expect(words).toContain('You are entered. Your first bout is revealed at Wed 7 Oct, 17:40 UTC.');
    // Rounds are tabs; the round in play is selected.
    expect(html).toContain('role="tablist"');
    expect(count(html, 'role="tab"')).toBe(3);
    expect(html).toMatch(/aria-selected="true"[^>]*>Quarterfinals</);
    expect(html).not.toContain('Watch replay');
  });

  it('marks a due round whose results are not published as preparing, never inventing one', () => {
    const words = text(bracket('midway', 65));
    expect(words).toContain('Processing results');
    expect(count(words, 'Result preparing')).toBe(1);
    expect(words).toContain('These results were due at Sat 3 Oct, 18:20 UTC but are not published yet. They appear here as soon as they are revealed.');
    expect(words).toContain('You are not entered in this tournament.');
  });

  it('says the viewer advances only after a shown win or bye, and that a due but unpublished result is not published yet', () => {
    // The opening view was read at minute 5: by minute 25 round 1 is due, but Aster's result is not published.
    const words = text(bracket('opening', 25));
    expect(words).toContain('Processing results');
    expect(words).toContain('Your Quarterfinals result is not published yet. It appears here as soon as it is revealed.');
    expect(words).not.toContain('You advance');
    const own = (key: TournamentKey, minute: number, name: keyof typeof ARENA_GLADIATORS) =>
      viewerText(renderTournament(TOURNAMENT_VIEWS[key], TOURNAMENTS[key].startsAtMs + minute * MIN, { viewerId: ARENA_GLADIATORS[name].id }), true, 'UTC');
    // A shown win or a bye in every due round: the viewer advances.
    expect(own('completed', 30, 'varro')).toBe('You advance. Your next bout is revealed at Sat 26 Sept, 18:00 UTC.');
    expect(own('midway', 30, 'gallus')).toBe('You advance. Your next bout is revealed at Sat 3 Oct, 18:00 UTC.');
    // The mid-way final is due at minute 60 but unpublished: both finalists wait for it, and nobody advances.
    expect(own('midway', 65, 'decimus')).toBe('Your Final result is not published yet. It appears here as soon as it is revealed.');
    expect(own('midway', 65, 'aurelia')).toBe('Your Final result is not published yet. It appears here as soon as it is revealed.');
    // A round 1 bout is revealed but still being fought: no advance yet.
    expect(own('completed', 20.1, 'varro')).toBe('Your bout is being fought now.');
  });

  it('shows byes, revealed winners by winnerId and the bouts in progress', () => {
    const r1 = bracket('midway', 30, { round: 1 });
    expect(count(r1, 'advances on a bye')).toBe(3);
    expect(count(r1, 'data-winner-id')).toBe(4);
    expect(text(r1)).toContain('8-slot bracket · 3 rounds · 3 byes');
    const liveHtml = bracket('completed', 20.1, { round: 1 });
    const live = text(liveHtml);
    expect(count(live, 'Bout in progress')).toBe(4);
    // A bout being fought names no winner and offers no replay until it has ended.
    expect(liveHtml).not.toContain('data-winner-id');
    expect(liveHtml).not.toContain('Watch replay');
    expect(live).toContain('Your bout is being fought now.');
    const tie = bracket('pair', 79);
    expect(text(tie)).toContain('Both fell at 0 HP; a seeded tie-break decided it.');
    expect(tie).toContain(`data-winner-id="${ASTER}"`);
    expect(text(tie)).toContain('You are the champion of this tournament!');
  });

  it('shows the owner’s loss and spectating, and replays only completed bouts inline, never through /replay/', () => {
    const html = bracket('completed', 30, { round: 1 });
    const words = text(html);
    expect(words).toContain('You were eliminated in the Quarterfinals. You stay in the tournament as a spectator until it ends at Sat 26 Sept, 18:40 UTC; this slot has no other activity for you.');
    expect(count(html, '>Watch replay<')).toBe(4);
    expect(html).not.toMatch(/href="[^"]*replay/);
    expect(words).toMatch(/Eliminated in the Quarterfinals · spectating/);
  });

  it('nests the inline replay’s headings under the panel’s, while BattleReplay keeps its h1 by default', () => {
    const final = (v: TournamentView) => v.bouts.find(b => b.round === 3)!;
    const boutId = final(TOURNAMENT_VIEWS.completed).id;
    const html = bracket('completed', 85, { replayBoutId: boutId });
    const headings = [...html.matchAll(/<h([1-6])[^>]*>(.*?)<\/h\1>/g)].map(m => [Number(m[1]), text(m[2]).trim()]);
    // The card title is an h4 (under the tab's h2 and the Brackets h3); the replay section an h5 inside it.
    expect(headings).toEqual([[4, 'Bronze tournament'], [5, 'Entrants (8)'], [5, 'Replay · Final, bout 1'], [6, 'Severus vs Varro'],
      [6, 'Result'], [6, 'Fighters'], [6, 'Combat log']]);
    const log = final(TOURNAMENT_VIEWS.completed).revealedResult!.battleLog!;
    const stage = { id: boutId, kind: 'bout' as const, label: 'Tournament · Final', revealedAtMs: 0, startedAtMs: 0, endsAtMs: log.durationMs };
    const standalone = renderToStaticMarkup(createElement(BattleReplay, { view: { kind: 'replay', selected: 0, summary: null, battles: [{ log, stage }] } }));
    expect([...standalone.matchAll(/<h([1-6])[^>]*>(.*?)<\/h\1>/g)].map(m => [Number(m[1]), text(m[2]).trim()]))
      .toEqual([[1, 'Severus vs Varro'], [2, 'Result'], [2, 'Fighters'], [2, 'Combat log']]);
  });

  it('places entrants after settlement and shows rewards only for the viewer’s own placement', () => {
    const words = text(bracket('completed', 85));
    expect(words).toContain('Completed');
    expect(words).toContain('Champion: Varro');
    expect(words).toMatch(/Place Gladiator 1 Varro 2 Severus 3 Cassia 3 Decimus 5 Aster 5 Aurelia 5 Bellator 5 Corvina/);
    expect(words).toContain('Your placement: 5th. Credited: +7 renown.');
    expect(count(words, 'renown')).toBe(1);
    expect(words).not.toMatch(/money|\+80|\+52/);
    expect(text(bracket('completed', 79))).not.toMatch(/Your placement|Place Gladiator/);
  });

  it('explains a slot with too few entrants: regular Arena this slot', () => {
    const words = text(bracket('insufficient', 30));
    expect(words).toContain('Not held: too few entrants');
    expect(words).toContain('Only 1 gladiator qualified in the Gold league, so no bracket was held: that entrant fought regular Arena this slot (with an NPC opponent where needed).');
    expect(words).not.toContain('Result preparing');
  });

  it('renders names as text', () => {
    const view = structuredClone(TOURNAMENT_VIEWS.opening);
    view.entrants[1].name = '<img src=x onerror=alert(1)>';
    const html = bracket('opening', 5, {}, view);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('fixture samples', () => {
  it('carry the server time each view was projected at, where each shows what its label says', () => {
    expect(TOURNAMENT_SAMPLES.map(s => [s.id, s.asOfMs])).toEqual(TOURNAMENT_SAMPLE_KEYS.map(key => [tournamentId(key), tournamentAsOf(key)]));
    const shown = (key: TournamentKey) => {
      const sample = TOURNAMENT_SAMPLES.find(s => s.id === tournamentId(key))!;
      return renderTournament(TOURNAMENT_VIEWS[key], sample.asOfMs, { viewerId: ASTER });
    };
    // 'started, before round 1'
    expect([shown('opening').status, shown('opening').rounds.map(r => r.due)]).toEqual(['active', [false, false, false]]);
    // 'five entrants with byes, mid-way'
    expect([shown('midway').status, shown('midway').shape?.byes, shown('midway').rounds.map(r => r.due)]).toEqual(['active', 3, [true, true, false]]);
    // 'final revealed, placements pending'
    const late = shown('late');
    expect([late.status, late.rounds.map(r => r.due && !r.delayed), late.championId !== null, late.placements]).toEqual(['active', [true, true, true], true, []]);
    // 'completed; you lost in the first round'
    expect([shown('completed').status, shown('completed').viewer.entrant?.eliminatedInRound, shown('completed').placements.length]).toEqual(['completed', 1, 8]);
    // 'two entrants, a 0 HP tie-break final', 'one qualifier, regular Arena instead', 'scheduled, entries not yet fixed'
    expect([shown('pair').status, shown('pair').championId]).toEqual(['completed', ASTER]);
    expect(shown('insufficient').status).toBe('insufficient-entrants');
    expect([shown('upcoming').status, shown('upcoming').entrants]).toEqual(['scheduled', []]);
  });
});
