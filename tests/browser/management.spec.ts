import { expect, test, type Locator, type Page } from './fixtures';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { worldToScreen } from '../../src/game/iso';
import type { GameCommand } from '../../supabase/functions/_shared/contracts/commands';
import type { OwnerState, PublicActor, ResultRow } from '../../supabase/functions/_shared/contracts/reads';
import { ARENA_GLADIATORS } from '../fixtures/arena-ids';
import { ownerFixture } from '../fixtures/domain';
import { SLOT_MS, SUPABASE_URL, emptyWorld, isPresence, routeLiveReads, seedSession } from './live-routes';
import { closeMenu, cornerChip, everyoneResults, expectOwnerShown, menuDialog, openMenu, quietArrivals, railMenus, touchLayout, pageTo } from './shell-helpers';
import { openSection } from './section-helpers';

// Task 13.7: the Results list, the profile card a click on a gladiator opens (and its keyboard paths: the Gladiators
// list and the standings), the merchants' stalls as shortcuts into Inventory and shops, and the owner's pending build through a
// slot end (the old plan's Task 13 Step 1). Cards and Results show public fields only.

const production = process.env.PLAYWRIGHT_STATIC === 'true';
const ASTER = ARENA_GLADIATORS.aster.id;
const nextFrames = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
/** The profile card of `name` (a non-modal dialog over the camp). */
const profileCard = (page: Page, name: string) => page.getByRole('dialog', { name: `Profile: ${name}`, exact: true });
/** Text that only an owner's private state holds; no card or result row may show it. */
const PRIVATE = /Gold|Money|Stamina|Renown|wallet|Inventory|receipt|reward/i;

async function openCamp(page: Page, url: string) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(url);
  await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
}
/** Clicks the camp on `id`'s body, centred at zoom 2 (the camp click a player makes; a gladiator or an NPC). */
async function clickInCamp(page: Page, id: string, clearOf?: Locator) {
  const actor = (await page.evaluate(() => window.__cloudiatorCamp!.state()!)).actors.find(a => a.id === id)!;
  await page.evaluate(({ x, y }) => window.__cloudiatorCamp!.centerOn(x, y, 2), { x: actor.x, y: actor.y });
  await nextFrames(page);
  let at = (await page.evaluate(x => window.__cloudiatorCamp!.screenOf(x), id))!;
  const box = (await page.locator('canvas').boundingBox())!;
  if (clearOf) {
    const panel = (await clearOf.boundingBox())!;
    const dx = panel.x + panel.width + 24 - (box.x + at.x);
    if (dx > 0) {
      await page.evaluate(shift => window.__cloudiatorCamp!.emit('camera-pan', { dx: shift, dy: 0 }), dx);
      await nextFrames(page);
      at = (await page.evaluate(x => window.__cloudiatorCamp!.screenOf(x), id))!;
    }
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y) instanceof HTMLCanvasElement,
      { x: box.x + at.x, y: box.y + at.y - 16 })).toBe(true);
  }
  await page.mouse.click(box.x + at.x, box.y + at.y - 16);
  return { x: box.x + at.x, y: box.y + at.y };
}
const boxOf = async (locator: Locator) => (await locator.boundingBox())!;
const campProps = (JSON.parse(readFileSync('public/assets/camp/map.json', 'utf8')) as { props: { frame: string; x: number; y: number }[] }).props;
/**
 * Clicks a merchant's stall on its awning, above anyone at the counter, centred at zoom 2 (a click on the merchant talks
 * since Patch 1.9, Task 11). With `clearOf`, the camp is first panned so the awning is beside that panel.
 */
async function clickStall(page: Page, frame: 'stall-weapons' | 'stall-armor', clearOf?: Locator) {
  const prop = campProps.find(p => p.frame === frame)!;
  await page.evaluate(({ x, y }) => window.__cloudiatorCamp!.centerOn(x, y, 2), { x: prop.x + 1.5, y: prop.y + 1 });
  await nextFrames(page);
  const awning = async () => {
    const { camera } = await page.evaluate(() => window.__cloudiatorCamp!.state()!);
    const a = worldToScreen(prop.x, prop.y);
    return { x: (a.x + 14 - camera.worldView.x) * camera.zoom, y: (a.y - 23 - camera.worldView.y) * camera.zoom };
  };
  const box = (await page.locator('canvas').boundingBox())!;
  let at = await awning();
  if (clearOf) {
    const panel = (await clearOf.boundingBox())!;
    const dx = panel.x + panel.width + 24 - (box.x + at.x);
    if (dx > 0) {
      await page.evaluate(shift => window.__cloudiatorCamp!.emit('camera-pan', { dx: shift, dy: 0 }), dx);
      await nextFrames(page);
      at = await awning();
    }
  }
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y) instanceof HTMLCanvasElement, { x: box.x + at.x, y: box.y + at.y })).toBe(true);
  await page.mouse.click(box.x + at.x, box.y + at.y);
}

test.describe('profile cards and merchants in the fixture preview', () => {
  test.skip(production, 'These checks use the fixture preview.');

  test('opens a public profile card from a camp click, the Gladiators list and the standings', { tag: '@render' }, async ({ page, context }, testInfo) => {
    // The arrival banner (Patch A item 2) would cover the top of the camp, where this test clicks "away from anyone".
    await quietArrivals(context);
    await openCamp(page, '/game/?mode=fixture&as=visitor');
    const touch = await touchLayout(page);
    // A camp click on Aster, who is training: the card shows the public actor and its loaded rating, and nothing private.
    const at = await clickInCamp(page, ASTER);
    const aster = profileCard(page, 'Aster');
    await expect(aster).toBeVisible();
    await expect(aster).toContainText('Guardian · Level 1 · Bronze league');
    await expect(aster).toContainText(/Now\s*Training/);
    await expect(aster).toContainText(/Rating\s*\d+/);
    await expect(aster).not.toContainText(PRIVATE);
    await expect(aster.getByRole('button', { name: 'My gladiator' })).toHaveCount(0);
    // Desktop: beside the click, clear of the gladiator's head; touch: a sheet above the ☰ button.
    const card = await boxOf(aster);
    const viewport = page.viewportSize()!;
    if (touch) {
      expect(card.y + card.height).toBeLessThanOrEqual(viewport.height - 62);
      expect(card.x).toBeGreaterThanOrEqual(0);
      expect(card.x + card.width).toBeLessThanOrEqual(viewport.width);
    } else {
      expect(Math.abs(card.x + card.width / 2 - at.x)).toBeLessThan(card.width);
      // Above or below the gladiator, or (Task 11c: the taller card in a short window) beside them.
      const clearAboveOrBelow = card.y + card.height <= at.y - 40 || card.y >= at.y + 30;
      const clearBeside = card.x >= at.x + 30 || card.x + card.width <= at.x - 30;
      expect(clearAboveOrBelow || clearBeside, 'the card leaves the gladiator visible').toBe(true);
      expect(card.y).toBeGreaterThanOrEqual(60);
    }
    await nextFrames(page);
    await page.screenshot({ path: testInfo.outputPath(`profile-camp-click-${testInfo.project.name}.png`) });
    // A camp click away from anyone closes it.
    await page.mouse.click(page.viewportSize()!.width / 2, 20);
    await expect(aster).toBeHidden();

    // The keyboard path: a row of the Gladiators list opens the same card, which takes the focus; Escape gives it back.
    const gladiators = await openMenu(page, 'Gladiators');
    const row = gladiators.getByRole('button', { name: 'Profile: Bellator', exact: true });
    await pageTo(gladiators, row);
    await row.focus();
    await page.keyboard.press('Enter');
    const bellator = profileCard(page, 'Bellator');
    await expect(bellator).toBeVisible();
    await expect(bellator).toBeFocused();
    await expect(bellator).toContainText(/Now\s*In the arena/);
    await expect(bellator).toContainText(/Rating\s*\d+/);
    await expect(bellator).not.toContainText(PRIVATE);
    await page.keyboard.press('Escape');
    await expect(bellator).toBeHidden();
    await expect(row).toBeFocused();
    await expect(gladiators).toBeVisible();

    // The standings: Cassia is not in the camp, so her card loads her public profile; the row adds her record.
    const arena = await openMenu(page, 'Arena');
    const table = arena.getByRole('table', { name: 'Bronze league standings' });
    const cassiaRow = table.getByRole('row', { name: /Cassia/ });
    const record = (await cassiaRow.locator('td').nth(2).textContent())!.trim();
    await cassiaRow.getByRole('button', { name: 'Profile: Cassia', exact: true }).click();
    const cassia = profileCard(page, 'Cassia');
    await expect(cassia).toBeVisible();
    // Task 11c: the row's season record has its own line, "This season"; the rating its own.
    await expect(cassia).toContainText(/Rating\s*\d+/);
    await expect(cassia).toContainText(new RegExp(`This season\\s*${record}`));
    await expect(cassia).not.toContainText(PRIVATE);
    await cassia.getByRole('button', { name: 'Close profile' }).click();
    await expect(cassia).toBeHidden();
    // A standings row of someone without a public profile says so, with its record.
    const filler = table.locator('tbody tr').filter({ hasNotText: /Aster|Varro|Cassia|Severus|Bellator|Corvina|Faustina|Gallus|Lucilla|Marcellus|Nerva|Titus|Aurelia|Decimus|Valeria|Cato|Ardea/ }).first();
    const fillerName = (await filler.locator('th').textContent())!.trim();
    await filler.getByRole('button', { name: `Profile: ${fillerName}`, exact: true }).click();
    await expect(profileCard(page, fillerName)).toContainText('This profile is not available right now.');
  });

  test('shows management shortcuts only on the viewer’s own card', { tag: '@render' }, async ({ page }, testInfo) => {
    await openCamp(page, '/game/?mode=fixture');
    await expectOwnerShown(page, 'Aster');
    await clickInCamp(page, ASTER);
    const own = profileCard(page, 'Aster');
    await expect(own.getByRole('button', { name: 'My gladiator', exact: true })).toBeVisible();
    await expect(own.getByRole('button', { name: 'Schedule', exact: true })).toBeVisible();
    // The own card adds shortcuts, never values My gladiator does not already show (here: none private at all).
    await expect(own).not.toContainText(PRIVATE);
    await nextFrames(page);
    if (testInfo.project.name === 'desktop') await page.screenshot({ path: testInfo.outputPath('profile-own-card-desktop.png') });
    await own.getByRole('button', { name: 'Schedule', exact: true }).click();
    await expect(menuDialog(page, 'Schedule')).toBeVisible();
    await expect(own).toBeHidden();
    // Another gladiator's card has no shortcuts; an Arena entrant's offers its bout.
    const gladiators = await openMenu(page, 'Gladiators');
    await pageTo(gladiators, gladiators.getByRole('button', { name: 'Profile: Bellator', exact: true }));
    await gladiators.getByRole('button', { name: 'Profile: Bellator', exact: true }).click();
    const other = profileCard(page, 'Bellator');
    await expect(other).toBeVisible();
    await expect(other.getByRole('button', { name: 'My gladiator', exact: true })).toHaveCount(0);
    await expect(other.getByRole('button', { name: 'Schedule', exact: true })).toHaveCount(0);
    await other.getByRole('button', { name: 'Watch bout', exact: true }).click();
    const arena = menuDialog(page, 'Arena');
    await expect(arena).toBeVisible();
    await expect(arena.getByRole('heading', { name: 'Bellator', exact: true })).toBeVisible();
    await expect(other).toBeHidden();
    // The own card's My gladiator shortcut opens that menu.
    await closeMenu(page);
    await clickInCamp(page, ASTER);
    await own.getByRole('button', { name: 'My gladiator', exact: true }).click();
    await expect(menuDialog(page, 'My gladiator')).toBeVisible();
  });

  test('opens Inventory and shops at the merchant’s shop filter when a merchant’s stall is clicked', async ({ page }) => {
    await openCamp(page, '/game/?mode=fixture');
    await expectOwnerShown(page, 'Aster');
    // Hold the camp still so the merchants stay where they are drawn.
    await page.evaluate(() => window.__cloudiatorCamp!.freezeClock(window.__cloudiatorShell!.clock.now()));
    await clickStall(page, 'stall-weapons');
    const inventory = menuDialog(page, 'Inventory and shops');
    await expect(inventory).toBeVisible();
    // Patch 1.9: the merchant chooses the shop's filter (Weapons or Armor) and its first piece.
    const shopFilters = inventory.getByRole('group', { name: 'Shop filters', exact: true });
    // Task 33: a stall opens the menu on its Shops section.
    await expect(inventory.getByRole('navigation', { name: 'Sections', exact: true }).locator('b').first()).toHaveText('Shops');
    await expect(shopFilters.getByRole('button', { pressed: true })).toHaveText(['Weapons']);
    await expect(inventory.getByTestId('offer-sword:1:common')).toHaveAttribute('aria-pressed', 'true');
    // Task 33: the Shops section starts at the menu's top; its heading is read, not shown (the strip names the section), so its chips are what is in view.
    await expect(inventory.getByRole('heading', { name: 'Shops', exact: true })).toBeAttached();
    await expect(shopFilters).toBeInViewport();
    // On desktop pan the stall into the camp beside the open panel. Close the phone sheet before tapping camp.
    const touch = await touchLayout(page);
    if (touch) await closeMenu(page);
    await clickStall(page, 'stall-armor', touch ? undefined : inventory);
    await expect(inventory).toBeVisible();
    await expect(shopFilters.getByRole('button', { pressed: true })).toHaveText(['Armor']);
    await expect(inventory.getByTestId('offer-round-shield:1:common')).toHaveAttribute('aria-pressed', 'true');
    await expect(inventory.getByRole('navigation', { name: 'Sections', exact: true }).locator('b').first()).toHaveText('Shops');
    await expect(shopFilters).toBeInViewport();
  });

  test('opens My gladiator’s sign-in prompt when a visitor clicks a merchant’s stall', async ({ page }) => {
    await openCamp(page, '/game/?mode=fixture&as=visitor');
    await page.evaluate(() => window.__cloudiatorCamp!.freezeClock(window.__cloudiatorShell!.clock.now()));
    await clickStall(page, 'stall-weapons');
    const mine = menuDialog(page, 'My gladiator');
    await expect(mine).toBeVisible();
    await expect(mine.getByRole('button', { name: 'Sign in with Google to create your gladiator' })).toBeVisible();
    await expect(menuDialog(page, 'Inventory and shops')).toHaveCount(0);
    await expect(railMenus(page).getByRole('button', { name: 'Inventory and shops' })).toHaveCount(0);
  });

  test('lists recent results with their replays and the viewer’s own rows, beside the fixture samples', async ({ page }, testInfo) => {
    await openCamp(page, '/game/?mode=fixture');
    await expectOwnerShown(page, 'Aster');
    const results = await everyoneResults(page);
    const list = results.getByRole('list', { name: 'Recent results' });
    await expect(list.getByRole('listitem').first()).toBeVisible();
    // Training and Rest offer no replay and never say one is no longer kept; the owner's rows say "You".
    await expect(list.getByRole('listitem').filter({ hasText: 'Varro finished training' }).getByRole('button')).toHaveCount(0);
    await expect(list.getByRole('listitem').filter({ hasText: 'Cassia finished resting' })).not.toContainText('no longer kept');
    await expect(list.getByRole('listitem').filter({ hasText: 'Aster' }).first()).toContainText('You');
    await expect(list.getByRole('listitem').filter({ hasText: 'Varro' }).first()).not.toContainText('You');
    await expect(list).not.toContainText(PRIVATE);
    // The fixture samples stay below.
    await expect(results.getByRole('navigation', { name: 'Sample replays' })).toBeVisible();
    await expect(results.getByRole('navigation', { name: 'Sample expeditions' })).toBeVisible();
    await results.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
    await page.screenshot({ path: testInfo.outputPath(`results-menu-${testInfo.project.name}.png`) });
    // A kept replay opens over the camp (Task 13.8, plan Decision 4).
    const replay = list.getByRole('button', { name: /^Replay: Aster won an Arena bout/ }).first();
    await replay.click();
    await expect(page.getByRole('dialog', { name: 'Replay', exact: true })).toBeVisible();
    // A row of Everyone names Results as its origin (Arena replays Task 3).
    await expect(page).toHaveURL(/\/game\/\?mode=fixture&view=replay&activity=[0-9a-f-]{36}&from=results$/);
  });
});

// ------------------------------------------------------------------ live: a camp click on an Arena entrant (13.7 review)

test.describe('a camp click on an Arena entrant', () => {
  test.skip(production, 'Live mode uses development-only intercepted Supabase transport.');

  test('opens only the Arena card for an Arena entrant, with no profile card or profile read', async ({ page, context }) => {
    // The 13.7 review: the click mounted the profile card, which sent one discarded profile read, before open-arena
    // opened the Arena card. Every profile card mounted on the page is counted, however briefly.
    await page.addInitScript(() => {
      const w = window as unknown as { __profileCards: number };
      w.__profileCards = 0;
      new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
          if (node instanceof Element && (node.matches('[data-profile-card]') || node.querySelector('[data-profile-card]'))) w.__profileCards += 1;
        }
      }).observe(document, { childList: true, subtree: true });
    });
    const slotStart = Math.floor(Date.now() / SLOT_MS) * SLOT_MS;
    const actor = (name: string, location: PublicActor['location'], activityId: string | null): PublicActor => ({
      gladiatorId: randomUUID(), name, classId: 'berserker', equipmentSilhouettes: ['weapon-axe'], appearance: null, league: 'bronze', level: 3, phase: 'morning',
      location, activityId, activityStatus: 'active', startsAtMs: slotStart, endsAtMs: slotStart + SLOT_MS, visibleStage: null, resting: false,
    });
    // Warming up in staging at minute 40 (no bout revealed yet, so the Arena card reads no opponent profile), and a trainee.
    const entrant = actor('Bellator', 'arena', randomUUID());
    const trainee = actor('Corvina', 'training', randomUUID());
    const live = await routeLiveReads(context, { world: { ...emptyWorld(slotStart + 40 * 60_000), revision: 'entrant-1', actors: [entrant, trainee] } });
    await openCamp(page, '/game/');
    await page.waitForFunction(n => window.__cloudiatorCamp!.state()!.actors.filter(a => a.kind === 'player').length === n, 2);
    await clickInCamp(page, entrant.gladiatorId);
    await expect(menuDialog(page, 'Arena')).toBeVisible();
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as unknown as { __profileCards: number }).__profileCards)).toBe(0);
    await expect(page.locator('[data-profile-card]')).toHaveCount(0);
    expect(live.count('public_profile_reads')).toBe(0);
    // Anyone else's click still opens their card and reads their public profile (React's development mode runs the
    // card's read effect twice). The Arena menu closes first: on a phone its sheet covers the camp.
    await closeMenu(page);
    await clickInCamp(page, trainee.gladiatorId);
    await expect(profileCard(page, 'Corvina')).toBeVisible();
    await expect.poll(() => live.count('public_profile_reads')).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as unknown as { __profileCards: number }).__profileCards)).toBe(1);
  });
});

// ------------------------------------------------------------------ live: Results for a visitor, a player's build at a slot end

test.describe('live results and a signed-in player through a slot end', () => {
  test.skip(production, 'Live UI uses development-only intercepted identity transport.');

  test('lists a visitor’s public recent results from the live read, and sends no command', async ({ page, context }) => {
    const slotStart = Math.floor(Date.now() / SLOT_MS) * SLOT_MS;
    const bout = randomUUID();
    const recent: ResultRow[] = [
      { gladiatorId: randomUUID(), name: 'Varro', summary: { activityId: bout, resolvedKind: 'arena', result: 'victory', success: true,
        settledAtMs: slotStart, replayExpiry: { state: 'available', expiresAtMs: slotStart + 7 * 86_400_000 } } },
      { gladiatorId: randomUUID(), name: 'Cassia', summary: { activityId: randomUUID(), resolvedKind: 'training', result: 'completed', success: true,
        settledAtMs: slotStart - SLOT_MS, replayExpiry: { state: 'expired' } } },
    ];
    const live = await routeLiveReads(context, { world: emptyWorld(), recent });
    const commands: string[] = [];
    page.on('request', request => { if (request.url().includes('/functions/v1/')) commands.push(request.url()); });
    await page.goto('/game/');
    const results = await openMenu(page, 'Results');
    const list = results.getByRole('list', { name: 'Recent results' });
    await expect(list.getByRole('listitem')).toHaveCount(2);
    await expect(list.getByRole('listitem').nth(0)).toContainText('Varro won an Arena bout');
    await expect(list.getByRole('listitem').nth(1)).toContainText('Cassia finished training');
    await expect(list.getByRole('listitem').nth(1).getByRole('button')).toHaveCount(0);
    await expect(list).not.toContainText('You');
    // The fixture samples are the preview's only.
    await expect(results.getByRole('navigation', { name: 'Sample replays' })).toHaveCount(0);
    expect(live.count('recent_results')).toBeGreaterThan(0);
    expect(live.requests.every(r => r.reader === null)).toBe(true);
    await list.getByRole('button', { name: 'Replay: Varro won an Arena bout' }).click();
    await expect(page.getByRole('dialog', { name: 'Replay', exact: true })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/game/\\?view=replay&activity=${bout}&from=results$`));
    expect(commands).toEqual([]);
  });

  test('shows the pending build, then Processing results at the slot end, without changing the displayed gold', async ({ page, context }) => {
    await seedSession(context);
    const slot = Math.floor(Date.now() / SLOT_MS);
    const owner: OwnerState = structuredClone(ownerFixture);
    owner.wallets = { money: 300, renown: 40 };
    owner.reservedFees = { money: 0, renown: 0 };
    owner.processedSlotIndex = slot;
    owner.currentActivity = { ...owner.currentActivity!, status: 'active', startsAtMs: slot * SLOT_MS, endsAtMs: (slot + 1) * SLOT_MS };
    const live = await routeLiveReads(context, { world: emptyWorld(), owner });
    const commands: GameCommand[] = [];
    await context.route(`${SUPABASE_URL}/functions/v1/**`, async route => {
      const request = route.request();
      // The player's presence (Task 23.9) is the live transport's.
      if (request.method() === 'OPTIONS' || isPresence(request)) return route.fallback();
      const command = request.postDataJSON() as GameCommand;
      commands.push(command);
      if (command.kind !== 'queue-build') throw new Error(`Unexpected command ${command.kind}`);
      owner.buildVersion += 1;
      owner.pendingBuild = { build: { version: owner.buildVersion, classId: command.classId, stance: command.stance, allocations: command.allocation, equipment: command.equipment },
        effectiveSlotIndex: slot + 1, reservedMoney: 0, reservedItemIds: [], operationId: command.operationId };
      live.setOwner(structuredClone(owner));
      return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json',
        body: JSON.stringify({ ok: true, receiptId: randomUUID(), value: owner.pendingBuild }) });
    });
    await page.goto('/game/');
    await expectOwnerShown(page, owner.name);
    const mine = await openMenu(page, 'My gladiator');
    const status = mine.locator('p[role="status"]').filter({ hasText: /^(Scheduled|In progress|Processing results|Preparing|Completed)/ });
    await expect(status).toHaveText(/^In progress/);
    // The class is fixed (Avi, 2026-10-28) and every build change is free: a stance change reserves nothing. (Task 33: the planner is in
    // the Worn equipment section; the activity line and the gold stay on the Overview, read there while it is hidden.)
    await openSection(mine, 'Worn equipment');
    await mine.getByLabel('Stance', { exact: true }).selectOption('offensive');
    await mine.getByRole('button', { name: 'Queue build' }).click();
    await expect(mine.getByRole('heading', { name: 'Pending build', exact: true })).toBeVisible();
    expect(commands.map(c => c.kind)).toEqual(['queue-build']);
    const money = mine.locator('dl dd').first();
    await expect(money).toHaveText('300');
    await expect(cornerChip(page).getByTestId('chip-money')).toContainText('300');
    // The shared clock passes the activity's end before the server has published the slot's results.
    await page.waitForFunction(() => window.__cloudiatorShell?.clock.synced() === true);
    await page.evaluate(end => window.__cloudiatorShell!.clock.freeze(end + 1000), owner.currentActivity!.endsAtMs);
    await expect(status).toHaveText('Processing results');
    await expect(mine.getByRole('heading', { name: 'Pending build', exact: true })).toBeVisible();
    await expect(money).toHaveText('300');
    await expect(cornerChip(page).getByTestId('chip-money')).toContainText('300');
    expect(commands).toHaveLength(1);
  });
});
