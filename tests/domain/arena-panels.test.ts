import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LeagueId } from '@contracts/commands';
import type { StandingRow } from '@contracts/reads';
import { renderArenaStage, ARENA_SLOT_MS } from '@/game/arena-stage';
import { ArenaCardView, type ArenaCardModel } from '@/features/arena/ArenaPanel';
import { StandingsView, readStandingsPages, type StandingsModel } from '@/features/arena/StandingsPanel';
import { NO_INJURY, NPC_DISCLOSURE, arenaUnavailableText, creditedLines, replayHref, resultText } from '@/features/arena/arena-text';
import { ARENA_ACTIVITIES, ARENA_GLADIATORS, ARENA_STANDINGS, ARENA_TIMELINES, arenaActivityId, arenaStandingsPage, type ArenaActivityKey } from '../fixtures/arena';
import { worldFixture } from '../fixtures/domain';
import { createFixtureGateway } from '@/lib/api/fixture-gateway';

const MIN = 60_000;
const NOW = worldFixture.serverNowMs;
const SLOT_START = NOW - (NOW % ARENA_SLOT_MS);
const noop = () => {};

function card(key: ArenaActivityKey, minute: number, overrides: Partial<ArenaCardModel> = {}): string {
  const { gladiator, slotsAgo, owner } = ARENA_ACTIVITIES[key];
  const entrantId = ARENA_GLADIATORS[gladiator].id;
  const state = renderArenaStage(ARENA_TIMELINES[arenaActivityId(key)], SLOT_START - slotsAgo * ARENA_SLOT_MS + minute * MIN, { entrantId, owner });
  const opponent = state.opponent ? { name: state.opponent.name, className: state.opponent.npc ? 'NPC fallback' : 'Berserker', rating: state.opponent.npc ? null : 1027 } : null;
  const model: ArenaCardModel = { state, owner, entrantName: ARENA_GLADIATORS[gladiator].name, opponent, fixture: true, ...overrides };
  return renderToStaticMarkup(createElement(ArenaCardView, { model, onWatch: noop, onClose: noop }));
}
const watch = (html: string) => /<button[^>]*>Watch replay<\/button>/.exec(html)?.[0] ?? '';
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('Arena card', () => {
  it('shows only the warm-up at minute 59, with the replay button disabled', () => {
    const html = card('ownerNpcWin', 59);
    expect(text(html)).toContain('Warming up');
    expect(watch(html)).toContain('disabled');
    expect(html).not.toContain(NPC_DISCLOSURE);
    expect(html).not.toMatch(/Iron Warden|Victory|Defeat|renown/);
  });

  it('discloses the NPC fallback at minute 60, with no outcome yet, and offers the replay once the bout has ended', () => {
    const html = card('ownerNpcWin', 60);
    expect(text(html)).toContain('Bout in progress');
    // Fix round 1, M3: mid-bout the replay would only say "not available yet".
    expect(watch(html)).toContain('disabled');
    expect(text(html)).toContain('The replay becomes available when the bout ends.');
    const ended = card('ownerNpcWin', 61);
    expect(watch(ended)).not.toContain('disabled');
    expect(text(ended)).toContain('The replay is the recorded bout.');
    expect(text(html)).toContain(NPC_DISCLOSURE);
    expect(text(html)).toContain('Iron Warden');
    // Nothing but the disclosure itself mentions renown before the result is credited.
    expect(text(html).replace(NPC_DISCLOSURE, '')).not.toMatch(/Victory|Defeat|renown|Current rating/);
  });

  it('shows the human opponent with class and current rating, the result after the bout, and credits only at minute 80', () => {
    const before = text(card('ownerHumanWin', 79));
    expect(before).toContain('Varro');
    expect(before).toContain('Current rating 1027');
    expect(before).toContain('Victory');
    expect(before).toContain('Varro was defeated.');
    expect(before).toContain('Rewards and any rating change are credited at minute 80.');
    expect(before).not.toMatch(/\+10 renown|Rating \+13/);
    const after = text(card('ownerHumanWin', 80));
    expect(after).toContain('CREDITED AT MINUTE 80');
    expect(after).toContain('+10 renown');
    expect(after).toContain('Rating +13');
  });

  it('credits reduced renown and no rating change for NPC bouts, and reports losses without lasting injury', () => {
    expect(text(card('ownerNpcWin', 80))).toMatch(/\+3 renown.*No rating change/);
    const npcLoss = text(card('ownerNpcLoss', 80));
    expect(npcLoss).toContain('Defeat');
    expect(npcLoss).toContain(NO_INJURY);
    expect(npcLoss).toMatch(/No renown.*No rating change/);
    const humanLoss = text(card('ownerHumanLoss', 80));
    expect(humanLoss).toContain(NO_INJURY);
    expect(humanLoss).toMatch(/\+2 renown.*Rating −13/);
  });

  it('names the seeded tie-break winner at 0 HP', () => {
    const html = text(card('ownerTieBreak', 80));
    expect(html).toContain('Victory');
    expect(html).toContain('Both fighters fell at the same moment. A seeded tie-break named Aster the winner.');
  });

  it('never shows rewards to a spectator', () => {
    const html = text(card('varroSpectator', 85, { owner: false }));
    expect(html).toContain('Completed');
    expect(html).toContain('Rewards are private to the gladiator’s owner.');
    expect(html).toContain('Defeat');
    expect(html).not.toMatch(/renown|Rating [+−]|CREDITED/);
  });

  it('says Preparing when the bout is late and Processing results after minute 80', () => {
    const late = text(card('ownerDelayed', 65));
    expect(late).toContain('Preparing');
    expect(late).toContain('has not been published yet');
    expect(watch(card('ownerDelayed', 65))).toContain('disabled');
    expect(late).toContain('The replay becomes available once the bout is published.');
    expect(text(card('ownerDelayed', 30))).toContain('The replay becomes available when the bout is revealed at minute 60.');
    expect(text(card('ownerDelayed', 85))).toContain('Processing results');
  });

  it('never claims that minute 60 has passed while the slot start is unknown', () => {
    const state = renderArenaStage({ ...ARENA_TIMELINES[arenaActivityId('ownerDelayed')], stages: [] }, NOW, { entrantId: ARENA_GLADIATORS.aster.id, owner: true });
    expect(state).toMatchObject({ phase: 'preparing', startMs: null, minute: null });
    const html = text(renderToStaticMarkup(createElement(ArenaCardView, { model: { state, owner: true, entrantName: 'Aster', opponent: null, fixture: true }, onWatch: noop })));
    expect(html).toContain('Preparing');
    expect(html).toContain('has not been published yet');
    expect(html).not.toMatch(/Minute 60 has passed|MINUTE \d/);
    // With a known start, the late bout still says so.
    expect(text(card('ownerDelayed', 65))).toContain('Minute 60 has passed');
  });

  it('renders names as text', () => {
    const html = card('ownerHumanWin', 80, { entrantName: '<img src=x onerror=alert(1)>' });
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
  });

  it('links the expanded replay of the selected bout, keeping the fixture mode', () => {
    const replay = { activityId: arenaActivityId('ownerNpcWin'), stageId: `${arenaActivityId('ownerNpcWin')}:1` };
    expect(replayHref(replay, true)).toBe(`/replay/?mode=fixture&activity=${replay.activityId}&stage=${encodeURIComponent(replay.stageId)}`);
    expect(replayHref(replay, false)).toBe(`/replay/?activity=${replay.activityId}&stage=${encodeURIComponent(replay.stageId)}`);
  });

  it('words results and credits from the logged winner and the summary only', () => {
    const tie = { outcome: 'defeat' as const, winnerId: 'b', reason: 'tie-break' as const, tieBreakReason: 'equal-health-fraction' as const, finalHp: [5, 5] as const };
    expect(resultText(tie, { entrant: 'A', opponent: 'B' })).toEqual({ title: 'Defeat', detail: 'Time ran out with equal shares of health. A seeded tie-break named B the winner.' });
    const summary = ARENA_TIMELINES[arenaActivityId('ownerHumanLoss')].summary!;
    expect(creditedLines(summary)).toEqual(['+2 renown', 'Rating −13']);
    expect(creditedLines({ ...summary, ratingDelta: 0 })).toEqual(['+2 renown', 'Rating unchanged']);
  });

  it('tells a build without the Arena read apart from a read that failed or found nothing', () => {
    // The live game until Task 10's timeline read lands: no reader, so nothing to retry.
    expect(arenaUnavailableText('build')).toBe('The Arena card is not available in this build yet.');
    // A real read failure stays a temporary, retryable message.
    expect(arenaUnavailableText('unavailable')).toBe('Arena activity cannot be loaded right now. Only revealed stages are ever shown.');
    expect(arenaUnavailableText('unavailable')).not.toContain('build');
    expect(arenaUnavailableText('not-found')).toBe('No Arena activity matches this selection.');
  });
});

describe('Arena standings', () => {
  const page = arenaStandingsPage('bronze');
  const base: StandingsModel = {
    league: 'bronze', rows: page.rows, nextCursor: page.nextCursor, seasonId: page.seasonId, archived: false, status: 'ready',
    ownerId: ARENA_GLADIATORS.aster.id, own: { name: 'Aster', league: 'bronze', rating: 1015, renown: 25, combatStrength: 412 },
  };
  const view = (model: Partial<StandingsModel> = {}) => renderToStaticMarkup(createElement(StandingsView, { model: { ...base, ...model }, onLeague: noop, onMore: noop, onRetry: noop }));

  it('shows a page of at most 50 rows with rating, human wins and losses, markers and a More button', () => {
    const html = view();
    expect(html.match(/<tr/g)!.length - 1).toBe(50);
    expect(text(html)).toContain('Bronze league standings');
    expect(html).toContain('>More</button>');
    expect(html).toMatch(/Promoted/);
    expect(html).toMatch(/Inactive/);
    const aster = page.rows.find(r => r.gladiatorId === ARENA_GLADIATORS.aster.id)!;
    expect(html).toContain(`<tr aria-current="true"`);
    expect(text(html)).toContain(`${aster.rank} Aster ${aster.rating} ${aster.humanWins}–${aster.humanLosses} You`);
    expect(view({ nextCursor: null })).not.toContain('>More</button>');
  });

  it('shows the owner’s rating, renown and current combat strength separately, or not available', () => {
    expect(text(view())).toMatch(/Your standing League Bronze Rating 1015 Renown 25 Current combat strength 412/);
    expect(text(view({ own: { ...base.own!, combatStrength: null } }))).toContain('Current combat strength not available');
    expect(view({ own: null })).not.toContain('Your standing');
  });

  it('explains the leagues from the spec thresholds', () => {
    const html = text(view());
    for (const range of ['Bronze : index below 25', 'Silver : index 25–59', 'Gold : index 60–119', 'Champion : index 120 and above']) expect(html).toContain(range);
    expect(html).toContain('NPC fallback bouts never change rating');
  });

  it('says when a league is empty or standings cannot be read', () => {
    expect(text(view({ league: 'champion', rows: [], nextCursor: null }))).toContain('No standings in the Champion league yet.');
    expect(text(view({ rows: [], status: 'unavailable', nextCursor: null }))).toContain('Standings are not available in this build yet.');
  });

  it('tells a temporary read failure apart from a build without standings, and offers a retry', () => {
    const failed = view({ rows: [], status: 'failed', nextCursor: null });
    expect(text(failed)).toContain('The standings could not be loaded right now.');
    expect(failed).toMatch(/<button[^>]*>Try again<\/button>/);
    expect(failed).not.toContain('not available in this build');
    // A failed refresh keeps the rows already shown and says they may be out of date.
    const stale = view({ status: 'failed' });
    expect(stale.match(/<tr/g)!.length - 1).toBe(50);
    expect(text(stale)).toContain('The latest standings could not be loaded; these rows may be out of date.');
    expect(stale).toMatch(/<button[^>]*>Try again<\/button>/);
    expect(view({ rows: [], status: 'unavailable', nextCursor: null })).not.toContain('Try again');
  });

  it('renders names as text', () => {
    const row: StandingRow = { ...page.rows[0], name: '<b>Bold</b>' };
    const html = view({ rows: [row] });
    expect(html).toContain('&lt;b&gt;Bold&lt;/b&gt;');
  });
});

describe('standings pages', () => {
  const reader = createFixtureGateway();

  it('reads as many pages as were loaded, so a refresh keeps the rows loaded with More', async () => {
    const one = await readStandingsPages(reader, 'bronze', 1);
    expect(one).toMatchObject({ league: 'bronze', pages: 1, seasonId: '1', archived: false });
    expect(one.rows).toEqual(ARENA_STANDINGS.bronze.slice(0, 50));
    expect(one.nextCursor).not.toBeNull();
    const two = await readStandingsPages(reader, 'bronze', 2);
    expect(two).toMatchObject({ pages: 2, nextCursor: null });
    expect(two.rows).toEqual(ARENA_STANDINGS.bronze);
    // Asking for more pages than exist stops at the last one.
    expect(await readStandingsPages(reader, 'bronze', 5)).toEqual(two);
    expect((await readStandingsPages(reader, 'silver', 3)).rows).toEqual(ARENA_STANDINGS.silver);
  });

  it('stops when a reader ignores the cursor, without repeating rows', async () => {
    const ignoring = { standings: async (league: LeagueId) => arenaStandingsPage(league) };
    const read = await readStandingsPages(ignoring, 'bronze', 3);
    expect(read).toMatchObject({ pages: 1, nextCursor: null });
    expect(read.rows).toEqual(ARENA_STANDINGS.bronze.slice(0, 50));
  });
});
