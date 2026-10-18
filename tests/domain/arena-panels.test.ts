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
import { FIXTURE_SEASONS } from '../fixtures/seasons';
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
  const asterRow = page.rows.find(r => r.gladiatorId === ARENA_GLADIATORS.aster.id)!;
  const base: StandingsModel = {
    league: 'bronze', rows: page.rows, nextCursor: page.nextCursor, seasonId: page.seasonId, archived: false, status: 'ready',
    ownerId: ARENA_GLADIATORS.aster.id,
    own: { name: 'Aster', league: 'bronze', rating: 1015, renown: 25, combatStrength: 412, season: { status: 'ready', row: asterRow } },
    seasons: FIXTURE_SEASONS, nowMs: NOW,
  };
  const view = (model: Partial<StandingsModel> = {}) => renderToStaticMarkup(createElement(StandingsView, { model: { ...base, ...model }, onLeague: noop, onMore: noop, onRetry: noop,
    onSeason: noop, timeZone: 'Asia/Jerusalem' }));

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

  // Task 21.4 (plan Decision 8): seasons inside the standings.
  const archive = arenaStandingsPage('bronze', '0');
  const archivedModel: Partial<StandingsModel> = { rows: archive.rows, nextCursor: archive.nextCursor, seasonId: '0', archived: true };
  const options = (html: string) => [...html.matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map(m => [m[1], m[2]]);

  it('offers a season picker with the current season and each finished one, set to the shown season', () => {
    const html = view();
    expect(html).toMatch(/<label[^>]*for="([^"]+)"[^>]*>Season<\/label>/);
    expect(options(html)).toEqual([['1', 'Season 2 · current'], ['0', 'Season 1 · ended Sat 26 Sep']]);
    expect(html).toMatch(/<option[^>]*value="1"[^>]*selected=""/);
    expect(view(archivedModel)).toMatch(/<option[^>]*value="0"[^>]*selected=""/);
    // No season yet: no picker and no season card; the tag names no season.
    const none = view({ seasons: [], seasonId: '', rows: [] });
    expect(none).not.toContain('<select');
    expect(text(none)).not.toMatch(/ends in|final standings/);
  });

  it('shows the current season’s countdown, its end in local time with UTC, the prizes and the rule', () => {
    const html = text(view());
    expect(html).toContain('Current season');
    expect(html).toContain('Season 2 ends in 13 days 23 h');
    expect(html).toContain('Sat 24 Oct, 03:00 your time (00:00 UTC). Ratings then restart at 1000; level, gear, money and renown stay.');
    expect(html).toContain('500 money · 100 renown · Champion title · gold badge');
    expect(html).toContain('300 money · 60 renown · silver badge');
    expect(html).toContain('200 money · 40 renown · bronze badge');
    expect(html).toContain('Top 3 in each league among gladiators with at least 5 human bouts. Paid once, in your highest league where you qualify.');
    // Past its end but not closed yet: it says the close is coming, never a negative countdown.
    const ending = text(view({ nowMs: FIXTURE_SEASONS[0].endsAtMs + 60_000 }));
    expect(ending).toContain('Season 2 is ending');
    expect(ending).toContain('Ended Sat 24 Oct, 03:00 your time (00:00 UTC). Final standings and rewards appear once the server closes the season.');
    expect(ending).not.toContain('ends in');
  });

  it('adds the season rank and human bouts to Your standing, with progress to five', () => {
    expect(text(view())).toMatch(new RegExp(`Your standing League Bronze Rating 1015 Renown 25 Current combat strength 412 Season rank #${asterRow.rank} Human bouts 3 of 5`));
    const html = view();
    expect(html).toMatch(/role="progressbar"[^>]*aria-label="Human bouts toward season rewards"/);
    expect(html).toMatch(/aria-valuenow="3"/);
    expect(text(html)).toContain('2 more human bouts to qualify for season rewards. NPC bouts do not count.');
    // Not ranked in the current season yet (no rating row), still loading, or the row could not be read.
    const unranked = text(view({ own: { ...base.own!, season: { status: 'ready', row: null } } }));
    expect(unranked).toContain('Season rank Not ranked yet Human bouts 0 of 5');
    expect(unranked).toContain('5 more human bouts to qualify');
    expect(text(view({ own: { ...base.own!, season: { status: 'loading' } } }))).toContain('Season rank Loading… Human bouts Loading…');
    const failed = view({ own: { ...base.own!, season: { status: 'unavailable' } } });
    expect(text(failed)).toContain('Season rank not available Human bouts not available');
    expect(failed).not.toContain('progressbar');
    // Five or more: qualified.
    const qualified = text(view({ own: { ...base.own!, season: { status: 'ready', row: { ...asterRow, humanWins: 4, humanLosses: 3 } } } }));
    expect(qualified).toContain('Human bouts 7 of 5');
    expect(qualified).toContain('Qualified: at least 5 human bouts in the Bronze league');
  });

  it('marks eligible rows in the current season and explains the mark', () => {
    const html = view();
    const severus = page.rows.find(r => r.name === 'Severus')!;
    expect(severus.rewardEligible).toBe(true);
    expect(text(html)).toContain(`${severus.rank} Severus ${severus.rating} ${severus.humanWins}–${severus.humanLosses} ✓ Eligible`);
    expect(text(html)).toContain(`${asterRow.rank} Aster ${asterRow.rating} 2–1 You`);
    expect(text(html)).not.toMatch(/Aster \d+ 2–1 You ✓ Eligible/);
    expect(text(html)).toContain('✓ Eligible: has 5 or more human bouts and this is their highest qualifying league.');
    expect(text(html)).not.toMatch(/1st|2nd|3rd/);
  });

  it('shows a finished season’s frozen ranks with medals, no Your standing and the promotion footnote', () => {
    const html = text(view(archivedModel));
    expect(html).toContain('Archived season');
    expect(html).toContain('Season 1 final standings');
    expect(html).toContain('Ended Sat 26 Sep, 03:00 your time (00:00 UTC). Frozen at the close; medals show the season rewards.');
    expect(html).not.toContain('Your standing');
    expect(html).not.toContain('ends in');
    expect(html).not.toContain('✓ Eligible');
    const [lucilla, severus, nerva, aster] = archive.rows;
    expect([lucilla.name, severus.name, nerva.name, aster.name]).toEqual(['Lucilla', 'Severus', 'Nerva', 'Aster']);
    expect(html).toContain(`1 Lucilla ${lucilla.rating} ${lucilla.humanWins}–${lucilla.humanLosses} Promoted 2 Severus`);
    expect(html).toContain(`2 Severus ${severus.rating} ${severus.humanWins}–${severus.humanLosses} 🥇 1st · Champion`);
    expect(html).toContain('3 Nerva 1098 9–4 🥈 2nd');
    expect(html).toContain('4 Aster 1074 8–5 You 🥉 3rd');
    expect(html).toContain('Lucilla was promoted and qualified in a higher league, so Lucilla is rewarded there only, and the Bronze medals go to the next eligible gladiators.');
    // A visitor's view of it is the same, without You.
    expect(text(view({ ...archivedModel, ownerId: null, own: null }))).toContain('4 Aster 1074 8–5 🥉 3rd');
  });

  it('names every promoted qualifier above the medals, or else states the promotion rule', () => {
    const [lucilla, severus, nerva, aster, varro] = archive.rows;
    const two = text(view({ ...archivedModel, rows: [lucilla, { ...severus, promoted: true, rewardEligible: false, awardPlace: null }, { ...nerva, awardPlace: 1 },
      { ...aster, awardPlace: 2 }, { ...varro, awardPlace: 3 }] }));
    expect(two).toContain('Lucilla and Severus were promoted and qualified in a higher league, so they are rewarded there only, and the Bronze medals go to the next eligible gladiators.');
    const silver = arenaStandingsPage('silver', '0');
    const rule = text(view({ ...archivedModel, league: 'silver', rows: silver.rows, nextCursor: null }));
    expect(rule).toContain('A gladiator promoted during the season is rewarded only in their highest league with at least 5 human bouts; a lower league’s medals then go to its next eligible gladiators.');
    expect(rule).not.toContain('was promoted and qualified');
  });

  it('keeps the picker when the newest season has no standings yet, and shows the normal empty state', () => {
    const html = text(view({ rows: [], nextCursor: null }));
    expect(html).toContain('No standings in the Bronze league yet.');
    expect(options(view({ rows: [], nextCursor: null }))).toHaveLength(2);
    expect(html).toContain('Season 2 ends in');
  });

  it('shows a visitor the season card and the picker, never Your standing', () => {
    const html = view({ ownerId: null, own: null });
    expect(text(html)).toContain('Season 2 ends in 13 days 23 h');
    expect(options(html)).toHaveLength(2);
    expect(html).not.toContain('Your standing');
    expect(text(html)).not.toContain('You ');
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

  // Task 21.4: a named season, and a season that closes between two pages.
  it('reads the pages of a named season, a finished one from its archive', async () => {
    const archived = await readStandingsPages(reader, 'bronze', 2, '0');
    expect(archived).toMatchObject({ league: 'bronze', seasonId: '0', archived: true, pages: 2, nextCursor: null });
    expect(archived.rows.map(r => r.rank)).toEqual(Array.from({ length: archived.rows.length }, (_, i) => i + 1));
    expect(archived.rows.slice(1, 4).map(r => r.awardPlace)).toEqual([1, 2, 3]);
    expect(await readStandingsPages(reader, 'bronze', 1, '1')).toEqual(await readStandingsPages(reader, 'bronze', 1));
  });

  it('reads every loaded page again from the archive when the season closes between pages', async () => {
    // Page 1 is read while season '1' is open; it closes before page 2, which the server then serves from its archive.
    let closed = false;
    const calls: [string | undefined, string | undefined][] = [];
    const closing = {
      standings: async (league: LeagueId, cursor?: string, seasonId?: string) => {
        calls.push([cursor, seasonId]);
        const live = arenaStandingsPage(league, '1', cursor ? Number(cursor.split(':')[1]) : 0);
        const page = closed ? { ...live, archived: true, rows: live.rows.map(r => ({ ...r, rewardEligible: false, awardPlace: r.rank <= 3 ? r.rank as 1 | 2 | 3 : null })) } : live;
        closed = true;
        return page;
      },
    };
    const read = await readStandingsPages(closing, 'bronze', 2);
    expect(read).toMatchObject({ seasonId: '1', archived: true, pages: 2, nextCursor: null });
    expect(read.rows).toHaveLength(ARENA_STANDINGS.bronze.length);
    // Every shown row is the archive's: page 1 again, named by its season, then page 2.
    expect(read.rows.slice(0, 3).map(r => r.awardPlace)).toEqual([1, 2, 3]);
    expect(calls).toEqual([[undefined, undefined], ['1:50', undefined], [undefined, '1'], ['1:50', undefined]]);
  });
});
