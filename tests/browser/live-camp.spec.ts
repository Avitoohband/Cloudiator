import { expect, test, type Page } from '@playwright/test';
import type { WorldSnapshot } from '../../supabase/functions/_shared/contracts/reads';
import { ownerFixture, worldFixture } from '../fixtures/domain';
import { createDemoWorld } from '../../src/game/demo-world';
import { SLOT_MS, routeLiveReads, seedSession } from './live-routes';
import { openMenu } from './shell-helpers';

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
  // The tab regains focus.
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
