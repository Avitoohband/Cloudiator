import { readFileSync } from 'node:fs';
import { expect, test, type Page } from './fixtures';
import type { BattleLog } from '../../supabase/functions/_shared/contracts/events';
import type { TournamentView, WorldSnapshot } from '../../supabase/functions/_shared/contracts/reads';
import { ownerFixture, worldFixture } from '../fixtures/domain';
import { ARENA_BOUTS, type ArenaBoutKey } from '../fixtures/arena-ids';
import { buildArenaFixtures } from '../fixtures/arena-build';
import { TOURNAMENTS } from '../fixtures/tournament-ids';
import { tournamentCampActors } from '../fixtures/tournament-build';
import { createDemoWorld } from '../../src/game/demo-world';
import { SLOT_MS, emptyWorld, routeLiveReads, seedSession } from './live-routes';
import { expectOwnerShown, joinButton, openMenu } from './shell-helpers';

// Task 13.3: the game page mounts the camp in live mode from the public reads, with one sync controller owning the
// shared display clock (`window.__cloudiatorShell.clock`, fixture-enabled builds only) and the owner state.

/** A live camp from fixture DTOs: the owner fixture's actor and a training and resting crowd (no Arena or tournament entrants). */
function liveWorld(): WorldSnapshot {
  const crowd = createDemoWorld(worldFixture.serverNowMs, 14, 2).actors.filter(a => a.location !== 'arena' && a.location !== 'tournament');
  return { ...worldFixture, revision: 'live-1', actors: [...worldFixture.actors, ...crowd] };
}
/** Waits for the scene to be ready with a world of `actors` actors (any number when omitted). */
async function waitForCamp(page: Page, actors?: number) {
  await page.waitForFunction(n => {
    const length = window.__cloudiatorCamp?.state()?.ready === true ? window.__cloudiatorCamp.world()?.actors.length : undefined;
    return length !== undefined && (n === null ? length > 0 : length === n);
  }, actors ?? null, { timeout: 45_000 });
}
const shownTime = (page: Page) => page.evaluate(() => window.__cloudiatorShell!.clock.now());
/** The stored session's Auth calls that renew or end it, in order: `token:refresh_token` and `logout:local`. */
const renewalsAndSignOuts = (live: { authRequests: readonly { path: string; query: URLSearchParams }[] }) => live.authRequests
  .filter(r => r.path === '/auth/v1/token' || r.path === '/auth/v1/logout')
  .map(r => (r.path === '/auth/v1/token' ? `token:${r.query.get('grant_type')}` : `logout:${r.query.get('scope')}`));

test.beforeEach(() => { test.skip(process.env.PLAYWRIGHT_STATIC === 'true', 'Live mode uses development-only intercepted Supabase transport.'); });

test('mounts the camp from live public reads, polling only the revision every 30 s', async ({ page, context }) => {
  const world = liveWorld();
  const live = await routeLiveReads(context, { world });
  await page.clock.install();
  await page.goto('/game/');
  await waitForCamp(page, world.actors.length);
  await expect(page.locator('.scene-placeholder')).toHaveCount(0);
  // The shared clock shows the server's time from the timed revision read (days behind this browser's wall clock here).
  expect(Math.abs(await shownTime(page) - live.serverNowMs())).toBeLessThan(5_000);
  const revisions = live.count('world_revision'), loads = live.count('world_actor_reads');
  for (let poll = 1; poll <= 3; poll++) {
    await page.clock.fastForward(30_000);
    await expect.poll(() => live.count('world_revision')).toBe(revisions + poll);
  }
  expect(live.count('world_actor_reads')).toBe(loads);
  // A changed revision loads the world once, and the camp shows it.
  live.setWorld({ ...world, revision: 'live-2', actors: world.actors.slice(1) });
  await page.clock.fastForward(30_000);
  await expect.poll(() => live.count('world_actor_reads')).toBe(loads + 1);
  await waitForCamp(page, world.actors.length - 1);
  // A visitor: only anonymous public reads, never the owner state or a command.
  expect(live.requests.every(r => r.reader === null)).toBe(true);
  expect(new Set(live.requests.map(r => r.table))).toEqual(new Set(['world_revision', 'world_actor_reads']));
});

test('a visitor’s live camp reads Arena timelines and tournaments anonymously, from public tables only, and sends no command', async ({ page, context }) => {
  // 13.3 review: the camp's live timeline and tournament reads were untested for a visitor. Minute 60 of the `completed`
  // tournament's slot (5 s after the final shows), with two of the slot's Arena entrants whose bout is revealed then too.
  const view = JSON.parse(readFileSync('tests/fixtures/tournaments/completed.json', 'utf8')) as TournamentView;
  const start = TOURNAMENTS.completed.startsAtMs;
  const at = start + 60 * 60_000 + 5_000;
  const logs = Object.fromEntries((Object.keys(ARENA_BOUTS) as ArenaBoutKey[]).map(key => [key, JSON.parse(readFileSync(`tests/fixtures/arena/${key}.json`, 'utf8')) as BattleLog])) as Record<ArenaBoutKey, BattleLog>;
  const arena = buildArenaFixtures(logs);
  // The Bellator and Corvina pair, moved from the fixture world's slot into the tournament's.
  const pair = arena.worldActors.filter(a => a.name === 'Bellator' || a.name === 'Corvina');
  const shift = start - pair[0].startsAtMs!;
  const moved = (t: number) => t + shift;
  const entrants = pair.map(a => ({ ...a, startsAtMs: moved(a.startsAtMs!), endsAtMs: moved(a.endsAtMs!), visibleStage: null }));
  const timelines = Object.fromEntries(pair.map(a => {
    const timeline = arena.timelines[a.activityId!];
    return [a.activityId!, { ...timeline, serverNowMs: at, visibleThroughMs: at,
      stages: timeline.stages.map(s => ({ ...s, revealedAtMs: moved(s.revealedAtMs), startedAtMs: moved(s.startedAtMs), endsAtMs: moved(s.endsAtMs) })) }];
  }));
  const world: WorldSnapshot = { ...emptyWorld(at), revision: 'live-tournament', actors: [...tournamentCampActors('completed'), ...entrants] };
  const live = await routeLiveReads(context, { world, tournaments: [view], timelines, serverNowMs: () => at });
  const commands: string[] = [];
  page.on('request', request => { if (request.url().includes('/functions/v1/')) commands.push(request.url()); });
  await page.goto('/game/');
  await waitForCamp(page, world.actors.length);
  // The camp stages the Arena pair's bout and the final (with the earlier rounds' bouts, long over), each from public reads.
  const final = view.bouts.find(b => b.round === 3)!.id;
  await page.waitForFunction(({ final, bellator }) => {
    const fights = window.__cloudiatorCamp!.state()!.arena.fights;
    return fights.some(f => f.battleId === final) && fights.some(f => f.fighters.includes(bellator));
  }, { final, bellator: pair.find(a => a.name === 'Bellator')!.gladiatorId }, { timeout: 30_000 });
  await expect.poll(() => live.requests.some(r => r.table === 'tournament_bout_results' && r.query.get('bout_id') === `eq.${final}`)).toBe(true);
  expect(live.count('visible_events')).toBeGreaterThan(0);
  expect(live.count('tournament_views')).toBeGreaterThan(0);
  // Only the public projections, every read anonymous, no command and no Auth call.
  const PUBLIC = new Set(['world_revision', 'world_actor_reads', 'visible_events', 'recent_results', 'tournament_views', 'tournament_bout_results', 'tournament_placements']);
  expect(live.requests.filter(r => !PUBLIC.has(r.table)).map(r => r.table)).toEqual([]);
  expect(live.requests.filter(r => r.reader !== null)).toEqual([]);
  expect(commands).toEqual([]);
  expect(live.authRequests).toEqual([]);
});

test('shows the camp when the first world arrives late', async ({ page, context }) => {
  const world = liveWorld();
  const live = await routeLiveReads(context, { world });
  const release = live.hold('world_actor_reads');
  const opened = Date.now();
  await page.goto('/game/');
  // The scene opens on an empty camp while the first world is still loading.
  await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
  expect(await page.evaluate(() => window.__cloudiatorCamp!.world())).toBeNull();
  await expect.poll(() => live.count('world_actor_reads')).toBeGreaterThan(0);
  await page.waitForTimeout(Math.max(0, 3_000 - (Date.now() - opened)));
  release();
  await waitForCamp(page, world.actors.length);
  const away = world.actors.filter(a => a.location.startsWith('expedition:')).length;
  const state = await page.evaluate(() => window.__cloudiatorCamp!.state()!);
  expect({ players: state.players, away: state.away }).toEqual({ players: world.actors.length - away, away });
  await expect(page.getByText('Opening the camp…')).toHaveCount(0);
});

test('signs a rejected stored session out locally and keeps the camp running for the visitor', async ({ page, context }) => {
  // The stored token is no longer accepted: supabase-js still attaches it to the public reads.
  const user = await seedSession(context);
  const world = liveWorld();
  const live = await routeLiveReads(context, { world, owner: ownerFixture });
  live.rejectSessions();
  await page.goto('/game/');
  await waitForCamp(page, world.actors.length);
  await openMenu(page, 'My gladiator');
  await expect(page.getByRole('button', { name: 'Sign in with Google to create your gladiator' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('sb-127-auth-token'))).toBeNull();
  expect(live.requests.some(r => r.reader === user.id && r.table === 'world_revision')).toBe(true);
  const loads = live.requests.filter(r => r.table === 'world_actor_reads');
  expect(loads.length).toBeGreaterThan(0);
  expect(loads.every(r => r.reader === null)).toBe(true);
  // The sign-out was this browser's only (scope=local), never the account's other sessions.
  const logouts = live.authRequests.filter(r => r.path === '/auth/v1/logout');
  expect(logouts.map(r => r.query.get('scope'))).toEqual(['local']);
  // Final review Minor 3: one refresh was tried first; the server refused it, so the session was signed out.
  expect(renewalsAndSignOuts(live)).toEqual(['token:refresh_token', 'logout:local']);
});

test('keeps a player signed in when one refresh renews a rejected stored session', async ({ page, context }) => {
  // Final review Minor 3: a device clock running slow, or a transient rejection, has the server refuse a stored access
  // token whose refresh token is still good. One refresh renews it; the camp and the owner read again with the new token.
  const user = await seedSession(context);
  const world = liveWorld();
  const live = await routeLiveReads(context, { world, owner: ownerFixture });
  live.rejectSessions();
  live.renewSessions();
  await page.goto('/game/');
  await waitForCamp(page, world.actors.length);
  await expectOwnerShown(page, 'Aster');
  await expect(joinButton(page)).toHaveCount(0);
  expect(renewalsAndSignOuts(live)).toEqual(['token:refresh_token']);
  expect(await page.evaluate(() => localStorage.getItem('sb-127-auth-token'))).not.toBeNull();
  expect(live.requests.filter(r => r.table === 'world_actor_reads').every(r => r.reader === user.id)).toBe(true);
  // Nothing more is renewed or signed out while the reads succeed.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(1_000);
  expect(renewalsAndSignOuts(live)).toEqual(['token:refresh_token']);
});

test('signs out locally when the renewed session is still refused at the next read', async ({ page, context }) => {
  // Final review Minor 3: the refresh succeeds but the server refuses the new token as well, so this browser signs out.
  await seedSession(context);
  const world = liveWorld();
  const live = await routeLiveReads(context, { world, owner: ownerFixture });
  live.rejectSessions();
  live.renewSessions({ accepted: false });
  await page.goto('/game/');
  await waitForCamp(page, world.actors.length);
  await expect(joinButton(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('sb-127-auth-token'))).toBeNull();
  expect(renewalsAndSignOuts(live)).toEqual(['token:refresh_token', 'logout:local']);
  const loads = live.requests.filter(r => r.table === 'world_actor_reads');
  expect(loads.length).toBeGreaterThan(0);
  expect(loads.every(r => r.reader === null)).toBe(true);
});

test('retries a failed local sign-out of a rejected session on the next sync publish, then reads as a visitor', async ({ page, context }) => {
  // 13.3 review: a sign-out that fails and keeps the stored session must not leave a signed-in view over an empty camp.
  // Here the browser's storage refuses the first removal of the session, so the first sign-out fails with it stored.
  await context.addInitScript(() => {
    const original = Storage.prototype.removeItem;
    let refused = false;
    Storage.prototype.removeItem = function (this: Storage, key: string) {
      if (!refused && key === 'sb-127-auth-token') { refused = true; throw new Error('storage unavailable (test)'); }
      return original.call(this, key);
    };
  });
  await seedSession(context);
  const world = liveWorld();
  const live = await routeLiveReads(context, { world, owner: ownerFixture });
  live.rejectSessions();
  await page.clock.install();
  await page.goto('/game/');
  const logouts = () => live.authRequests.filter(r => r.path === '/auth/v1/logout');
  await expect.poll(() => logouts().length).toBe(1);
  await page.waitForTimeout(1_000);
  // The failed sign-out keeps the stored session; nothing asks again before the next sync publish.
  expect(logouts()).toHaveLength(1);
  expect(await page.evaluate(() => localStorage.getItem('sb-127-auth-token'))).not.toBeNull();
  await page.clock.fastForward(30_000);
  await expect.poll(() => logouts().length).toBe(2);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('sb-127-auth-token'))).toBeNull();
  await waitForCamp(page, world.actors.length);
  await openMenu(page, 'My gladiator');
  await expect(page.getByRole('button', { name: 'Sign in with Google to create your gladiator' })).toBeVisible();
  // Both attempts signed out this browser only.
  expect(logouts().map(r => r.query.get('scope'))).toEqual(['local', 'local']);
  const loads = live.requests.filter(r => r.table === 'world_actor_reads');
  expect(loads.length).toBeGreaterThan(0);
  expect(loads.every(r => r.reader === null)).toBe(true);
});

test('drops the rejected session locally even when the server refuses its sign-out', async ({ page, context }) => {
  // Observed with supabase-js 2.117.3: a failed /auth/v1/logout (503) still removes the local session, so one attempt
  // is enough and the reads continue as a visitor's.
  await seedSession(context);
  const world = liveWorld();
  const live = await routeLiveReads(context, { world, owner: ownerFixture });
  live.rejectSessions();
  live.failLogout(1);
  await page.goto('/game/');
  await waitForCamp(page, world.actors.length);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('sb-127-auth-token'))).toBeNull();
  await openMenu(page, 'My gladiator');
  await expect(page.getByRole('button', { name: 'Sign in with Google to create your gladiator' })).toBeVisible();
  expect(live.authRequests.filter(r => r.path === '/auth/v1/logout').map(r => r.query.get('scope'))).toEqual(['local']);
});

test('a signed-in player sees the camp on their gladiator and re-reads the owner on a new revision, slot or focus', async ({ page, context }) => {
  const user = await seedSession(context);
  const world = liveWorld();
  // The server clock can jump a slot ahead without a new world revision.
  let skipped = 0;
  const started = Date.now();
  const live = await routeLiveReads(context, { world, owner: ownerFixture, serverNowMs: () => world.serverNowMs + skipped + (Date.now() - started) });
  await page.clock.install();
  await page.goto('/game/');
  await waitForCamp(page, world.actors.length);
  await openMenu(page, 'My gladiator');
  await expect(page.getByRole('heading', { name: 'Aster', exact: true })).toBeVisible();
  await openMenu(page, 'Gladiators');
  await expect(page.getByRole('button', { name: 'Find my gladiator' })).toBeVisible();
  const owners = () => live.count('owner_state');
  const revisions = () => live.count('world_revision');
  let read = owners(), polled = revisions();
  // The same revision in the same slot: only the revision is read.
  await page.clock.fastForward(30_000);
  await expect.poll(revisions).toBe(++polled);
  expect(owners()).toBe(read);
  // A new revision.
  live.setWorld({ ...world, revision: 'live-2' });
  await page.clock.fastForward(30_000);
  await expect.poll(owners).toBe(++read);
  polled = revisions();
  // The next slot.
  skipped = SLOT_MS;
  await page.clock.fastForward(30_000);
  await expect.poll(revisions).toBe(++polled);
  await expect.poll(owners).toBe(++read);
  // The tab comes back (visibilitychange and focus fire together) more than 2 s after the last owner read: one read
  // serves both events (final review Minor 5).
  await page.waitForTimeout(500);
  await page.clock.fastForward(2_500);
  await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
  await expect.poll(owners).toBe(++read);
  await page.waitForTimeout(1_000);
  expect(owners()).toBe(read);
  // Another return within 2 s of that read is served by it; one after that reads again.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(500);
  expect(owners()).toBe(read);
  await page.clock.fastForward(2_500);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(owners).toBe(++read);
  expect(live.requests.filter(r => r.table === 'owner_state').every(r => r.reader === user.id)).toBe(true);
});

test('the fixture preview keeps its owner, and previews the visitor view with ?as=visitor', async ({ page }) => {
  await page.goto('/game/?mode=fixture');
  await waitForCamp(page);
  await openMenu(page, 'Gladiators');
  await expect(page.getByRole('button', { name: 'Find my gladiator' })).toBeVisible();
  // The shared clock runs from the fixture's server time, not this browser's wall clock.
  const shown = await shownTime(page);
  expect(shown).toBeGreaterThanOrEqual(worldFixture.serverNowMs);
  expect(shown).toBeLessThan(worldFixture.serverNowMs + 600_000);
  await page.goto('/game/?mode=fixture&as=visitor');
  await waitForCamp(page);
  await openMenu(page, 'My gladiator');
  await expect(page.getByRole('heading', { name: 'A legend awaits' })).toBeVisible();
  await openMenu(page, 'Gladiators');
  await expect(page.getByRole('button', { name: 'Find my gladiator' })).toHaveCount(0);
});
