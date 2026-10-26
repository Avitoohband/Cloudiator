import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from './fixtures';
import type { BattleLog, RevealedTimeline } from '../../supabase/functions/_shared/contracts/events';
import type { GameCommand } from '../../supabase/functions/_shared/contracts/commands';
import type { OwnerState, PublicActor, TournamentView, WorldSnapshot } from '../../supabase/functions/_shared/contracts/reads';
import { ownerFixture, worldFixture } from '../fixtures/domain';
import { recordMeasurement } from '../fixtures/measurements';
import { ARENA_BOUTS, type ArenaBoutKey } from '../fixtures/arena-ids';
import { buildArenaFixtures } from '../fixtures/arena-build';
import { EXPEDITION_FIXTURES } from '../fixtures/expedition-ids';
import { REPLAY_FIXTURES } from '../fixtures/replay-ids';
import { TOURNAMENT_KEYS, TOURNAMENTS, type TournamentKey } from '../fixtures/tournament-ids';
import { largeTournament } from '../fixtures/tournament-build';
import { SLOT_MS, SUPABASE_URL, emptyWorld, routeLiveReads, seedSession } from './live-routes';
import { reviewShot, reviewShot360 } from './review-shots';
import { creationDialog, expectOwnerShown, openMenu, spendSuggestedPoints } from './shell-helpers';

// Task 23.4: read volume and render cost. The camp stops drawing under an opaque scene; "being prepared" re-reads back off;
// a multi-league camp lays its rings out the same whatever order the views arrive in, and asks a failed ring log again
// soon; the owner is read once per revision change; a /replay/ deep link reads no world; one timeline is read per human
// Arena pair; a failed replay offers Try again; and the frame-rate overlay shows only with `?perf=1`.

const production = process.env.PLAYWRIGHT_STATIC === 'true';
const MIN = 60_000;
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const VIEWS = Object.fromEntries(TOURNAMENT_KEYS.map(key => [key, readJson<TournamentView>(`tests/fixtures/tournaments/${key}.json`)])) as Record<TournamentKey, TournamentView>;
const campReady = (page: Page) => page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
const scene = (page: Page, name: 'Replay' | 'Expedition') => page.getByRole('dialog', { name, exact: true });
const backToCamp = (page: Page) => page.getByRole('button', { name: 'Back to camp' });
const campState = (page: Page) => page.evaluate(() => window.__cloudiatorCamp!.state()!);
const CORS = { 'access-control-allow-origin': '*' };
const serverError = { status: 500, headers: CORS, contentType: 'application/json', body: JSON.stringify({ code: 'XX000', message: 'internal error', details: null, hint: null }) };

/** Counts each canvas's WebGL draw calls, so a test can tell whether the camp is still drawing. */
async function countDraws(context: BrowserContext) {
  await context.addInitScript(() => {
    const counts = new WeakMap<object, number>();
    for (const proto of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype] as unknown as Record<string, (...args: unknown[]) => unknown>[]) {
      for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
        const original = proto[name];
        if (typeof original !== 'function') continue;
        proto[name] = function (this: WebGLRenderingContext, ...args: unknown[]) {
          counts.set(this.canvas, (counts.get(this.canvas) ?? 0) + 1);
          return original.apply(this, args);
        };
      }
    }
    (window as unknown as { __draws(canvas: Element | null): number }).__draws = canvas => (canvas ? counts.get(canvas) ?? 0 : 0);
  });
}
const campDraws = (page: Page) => page.evaluate(() => (window as unknown as { __draws(canvas: Element | null): number }).__draws(document.querySelector('[data-camp-view] canvas')));
/** The camp's draw calls over `ms` of real time. */
async function drawsDuring(page: Page, ms: number) {
  const before = await campDraws(page);
  await page.waitForTimeout(ms);
  return (await campDraws(page)) - before;
}

/** Holds the camp's display clock at `ms` from the moment the camp exists (Task 13.9's late-joiner pattern). */
async function freezeCampAt(context: BrowserContext, ms: number) {
  await context.addInitScript(t => {
    let hook: { freezeClock(ms: number): void } | undefined;
    Object.defineProperty(window, '__cloudiatorCamp', { configurable: true, get: () => hook, set: value => { hook = value; value?.freezeClock(t); } });
  }, ms);
}

test.describe('the camp under an opaque scene (C8)', () => {
  test.skip(production, 'The sample scenes need the fixture preview.');

  test('pauses the camp loop while an opaque scene is open and resumes after', async ({ page, context }, testInfo) => {
    await countDraws(context);
    await page.goto('/game/?mode=fixture');
    await campReady(page);
    expect(await drawsDuring(page, 500), 'the camp draws while nothing covers it').toBeGreaterThan(0);
    const views = [
      { name: 'Replay' as const, event: 'view-replay' as const, activityId: REPLAY_FIXTURES.pvp.activityId, ready: () => page.waitForFunction(() => window.__cloudiatorBattle?.debug()?.ready === true, null, { timeout: 45_000 }) },
      { name: 'Expedition' as const, event: 'view-expedition' as const, activityId: EXPEDITION_FIXTURES.woodland.activityId, ready: () => page.waitForFunction(() => window.__cloudiatorExpeditionScene?.debug()?.ready === true, null, { timeout: 45_000 }) },
    ];
    for (const view of views) {
      await page.evaluate(({ event, activityId }) => window.__cloudiatorCamp!.emit(event, { activityId }), { event: view.event, activityId: view.activityId });
      await expect(scene(page, view.name)).toBeVisible();
      await view.ready();
      await page.waitForTimeout(300);
      // Covered by the scene, the camp draws nothing at all; the scene's own view keeps drawing.
      expect(await drawsDuring(page, 1_000), `under the ${view.name} scene`).toBe(0);
      if (view.name === 'Replay') await reviewShot(page, testInfo, 'perf-camp-paused-under-replay');
      await backToCamp(page).click();
      await expect(scene(page, view.name)).toHaveCount(0);
      // Back in the camp it draws again, the same ready scene with its one canvas.
      await expect.poll(() => drawsDuring(page, 300), { message: `after the ${view.name} scene` }).toBeGreaterThan(0);
      expect(await page.evaluate(() => ({ ready: window.__cloudiatorCamp!.state()!.ready, canvases: window.__cloudiatorCamp!.canvases() }))).toEqual({ ready: true, canvases: 1 });
    }
  });
});

test.describe('live reads (C6, C9, C11, C25)', () => {
  test.skip(production, 'Live mode uses development-only intercepted Supabase transport.');
  test.use({ timezoneId: 'UTC' });

  test('backs off both preparing reads after three minutes', async ({ page, context }) => {
    // A player whose processed slot lags, 40 s after the cutoff: the slot is never published here, so its tournament stays
    // "being prepared". Without a published slot on the revision (before the first coordination) each re-read refreshes
    // the owner first (Task 19 R2), so the two reads go together; with one, only the tournament is re-read (C5, below).
    const start = TOURNAMENTS.opening.startsAtMs;
    const slot = start / SLOT_MS;
    const at = start + 40_000;
    await seedSession(context);
    const live = await routeLiveReads(context, { world: emptyWorld(at), owner: { ...structuredClone(ownerFixture), processedSlotIndex: slot - 1 }, serverNowMs: () => at,
      publishedSlotIndex: () => null });
    await page.clock.install();
    await page.goto('/game/');
    await expectOwnerShown(page, 'Aster');
    await openMenu(page, 'Tournaments');
    const panel = page.getByRole('region', { name: 'Tournaments', exact: true });
    await expect(panel.getByRole('status').filter({ hasText: 'Tournament being prepared' })).toBeVisible({ timeout: 45_000 });
    const views = () => live.count('tournament_views'), owners = () => live.count('owner_state');
    await page.waitForTimeout(500);
    let [v, o] = [views(), owners()];
    // Each step is one 30 s retry tick. Until three minutes after the cutoff every tick reads (70, 100, 130 and 160 s);
    // then the reads come after 60 s (220 s), 120 s (340 s) and 240 s (580 s).
    const expected = [1, 1, 1, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1];
    for (const [step, reads] of expected.entries()) {
      await page.clock.fastForward(30_000);
      if (reads) await expect.poll(views, { message: `tick ${step + 1}` }).toBe(v + 1);
      else await page.waitForTimeout(400);
      expect(views(), `tick ${step + 1}: tournament reads`).toBe(v + reads);
      expect(owners(), `tick ${step + 1}: owner reads`).toBe(o + reads);
      v += reads;
      o += reads;
    }
    await expect(panel.getByRole('status').filter({ hasText: 'Tournament being prepared' })).toBeVisible();
  });

  test('uses the published slot instead of the five-minute grace', async ({ page, context }) => {
    // A gladiator created after the cutoff (its processed slot is already the tournament's): the five-minute grace ended
    // its "being prepared" at +300 s although the slot was not published. The revision's published slot (Task 23.2) keeps it
    // until the publication, re-reads only the tournament meanwhile, and reads it again as soon as the slot is published.
    const start = TOURNAMENTS.opening.startsAtMs;
    const slot = start / SLOT_MS;
    let skipped = 0, published = slot - 1;
    const began = Date.now();
    await seedSession(context);
    const live = await routeLiveReads(context, { world: emptyWorld(start + 40_000), owner: { ...structuredClone(ownerFixture), processedSlotIndex: slot },
      serverNowMs: () => start + 40_000 + skipped + (Date.now() - began), publishedSlotIndex: () => published });
    await page.clock.install();
    await page.goto('/game/');
    await expectOwnerShown(page, 'Aster');
    await openMenu(page, 'Tournaments');
    const panel = page.getByRole('region', { name: 'Tournaments', exact: true });
    const preparing = panel.getByRole('status').filter({ hasText: 'Tournament being prepared' });
    const missing = panel.getByRole('status').filter({ hasText: 'No tournament matches this selection.' });
    await expect(preparing).toBeVisible({ timeout: 45_000 });
    await page.waitForTimeout(500);
    const owners = live.count('owner_state');
    /** Moves the page clock, and the server's time with it, in 30 s steps to `ms` after the cutoff. */
    const advanceTo = async (ms: number) => {
      for (;;) {
        const shown = await page.evaluate(() => window.__cloudiatorShell!.clock.now());
        const by = Math.min(30_000, start + ms - shown);
        if (by <= 0) return;
        skipped += by;
        await page.clock.fastForward(by);
        await page.waitForTimeout(150);
      }
    };
    await advanceTo(290_000);
    await expect(preparing).toBeVisible();
    await advanceTo(420_000);
    await expect(preparing).toBeVisible();
    await expect(missing).toHaveCount(0);
    // While being prepared only the tournament is re-read: the owner is not refreshed with each re-read.
    expect(live.count('owner_state'), 'owner reads while the slot is being prepared').toBe(owners);
    // The slot is published: the next revision poll says so, and the card reads its tournament at once.
    published = slot;
    live.setTournaments([VIEWS.opening]);
    const views = live.count('tournament_views');
    await page.clock.fastForward(30_000);
    await expect.poll(() => live.count('tournament_views'), { timeout: 5_000 }).toBeGreaterThan(views);
    await expect(panel.locator('article[data-status]').getByRole('heading', { name: 'Bronze tournament' })).toBeVisible();
    await expect(preparing).toHaveCount(0);
  });

  test('retries a failed ring log and keeps multi-league arrival order', async ({ page, context }) => {
    // Two leagues' 24-entrant tournaments (32-slot brackets, eight fought round-1 bouts each) share their reveal times.
    // Joined 10 s after round 1 shows, sixteen bouts compete for six rings: which league's view arrives first must not
    // decide which bouts take them.
    const templates = Object.values(VIEWS).flatMap(view => view.bouts.flatMap(b => (b.revealedResult?.battleLog ? [b.revealedResult.battleLog] : [])));
    const start = TOURNAMENTS.opening.startsAtMs;
    const bronze = largeTournament(24, { startsAtMs: start, league: 'bronze', templates });
    const silver = largeTournament(24, { startsAtMs: start, league: 'silver', templates });
    const at = start + Math.ceil(80 * MIN / 6) + 10_000;
    const live = await routeLiveReads(context, { world: { ...emptyWorld(at), actors: [...bronze.actors, ...silver.actors] }, tournaments: [bronze.view, silver.view], serverNowMs: () => at });
    await freezeCampAt(context, at);
    let slow: 'bronze' | 'silver' = 'bronze';
    await context.route(url => url.pathname === '/rest/v1/tournament_views', async route => {
      if (new URL(route.request().url()).searchParams.get('id')?.endsWith(`:${slow}`)) await new Promise(resolve => setTimeout(resolve, 1_500));
      return route.fallback();
    });
    let failOnce = false;
    const failed: string[] = [];
    await context.route(url => url.pathname === '/rest/v1/tournament_bout_results', route => {
      const bout = new URL(route.request().url()).searchParams.get('bout_id')?.replace(/^eq\./, '') ?? null;
      if (bout && failOnce && failed.length === 0) { failed.push(bout); return route.fulfill(serverError); }
      return route.fallback();
    });
    const logReads = (id: string) => live.requests.filter(r => r.table === 'tournament_bout_results' && r.query.get('bout_id') === `eq.${id}`).length;
    const layout = async () => {
      await page.goto('/game/');
      await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
      await page.waitForFunction(() => window.__cloudiatorCamp!.state()!.arena.fights.length === 16, null, { timeout: 30_000 });
      await page.waitForTimeout(2_000);
      return (await campState(page)).arena.fights.map(f => ({ battleId: f.battleId, ring: f.ring, enterAtMs: f.enterAtMs })).sort((p, q) => (p.battleId < q.battleId ? -1 : 1));
    };
    const bronzeLast = await layout();
    slow = 'silver';
    failOnce = true;
    const silverLast = await layout();
    expect(silverLast).toEqual(bronzeLast);
    // The failed ring log was asked for again within a few seconds (not after 30 s), and its pair has its log.
    expect(failed).toHaveLength(1);
    const [bout] = failed;
    const before = logReads(bout);
    await expect.poll(() => logReads(bout), { timeout: 8_000 }).toBeGreaterThan(before);
    await page.waitForFunction(id => window.__cloudiatorCamp!.state()!.arena.fights.find(f => f.battleId === id)?.logged === true, bout, { timeout: 8_000 });
  });

  test('reads the owner once per revision change', async ({ page, context }) => {
    await seedSession(context);
    const world: WorldSnapshot = { ...worldFixture, revision: 'live-1' };
    const live = await routeLiveReads(context, { world, owner: ownerFixture });
    await page.clock.install();
    await page.goto('/game/');
    await expectOwnerShown(page, 'Aster');
    const owners = () => live.count('owner_state'), loads = () => live.count('world_actor_reads');
    await page.waitForTimeout(500);
    let read = owners();
    // A new revision at the 30 s poll: one owner read.
    live.setWorld({ ...world, revision: 'live-2' });
    await page.clock.fastForward(30_000);
    await expect.poll(owners).toBe(++read);
    await page.waitForTimeout(1_000);
    expect(owners()).toBe(read);
    // The tab comes back (visibilitychange and focus) to a new revision: the return and the revision change share one read.
    live.setWorld({ ...world, revision: 'live-3' });
    const loaded = loads();
    await page.clock.fastForward(2_500);
    await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
    await expect.poll(loads).toBe(loaded + 1);
    await expect.poll(owners).toBe(++read);
    await page.waitForTimeout(1_500);
    expect(owners(), 'one owner read for the return and its revision change').toBe(read);
    // A return with no revision change still reads the owner once (a sale changes it without one).
    await page.clock.fastForward(2_500);
    await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
    await expect.poll(owners).toBe(++read);
    await page.waitForTimeout(1_000);
    expect(owners()).toBe(read);
    expect(loads()).toBe(loaded + 1);
  });

  test('reads the owner once more after creating a gladiator, and shows its new world at once', async ({ page, context }) => {
    // Creation confirms itself with one owner read; the world revision it changes then costs one more, never a second
    // refresh, and the camp loads the new world at once instead of at the next 30 s poll.
    const user = await seedSession(context);
    const world: WorldSnapshot = { ...worldFixture, revision: 'before-creation', actors: [] };
    const live = await routeLiveReads(context, { world, owner: null });
    await context.route(`${SUPABASE_URL}/functions/v1/game-command`, async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      const command = route.request().postDataJSON() as GameCommand;
      if (command.kind !== 'create-character') return route.fallback();
      const owner: OwnerState = { ...structuredClone(ownerFixture), name: command.name };
      live.setOwner(owner);
      live.setWorld({ ...world, revision: 'after-creation', actors: [{ ...worldFixture.actors[0], name: command.name }] });
      return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify({ ok: true, receiptId: randomUUID(), value: { gladiatorId: owner.gladiatorId } }) });
    });
    await page.clock.install();
    await page.goto('/game/');
    const dialog = creationDialog(page);
    await expect(dialog).toBeVisible({ timeout: 45_000 });
    await dialog.getByLabel('Gladiator name').fill('Marcus');
    await spendSuggestedPoints(page);
    const [owners, loads] = [live.count('owner_state'), live.count('world_actor_reads')];
    await dialog.getByRole('button', { name: 'Create gladiator', exact: true }).click();
    await expectOwnerShown(page, 'Marcus');
    await expect(page.getByRole('heading', { name: 'Marcus', exact: true })).toBeVisible();
    // The new world loads at once, with the new gladiator in camp.
    await expect.poll(() => live.count('world_actor_reads'), { timeout: 5_000 }).toBe(loads + 1);
    await page.waitForFunction(() => window.__cloudiatorCamp?.world()?.actors.some(a => a.name === 'Marcus') === true, null, { timeout: 10_000 });
    await page.waitForTimeout(1_000);
    expect(live.count('owner_state') - owners, 'the confirming read and the revision change').toBe(2);
    // The next poll finds the same revision: nothing more is read.
    await page.clock.fastForward(30_000);
    await expect.poll(() => live.count('world_revision')).toBeGreaterThan(0);
    await page.waitForTimeout(1_000);
    expect(live.count('owner_state') - owners).toBe(2);
    expect(live.count('world_actor_reads')).toBe(loads + 1);
    expect(live.requests.filter(r => r.table === 'owner_state').every(r => r.reader === user.id)).toBe(true);
  });

  test('reads only the revision and the timeline for a /replay/ deep link, and the owner once', async ({ page, context }) => {
    const log = readJson<BattleLog>('tests/fixtures/battles/pvp.json');
    const activityId = REPLAY_FIXTURES.pvp.activityId;
    const at = worldFixture.serverNowMs;
    const fought = at - 30 * MIN;
    const timeline: RevealedTimeline = { activityId, serverNowMs: at, visibleThroughMs: at, stages: [
      { id: `${activityId}:1`, kind: 'bout', revealedAtMs: fought, startedAtMs: fought, endsAtMs: fought + log.durationMs, label: 'Bout: victory', battleLog: log },
    ] };
    await seedSession(context);
    const world: WorldSnapshot = { ...worldFixture, revision: 'live-1' };
    const live = await routeLiveReads(context, { world, owner: ownerFixture, timelines: { [activityId]: timeline } });
    await page.clock.install();
    await page.goto(`/replay/?activity=${activityId}`);
    const main = page.locator('main#main');
    await expect(main.getByRole('heading', { level: 1, name: 'Aster vs Varro' })).toBeVisible({ timeout: 45_000 });
    await page.waitForTimeout(500);
    // The page's display clock needs the server's time, which the revision gives: no world, and the owner once. The replay's
    // two fighters' looks are one batched read of the actor projection (an `in` filter), made once, never the whole world.
    const worldReads = () => live.requests.filter(r => r.table === 'world_actor_reads' && !r.query.get('gladiator_id')?.startsWith('in.')).length;
    const lookReads = () => live.requests.filter(r => r.table === 'world_actor_reads' && r.query.get('gladiator_id')?.startsWith('in.')).length;
    expect(worldReads(), 'world reads').toBe(0);
    expect(lookReads(), 'look reads').toBe(1);
    expect(live.count('owner_state'), 'owner reads').toBe(1);
    const revisions = live.count('world_revision');
    live.setWorld({ ...world, revision: 'live-2' });
    await page.clock.fastForward(30_000);
    await expect.poll(() => live.count('world_revision')).toBeGreaterThan(revisions);
    await page.waitForTimeout(1_000);
    await page.clock.fastForward(2_500);
    await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
    await page.waitForTimeout(1_000);
    expect(worldReads(), 'world reads after a revision change and a tab return').toBe(0);
    expect(lookReads(), 'look reads after a revision change and a tab return').toBe(1);
    expect(live.count('owner_state'), 'owner reads after a revision change and a tab return').toBe(1);
  });

  test('reads one Arena timeline per human pair', async ({ page, context }) => {
    // The fixture slot's Arena entrants at minute 61: five human pairs, two NPC fallbacks and one entrant without a bout.
    const logs = Object.fromEntries((Object.keys(ARENA_BOUTS) as ArenaBoutKey[]).map(key => [key, readJson<BattleLog>(`tests/fixtures/arena/${key}.json`)])) as Record<ArenaBoutKey, BattleLog>;
    const arena = buildArenaFixtures(logs);
    const at = worldFixture.serverNowMs - (worldFixture.serverNowMs % SLOT_MS) + 61 * MIN;
    const entrants: PublicActor[] = arena.worldActors.map(a => ({ ...a }));
    const timelines = Object.fromEntries(entrants.map(a => [a.activityId!, { ...arena.timelines[a.activityId!], serverNowMs: at, visibleThroughMs: at }]));
    const live = await routeLiveReads(context, { world: { ...emptyWorld(at), revision: 'arena', actors: entrants }, timelines, serverNowMs: () => at });
    await page.goto('/game/');
    await campReady(page);
    await page.waitForFunction(() => window.__cloudiatorCamp!.state()!.arena.fights.length === 7, null, { timeout: 30_000 });
    await page.waitForTimeout(2_000);
    const reads = live.requests.filter(r => r.table === 'visible_events').map(r => r.query.get('activity_id'));
    const pairs = 5, npcBouts = 2, noBout = entrants.length - 2 * pairs - npcBouts;
    expect(entrants.length).toBe(2 * pairs + npcBouts + noBout);
    // One read for each pair, NPC bout and boutless entrant, with at most one more for a pair whose sides were read at the
    // same time (two reads run at once); Task 17 read every entrant's timeline.
    expect(reads.length, `timeline reads for ${entrants.length} entrants`).toBeLessThanOrEqual(pairs + npcBouts + noBout + 1);
    recordMeasurement('arena timeline reads', `${reads.length} for ${entrants.length} entrants (${pairs} human pairs)`);
    expect(new Set(reads).size).toBe(reads.length);
  });

  test('offers Try again when a replay cannot be loaded and recovers after it', async ({ page, context }, testInfo) => {
    // The /replay/ deep link (the scene over the camp shows the same view).
    const log = readJson<BattleLog>('tests/fixtures/battles/pvp.json');
    const activityId = REPLAY_FIXTURES.pvp.activityId;
    const at = worldFixture.serverNowMs, fought = at - 30 * MIN;
    const timeline: RevealedTimeline = { activityId, serverNowMs: at, visibleThroughMs: at, stages: [
      { id: `${activityId}:1`, kind: 'bout', revealedAtMs: fought, startedAtMs: fought, endsAtMs: fought + log.durationMs, label: 'Bout: victory', battleLog: log },
    ] };
    const live = await routeLiveReads(context, { world: { ...worldFixture, revision: 'live-1' }, timelines: { [activityId]: timeline } });
    live.fail('visible_events');
    await page.goto(`/replay/?activity=${activityId}`);
    const main = page.locator('main#main');
    await expect(main).toContainText('This replay cannot be loaded right now. Try again shortly.', { timeout: 45_000 });
    const again = main.getByRole('button', { name: 'Try again', exact: true });
    await expect(again).toBeEnabled();
    await reviewShot(page, testInfo, 'reload-replay-try-again');
    await reviewShot360(page, testInfo, 'reload-replay-try-again', again);
    live.fail('visible_events', false);
    await again.click();
    await expect(main.getByRole('heading', { level: 1, name: 'Aster vs Varro' })).toBeVisible({ timeout: 45_000 });

    // A tournament bout's inline replay whose log fails to load.
    const start = TOURNAMENTS.completed.startsAtMs, after = start + 85 * MIN;
    const tournaments = await routeLiveReads(context, { world: emptyWorld(after), tournaments: [VIEWS.completed], serverNowMs: () => after });
    let failing = true;
    await context.route(url => url.pathname === '/rest/v1/tournament_bout_results', route => (failing && new URL(route.request().url()).searchParams.has('bout_id') ? route.fulfill(serverError) : route.fallback()));
    await page.goto('/game/');
    await openMenu(page, 'Tournaments');
    const bracket = page.locator('article[data-status]');
    await bracket.getByRole('tab', { name: 'Final', exact: true }).click({ timeout: 45_000 });
    await bracket.getByRole('button', { name: 'Watch replay of Severus vs Varro' }).click();
    const replay = bracket.getByRole('region', { name: /^Replay · Final, bout 1$/ });
    await expect(replay).toContainText('This replay cannot be loaded right now. Try again shortly.');
    await replay.getByRole('button', { name: 'Try again', exact: true }).scrollIntoViewIfNeeded();
    await reviewShot(page, testInfo, 'reload-tournament-replay-try-again');
    await reviewShot360(page, testInfo, 'reload-tournament-replay-try-again', replay.getByRole('button', { name: 'Try again', exact: true }));
    failing = false;
    await replay.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(replay.getByRole('heading', { level: 6, name: 'Severus vs Varro' })).toBeVisible({ timeout: 30_000 });
    expect(tournaments.requests.filter(r => r.table === 'tournament_bout_results' && r.query.has('bout_id')).length).toBeGreaterThanOrEqual(1);
  });
});

test.describe('the frame-rate overlay (Decision 2)', () => {
  test('shows the frame-rate overlay only with ?perf=1', async ({ page }, testInfo) => {
    const camp = production ? '/game/' : '/game/?mode=fixture';
    await page.goto(camp);
    await expect(page.getByRole('application')).toBeVisible({ timeout: 45_000 });
    await page.waitForTimeout(1_500);
    // Off by default: no overlay at all.
    await expect(page.locator('[data-perf-overlay]')).toHaveCount(0);
    await page.goto(`${camp}${camp.includes('?') ? '&' : '?'}perf=1`);
    await expect(page.getByRole('application')).toBeVisible({ timeout: 45_000 });
    const overlay = page.locator('[data-perf-overlay]');
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText(/\d+ fps/);
    await expect(overlay).toContainText(/mean \d+(\.\d)? · p5 \d+(\.\d)?/);
    await expect(overlay).toContainText(/>16\.7 ms \d+(\.\d)?% · >33\.3 ms \d+(\.\d)?%/);
    // It never takes a pointer or the keyboard, and screen readers skip it.
    expect(await overlay.evaluate(el => ({ pointer: getComputedStyle(el).pointerEvents, hidden: el.getAttribute('aria-hidden'), focusable: el.querySelectorAll('a, button, input, [tabindex]').length })))
      .toEqual({ pointer: 'none', hidden: 'true', focusable: 0 });
    const frames = async () => Number(/(\d+) frames/.exec((await overlay.textContent()) ?? '')?.[1] ?? 0);
    const first = await frames();
    await expect.poll(frames).toBeGreaterThan(first);
    // Task 24.1b (Decision 11): the numbers are the current phase's, named with its age, beside a rolling 10 s line.
    await expect(overlay).toContainText(production ? /^(loading|camp|camp unavailable) · \d+ s · \d+ fps/ : /^camp · \d+ s · \d+ fps/);
    await expect(overlay).toContainText(/10 s: mean \d+(\.\d)? · p5 \d+(\.\d)? · >33\.3 ms \d+(\.\d)?%/);
    await reviewShot(page, testInfo, 'perf-overlay-camp');
    // At 360 px the renderer line wraps onto as many lines as it needs: nothing of it is cut short or hidden.
    const size = page.viewportSize();
    await page.setViewportSize({ width: 360, height: 740 });
    await page.waitForTimeout(500);
    const expected = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl');
      if (!gl) return 'no WebGL';
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return name;
    });
    const rendererLine = overlay.locator('p').last();
    await expect(rendererLine).toHaveText(expected);
    const wrap = await rendererLine.evaluate(el => {
      const box = el.closest('[data-perf-overlay]')!.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(el);
      const lines = new Set([...range.getClientRects()].map(r => Math.round(r.top))).size;
      // The same text on one line, measured off-screen: wider than the line box means it has to wrap.
      const probe = document.createElement('span');
      probe.style.cssText = 'position:fixed;left:-9999px;white-space:nowrap;';
      probe.style.font = getComputedStyle(el).font;
      probe.textContent = el.textContent;
      document.body.append(probe);
      const natural = probe.getBoundingClientRect().width;
      probe.remove();
      return { whiteSpace: getComputedStyle(el).whiteSpace, clipped: el.scrollWidth > el.clientWidth, lines, needed: natural > el.clientWidth,
        inside: box.left >= 0 && box.right <= window.innerWidth };
    });
    expect(wrap, `the renderer line at 360 px: ${JSON.stringify(wrap)}`).toMatchObject({ whiteSpace: 'normal', clipped: false, inside: true });
    if (wrap.needed) expect(wrap.lines, 'a renderer string wider than the box wraps').toBeGreaterThan(1);
    await reviewShot(page, testInfo, 'perf-overlay-camp-360');
    if (size) {
      await page.setViewportSize(size);
      await page.waitForTimeout(300);
    }
    if (!production) {
      // The camp's phase runs on until a scene opens (at least 6 s here, so its reset shows in the age).
      await expect(overlay).toContainText(/^camp · ([6-9]|\d{2,}) s/, { timeout: 20_000 });
      // It stays over a scene, so a device run measures the scenes too.
      await page.evaluate(id => window.__cloudiatorCamp!.emit('view-replay', { activityId: id }), REPLAY_FIXTURES.pvp.activityId);
      await expect(scene(page, 'Replay')).toBeVisible();
      // Opening the scene starts a new phase: the replay's own numbers, from its opening.
      await expect(overlay).toContainText(/^replay · [0-4] s · \d+ fps/);
      await page.waitForFunction(() => window.__cloudiatorBattle?.debug()?.ready === true, null, { timeout: 45_000 });
      // A manual popover, raised again above the scene's modal dialog in the top layer (the screenshot shows it on top).
      await expect(overlay).toBeVisible();
      await expect.poll(() => overlay.evaluate(el => el.matches(':popover-open'))).toBe(true);
      const opened = await frames();
      await expect.poll(frames).toBeGreaterThan(opened + 30);
      await reviewShot(page, testInfo, 'perf-overlay-scene');
      // Closing it starts the camp's phase again.
      await backToCamp(page).click();
      await expect(scene(page, 'Replay')).toHaveCount(0);
      await expect(overlay).toContainText(/^camp · [0-4] s · \d+ fps/);
    }
  });
});
