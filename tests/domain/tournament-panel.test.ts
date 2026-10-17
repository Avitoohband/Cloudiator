import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TournamentView } from '@contracts/reads';
import { TOURNAMENT_PREPARE_GRACE_MS, renderTournament, tournamentPreparing, withoutTournamentLogs } from '@/game/tournament-stage';
import { createDisplayClock } from '@/game/display-clock';
import {
  RegistrationView, TournamentBracketView, TournamentCardNotice, TournamentNotice, TournamentPanel, TournamentScheduleView, readTournamentCard,
  type BracketModel, type RegistrationModel,
} from '@/features/tournaments/TournamentPanel';
import { viewerText } from '@/features/tournaments/tournament-text';
import { BattleReplay } from '@/features/arena/BattleReplay';
import { ARENA_GLADIATORS } from '../fixtures/arena-ids';
import { ownerFixture, worldFixture } from '../fixtures/domain';
import {
  TOURNAMENT_OWNER_TIMELINES, TOURNAMENT_SAMPLE_KEYS, TOURNAMENT_SAMPLES, TOURNAMENT_VIEWS, TOURNAMENTS, tournamentActivityId, tournamentAsOf, tournamentId,
  type TournamentKey,
} from '../fixtures/tournaments';

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
    // The seeded first round is public from the start: every bout names its pair, with no result.
    const named = (id: string | null) => TOURNAMENT_VIEWS.opening.entrants.find(e => e.gladiatorId === id)!.name;
    const slots = TOURNAMENT_VIEWS.opening.bracket!.slots;
    for (let p = 0; p < 4; p += 1) expect(words).toContain(`Bout ${p + 1} ${named(slots[2 * p])} vs ${named(slots[2 * p + 1])}`);
    expect(words).not.toMatch(/To be revealed|Pairings are revealed/);
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
    // A bye receiver knows from the start that its first bout comes in round 2.
    const bye = TOURNAMENT_VIEWS.midway.bracket!.slots.find((id, i, all) => id !== null && all[i ^ 1] === null)!;
    expect(viewerText(renderTournament(TOURNAMENT_VIEWS.midway, TOURNAMENTS.midway.startsAtMs + 5 * MIN, { viewerId: bye }), true, 'UTC'))
      .toBe('You are entered with a bye in the Quarterfinals. Your first bout is revealed at Sat 3 Oct, 18:00 UTC.');
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

  it('places entrants after settlement and shows rewards only for the viewer’s own placement, from its own timeline', () => {
    // No credited summary yet (the owner's timeline is read separately): the place only.
    expect(text(bracket('completed', 85))).toContain('Your placement: 5th.');
    expect(text(bracket('completed', 85))).not.toContain('Credited');
    const credited = TOURNAMENT_OWNER_TIMELINES[tournamentActivityId('completed', 'aster')].summary!;
    const words = text(bracket('completed', 85, { credited }));
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

describe('replays load on demand (2b review I1)', () => {
  const polled = (key: TournamentKey) => withoutTournamentLogs(TOURNAMENT_VIEWS[key]);
  const final = TOURNAMENT_VIEWS.completed.bouts.find(b => b.round === 3)!;

  it('offers a replay of every completed bout of a polled view, which carries no log', () => {
    const html = bracket('completed', 30, { round: 1 }, polled('completed'));
    expect(count(html, '>Watch replay<')).toBe(4);
    // Bouts in progress still name no winner and offer no replay; their timing comes from the fight summary.
    const live = bracket('completed', 20.1, { round: 1 }, polled('completed'));
    expect(count(text(live), 'Bout in progress')).toBe(4);
    expect(live).not.toContain('Watch replay');
    // How the winner won comes from the summary too.
    expect(text(bracket('pair', 79, {}, polled('pair')))).toContain('Both fell at 0 HP; a seeded tie-break decided it.');
  });

  it('says the replay is loading, or cannot be loaded, until its log arrives, and can be closed either way', () => {
    const loading = bracket('completed', 85, { replayBoutId: final.id, replayStatus: 'loading' }, polled('completed'));
    expect(text(loading)).toContain('Replay · Final, bout 1');
    expect(text(loading)).toContain('Loading the replay…');
    expect(loading).toContain('>Close replay<');
    expect(loading).not.toContain('Combat log');
    const failed = bracket('completed', 85, { replayBoutId: final.id, replayStatus: 'failed' }, polled('completed'));
    expect(text(failed)).toContain('This replay cannot be loaded right now. Try again shortly.');
    expect(failed).toContain('>Close replay<');
    // Once the log is merged the replay plays as before.
    expect(text(bracket('completed', 85, { replayBoutId: final.id, replayStatus: null }))).toContain('Combat log');
  });
});

describe('the tournament being prepared (2b review M4; Task 19 R3 and R5)', () => {
  const slot = TOURNAMENTS.completed.startsAtMs / 4_800_000;
  const tid = tournamentId('completed');
  const start = TOURNAMENTS.completed.startsAtMs;
  const GRACE = 300_000;

  it('treats a missing view as being prepared for five minutes after the cutoff, for every viewer', () => {
    expect(TOURNAMENT_PREPARE_GRACE_MS).toBe(GRACE);
    // R3: within the grace a missing view reads as being prepared whatever the viewer: a visitor (no processed slot), a
    // gladiator created after the cutoff (processed slot already the tournament's) and a player whose slot lags.
    for (const processed of [null, slot, slot - 1]) {
      expect(tournamentPreparing(tid, start, processed), `${processed} at the cutoff`).toBe(true);
      expect(tournamentPreparing(tid, start + MIN, processed), `${processed} at +1 min`).toBe(true);
      expect(tournamentPreparing(tid, start + GRACE - 1, processed), `${processed} just before the grace ends`).toBe(true);
    }
    // From the end of the grace only an unprocessed owner slot still tells that the slot is being prepared.
    expect(tournamentPreparing(tid, start + GRACE, null)).toBe(false);
    expect(tournamentPreparing(tid, start + GRACE, slot)).toBe(false);
    expect(tournamentPreparing(tid, start + GRACE, slot - 1)).toBe(true);
    expect(tournamentPreparing(tid, start + 80 * MIN - 1, slot - 1)).toBe(true);
    // Never before the cutoff or after the slot, for another slot's tournament or for a malformed id.
    for (const processed of [null, slot, slot - 1]) {
      expect(tournamentPreparing(tid, start - 1, processed)).toBe(false);
      expect(tournamentPreparing(tid, start + 80 * MIN, processed)).toBe(false);
      expect(tournamentPreparing(tournamentId('pair'), start + MIN, processed)).toBe(false);
      expect(tournamentPreparing('tournament:x:bronze', start + MIN, processed)).toBe(false);
    }
  });

  it('renders the card with a not-found gateway and a lagging processed slot', async () => {
    const asked: string[] = [];
    const gateway = { tournament: async (id: string) => { asked.push(id); throw Object.assign(new Error('missing'), { code: 'not-found' as const }); } };
    const read = await readTournamentCard(gateway, tid);
    expect(read).toEqual({ view: null, failure: 'not-found' });
    expect(asked).toEqual([tid]);
    const card = (failure: 'not-found' | 'unavailable', processedSlotIndex: number | null, now: number) =>
      text(renderToStaticMarkup(createElement(TournamentCardNotice, { id: tid, failure, now, processedSlotIndex })));
    // Six minutes after the cutoff, past the grace, the owner's processed slot still lags: still being prepared.
    expect(card(read.failure!, slot - 1, start + 6 * MIN)).toContain('Tournament being prepared');
    expect(card(read.failure!, slot - 1, start + 6 * MIN)).not.toContain('No tournament matches');
    // Once the owner's slot is published, a missing view means no tournament in this league.
    expect(card(read.failure!, slot, start + 6 * MIN)).toContain('No tournament matches this selection.');
    // A visitor and a gladiator created after the cutoff: being prepared a minute after the cutoff, and not from +300 s.
    for (const processed of [null, slot]) {
      expect(card(read.failure!, processed, start + MIN), `${processed} at +1 min`).toContain('Tournament being prepared');
      expect(card(read.failure!, processed, start + GRACE), `${processed} at +300 s`).toContain('No tournament matches this selection.');
      expect(card(read.failure!, processed, start + GRACE + MIN), `${processed} at +360 s`).toContain('No tournament matches this selection.');
    }
    // Never before the cutoff, and a failed read is never "being prepared".
    expect(card(read.failure!, slot - 1, start - 1)).toContain('No tournament matches this selection.');
    expect(card('unavailable', slot - 1, start + MIN)).toContain('Tournament brackets cannot be loaded right now.');
    // Any other failure of the gateway reads as unavailable.
    const broken = await readTournamentCard({ tournament: async () => { throw new Error('network'); } }, tid);
    expect(broken).toEqual({ view: null, failure: 'unavailable' });
    const view = await readTournamentCard({ tournament: async () => TOURNAMENT_VIEWS.completed }, tid);
    expect(view).toEqual({ view: TOURNAMENT_VIEWS.completed, failure: null });
  });

  it('says “Tournament being prepared” in place of “No tournament matches” in that window', () => {
    const notice = (failure: 'not-found' | 'unavailable', preparing: boolean) =>
      text(renderToStaticMarkup(createElement(TournamentNotice, { failure, preparing })));
    expect(notice('not-found', true)).toContain('Tournament being prepared');
    expect(notice('not-found', true)).toContain('Entrants and the bracket appear here once this slot’s entries are processed, usually within about two minutes of the start.');
    expect(notice('not-found', true)).not.toContain('No tournament matches');
    expect(notice('not-found', false)).toContain('No tournament matches this selection.');
    expect(notice('unavailable', true)).toContain('Tournament brackets cannot be loaded right now.');
    expect(renderToStaticMarkup(createElement(TournamentNotice, { failure: 'not-found', preparing: true }))).toContain('role="status"');
  });
});

describe('the live Tournaments panel before the shared clock has the server’s time (Task 13.4 review M1)', () => {
  const start = TOURNAMENTS.completed.startsAtMs;
  const reads = { tournament: async () => TOURNAMENT_VIEWS.completed };
  const unsynced = () => createDisplayClock(() => 0, () => start + 10 * MIN);
  type PanelProps = Parameters<typeof TournamentPanel>[0];
  const panel = (props: Partial<PanelProps>) => text(renderToStaticMarkup(createElement(TournamentPanel,
    { reads, owner: null, clock: unsynced(), fixture: false, syncError: null, viewer: 'visitor', ...props } as PanelProps)));

  it('offers the league picker only to a visitor or a viewer without a gladiator, never while a player’s owner loads (13.4 M4)', () => {
    const clock = unsynced();
    clock.sync(start + 10 * MIN);
    const html = (props: Partial<PanelProps>) => renderToStaticMarkup(createElement(TournamentPanel,
      { reads, owner: null, clock, fixture: false, syncError: null, ...props } as PanelProps));
    for (const viewer of ['visitor', 'no-gladiator'] as const) expect(html({ viewer }), viewer).toContain('aria-label="League"');
    // A signed-in player whose owner is still loading: no picker, and no Bronze card read before the owner's league is known.
    const loading = html({ viewer: 'loading' });
    expect(loading).not.toContain('aria-label="League"');
    expect(text(loading)).toContain('Loading your gladiator’s tournament…');
    expect(text(loading)).not.toContain('Loading the tournament…');
    expect(html({ viewer: 'player', owner: ownerFixture })).not.toContain('aria-label="League"');
  });

  it('says brackets cannot be shown without a reader, whatever the clock and the sync', () => {
    for (const syncError of [null, 'unavailable'] as const) {
      const words = panel({ reads: null, syncError });
      expect(words).toContain('Tournament brackets cannot be shown in this build yet.');
      expect(words).not.toContain('Loading the tournament');
    }
  });

  it('says brackets cannot be loaded while the revision read fails, and waits for the clock otherwise', () => {
    const failed = panel({ syncError: 'unavailable' });
    expect(failed).toContain('Tournament brackets cannot be loaded right now.');
    expect(failed).not.toContain('Loading the tournament');
    expect(panel({ syncError: 'unauthenticated' })).toContain('Tournament brackets cannot be loaded right now.');
    // No failure yet: the panel waits for the server's time before it names a slot's tournament.
    const waiting = panel({});
    expect(waiting).toContain('Loading the tournament…');
    expect(waiting).not.toMatch(/cannot be (loaded|shown)/);
    // Once the clock has the server's time, the card reads its tournament even if a later revision read failed.
    const clock = unsynced();
    clock.sync(start + 10 * MIN);
    const synced = panel({ clock, syncError: 'unavailable' });
    expect(synced).not.toContain('cannot be loaded');
    expect(synced).toContain('Loading the tournament…');
  });
});
