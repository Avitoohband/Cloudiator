import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { PublicActor, TournamentView } from '../../supabase/functions/_shared/contracts/reads';
import { ARENA_GLADIATORS } from '../fixtures/arena-ids';
import { ownerFixture } from '../fixtures/domain';
import { TOURNAMENT_KEYS, TOURNAMENTS, tournamentAsOf, type TournamentKey } from '../fixtures/tournament-ids';
import { tournamentCampActors } from '../fixtures/tournament-build';
import { SLOT_MS, emptyWorld, routeLiveReads, seedSession } from './live-routes';
import { forbidRemote } from './remote';

const production = process.env.PLAYWRIGHT_STATIC === 'true';
const MIN = 60_000;
const VIEWS = Object.fromEntries(TOURNAMENT_KEYS.map(key => [key, JSON.parse(readFileSync(`tests/fixtures/tournaments/${key}.json`, 'utf8')) as TournamentView])) as Record<TournamentKey, TournamentView>;
const startOf = (key: TournamentKey) => TOURNAMENTS[key].startsAtMs;
/** Round r of R reveals at ceil(80 min × r / (R + 1)) after the start (written independently of the panel). */
const revealOf = (key: TournamentKey, round: number) => {
  const rounds = Math.max(...VIEWS[key].bouts.map(b => b.round));
  return startOf(key) + Math.ceil(80 * MIN * round / (rounds + 1));
};
const ASTER = ARENA_GLADIATORS.aster.id;

const card = (page: Page) => page.locator('article[data-status]');
const panelState = (page: Page) => page.evaluate(() => window.__cloudiatorTournaments!.state());

async function openTournaments(page: Page) {
  await page.goto('/game/?mode=fixture');
  await page.getByRole('button', { name: 'Tournaments', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tournaments', level: 2 })).toBeVisible({ timeout: 45_000 });
}
/**
 * The plan's helper: opens a sample tournament with the shared display clock held at a moment of its slot. Opening a
 * sample holds its bracket at the sample's projection time, so the clock is set after the sample is open.
 */
const tournamentFlow = {
  async openAt(page: Page, key: TournamentKey, ms: number) {
    if (!(await page.evaluate(() => !!window.__cloudiatorTournaments))) await openTournaments(page);
    const id = VIEWS[key].id;
    if ((await page.evaluate(() => window.__cloudiatorTournaments!.state()?.id ?? null)) !== id) {
      await page.getByRole('button', { name: TOURNAMENTS[key].label, exact: true }).click();
    }
    await page.evaluate(t => window.__cloudiatorTournaments!.freeze(t), ms);
    await page.waitForFunction(({ id, t }) => {
      const s = window.__cloudiatorTournaments!.state();
      return !!s && s.id === id && Math.abs(s.now - t) < 1;
    }, { id, t: ms });
  },
  openAtMinute(page: Page, key: TournamentKey, minute: number) { return this.openAt(page, key, startOf(key) + minute * MIN); },
  /** Just before round `round` of the started `opening` tournament reveals. */
  openBeforeRound(page: Page, round: number, key: TournamentKey = 'opening') { return this.openAt(page, key, revealOf(key, round) - 1000); },
  /** Winner ids shown anywhere visible on the page. */
  visibleWinnerIds: (page: Page) => page.locator('[data-winner-id]:visible').evaluateAll(els => [...new Set(els.map(e => e.getAttribute('data-winner-id')!))]),
};

test('the request guard accepts the test origin on any dev port and still flags Supabase', () => {
  for (const origin of ['http://127.0.0.1:3100', 'http://127.0.0.1:3200', 'http://127.0.0.1:4173']) {
    const handlers: ((request: { url(): string }) => void)[] = [];
    const page = { on: (_event: string, handler: (request: { url(): string }) => void) => { handlers.push(handler); } } as unknown as Page;
    const seen = forbidRemote(page, origin);
    for (const url of [`${origin}/_next/static/chunks/app.js`, `${origin}/game/?mode=fixture`, 'data:image/png;base64,AAAA', 'http://127.0.0.1:54321/rest/v1/x']) handlers.forEach(h => h({ url: () => url }));
    expect(seen, origin).toEqual(['http://127.0.0.1:54321/rest/v1/x']);
  }
});

test.describe('tournament registration and brackets', () => {
  test.skip(production, 'The tournament samples need the fixture preview, which production exports never include.');
  test.use({ timezoneId: 'UTC' });

  test('keeps every future result hidden before round 1 (plan Step 1)', async ({ page, baseURL }, testInfo) => {
    const remote = forbidRemote(page, baseURL);
    await tournamentFlow.openBeforeRound(page, 1);
    await expect(page.getByText('Result preparing')).toBeVisible();
    expect(await tournamentFlow.visibleWinnerIds(page)).toEqual([]);
    await expect(page.getByLabel('Automatically enter tournaments')).not.toBeChecked();
    // Entrants, the bracket shape and the seeded first round are public from the start; the results wait for the round.
    await expect(card(page)).toContainText('8-slot bracket · 3 rounds · 0 byes');
    await expect(card(page).getByRole('region', { name: 'Entrants' }).getByRole('listitem')).toHaveCount(8);
    const named = (id: string | null) => VIEWS.opening.entrants.find(e => e.gladiatorId === id)!.name;
    const slots = VIEWS.opening.bracket!.slots;
    for (let p = 0; p < 4; p += 1) await expect(card(page).getByRole('tabpanel')).toContainText(`${named(slots[2 * p])} vs ${named(slots[2 * p + 1])}`);
    await expect(card(page)).not.toContainText('Pairings are revealed');
    await expect(card(page)).toContainText('You are entered. Your first bout is revealed at Wed 7 Oct, 17:40 UTC.');
    await expect(card(page).getByRole('button', { name: /Watch replay/ })).toHaveCount(0);
    // Even a view holding every result shows none before its round's reveal time.
    await tournamentFlow.openAt(page, 'completed', revealOf('completed', 1) - 1000);
    await expect(page.getByText('Result preparing')).toBeVisible();
    expect(await tournamentFlow.visibleWinnerIds(page)).toEqual([]);
    await card(page).screenshot({ path: testInfo.outputPath('tournament-before-round-1.png') });
    expect(remote).toEqual([]);
  });

  test('reveals each round on the display clock, shows the owner’s loss and spectating, and replays a completed bout inline', async ({ page, baseURL }, testInfo) => {
    const remote = forbidRemote(page, baseURL);
    await tournamentFlow.openAtMinute(page, 'completed', 20 + 5 / 60);
    await expect(card(page).getByText('Bout in progress')).toHaveCount(4);
    expect(await tournamentFlow.visibleWinnerIds(page)).toEqual([]);
    await expect(card(page)).toContainText('Your bout is being fought now.');
    await tournamentFlow.openAtMinute(page, 'completed', 30);
    expect((await tournamentFlow.visibleWinnerIds(page)).sort()).toEqual(VIEWS.completed.bouts.filter(b => b.round === 1).map(b => b.revealedResult!.winnerId).sort());
    await expect(card(page)).toContainText('You were eliminated in the Quarterfinals. You stay in the tournament as a spectator until it ends at Sat 26 Sept, 18:40 UTC; this slot has no other activity for you.');
    const aster = card(page).getByRole('region', { name: 'Entrants' }).getByRole('listitem').filter({ hasText: 'Aster' });
    await expect(aster).toContainText('Eliminated in the Quarterfinals · spectating');
    // The semifinals are not revealed yet: their sides are the winners already shown, their results preparing.
    await card(page).getByRole('tab', { name: 'Semifinals' }).click();
    await expect(page.getByText('Result preparing')).toBeVisible();
    expect(await tournamentFlow.visibleWinnerIds(page)).toEqual([]);
    // A spectator watches the final once it is over: an inline close-up replay, no navigation and no rewards.
    await tournamentFlow.openAtMinute(page, 'completed', 79);
    await card(page).getByRole('tab', { name: 'Final', exact: true }).click();
    await card(page).getByRole('button', { name: 'Watch replay of Severus vs Varro' }).click();
    const replay = card(page).getByRole('region', { name: /^Replay · Final, bout 1$/ });
    // The replay's title sits under the card's h4 and the replay section's h5; the card has no h1.
    await expect(replay.getByRole('heading', { level: 6, name: 'Severus vs Varro' })).toBeVisible({ timeout: 30_000 });
    await expect(card(page).getByRole('heading', { level: 1 })).toHaveCount(0);
    await page.waitForFunction(() => window.__cloudiatorReplay?.state().battleId === 'tournament:373009:bronze:3:0');
    await page.evaluate(() => { window.__cloudiatorReplay!.pause(); window.__cloudiatorReplay!.seek(999_999); });
    await expect(replay.getByRole('region', { name: 'Result' })).toContainText('Varro wins');
    await expect(replay).toContainText('Rewards are credited when the activity settles.');
    expect(new URL(page.url()).pathname).toBe('/game/');
    await card(page).screenshot({ path: testInfo.outputPath('tournament-spectator-replay.png') });
    await replay.getByRole('button', { name: 'Close replay' }).click();
    await expect(replay).toHaveCount(0);
    // Placements and the viewer's own credited reward only once settled at minute 80.
    await expect(card(page).getByRole('table')).toHaveCount(0);
    await tournamentFlow.openAtMinute(page, 'completed', 85);
    await expect(card(page).getByRole('table')).toContainText('Varro');
    await expect(card(page)).toContainText('Champion: Varro');
    await expect(card(page)).toContainText('Your placement: 5th. Credited: +7 renown.');
    await expect(card(page)).not.toContainText(/\+80|money/);
    await card(page).screenshot({ path: testInfo.outputPath('tournament-placements.png') });
    expect(remote).toEqual([]);
  });

  test('moves between rounds with the arrow keys, Home and End', async ({ page }, testInfo) => {
    await tournamentFlow.openAtMinute(page, 'midway', 45);
    const tabs = card(page).getByRole('tablist', { name: 'Rounds' });
    await expect(tabs.getByRole('tab', { selected: true })).toHaveText('Semifinals');
    await tabs.getByRole('tab', { selected: true }).focus();
    await page.keyboard.press('ArrowLeft');
    await expect(tabs.getByRole('tab', { name: 'Quarterfinals' })).toBeFocused();
    await expect(tabs.getByRole('tab', { name: 'Quarterfinals' })).toHaveAttribute('aria-selected', 'true');
    await expect(card(page).getByRole('tabpanel')).toContainText('advances on a bye');
    await page.keyboard.press('End');
    await expect(tabs.getByRole('tab', { name: 'Final', exact: true })).toBeFocused();
    await expect(page.getByText('Result preparing')).toBeVisible();
    await page.keyboard.press('Home');
    await expect(tabs.getByRole('tab', { name: 'Quarterfinals' })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowRight');
    await expect(tabs.getByRole('tab', { name: 'Semifinals' })).toHaveAttribute('aria-selected', 'true');
    // Only the selected round's tab is in the Tab order.
    await expect(tabs.locator('[tabindex="0"]')).toHaveCount(1);
    await card(page).screenshot({ path: testInfo.outputPath('tournament-byes-midway.png') });
  });

  test('says a toggle after the cutoff applies to the next tournament, and the preview keeps the box unchanged', async ({ page, baseURL }) => {
    const remote = forbidRemote(page, baseURL);
    await tournamentFlow.openAtMinute(page, 'opening', 5);
    const registration = page.getByRole('region', { name: 'Registration' });
    await expect(registration).toContainText('Entries for the tournament running now were fixed at its 17:20 UTC cutoff.');
    await expect(registration).toContainText('A change now applies from the next tournament, Sat 10 Oct, 17:20 UTC.');
    const box = page.getByLabel('Automatically enter tournaments');
    await box.click();
    await expect(registration.getByRole('status')).toHaveText('Registration changes are unavailable in this preview. Your setting is unchanged.');
    await expect(box).not.toBeChecked();
    await expect(box).toBeEnabled();
    expect(await page.evaluate(() => window.__cloudiatorTournaments!.commands())).toEqual(['set-tournament-opt-in']);
    // Before a cutoff the change would apply to the coming tournament.
    await page.evaluate(t => window.__cloudiatorTournaments!.freeze(t), startOf('upcoming') - 60 * MIN);
    await expect(registration).toContainText('A change now applies to the next tournament, Sat 10 Oct, 17:20 UTC, if it is saved before that cutoff.');
    await expect(registration).not.toContainText('were fixed');
    await expect(registration.getByRole('definition')).toHaveText(['Off', 'Expedition: Woodland Path (not Arena)', '104 (25 needed at the cutoff)']);
    expect(await page.evaluate(() => window.__cloudiatorTournaments!.commands())).toEqual(['set-tournament-opt-in']);
    expect(remote).toEqual([]);
  });

  test('explains the one-entrant fallback: regular Arena this slot', async ({ page }, testInfo) => {
    await tournamentFlow.openAtMinute(page, 'insufficient', 30);
    await expect(card(page).getByRole('status')).toHaveText('Not held: too few entrants');
    await expect(card(page)).toContainText('Only 1 gladiator qualified in the Gold league, so no bracket was held: that entrant fought regular Arena this slot (with an NPC opponent where needed).');
    await expect(card(page).getByRole('tablist')).toHaveCount(0);
    await card(page).screenshot({ path: testInfo.outputPath('tournament-one-entrant.png') });
    // A tournament that has not started shows neither entrants nor a bracket.
    await tournamentFlow.openAt(page, 'upcoming', startOf('upcoming') - 30 * MIN);
    await expect(card(page).getByRole('status')).toHaveText('Scheduled');
    await expect(card(page)).toContainText('Entrants and the bracket are published at the start, Sat 10 Oct, 17:20 UTC.');
    await expect(page.getByRole('region', { name: 'Tournament schedule' }).getByRole('definition')).toHaveText(['Sat 10 Oct, 17:20 UTC', '30 min 0 s']);
  });

  test('marks a due round as preparing while its results are unpublished, and asks again', async ({ page }, testInfo) => {
    // The mid-way view was read at minute 45; by minute 65 its final is due but not published.
    await tournamentFlow.openAtMinute(page, 'midway', 65);
    await expect(card(page).getByRole('status')).toHaveText('Processing results');
    await expect(card(page).getByRole('tab', { selected: true })).toHaveText('Final');
    await expect(page.getByText('Result preparing')).toBeVisible();
    await expect(card(page)).toContainText('These results were due at Sat 3 Oct, 18:20 UTC but are not published yet.');
    expect(await tournamentFlow.visibleWinnerIds(page)).toEqual([]);
    await expect(card(page).getByRole('tabpanel')).toContainText('Decimus vs Aurelia');
    await card(page).screenshot({ path: testInfo.outputPath('tournament-unavailable-round.png') });
    // The panel reads again every 30 s while a due round is missing.
    const reads = await page.evaluate(() => window.__cloudiatorTournaments!.reads());
    await page.evaluate(t => window.__cloudiatorTournaments!.freeze(t), startOf('midway') + 65 * MIN + 31_000);
    await page.waitForFunction(n => window.__cloudiatorTournaments!.reads() > n, reads);
  });

  test('says the owner’s due but unpublished result is not published yet, never that she advances', async ({ page }) => {
    // The opening view was read at minute 5; at minute 25 round 1 is due but unpublished.
    await tournamentFlow.openAtMinute(page, 'opening', 25);
    await expect(card(page).getByRole('status')).toHaveText('Processing results');
    await expect(card(page)).toContainText('Your Quarterfinals result is not published yet. It appears here as soon as it is revealed.');
    await expect(card(page)).not.toContainText('You advance');
    expect(await tournamentFlow.visibleWinnerIds(page)).toEqual([]);
  });

  test('holds each sample at the server time its view was projected at, so it shows what its label says', async ({ page }) => {
    await openTournaments(page);
    const shows: [TournamentKey, string, string][] = [
      ['opening', 'In progress', 'You are entered. Your first bout is revealed at Wed 7 Oct, 17:40 UTC.'],
      ['midway', 'In progress', 'Next reveal: Final, Sat 3 Oct, 18:20 UTC.'],
      ['late', 'In progress', 'Every round is revealed. Placements settle at minute 80, Wed 30 Sept, 18:40 UTC.'],
      ['completed', 'Completed', 'Your placement: 5th. Credited: +7 renown.'],
      ['pair', 'Completed', 'You are the champion of this tournament!'],
      ['insufficient', 'Not held: too few entrants', 'that entrant fought regular Arena this slot'],
      ['upcoming', 'Scheduled', 'Entrants and the bracket are published at the start, Sat 10 Oct, 17:20 UTC.'],
    ];
    for (const [key, status, detail] of shows) {
      await page.getByRole('button', { name: TOURNAMENTS[key].label, exact: true }).click();
      await expect(card(page).getByRole('status'), key).toHaveText(status);
      await expect(card(page), key).toContainText(detail);
      expect((await panelState(page))?.now, key).toBe(tournamentAsOf(key));
    }
    // The held sample time stays put (no running clock); the test hook's clock still overrides it.
    await page.waitForTimeout(1500);
    expect((await panelState(page))?.now).toBe(tournamentAsOf('upcoming'));
    await page.getByRole('button', { name: TOURNAMENTS.opening.label, exact: true }).click();
    await page.evaluate(t => window.__cloudiatorTournaments!.freeze(t), startOf('opening') + 25 * MIN);
    await expect(card(page).getByRole('status')).toHaveText('Processing results');
  });

  test('retries a failed first read every 30 s while the tab is visible', async ({ page }) => {
    await page.clock.install();
    await openTournaments(page);
    // The owner has loaded (the panel is keyed by the owner's gladiator), so the panel is not replaced mid-test.
    await expect(page.getByRole('region', { name: 'Registration' })).toContainText('Automatic entry');
    await page.evaluate(() => window.__cloudiatorTournaments!.open('tournament:1:bronze'));
    await expect(page.getByText('Tournament brackets cannot be loaded right now.')).toBeVisible();
    const reads = () => page.evaluate(() => window.__cloudiatorTournaments!.reads());
    const first = await reads();
    await page.clock.fastForward(29_000);
    expect(await reads()).toBe(first);
    await page.clock.fastForward(1_500);
    await expect.poll(reads).toBe(first + 1);
    await page.clock.fastForward(30_000);
    await expect.poll(reads).toBe(first + 2);
    // A hidden tab does not retry; once visible again, the next 30 s tick reads.
    await page.evaluate(() => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }));
    await page.clock.fastForward(65_000);
    expect(await reads()).toBe(first + 2);
    await page.evaluate(() => { delete (document as { visibilityState?: unknown }).visibilityState; });
    await page.clock.fastForward(30_000);
    await expect.poll(reads).toBe(first + 3);
    await expect(page.getByText('Tournament brackets cannot be loaded right now.')).toBeVisible();
  });

  test('backs processing re-reads off from 30 s to 5 minutes, pauses them in a hidden tab, re-reads once on focus and resets when the status changes', async ({ page }) => {
    // The late view (final revealed, placements pending) after minute 80 is a stuck settlement: processing, no mark left.
    const reads = () => page.evaluate(() => window.__cloudiatorTournaments!.reads());
    const at = (seconds: number) => page.evaluate(t => window.__cloudiatorTournaments!.freeze(t), startOf('late') + 85 * MIN + seconds * 1000);
    const settled = async (expected: number) => { await page.waitForTimeout(1200); expect(await reads()).toBe(expected); };
    await tournamentFlow.openAtMinute(page, 'late', 85);
    await expect(card(page).getByRole('status')).toHaveText('Processing results');
    // Crossing minute 80 read the view once; then only the processing back-off reads.
    await page.waitForTimeout(1200);
    let n = await reads();
    let t = 0;
    for (const wait of [30, 60, 120, 240, 300, 300]) {
      await at(t + wait - 1);
      await settled(n);
      await at(t + wait);
      await expect.poll(reads, { message: `after ${wait} s` }).toBe(n + 1);
      n += 1;
      t += wait;
    }
    // A hidden tab never reads, however long it waits; coming back reads once (focus and visibility fire together).
    await page.evaluate(() => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }));
    await at(t + 900);
    await settled(n);
    await page.evaluate(() => {
      delete (document as { visibilityState?: unknown }).visibilityState;
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    await expect.poll(reads).toBe(n + 1);
    await settled(n + 1);
    n += 1;
    // Back before the end the view is not processing, which resets the back-off: the next stuck spell starts at 30 s.
    await page.evaluate(ts => window.__cloudiatorTournaments!.freeze(ts), startOf('late') + 78 * MIN);
    await expect(card(page).getByRole('status')).toHaveText('In progress');
    await settled(n);
    await at(0);
    await expect.poll(reads).toBe(n + 1);
    n += 1;
    await at(29);
    await settled(n);
    await at(30);
    await expect.poll(reads).toBe(n + 1);
  });

  test('loads a bout’s battle log only when its replay is watched, and only once', async ({ page }) => {
    await tournamentFlow.openAtMinute(page, 'completed', 79);
    const logReads = () => page.evaluate(() => window.__cloudiatorTournaments!.logReads());
    // Every round is revealed and decided, and no log has been asked for.
    await card(page).getByRole('tab', { name: 'Final', exact: true }).click();
    await expect(card(page).getByRole('button', { name: 'Watch replay of Severus vs Varro' })).toBeVisible();
    expect(await logReads()).toBe(0);
    await card(page).getByRole('button', { name: 'Watch replay of Severus vs Varro' }).click();
    const replay = card(page).getByRole('region', { name: /^Replay · Final, bout 1$/ });
    await expect(replay.getByRole('heading', { level: 6, name: 'Severus vs Varro' })).toBeVisible({ timeout: 30_000 });
    expect(await logReads()).toBe(1);
    // Watching it again, and a fresh read of the view after minute 80, keep the loaded log.
    await replay.getByRole('button', { name: 'Close replay' }).click();
    await tournamentFlow.openAtMinute(page, 'completed', 85);
    await card(page).getByRole('tab', { name: 'Final', exact: true }).click();
    await card(page).getByRole('button', { name: 'Watch replay of Severus vs Varro' }).click();
    await expect(replay.getByRole('heading', { level: 6, name: 'Severus vs Varro' })).toBeVisible();
    expect(await logReads()).toBe(1);
  });

  test('reads the view again when the display clock passes a reveal', async ({ page }) => {
    await tournamentFlow.openAt(page, 'completed', revealOf('completed', 2) - 2000);
    const reads = await page.evaluate(() => window.__cloudiatorTournaments!.reads());
    await page.evaluate(t => window.__cloudiatorTournaments!.freeze(t), revealOf('completed', 2) + 500);
    await page.waitForFunction(n => window.__cloudiatorTournaments!.reads() === n + 1, reads);
    await expect(card(page).getByText('Bout in progress')).toHaveCount(2);
  });

  test('works by keyboard alone', async ({ page }) => {
    await openTournaments(page);
    const sample = page.getByRole('button', { name: TOURNAMENTS.pair.label, exact: true });
    await sample.focus();
    await page.keyboard.press('Enter');
    await expect(card(page)).toContainText('You are the champion of this tournament!');
    await page.evaluate(t => window.__cloudiatorTournaments!.freeze(t), startOf('pair') + 79 * MIN);
    await expect(card(page).getByRole('table')).toHaveCount(0);
    await expect(card(page)).toContainText('Both fell at 0 HP; a seeded tie-break decided it.');
    expect(await tournamentFlow.visibleWinnerIds(page)).toEqual([ASTER]);
    // Past the two remaining sample buttons, Tab reaches the selected round's tab, then the replay button.
    for (let i = 0; i < 3; i += 1) await page.keyboard.press('Tab');
    await expect(card(page).getByRole('tab', { name: 'Final', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    const watch = card(page).getByRole('button', { name: 'Watch replay of Severus vs Aster' });
    await expect(watch).toBeFocused();
    await page.keyboard.press('Enter');
    const close = card(page).getByRole('button', { name: 'Close replay' });
    await expect(close).toBeVisible({ timeout: 30_000 });
    await close.focus();
    await page.keyboard.press('Enter');
    await expect(close).toHaveCount(0);
    // The opt-in box toggles from the keyboard too, and still only attempts the one command.
    await page.getByLabel('Automatically enter tournaments').focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('region', { name: 'Registration' }).getByRole('status')).toContainText('unavailable in this preview');
    expect(await page.evaluate(() => window.__cloudiatorTournaments!.commands())).toEqual(['set-tournament-opt-in']);
  });

  test('fits a 360 px phone with the bracket and an inline replay open', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 360, height: 760 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await tournamentFlow.openAtMinute(page, 'completed', 85);
    const wide = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(await wide()).toBeLessThanOrEqual(0);
    await card(page).getByRole('tab', { name: 'Quarterfinals' }).click();
    await card(page).getByRole('button', { name: /^Watch replay of / }).first().click();
    await expect(card(page).getByRole('heading', { level: 6 }).first()).toBeVisible({ timeout: 30_000 });
    expect(await wide()).toBeLessThanOrEqual(0);
    // Every word in the replay's fighter table stays whole ("Endurance", "Equipment"): no word spans two lines.
    const fighters = card(page).getByRole('table', { name: 'Fighters at the start of the fight' });
    await fighters.scrollIntoViewIfNeeded();
    const split = await fighters.evaluate(table => {
      const broken: string[] = [];
      const walker = document.createTreeWalker(table, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if ((node.parentElement?.getBoundingClientRect().width ?? 0) < 2) continue; // visually hidden labels
        for (const word of (node.textContent ?? '').matchAll(/\S+/g)) {
          const range = document.createRange();
          range.setStart(node, word.index!);
          range.setEnd(node, word.index! + word[0].length);
          if (new Set([...range.getClientRects()].filter(r => r.width > 0).map(r => Math.round(r.top))).size > 1) broken.push(word[0]);
        }
      }
      return broken;
    });
    expect(split).toEqual([]);
    await page.getByRole('region', { name: 'Registration' }).screenshot({ path: testInfo.outputPath('width360-registration.png') });
    await card(page).screenshot({ path: testInfo.outputPath('width360-bracket-replay.png') });
  });
});

test.describe('tournament times in the viewer’s time zone', () => {
  test.skip(production, 'The tournament panel needs the fixture preview.');
  test.use({ timezoneId: 'America/New_York' });

  test('shows local times beside the fixed UTC time across a daylight-saving change', async ({ page }, testInfo) => {
    await openTournaments(page);
    const schedule = page.getByRole('region', { name: 'Tournament schedule' });
    // After Saturday 24 October's tournament, New York is still on daylight time (UTC−4).
    await page.evaluate(t => window.__cloudiatorTournaments!.freeze(t), Date.UTC(2026, 9, 24, 18, 40));
    await expect(schedule).toContainText('Wed 28 Oct, 13:20 GMT-4 (Wed 28 Oct, 17:20 UTC)');
    await expect(schedule).toContainText('3 d 22 h 40 min');
    // After Saturday 31 October's, it is on standard time (UTC−5); the UTC time is unchanged.
    await page.evaluate(t => window.__cloudiatorTournaments!.freeze(t), Date.UTC(2026, 9, 31, 18, 40));
    await expect(schedule).toContainText('Wed 4 Nov, 12:20 GMT-5 (Wed 4 Nov, 17:20 UTC)');
    await expect(schedule).toContainText('3 d 22 h 40 min');
    await schedule.screenshot({ path: testInfo.outputPath('tournament-local-time-new-york.png') });
    // Bracket times follow the same zone.
    await tournamentFlow.openAtMinute(page, 'opening', 5);
    await expect(card(page)).toContainText('Your first bout is revealed at Wed 7 Oct, 13:40 GMT-4 (Wed 7 Oct, 17:40 UTC).');
  });
});


// ------------------------------------------------------------------ the live Tournaments panel (Task 13.4)
// Live mode through the test transport: the shared clock, the world revision's slot and the owner refresh drive the
// panel. The `opening` tournament's slot stands for "this slot".

/** A view of the same tournament slot for another league (its ids and league relabelled). */
const inLeague = (view: TournamentView, league: TournamentView['league']): TournamentView =>
  JSON.parse(JSON.stringify(view).replaceAll(`:${view.league}`, `:${league}`).replace(`"league":"${view.league}"`, `"league":"${league}"`)) as TournamentView;
const OPENING_SLOT = startOf('opening') / SLOT_MS;
const tournamentsPanel = async (page: Page) => {
  await page.getByRole('button', { name: 'Tournaments', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Tournaments', exact: true });
  await expect(panel).toBeVisible({ timeout: 45_000 });
  return panel;
};

test.describe('the live Tournaments panel', () => {
  test.skip(production, 'Live mode uses development-only intercepted Supabase transport.');
  test.use({ timezoneId: 'UTC' });

  test('keeps one 30 s retry while preparing even when the owner refresh prop changes', async ({ page, context }) => {
    // 40 s after the cutoff: the slot is not published yet, so the view is missing and the owner's processed slot lags.
    const at = startOf('opening') + 40_000;
    const owner = { ...structuredClone(ownerFixture), processedSlotIndex: OPENING_SLOT - 1 };
    await seedSession(context);
    const live = await routeLiveReads(context, { world: emptyWorld(at), owner, serverNowMs: () => at });
    await page.clock.install();
    await page.goto('/game/');
    await expect(page.getByRole('heading', { name: 'Aster', exact: true })).toBeVisible({ timeout: 45_000 });
    const panel = await tournamentsPanel(page);
    await expect(panel.getByRole('status').filter({ hasText: 'Tournament being prepared' })).toBeVisible();
    const views = () => live.count('tournament_views'), owners = () => live.count('owner_state');
    const [v0, o0] = [views(), owners()];
    // A parent handing the panel a new refresh function part-way leaves the 30 s retry where it was.
    await page.clock.fastForward(10_000);
    await page.evaluate(() => window.__cloudiatorShell!.renewRefreshOwner());
    await page.clock.fastForward(20_500);
    await expect.poll(views).toBe(v0 + 1);
    expect(owners()).toBe(o0 + 1);
    // Exactly one retry per 30 s.
    await page.clock.fastForward(25_000);
    await page.waitForTimeout(500);
    expect([views(), owners()]).toEqual([v0 + 1, o0 + 1]);
    // While preparing, each retry awaits the owner refresh before it reads the tournament again.
    const release = live.hold('owner_state');
    await page.clock.fastForward(6_000);
    await expect.poll(owners).toBe(o0 + 2);
    await page.waitForTimeout(1_000);
    expect(views()).toBe(v0 + 1);
    // Phase 8 publishes the slot: the owner's processed slot and the slot's views commit together.
    live.setOwner({ ...owner, processedSlotIndex: OPENING_SLOT });
    live.setTournaments([VIEWS.opening]);
    release();
    await expect.poll(views).toBe(v0 + 2);
    const bracket = panel.locator('article[data-status]');
    await expect(bracket.getByRole('heading', { name: 'Bronze tournament' })).toBeVisible();
    await expect(bracket).toContainText('You are entered.');
    // With a view, the retry stops.
    await page.clock.fastForward(31_000);
    await page.waitForTimeout(500);
    expect(views()).toBe(v0 + 2);
  });

  for (const viewer of ['gladiator', 'visitor'] as const) {
    test(viewer === 'gladiator' ? 'shows "Tournament being prepared" for a gladiator created after the cutoff, for five minutes'
      : 'shows a visitor "Tournament being prepared" for five minutes after the cutoff', async ({ page, context }) => {
      // R3: the server's time runs on (and jumps with the page clock), so every revision read reports the tournament's
      // slot by time. The slot is never published here, so its view stays missing. A gladiator created after the cutoff
      // already has the tournament's processed slot; a visitor has none.
      const start = startOf('opening');
      let skipped = 0;
      const began = Date.now();
      if (viewer === 'gladiator') await seedSession(context);
      const live = await routeLiveReads(context, { world: emptyWorld(start + 40_000), serverNowMs: () => start + 40_000 + skipped + (Date.now() - began),
        owner: viewer === 'gladiator' ? { ...structuredClone(ownerFixture), processedSlotIndex: OPENING_SLOT } : null });
      await page.clock.install();
      await page.goto('/game/');
      if (viewer === 'gladiator') await expect(page.getByRole('heading', { name: 'Aster', exact: true })).toBeVisible({ timeout: 45_000 });
      const panel = await tournamentsPanel(page);
      const preparing = panel.getByRole('status').filter({ hasText: 'Tournament being prepared' });
      const missing = panel.getByRole('status').filter({ hasText: 'No tournament matches this selection.' });
      await expect(preparing).toBeVisible();
      /** Moves the page clock, and the server's time with it, to `ms` after the cutoff. */
      const advanceTo = async (ms: number) => {
        const shown = await page.evaluate(() => window.__cloudiatorShell!.clock.now());
        const by = Math.max(0, start + ms - shown);
        skipped += by;
        await page.clock.fastForward(by);
      };
      // Well past the first revision polls after the cutoff, which report the tournament's slot.
      const polls = live.count('world_revision');
      await advanceTo(120_000);
      await expect(preparing).toBeVisible();
      await expect.poll(() => live.count('world_revision')).toBeGreaterThan(polls);
      expect(Math.floor(live.serverNowMs() / SLOT_MS)).toBe(OPENING_SLOT);
      await advanceTo(290_000);
      await expect(preparing).toBeVisible();
      await expect(missing).toHaveCount(0);
      // From 300 s after the cutoff a missing view means no tournament in this league.
      await advanceTo(302_000);
      await expect(missing).toBeVisible();
      await expect(preparing).toHaveCount(0);
      expect(live.requests.some(r => r.table === 'tournament_views' && r.query.get('id') === `eq.tournament:${OPENING_SLOT}:bronze`)).toBe(true);
      if (viewer === 'visitor') {
        await expect(panel.getByRole('group', { name: 'League' })).toBeVisible();
        expect(live.requests.every(r => r.reader === null)).toBe(true);
      }
    });
  }

  test('says brackets cannot be loaded when the world revision cannot be read', async ({ page, context }) => {
    // Review M1: without a revision read the shared clock never gets the server's time; the panel must not wait forever.
    const at = startOf('opening') + 30 * MIN;
    const live = await routeLiveReads(context, { world: emptyWorld(at), tournaments: [VIEWS.opening], serverNowMs: () => at });
    live.fail('world_revision');
    await page.goto('/game/');
    const panel = await tournamentsPanel(page);
    await expect(panel.getByRole('status').filter({ hasText: 'Tournament brackets cannot be loaded right now.' })).toBeVisible();
    await expect(panel).not.toContainText('Loading the tournament');
    // Without the server's time the panel names no slot's tournament, so it reads none.
    expect(live.count('world_revision')).toBeGreaterThan(0);
    expect(live.count('tournament_views')).toBe(0);
  });

  test('lets a visitor pick a league and see its countdown and bracket', async ({ page, context }) => {
    const at = startOf('opening') + 30 * MIN;
    const live = await routeLiveReads(context, { world: emptyWorld(at), tournaments: [VIEWS.opening, inLeague(VIEWS.opening, 'silver')], serverNowMs: () => at });
    await page.goto('/game/');
    const panel = await tournamentsPanel(page);
    const schedule = panel.getByRole('region', { name: 'Tournament schedule' });
    await expect(schedule).toContainText('A tournament is running now');
    await expect(schedule.getByRole('definition')).toHaveText(['Sat 10 Oct, 17:20 UTC', /^2 d 23 h 2\d min$/]);
    const leagues = panel.getByRole('group', { name: 'League' });
    await expect(leagues.getByRole('button')).toHaveText(['Bronze', 'Silver', 'Gold', 'Champion']);
    await expect(leagues.getByRole('button', { name: 'Bronze' })).toHaveAttribute('aria-pressed', 'true');
    const bracket = panel.locator('article[data-status]');
    await expect(bracket.getByRole('heading', { name: 'Bronze tournament' })).toBeVisible();
    await expect(bracket.getByRole('region', { name: 'Entrants' }).getByRole('listitem')).toHaveCount(8);
    await expect(bracket).not.toContainText(/You are|Your /);
    await leagues.getByRole('button', { name: 'Silver' }).click();
    await expect(leagues.getByRole('button', { name: 'Silver' })).toHaveAttribute('aria-pressed', 'true');
    await expect(bracket.getByRole('heading', { name: 'Silver tournament' })).toBeVisible();
    await expect(bracket.getByRole('region', { name: 'Entrants' }).getByRole('listitem')).toHaveCount(8);
    // A league without a tournament in that slot.
    await leagues.getByRole('button', { name: 'Gold' }).click();
    await expect(panel.getByRole('status').filter({ hasText: 'No tournament matches this selection.' })).toBeVisible();
    await expect(panel).not.toContainText('Create a gladiator to follow');
    // A visitor reads public projections only, anonymously, and never the owner state.
    const ids = live.requests.filter(r => r.table === 'tournament_views').map(r => r.query.get('id'));
    expect(new Set(ids)).toEqual(new Set(['silver', 'bronze', 'gold'].map(league => `eq.tournament:${OPENING_SLOT}:${league}`)));
    expect(live.requests.every(r => r.reader === null)).toBe(true);
    expect(live.requests.some(r => r.table === 'owner_state' || r.table === 'activities')).toBe(false);
  });

  test('follows the owner’s league after a promotion, from the owner read on a new revision', async ({ page, context }) => {
    // The lookup league is the owner's, re-read by the shared game state when the revision changes (Task 19 gate).
    const at = startOf('opening') + 30 * MIN;
    const owner = { ...structuredClone(ownerFixture), processedSlotIndex: OPENING_SLOT };
    const world = emptyWorld(at);
    await seedSession(context);
    const live = await routeLiveReads(context, { world, owner, tournaments: [VIEWS.opening, inLeague(VIEWS.opening, 'silver')], serverNowMs: () => at });
    await page.clock.install();
    await page.goto('/game/');
    await expect(page.getByRole('heading', { name: 'Aster', exact: true })).toBeVisible({ timeout: 45_000 });
    const panel = await tournamentsPanel(page);
    const bracket = panel.locator('article[data-status]');
    await expect(bracket.getByRole('heading', { name: 'Bronze tournament' })).toBeVisible();
    // An owner follows its own league: no picker.
    await expect(panel.getByRole('group', { name: 'League' })).toHaveCount(0);
    live.setOwner({ ...owner, progression: { ...owner.progression, league: 'silver' } });
    live.setWorld({ ...world, revision: 'promoted' });
    await page.clock.fastForward(30_000);
    await expect(bracket.getByRole('heading', { name: 'Silver tournament' })).toBeVisible();
    expect(live.requests.some(r => r.table === 'tournament_views' && r.query.get('id') === `eq.tournament:${OPENING_SLOT}:silver`)).toBe(true);
  });
});

// ------------------------------------------------------------------ tournament roles in the camp
// The fixture world has no tournament in its own slot, so these push the `completed` tournament's entrants (location
// `tournament`) and its public view through the fixture-only scene hook, holding the display clock in that slot.

const MAP = JSON.parse(readFileSync('public/assets/camp/map.json', 'utf8')) as { arena: { centre: [number, number]; radius: number }; zones: { id: string; stations: { kind: string; x: number; y: number }[] }[] };
const RINGS = new Set(MAP.zones.find(z => z.id === 'arena')!.stations.filter(st => st.kind === 'arena-ring').map(st => `${st.x},${st.y}`));
const fromCentre = (x: number, y: number) => Math.hypot(x - MAP.arena.centre[0], y - MAP.arena.centre[1]);
const ENTRANTS = tournamentCampActors('completed');
const campState = (page: Page) => page.evaluate(() => window.__cloudiatorCamp!.state()!);
const nextFrames = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));

async function openCampTournament(page: Page, minute: number, push = true) {
  await page.goto('/game/?mode=fixture');
  await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
  await page.evaluate(({ entrants, view, at, push }) => {
    const hook = window.__cloudiatorCamp!;
    hook.freezeClock(at);
    const world = hook.world()!;
    // Keep the crowd, minus the fixture slot's Arena entrants (their bouts belong to another day).
    const others = world.actors.filter(a => a.location !== 'arena' && !entrants.some(e => e.gladiatorId === a.gladiatorId));
    hook.setWorld({ ...world, actors: [...others.slice(0, 50 - entrants.length), ...entrants] });
    if (push) hook.setTournaments([view]);
  }, { entrants: ENTRANTS as PublicActor[], view: VIEWS.completed, at: startOf('completed') + minute * MIN, push });
  await nextFrames(page);
}
const freezeCamp = async (page: Page, ms: number) => { await page.evaluate(t => window.__cloudiatorCamp!.freezeClock(t), ms); await nextFrames(page); };
const entrantActors = async (page: Page) => (await campState(page)).actors.filter(a => ENTRANTS.some(e => e.gladiatorId === a.id));

test.describe('tournament entrants in the camp', () => {
  test.skip(production, 'The camp harness runs on the fixture preview only.');
  test.use({ timezoneId: 'UTC' });

  test('waits every entrant in staging, then fights each revealed bout in a sparring ring', async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce' }); // entrants take their spots at once
    await openCampTournament(page, 5);
    let state = await campState(page);
    expect(Object.values(state.tournament.roles)).toEqual(Array(8).fill('waiting'));
    expect(state.arena.fights).toEqual([]);
    for (const a of await entrantActors(page)) {
      expect(a.zone, a.name).toBe('arena');
      expect(fromCentre(a.x, a.y), `${a.name} inside the wall`).toBeLessThan(MAP.arena.radius);
      expect(RINGS.has(`${Math.floor(a.x)},${Math.floor(a.y)}`), `${a.name} on a ring tile`).toBe(false);
    }
    // Round 1 reveals at minute 20: every entrant is fighting by the stage core's reveal rule, and its four bouts jog
    // into rings (at most 4 s) and play from their logs there at the bout's real time, participant 0 on side a (Task
    // 17's ring rule: the shortest bout, 10.2 s, already shows its result 12 s after the reveal).
    await freezeCamp(page, revealOf('completed', 1) + 5_000);
    state = await campState(page);
    expect(Object.values(state.tournament.roles)).toEqual(Array(8).fill('fighting'));
    const round1 = VIEWS.completed.bouts.filter(b => b.round === 1);
    expect(state.arena.fights.map(f => f.battleId).sort()).toEqual(round1.map(b => b.id).sort());
    for (const fight of state.arena.fights) {
      const log = round1.find(b => b.id === fight.battleId)!.revealedResult!.battleLog!;
      expect(fight.fighters).toEqual(log.participants.map(p => p.gladiatorId));
      expect([fight.status, fight.npc]).toEqual(['fighting', null]);
      for (const id of fight.fighters) {
        const a = state.actors.find(x => x.id === id)!;
        expect(RINGS.has(`${Math.floor(a.x)},${Math.floor(a.y)}`), `${a.name} in a ring`).toBe(true);
      }
    }
    expect(new Set(state.arena.fights.map(f => f.ring)).size).toBe(4);
    expect(state.actors.some(a => a.kind === 'arena-npc')).toBe(false);
    // Tournament bouts are followed in the Tournaments panel, not listed as Arena bouts.
    await expect(page.getByRole('group', { name: 'Arena bouts in the rings' })).toHaveCount(0);
    await page.evaluate(() => window.__cloudiatorCamp!.centerOn(23, 22.5, 2));
    await nextFrames(page);
    await page.screenshot({ path: testInfo.outputPath('camp-tournament-round-1.png') });
  });

  test('sends the eliminated to spectator spots outside the wall and marks the champion at the end', async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openCampTournament(page, 5);
    const players = (await campState(page)).players;
    await freezeCamp(page, startOf('completed') + 30 * MIN);
    let state = await campState(page);
    const losers = VIEWS.completed.bouts.filter(b => b.round === 1).map(b => b.revealedResult!.participants.find(p => p.gladiatorId !== b.revealedResult!.winnerId)!.gladiatorId);
    expect([...state.tournament.spectators].sort()).toEqual([...losers].sort());
    expect(state.tournament.roles[ASTER]).toBe('spectating');
    for (const a of state.actors.filter(x => losers.includes(x.id))) {
      expect(fromCentre(a.x, a.y), `${a.name} outside the wall`).toBeGreaterThan(MAP.arena.radius + 0.5);
      expect([a.walking, a.action], a.name).toEqual([false, 'idle']);
    }
    for (const a of state.actors.filter(x => ENTRANTS.some(e => e.gladiatorId === x.id) && !losers.includes(x.id))) {
      expect(state.tournament.roles[a.id], a.name).toBe('waiting');
      expect(fromCentre(a.x, a.y), `${a.name} waits inside`).toBeLessThan(MAP.arena.radius);
    }
    await page.evaluate(() => window.__cloudiatorCamp!.centerOn(23, 23.5, 1));
    await nextFrames(page);
    await page.screenshot({ path: testInfo.outputPath('camp-tournament-spectators.png') });
    // After the final, Varro is the champion; everyone else watches from outside the wall; nobody was added. The clock
    // passes each reveal as a running one would: a bout the camp learns late plays from then (Task 17's ring rule).
    for (const minute of [40.1, 41.5, 60.1, 61.5, 79]) await freezeCamp(page, startOf('completed') + minute * MIN);
    state = await campState(page);
    const varro = ARENA_GLADIATORS.varro.id;
    expect(state.tournament.champion).toBe(varro);
    expect(state.tournament.spectators).toHaveLength(7);
    expect(state.actors.find(a => a.id === varro)!.marker).toBe('Champion');
    expect(state.actors.filter(a => a.marker === 'Champion')).toHaveLength(1);
    expect(state.players).toBe(players);
    await page.evaluate(() => window.__cloudiatorCamp!.centerOn(23, 23.5, 1));
    await nextFrames(page);
    await page.screenshot({ path: testInfo.outputPath('camp-tournament-champion.png') });
  });

  test('marks the champion only once the final has finished in its ring', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openCampTournament(page, 5);
    for (const minute of [30, 40.1, 41.5]) await freezeCamp(page, startOf('completed') + minute * MIN);
    const final = VIEWS.completed.bouts.find(b => b.round === 3)!;
    const duration = final.revealedResult!.battleLog!.durationMs;
    const varro = ARENA_GLADIATORS.varro.id;
    const ring = (state: Awaited<ReturnType<typeof campState>>) => state.arena.fights.find(f => f.battleId === final.id)!;
    // A ring shows a bout's result from the bout's end, as the stage core does, once its pair stands there (Task 17's
    // ring rule). A camp that learns the final only after it ended (a late read, a tab coming back) still jogs the
    // finalists in first; with motion on, the frozen clock holds them on the way.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect.poll(async () => (await campState(page)).reducedMotion).toBe(false);
    await freezeCamp(page, revealOf('completed', 3) + duration + 1000);
    let state = await campState(page);
    // The stage core has decided the final, but its pair is still jogging into the ring: no champion tag yet.
    expect(state.tournament.roles[varro]).toBe('champion');
    expect(ring(state).status).toBe('entering');
    expect(state.actors.filter(a => a.marker === 'Champion')).toEqual([]);
    // Once the ring shows the final's result (the pair is in by the jog-in bound), the champion carries the tag.
    await freezeCamp(page, ring(state).fightStartMs);
    state = await campState(page);
    expect(ring(state).status).toBe('result');
    expect(state.actors.filter(a => a.marker === 'Champion').map(a => a.id)).toEqual([varro]);
  });

  test('walks the eliminated out to their spots and keeps them there across world updates', async ({ page }) => {
    await openCampTournament(page, 5);
    // The display clock runs while frozen frames are drawn, so step it through the walk out.
    for (let t = startOf('completed') + 29 * MIN; t <= startOf('completed') + 30 * MIN; t += 500) await freezeCamp(page, t);
    let state = await campState(page);
    const aster = () => state.actors.find(a => a.id === ASTER)!;
    expect(state.tournament.spectators).toContain(ASTER);
    expect([aster().walking, fromCentre(aster().x, aster().y) > MAP.arena.radius + 0.5]).toEqual([false, true]);
    // A new world snapshot (the same public rows) leaves the spectators where they are.
    await page.evaluate(() => { const hook = window.__cloudiatorCamp!; hook.setWorld({ ...hook.world()!, revision: 'fixture-2' }); });
    await nextFrames(page);
    state = await campState(page);
    expect([aster().walking, fromCentre(aster().x, aster().y) > MAP.arena.radius + 0.5]).toEqual([false, true]);
  });

  test('reads the tournament of camp entrants during their slot, again after a reveal, and never after it', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openCampTournament(page, 5, false);
    await page.waitForFunction(() => window.__cloudiatorCamp!.tournamentReads() === 1);
    await page.waitForFunction(() => Object.keys(window.__cloudiatorCamp!.state()!.tournament.roles).length === 8);
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => window.__cloudiatorCamp!.tournamentReads())).toBe(1);
    await freezeCamp(page, revealOf('completed', 1) + 500);
    await page.waitForFunction(() => window.__cloudiatorCamp!.tournamentReads() === 2);
    await page.waitForFunction(() => window.__cloudiatorCamp!.state()!.arena.fights.length === 4);
    await freezeCamp(page, startOf('completed') + 80 * MIN + 1000);
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => window.__cloudiatorCamp!.tournamentReads())).toBe(2);
  });

  test('loads the battle log of each bout it stages on demand, once, from views that carry none', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openCampTournament(page, 5, false);
    const logReads = () => page.evaluate(() => window.__cloudiatorCamp!.tournamentLogReads());
    await page.waitForFunction(() => window.__cloudiatorCamp!.tournamentReads() === 1);
    await page.waitForTimeout(1500);
    // Before round 1 nothing is staged, so no log is asked for.
    expect([await logReads(), await page.evaluate(() => window.__cloudiatorCamp!.state()!.arena.fights.length)]).toEqual([0, 0]);
    // Round 1: its four bouts' logs load, and then the bouts are staged in rings.
    await freezeCamp(page, revealOf('completed', 1) + 500);
    await page.waitForFunction(() => window.__cloudiatorCamp!.state()!.arena.fights.length === 4);
    const round1 = VIEWS.completed.bouts.filter(b => b.round === 1).map(b => b.id).sort();
    expect((await page.evaluate(() => window.__cloudiatorCamp!.tournamentLogs())).sort()).toEqual(round1);
    expect(await logReads()).toBe(4);
    // Later checks, and the read after the next reveal, ask only for the new round's two logs.
    await page.waitForTimeout(1500);
    expect(await logReads()).toBe(4);
    await freezeCamp(page, revealOf('completed', 2) + 500);
    await page.waitForFunction(() => window.__cloudiatorCamp!.state()!.arena.fights.length === 6);
    await page.waitForTimeout(1500);
    expect(await logReads()).toBe(6);
  });
});
