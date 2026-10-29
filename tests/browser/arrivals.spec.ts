// Patch A item 2: a new player is announced. A gladiator in orientation (its first slot) is new: everyone in the camp, a visitor too,
// sees one banner for about 15 s (paused while hovered or focused), Find takes the camera to the gate, the Gladiators list shows the
// newcomers first with a NEW pill and the camp draws a NEW tag over them. The newcomer's own player is welcomed first. Live mode uses the
// development-only intercepted Supabase transport: the world below has Aster at camp and Ursa (the newest), Nero and Vita in orientation.
import { expect, test, type Locator, type Page } from './fixtures';
import type { PublicActor, WorldSnapshot } from '../../supabase/functions/_shared/contracts/reads';
import { ownerFixture, worldFixture } from '../fixtures/domain';
import { screenToWorld } from '../../src/game/iso';
import { contrastIssues, noHorizontalScroll } from './a11y-helpers';
import { routeLiveReads, seedSession, testUser } from './live-routes';
import { cornerChip, expectOwnerShown, openMenu, touchLayout } from './shell-helpers';

const production = process.env.PLAYWRIGHT_STATIC === 'true';
const ARRIVALS_KEY = 'cloudiator.arrivals-seen.v1';
const NOW = worldFixture.serverNowMs;
const IDS = { aster: worldFixture.actors[0].gladiatorId, ursa: 'a0000000-0000-4000-8000-000000000001', nero: 'a0000000-0000-4000-8000-000000000002', vita: 'a0000000-0000-4000-8000-000000000003' };

const person = (gladiatorId: string, name: string, classId: PublicActor['classId'], location: PublicActor['location'], startsAtMs: number): PublicActor => ({
  ...worldFixture.actors[0], gladiatorId, name, classId, location, activityId: null, activityStatus: 'active', startsAtMs, endsAtMs: startsAtMs + 4_800_000,
});
const ursa = person(IDS.ursa, 'Ursa', 'guardian', 'orientation', NOW - 60_000);
const nero = person(IDS.nero, 'Nero', 'duelist', 'orientation', NOW - 120_000);
const vita = person(IDS.vita, 'Vita', 'berserker', 'orientation', NOW - 180_000);
const aster = person(IDS.aster, 'Aster', 'guardian', 'camp', NOW - 4_000_000);
/** The live world with the given newcomers (Aster at camp). */
const worldOf = (...newcomers: PublicActor[]): WorldSnapshot => ({ ...worldFixture, revision: 'arrivals-1', actors: [aster, ...newcomers] });

/** The banner's slot (a polite status that is always there) and the banner in it. */
const slot = (page: Page) => page.locator('[data-arrival-slot]');
const banner = (page: Page) => page.getByTestId('arrival-banner');
/** What the banner shows, as read on the screen (the wide and the narrow sentence are both in the page, one of them hidden). */
const shown = (page: Page) => banner(page).evaluate(el => (el as HTMLElement).innerText);
const waitForCamp = (page: Page, actors: number) => page.waitForFunction(n => {
  const length = window.__cloudiatorCamp?.state()?.ready === true ? window.__cloudiatorCamp.world()?.actors.length : undefined;
  return length === n;
}, actors, { timeout: 45_000 });
const seenOnDevice = (page: Page) => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '[]') as string[], ARRIVALS_KEY);
const boxOf = async (locator: Locator) => (await locator.boundingBox())!;
/** How far the camera's centre is from where `name` is drawn (the camp's own pixels: the camera centres a gladiator 24 px over their feet). */
const cameraFrom = (page: Page, name: string) => page.evaluate(([who]) => {
  const s = window.__cloudiatorCamp!.state()!, a = s.actors.find(actor => actor.name === who)!;
  return { x: s.camera.centerX - (a.x - a.y) * 32, y: s.camera.centerY - ((a.x + a.y) * 16 - 24) };
}, [name]);
const near = async (page: Page, name: string) => { const d = await cameraFrom(page, name); return Math.hypot(d.x, d.y); };

test.describe('Patch A: a new player is announced', () => {
  test.skip(production, 'Live mode uses the development-only intercepted Supabase transport.');

  test('announces a newcomer to a visitor, finds them at the gate, and not again on this device', async ({ page, context }) => {
    const world = worldOf(ursa);
    await routeLiveReads(context, { world });
    await page.goto('/game/');
    await waitForCamp(page, world.actors.length);

    // A visitor sees it: a polite status with the eyebrow and the sentence (the phone's drops "in the camp").
    await expect(banner(page)).toBeVisible();
    await expect(slot(page)).toHaveAttribute('role', 'status');
    const compact = await touchLayout(page);
    const text = await shown(page);
    expect(text).toContain('NEW ARRIVAL');
    expect(text).toContain(compact ? 'Ursa, a new Guardian, has arrived. Say hello at the gate!' : 'Ursa, a new Guardian, has arrived in the camp. Say hello at the gate!');
    expect(text).not.toContain('Welcome');
    await expect(banner(page).locator('b:visible')).toHaveText('Ursa');
    // Its words read well on the shell's glass over the camp.
    expect(await contrastIssues(banner(page))).toEqual([]);

    // Find Ursa centres the camera on them (their spot is in the gate zone, two tiles from the gate (41, 22)) and closes the banner.
    expect(await near(page, 'Ursa'), 'the camera starts elsewhere').toBeGreaterThan(100);
    await page.getByRole('button', { name: 'Find Ursa', exact: true }).click();
    await expect(banner(page)).toHaveCount(0);
    expect(await near(page, 'Ursa')).toBeLessThan(40);
    const camera = await page.evaluate(() => window.__cloudiatorCamp!.state()!.camera);
    const centre = screenToWorld(camera.centerX, camera.centerY + 24);
    expect(Math.hypot(centre.x - 41.5, centre.y - 22.5), 'the camera centre, in tiles from the gate').toBeLessThanOrEqual(2.5);
    const spot = await page.evaluate(() => window.__cloudiatorCamp!.state()!.actors.find(a => a.name === 'Ursa'));
    expect(spot).toMatchObject({ zone: 'expedition-gate', marker: 'NEW' });

    // Remembered on this device: after a reload there is no banner, and the key holds Ursa's id.
    expect(await seenOnDevice(page)).toEqual([IDS.ursa]);
    await page.reload();
    await waitForCamp(page, world.actors.length);
    await page.waitForTimeout(1_000);
    await expect(banner(page)).toHaveCount(0);
    expect(await seenOnDevice(page)).toEqual([IDS.ursa]);
  });

  test('merges arrivals, and welcomes the newcomer’s own player first', async ({ page, context }) => {
    const world = worldOf(vita, nero, ursa);
    const owner = { ...structuredClone(ownerFixture), gladiatorId: IDS.ursa, name: 'Ursa' };
    await routeLiveReads(context, { world, owner });
    await page.goto('/game/');
    await waitForCamp(page, world.actors.length);
    // A visitor: three arrivals share one banner, the newest named first; Find goes to them.
    await expect(banner(page)).toBeVisible();
    expect(await shown(page)).toContain('Ursa and 2 others have arrived in the camp.');
    await expect(banner(page).locator('b:visible')).toHaveText('Ursa');
    await expect(page.getByRole('button', { name: 'Find Ursa', exact: true })).toBeEnabled();

    // Ursa's own player, signed in: the welcome comes first, alone, with the same Find and ×.
    await seedSession(context, testUser('ursa@example.invalid'));
    await page.reload();
    await expectOwnerShown(page, 'Ursa');
    await waitForCamp(page, world.actors.length);
    await expect(banner(page)).toHaveAttribute('data-kind', 'welcome');
    expect(await shown(page)).toContain('Welcome to the camp, Ursa! Everyone here has been told you arrived.');
    expect(await shown(page)).not.toContain('others');
    await expect(page.getByRole('button', { name: 'Find Ursa', exact: true })).toBeEnabled();
    // Closing it remembers only Ursa, and the others' banner takes its place.
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(banner(page)).toHaveAttribute('data-kind', 'arrival');
    expect(await shown(page)).toContain('Nero and Vita have arrived in the camp.');
    expect(await seenOnDevice(page)).toEqual([IDS.ursa]);
    await expect(banner(page).locator('b:visible')).toHaveText('Nero');
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(banner(page)).toHaveCount(0);
    expect(await seenOnDevice(page)).toEqual([IDS.ursa, IDS.nero, IDS.vita]);
  });

  test('stays 15 s, longer while hovered or focused, then goes', async ({ page, context }, testInfo) => {
    const world = worldOf(ursa);
    await routeLiveReads(context, { world });
    await page.clock.install();
    // The page records when the banner first shows, on the (fake) clock the banner counts on.
    await page.addInitScript(() => {
      new MutationObserver(() => {
        const w = window as unknown as { __shownAt?: number };
        if (w.__shownAt === undefined && document.querySelector('[data-testid="arrival-banner"]')) w.__shownAt = performance.now();
      }).observe(document, { childList: true, subtree: true });
    });
    /** A fresh visit with the banner showing and the clock stopped: from here it moves only when the test moves it. */
    const visit = async () => {
      await page.evaluate(key => localStorage.removeItem(key), ARRIVALS_KEY).catch(() => undefined);
      await page.goto('/game/');
      await expect(banner(page)).toBeVisible();
      await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
    };
    /** Moves the clock until the banner has been showing for `seconds`. */
    const showingFor = async (seconds: number) => {
      const elapsed = await page.evaluate(() => performance.now() - (window as unknown as { __shownAt: number }).__shownAt);
      await page.clock.runFor(Math.max(0, seconds * 1_000 - elapsed));
    };

    // 14.5 s: still there, not fading. 15.5 s: gone, and remembered.
    await visit();
    await showingFor(14.5);
    await expect(banner(page)).toBeVisible();
    await expect(banner(page)).not.toHaveAttribute('data-fading', 'true');
    await showingFor(15.5);
    await expect(banner(page)).toHaveCount(0);
    expect(await seenOnDevice(page)).toEqual([IDS.ursa]);

    // Held by a pointer: hovered at 10 s it is still there at 30 s, and gone 5.5 s after the pointer leaves (a pointer is the desktop's).
    if (testInfo.project.name === 'desktop') {
      await visit();
      await showingFor(10);
      const box = await boxOf(banner(page));
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await showingFor(30);
      await expect(banner(page)).toBeVisible();
      await expect(banner(page)).not.toHaveAttribute('data-fading', 'true');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height + 200);
      await page.clock.runFor(4_500);
      await expect(banner(page)).toBeVisible();
      await page.clock.runFor(1_000);
      await expect(banner(page)).toHaveCount(0);
    }

    // Held by the focus: the same with the focus on Find from 10 s to 30 s.
    await visit();
    await showingFor(10);
    await page.getByRole('button', { name: 'Find Ursa', exact: true }).focus();
    await showingFor(30);
    await expect(banner(page)).toBeVisible();
    await expect(banner(page)).not.toHaveAttribute('data-fading', 'true');
    await page.getByRole('button', { name: 'Find Ursa', exact: true }).blur();
    await page.clock.runFor(4_500);
    await expect(banner(page)).toBeVisible();
    await page.clock.runFor(1_000);
    await expect(banner(page)).toHaveCount(0);

    // With reduced motion there is no fade: it is gone as soon as the 15 s are over (a fade would keep it 0.4 s longer).
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await visit();
    await showingFor(14.5);
    await expect(banner(page)).toBeVisible();
    await showingFor(15.05);
    await expect(banner(page)).toHaveCount(0, { timeout: 250 });
  });

  test('marks the newcomer NEW at the gate and lists them first', async ({ page, context }) => {
    const world = worldOf(ursa, nero);
    await routeLiveReads(context, { world });
    await page.goto('/game/');
    await waitForCamp(page, world.actors.length);
    // The camp: an always-visible NEW tag over each newcomer at the gate, none over anyone else.
    const markers = () => page.evaluate(() => Object.fromEntries(window.__cloudiatorCamp!.state()!.actors.filter(a => a.kind === 'player').map(a => [a.name, a.marker])));
    expect(await markers()).toEqual({ Ursa: 'NEW', Nero: 'NEW', Aster: null });
    // Once a newcomer is past orientation the tag goes (the world the scene is given next).
    await page.evaluate(w => window.__cloudiatorCamp!.setWorld(w), { ...world, revision: 'arrivals-2', actors: [aster, { ...ursa, location: 'camp' as const }, nero] });
    await expect.poll(markers).toEqual({ Ursa: null, Nero: 'NEW', Aster: null });
    await page.evaluate(w => window.__cloudiatorCamp!.setWorld(w), world);
    await expect.poll(markers).toEqual({ Ursa: 'NEW', Nero: 'NEW', Aster: null });

    // The Gladiators list: the count, then NEW IN CAMP with the newest first and a NEW pill each, then EVERYONE with the rest.
    const roster = await openMenu(page, 'Gladiators');
    // The banner covers neither the open menu (the panel beside the rail, or the sheet) nor the corner chip.
    const clear = (a: { x: number; y: number; width: number; height: number }, b: typeof a) => a.x >= b.x + b.width || b.x >= a.x + a.width || a.y >= b.y + b.height || b.y >= a.y + a.height;
    await expect(banner(page)).toBeVisible();
    expect(clear(await boxOf(banner(page)), await boxOf(roster)), 'the banner and the open menu').toBe(true);
    expect(clear(await boxOf(banner(page)), await boxOf(cornerChip(page))), 'the banner and the chip').toBe(true);
    const text = () => roster.evaluate(el => (el as HTMLElement).innerText);
    const list = await text();
    expect(list.indexOf('3 players')).toBeLessThan(list.indexOf('NEW IN CAMP'));
    expect(list.indexOf('NEW IN CAMP')).toBeLessThan(list.indexOf('Ursa'));
    expect(list.indexOf('Ursa')).toBeLessThan(list.indexOf('Nero'));
    expect(list.indexOf('Nero')).toBeLessThan(list.indexOf('EVERYONE'));
    expect(list.indexOf('EVERYONE')).toBeLessThan(list.indexOf('Aster'));
    const fresh = roster.getByRole('list', { name: 'New in camp' });
    await expect(fresh.getByRole('listitem')).toHaveCount(2);
    await expect(fresh.getByRole('listitem').first()).toContainText('Ursa');
    await expect(fresh.getByRole('listitem').first()).toContainText('NEW');
    await expect(fresh.getByRole('listitem').first()).toContainText('Guardian · Level 1 · Bronze league · Arriving at camp');
    await expect(roster.getByRole('list', { name: 'Gladiators' }).getByRole('listitem')).toHaveCount(1);
    await expect(roster.getByRole('button', { name: /^Profile: Ursa$/ })).toHaveCount(1);
    await roster.evaluate(el => Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished)));
    expect(await contrastIssues(roster)).toEqual([]);

    // The filter applies to both parts: "ne" matches Nero (new) only, "as" Aster only, "r" all three.
    const filter = roster.getByRole('searchbox', { name: 'Filter by name' });
    await filter.fill('ne');
    await expect(fresh.getByRole('listitem')).toHaveCount(1);
    await expect(roster.getByText('EVERYONE')).toHaveCount(0);
    await filter.fill('as');
    await expect(roster.getByText('NEW IN CAMP')).toHaveCount(0);
    await expect(roster.getByText('EVERYONE')).toHaveCount(0);
    await expect(roster.getByRole('list', { name: 'Gladiators' }).getByRole('listitem')).toHaveCount(1);
    await filter.fill('r');
    await expect(roster.getByText('NEW IN CAMP')).toBeVisible();
    await expect(roster.getByText('EVERYONE')).toBeVisible();
  });

  test('disables Find while the camp view is unavailable, with the reason', async ({ page, context }) => {
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
        return /webgl/.test(type) ? null : (original as (...a: unknown[]) => RenderingContext | null).call(this, type, ...args);
      } as typeof original;
    });
    await routeLiveReads(context, { world: worldOf(ursa) });
    await page.goto('/game/');
    await expect(page.getByText(/needs WebGL/)).toBeVisible({ timeout: 30_000 });
    await expect(banner(page)).toBeVisible();
    const find = page.getByRole('button', { name: 'Find Ursa', exact: true });
    await expect(find).toBeDisabled();
    await expect(find).toHaveAccessibleDescription('The camp view is unavailable, so gladiators cannot be shown on the map.');
    // × still closes it.
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(banner(page)).toHaveCount(0);
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('phone: under the chip, full width; Find closes the open sheet', async ({ page, context }) => {
      const world = worldOf(ursa);
      await routeLiveReads(context, { world });
      await page.goto('/game/');
      await waitForCamp(page, world.actors.length);
      await expect(banner(page)).toBeVisible();
      expect(await touchLayout(page)).toBe(true);
      // Under the chip, full width with 12 px gutters.
      const chip = await boxOf(cornerChip(page));
      const box = await boxOf(banner(page));
      expect(box.y).toBeGreaterThan(chip.y + chip.height);
      expect(box.x).toBeCloseTo(12, 0);
      expect(390 - (box.x + box.width)).toBeCloseTo(12, 0);
      // The phone's sentence and button; both buttons are 44 px targets, and the banner covers neither ☰ nor the chip.
      expect(await shown(page)).toContain('📯 NEW ARRIVAL');
      expect(await shown(page)).toContain('Ursa, a new Guardian, has arrived. Say hello at the gate!');
      expect(await shown(page)).not.toContain('in the camp');
      for (const name of ['Find Ursa', 'Dismiss']) {
        const target = await boxOf(page.getByRole('button', { name, exact: true }));
        expect(target.height, name).toBeGreaterThanOrEqual(44);
        expect(target.width, name).toBeGreaterThanOrEqual(44);
      }
      const burger = await boxOf(page.getByRole('button', { name: 'Menus', exact: true }));
      expect(box.y + box.height).toBeLessThan(burger.y);
      expect(await contrastIssues(banner(page))).toEqual([]);

      // With Gladiators open, Find closes the sheet and takes the camera to Ursa.
      await openMenu(page, 'Gladiators');
      await expect(page.locator('[data-sheet="open"]')).toHaveCount(1);
      await page.getByRole('button', { name: 'Find Ursa', exact: true }).first().click();
      await expect(page.locator('[data-sheet]')).toHaveCount(0);
      await expect(banner(page)).toHaveCount(0);
      expect(await near(page, 'Ursa')).toBeLessThan(40);
    });

    test('phone: at 360 × 740 it fits, with a notice under it and no sideways scroll', async ({ page, context }) => {
      // Three arrivals make the longest sentence; the welcome is the longest of all, so the owner's view is checked too.
      const world = worldOf(ursa, nero, vita);
      const owner = { ...structuredClone(ownerFixture), gladiatorId: IDS.ursa, name: 'Ursa' };
      await seedSession(context, testUser('ursa@example.invalid'));
      await routeLiveReads(context, { world, owner });
      await page.setViewportSize({ width: 360, height: 740 });
      await page.goto('/game/');
      await expectOwnerShown(page, 'Ursa');
      await waitForCamp(page, world.actors.length);
      await expect(banner(page)).toHaveAttribute('data-kind', 'welcome');
      expect(await noHorizontalScroll(page)).toBe(true);
      const box = await boxOf(banner(page));
      expect(box.x).toBeGreaterThanOrEqual(12 - 0.5);
      expect(box.x + box.width).toBeLessThanOrEqual(360 - 12 + 0.5);
      const chip = await boxOf(cornerChip(page));
      expect(box.y).toBeGreaterThan(chip.y + chip.height);
      const burger = await boxOf(page.getByRole('button', { name: 'Menus', exact: true }));
      expect(box.y + box.height).toBeLessThan(burger.y);
      // Nothing of the banner is cut off: its text and both buttons lie inside its box.
      for (const name of ['Find Ursa', 'Dismiss']) {
        const target = await boxOf(page.getByRole('button', { name, exact: true }));
        expect(target.x, name).toBeGreaterThanOrEqual(box.x);
        expect(target.x + target.width, name).toBeLessThanOrEqual(box.x + box.width + 0.5);
        expect(target.y + target.height, name).toBeLessThanOrEqual(box.y + box.height + 0.5);
      }
    });
  });

  test('does not come back after a world poll when storage throws', async ({ page, context }) => {
    // Blocked site data: touching localStorage throws, as in a private window with every cookie blocked.
    await page.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } }); });
    const world = worldOf(ursa);
    const live = await routeLiveReads(context, { world });
    await page.clock.install();
    await page.goto('/game/');
    await waitForCamp(page, world.actors.length);
    await expect(banner(page)).toBeVisible();
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(banner(page)).toHaveCount(0);
    // A new revision of the same world is read at the next poll: the banner stays closed for the page's life.
    const loads = live.count('world_actor_reads');
    live.setWorld({ ...world, revision: 'arrivals-2' });
    await expect.poll(async () => { await page.clock.fastForward(5_000); return live.count('world_actor_reads'); }, { timeout: 30_000 }).toBeGreaterThan(loads);
    await page.waitForFunction(() => window.__cloudiatorCamp?.world()?.revision === 'arrivals-2', null, { timeout: 15_000 });
    await page.waitForTimeout(500);
    await expect(banner(page)).toHaveCount(0);
  });
});
