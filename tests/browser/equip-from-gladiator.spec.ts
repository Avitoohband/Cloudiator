import { test, expect, type BrowserContext, type Locator, type Page } from './fixtures';
import { randomUUID } from 'node:crypto';
import { ownerFixture, itemFixture } from '../fixtures/domain';
import type { ItemInstance, OwnerState } from '../../supabase/functions/_shared/contracts/reads';
import type { GameCommand } from '../../supabase/functions/_shared/contracts/commands';
import { CATALOG_V1 } from '../../supabase/functions/_shared/domain/catalog-v1';
import { SLOT_MS, emptyWorld, isPresence, routeLiveReads } from './live-routes';
import { openMenuSection } from './section-helpers';
import { slotTime } from './slot-time';
import { contrastIssues, focusDrops, watchFocus } from './a11y-helpers';

// Patch 1.9 Task 6: equip and swap gear straight from My gladiator's Worn equipment slots (the approved equip-from-gladiator and
// stacks mockups). A slot opens a picker of the pieces that fit it, one tile per stack; choosing a tile compares it with what is worn
// next in that slot; Wear, Undo, Remove and Cancel changes send the same `queue-build` / `cancel-build` as the Inventory's gear view.

/** A piece of `catalogId` with an id of its own. */
const piece = (catalogId: string, over: Partial<ItemInstance> = {}): ItemInstance => ({ ...itemFixture(CATALOG_V1.items[catalogId]), id: randomUUID(), ...over });
const listing = () => ({ kind: 'listing' as const, referenceId: randomUUID() });

/**
 * A signed-in player whose owner read is `state` (built by `setup`), with the server's own answer to the gear commands: a stale
 * version is a conflict, a queue-build replaces the pending build, a cancel-build clears it. Worn pieces are reserved by their build.
 */
async function gearFlow(context: BrowserContext, setup: (state: OwnerState) => void) {
  const state = structuredClone(ownerFixture);
  state.processedSlotIndex = Math.floor(Date.now() / SLOT_MS);
  setup(state);
  for (const id of Object.values(state.currentBuild.equipment)) {
    const worn = state.inventory.find(item => item.id === id);
    if (worn) worn.reservation = { kind: 'equipment', referenceId: state.gladiatorId };
  }
  const commands: GameCommand[] = [];
  /** A refusal the server gives every command until it is cleared (`reject('')`), as the Inventory's spec does. */
  let code = '';
  const user = { id: randomUUID(), aud: 'authenticated', role: 'authenticated', email: 'equip@example.invalid',
    app_metadata: { provider: 'google', providers: ['google'] }, user_metadata: {}, identities: [], created_at: new Date().toISOString() };
  await context.addInitScript(({ user }) => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = `${btoa(JSON.stringify({ alg: 'HS256' }))}.${btoa(JSON.stringify({ sub: user.id, exp }))}.test-only`;
    localStorage.setItem('sb-127-auth-token', JSON.stringify({ access_token: token, refresh_token: 'test-only', token_type: 'bearer', expires_at: exp, expires_in: 3600, user }));
  }, { user });
  await routeLiveReads(context, { world: emptyWorld() });
  await context.route('http://127.0.0.1:54321/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    const json = (body: unknown, status = 200) => route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(body) });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (path === '/auth/v1/user') return json(user);
    if (path === '/rest/v1/owner_state') return json([{ state }]);
    if (path === '/functions/v1/game-command' && isPresence(request)) return route.fallback();
    if (path === '/functions/v1/game-command') {
      const command = request.postDataJSON() as GameCommand; commands.push(command);
      if (command.kind !== 'queue-build' && command.kind !== 'cancel-build') throw new Error(`Unexpected command ${command.kind}`);
      if (code) return json({ ok: false, code }, 409);
      if (command.expectedVersion !== state.buildVersion) return json({ ok: false, code: 'conflict' }, 409);
      state.buildVersion++;
      if (command.kind === 'queue-build') {
        const reservedItemIds = Object.values(command.equipment).filter((id): id is string => id !== null);
        state.pendingBuild = { build: { version: state.buildVersion, classId: command.classId, stance: command.stance, allocations: command.allocation, equipment: command.equipment },
          effectiveSlotIndex: state.processedSlotIndex + 1, reservedMoney: 0, reservedItemIds, operationId: command.operationId };
        return json({ ok: true, receiptId: randomUUID(), value: state.pendingBuild });
      }
      state.pendingBuild = null;
      return json({ ok: true, receiptId: randomUUID(), value: { buildVersion: state.buildVersion } });
    }
    return route.fallback();
  });
  return { state, commands, reject: (value: string) => { code = value; } };
}

const wornRegion = (menu: Locator) => menu.getByRole('region', { name: 'Worn equipment', exact: true });
/** A Worn equipment slot by its name ("Weapon", "Off hand", "Body"). */
const slotButton = (menu: Locator, label: string) => wornRegion(menu).getByRole('button', { name: new RegExp(`^${label}:`) });
const picker = (menu: Locator, label: string) => menu.getByRole('dialog', { name: `Change ${label}`, exact: true });
const pick = (scope: Locator, item: ItemInstance) => scope.getByTestId(`pick-${item.id}`);
const pendingBox = (menu: Locator) => wornRegion(menu).getByRole('region', { name: 'At the next slot', exact: true });
/** A comparison row's four cells: the stat, what is worn (or next), the new value and the difference. */
const row = (scope: Locator, name: string) => scope.locator(`tr[data-row="${name}"]`);
async function expectRow(scope: Locator, name: string, cells: [string, string, string]) {
  await expect(row(scope, name).locator('th, td')).toHaveText([name, ...cells]);
}
const wearButton = (scope: Locator) => scope.getByRole('button', { name: /^Wear / });
/**
 * Task 33 fix round 1 (review Minor 2): while another tile's card shows, the chosen piece's Wear waits beside it, unseen (opacity 0) but still
 * the chosen piece's and still reachable by Tab, which ends the preview and shows its own card again.
 */
async function expectWearWaiting(scope: Locator, name: string) {
  await expect(scope.locator('[data-waiting]')).toHaveCount(1);
  await expect(wearButton(scope)).toHaveAccessibleName(name);
  await expect(wearButton(scope)).toHaveCSS('opacity', '0');
}
/** Only a change of the chosen piece is announced (review Minor 2): the picker's status line, never the previewed card. */
const chosenStatus = (scope: Locator) => scope.locator('[data-chosen-status]');
const clockNow = (page: Page) => page.evaluate(() => window.__cloudiatorShell!.clock.now());
const effectiveTime = async (page: Page, processedSlotIndex: number) => slotTime(page, (processedSlotIndex + 1) * SLOT_MS, await clockNow(page));
/** Waits for the phone sheet's rise (0.2 s) so boxes and screenshots read the settled layout. */
const settled = async (locator: Locator) => { await locator.evaluate(el => Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished))); return locator; };
const shotDir = process.env.EQUIP_SHOT_DIR;

test.describe('equip from My gladiator (live)', () => {
  test.beforeEach(() => { test.skip(process.env.PLAYWRIGHT_STATIC === 'true', 'Live UI uses development-only intercepted identity transport.'); });

  test('a worn slot opens a picker of the pieces that fit, one tile per stack, and Wear, Undo, Remove and Cancel changes queue the Inventory\'s commands', async ({ page, context, hasTouch }, info) => {
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 740 });
    const sword = piece('sword:1:common'), spare1 = piece('sword:1:common'), spare2 = piece('sword:1:common'), uncommon = piece('sword:1:uncommon');
    const high = piece('sword:5:common'), spear = piece('spear:1:common'), bow = piece('bow:1:common', { reservation: listing() });
    const shield = piece('round-shield:1:common'), armor = piece('light-armor:1:common'), hood = piece('leather-hood:1:common');
    const flow = await gearFlow(context, state => {
      state.inventory = [sword, spare1, uncommon, high, spear, bow, shield, armor, spare2, hood];
      state.currentBuild.equipment = { weapon: sword.id, offHand: shield.id, head: null, body: armor.id, feet: null };
    });
    await page.goto('/game/');
    const menu = await openMenuSection(page, 'My gladiator', 'Worn equipment');
    const weapon = slotButton(menu, 'Weapon'), worn = wornRegion(menu);
    await expect(weapon).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(weapon).toHaveAttribute('aria-expanded', 'false');
    await expect(weapon.locator('[data-chevron]')).toHaveText('▾');
    await expect(worn).toContainText('Load 12 / 24.7');
    await weapon.click();
    // A click in the phone emulation is a mouse's, and the mouse left where the slot was is over the sheet that rose under it, where it would
    // preview the tile under it, which a finger never does (Task 33 fix round 1: the one-line strip moved the slot over the Remove tile).
    if (hasTouch) await page.mouse.move(0, 0);
    const dialog = picker(menu, 'Weapon');
    await expect(dialog).toBeVisible();
    // (A CSS locator: on a phone the sheet hides the slot row under it, so the slot is out of the accessibility tree meanwhile.)
    const expanded = menu.locator('[data-slot-row] button[aria-expanded="true"]');
    await expect(expanded).toHaveCount(1);
    await expect(expanded).toContainText('Weapon');
    await expect(expanded).toHaveAttribute('aria-controls', (await dialog.getAttribute('id'))!);
    await expect(dialog).toContainText('Now: Sword');
    // The pieces that fit, in the bag's order: the worn sword (✓), the two spare swords as one ×2 tile, the uncommon sword, the level 5
    // sword and the listed bow locked, the spear, and Remove. The head piece is not offered for the weapon.
    const grid = dialog.getByRole('group', { name: 'Weapon pieces', exact: true });
    await expect(grid.getByRole('button')).toHaveCount(7);
    await expect(pick(dialog, sword)).toHaveAccessibleName(/^Sword, level 1 common, wearing/);
    await expect(pick(dialog, sword).locator('[data-mark]')).toHaveText('✓');
    await expect(pick(dialog, spare1)).toHaveAttribute('data-stack', '2');
    await expect(pick(dialog, spare1)).toContainText('×2');
    await expect(pick(dialog, spare1)).toHaveAccessibleName(/^Sword, level 1 common, 2 owned/);
    await expect(pick(dialog, spare2)).toHaveCount(0);
    await expect(pick(dialog, uncommon)).not.toContainText('×');
    await expect(pick(dialog, high)).toHaveAccessibleName(/Needs level 5/);
    await expect(pick(dialog, high)).toHaveAttribute('data-locked', '');
    await expect(pick(dialog, bow)).toHaveAccessibleName(/Listed for sale/);
    await expect(pick(dialog, bow)).toHaveAttribute('data-locked', '');
    await expect(pick(dialog, spear)).not.toHaveAttribute('data-locked', /.*/);
    await expect(pick(dialog, hood)).toHaveCount(0);
    for (const tile of [sword, spare1, uncommon, high, spear, bow]) await expect(pick(dialog, tile).getByText(/^L\d+$/)).toHaveCount(1);
    await expect(pick(dialog, high).getByText('L5', { exact: true })).toBeVisible();
    await expect(dialog.getByText(/^#\d$/)).toHaveCount(0);
    await expect(grid.getByRole('button', { name: 'Remove Sword and leave Weapon empty', exact: true })).toBeVisible();
    await expect(dialog).toContainText('Choose a piece to compare it with what you wear.');
    // The stack: one Wear takes one piece of it.
    await pick(dialog, spare1).click();
    await expect(pick(dialog, spare1)).toHaveAttribute('aria-pressed', 'true');
    await expect(wearButton(dialog)).toHaveText('Wear Sword');
    await expect(wearButton(dialog)).toHaveAccessibleName('Wear Sword, level 1 common (one of 2)');
    await expect(dialog).toContainText('You own 2. Wear takes one.');
    await expect(dialog).toContainText('Level 1 · common · Tradable · 2 owned');
    await expectRow(dialog, 'Damage', ['6', '6', '=']);
    await expectRow(dialog, 'Attack interval', ['1.00 s', '1.00 s', '=']);
    await expectRow(dialog, 'Weight', ['4', '4', '=']);
    await expectRow(dialog, 'Load', ['12', '12 / 24.7', '=']);
    await expect(row(dialog, 'Hands')).toHaveCount(0);
    await expect(row(dialog, 'Armor')).toHaveCount(0);
    // A locked piece shows why, and its Wear is disabled.
    await pick(dialog, high).click();
    await expect(wearButton(dialog)).toBeDisabled();
    await expect(wearButton(dialog)).toHaveAccessibleDescription('Needs level 5');
    await pick(dialog, spare1).click();
    // Wear closes the picker, gives the focus back to the slot and queues the whole build with only the weapon changed.
    await wearButton(dialog).click();
    await expect(dialog).toHaveCount(0);
    await expect(weapon).toBeFocused();
    await expect(worn.getByRole('status')).toHaveText('Sword will be worn from the next slot. 1 left in the stack.');
    expect(flow.commands).toHaveLength(1);
    expect(flow.commands[0]).toMatchObject({ kind: 'queue-build', expectedVersion: 1, classId: 'guardian', stance: 'balanced',
      allocation: ownerFixture.currentBuild.allocations, equipment: { weapon: spare1.id, offHand: shield.id, head: null, body: armor.id, feet: null } });
    await expect(weapon.locator('[data-next-tag]')).toHaveText('NEXT');
    await expect(weapon).toHaveAccessibleName('Weapon: Sword, next: Sword, level 1 common');
    await expect(worn).toContainText('Load 12 / 24.7 (next slot)');
    const time = await effectiveTime(page, flow.state.processedSlotIndex);
    await expect(pendingBox(menu)).toContainText('Next: Sword, level 1 · common');
    await expect(pendingBox(menu).getByText(/^Gear changes start/)).toHaveText(`Gear changes start at the next slot, ${time}. Anything already running keeps the gear it started with.`);
    await expect(pendingBox(menu).getByRole('button', { name: 'Cancel changes', exact: true })).toBeVisible();
    expect(await contrastIssues(wornRegion(menu))).toEqual([]);
    // The desktop picker is laid over the panel: opening it moves neither the "At the next slot" box nor the planner, and it covers the
    // details box under the slot row (the approved mockups' popover). Offsets are read from the section's top, so a scroll does not count.
    const planner = menu.getByTestId('current-build');
    const offsets = async () => {
      const top = await worn.evaluate(element => element.getBoundingClientRect().top);
      return Promise.all([pendingBox(menu), planner].map(locator => locator.evaluate((element, from) => Math.round(element.getBoundingClientRect().top - from), top)));
    };
    const before = hasTouch ? [] : await offsets();
    // The queued piece has its own → tile and Undo; the stack is down to one piece. Escape closes the picker, not the menu.
    await weapon.click();
    if (!hasTouch) {
      await expect(dialog).toBeVisible();
      expect(await offsets()).toEqual(before);
      const covered = await worn.locator('[role="group"][aria-label="Worn equipment details"]').evaluate(element => {
        const box = element.getBoundingClientRect(), hit = document.elementFromPoint(box.left + box.width / 2, box.top + 20);
        return !!hit?.closest('[role="dialog"][aria-label="Change Weapon"]');
      });
      expect(covered).toBe(true);
      if (shotDir) await page.screenshot({ path: `${shotDir}/task-6-fix1-overlay-desktop.png` });
    }
    await expect(pick(dialog, spare1).locator('[data-mark]')).toHaveText('→');
    await expect(pick(dialog, spare2)).not.toContainText('×');
    await pick(dialog, spare1).click();
    await expect(dialog.getByRole('button', { name: 'Undo wearing Sword, level 1 common', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(weapon).toBeFocused();
    await expect(menu).toBeVisible();
    // Undo in the box puts the piece back in the stack: nothing is left to queue.
    await pendingBox(menu).getByRole('button', { name: 'Undo Weapon change', exact: true }).click();
    await expect(worn.getByRole('status')).toHaveText('Swap undone. Sword is back in the stack.');
    expect(flow.commands[1]).toMatchObject({ kind: 'cancel-build', expectedVersion: 2 });
    await expect(pendingBox(menu)).toHaveCount(0);
    await expect(weapon.locator('[data-next-tag]')).toHaveCount(0);
    // Remove empties the slot from the next slot.
    await weapon.click();
    await grid.getByRole('button', { name: 'Remove Sword and leave Weapon empty', exact: true }).click();
    await expectRow(dialog, 'Damage', ['6', '–', '−6']);
    await expectRow(dialog, 'Load', ['12', '8 / 24.7', '−4']);
    await dialog.getByRole('button', { name: 'Remove Sword', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(worn.getByRole('status')).toHaveText('Weapon will be emptied from the next slot.');
    expect(flow.commands[2]).toMatchObject({ kind: 'queue-build', expectedVersion: 3, equipment: { weapon: null, offHand: shield.id, head: null, body: armor.id, feet: null } });
    await expect(pendingBox(menu)).toContainText('Next: Empty');
    // Cancel changes puts every slot back.
    await pendingBox(menu).getByRole('button', { name: 'Cancel changes', exact: true }).click();
    await expect(worn.getByRole('status')).toHaveText('Gear changes canceled.');
    expect(flow.commands[3]).toMatchObject({ kind: 'cancel-build', expectedVersion: 4 });
    await expect(pendingBox(menu)).toHaveCount(0);
    expect(await menu.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  });

  test('a two-handed weapon names the off-hand piece that comes off, blocks the off-hand picker, and Undo brings the shield back', async ({ page, context, hasTouch }, info) => {
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 740 });
    const sword = piece('sword:1:common'), spear = piece('spear:1:common'), shield = piece('round-shield:1:common'), shield2 = piece('round-shield:1:common');
    const armor = piece('light-armor:1:common');
    const flow = await gearFlow(context, state => {
      state.inventory = [sword, spear, shield, shield2, armor];
      state.currentBuild.equipment = { weapon: sword.id, offHand: shield.id, head: null, body: armor.id, feet: null };
    });
    await page.goto('/game/');
    const menu = await openMenuSection(page, 'My gladiator', 'Worn equipment');
    const weapon = slotButton(menu, 'Weapon'), offHand = slotButton(menu, 'Off hand');
    await weapon.click();
    const dialog = picker(menu, 'Weapon');
    await pick(dialog, spear).click();
    await expect(dialog).toContainText('Two-handed: the off hand goes empty, Round shield comes off.');
    await expectRow(dialog, 'Damage', ['6', '7', '+1']);
    await expectRow(dialog, 'Attack interval', ['1.00 s', '1.20 s', '+0.20 s']);
    await expectRow(dialog, 'Hands', ['1', '2', '']);
    await expectRow(dialog, 'Weight', ['4', '6', '+2']);
    // Load is worked out without the shield the spear pushes off: 6 + 3, not 6 + 5 + 3.
    await expectRow(dialog, 'Load', ['12', '9 / 24.7', '−3']);
    await expect(wearButton(dialog)).toHaveText('Wear Spear');
    await wearButton(dialog).click();
    await expect(slotButton(menu, 'Weapon').locator('[data-next-tag]')).toBeVisible();
    expect(flow.commands[0]).toMatchObject({ kind: 'queue-build', equipment: { weapon: spear.id, offHand: null, head: null, body: armor.id, feet: null } });
    await expect(offHand.locator('[data-next-tag]')).toBeVisible();
    const box = pendingBox(menu);
    await expect(box).toContainText('Next: Spear, level 1 · common');
    await expect(box).toContainText('Next: Empty (two-handed weapon)');
    await expect(box.getByRole('button', { name: 'Undo Off hand change', exact: true })).toHaveCount(0);
    // Removing the queued spear, or choosing a one-handed weapon instead, brings the worn shield back on: the card says so and counts it.
    await weapon.click();
    await dialog.getByRole('button', { name: 'Remove Spear and leave Weapon empty', exact: true }).click();
    await expect(dialog).toContainText('Round shield goes back on.');
    await expectRow(dialog, 'Load', ['9', '8 / 24.7', '−1']);
    await pick(dialog, sword).click();
    await expect(dialog).toContainText('Round shield goes back on.');
    await expectRow(dialog, 'Load', ['9', '12 / 24.7', '+3']);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    // The off-hand picker is blocked while the next weapon is two-handed.
    await offHand.click();
    const hands = picker(menu, 'Off hand');
    await expect(hands).toContainText('The next weapon is two-handed: it uses both hands, so nothing can go in the off hand. Undo the weapon to free it.');
    await expect(pick(hands, shield)).toHaveAccessibleName(/Needs a free hand/);
    await expect(pick(hands, shield)).toHaveAttribute('data-locked', '');
    await expect(pick(hands, shield2)).toHaveAttribute('data-locked', '');
    await expect(hands.getByRole('button', { name: /^Remove / })).toHaveCount(0);
    await pick(hands, shield2).click();
    await expect(wearButton(hands)).toBeDisabled();
    await expect(wearButton(hands)).toHaveAccessibleDescription('Needs a free hand');
    await page.keyboard.press('Escape');
    await expect(offHand).toBeFocused();
    // Undo the weapon: the sword and the shield come back together, which is the current build, so the queue is canceled.
    await box.getByRole('button', { name: 'Undo Weapon change', exact: true }).click();
    await expect(wornRegion(menu).getByRole('status')).toHaveText('Swap undone. Sword stays worn.');
    expect(flow.commands[1]).toMatchObject({ kind: 'cancel-build' });
    await expect(offHand.locator('[data-next-tag]')).toHaveCount(0);
    await offHand.click();
    await expect(pick(hands, shield2)).not.toHaveAttribute('data-locked', /.*/);
    await expect(pick(hands, shield).locator('[data-mark]')).toHaveText('✓');
    await page.keyboard.press('Escape');
    // A slot with nothing to offer: the focus goes to Back on a phone (the sheet hides the slot) and to the picker on the desktop.
    const head = slotButton(menu, 'Head');
    await head.click();
    const empty = picker(menu, 'Head');
    await expect(empty).toContainText('You have nothing for this slot.');
    await expect(empty.locator('[data-tile]')).toHaveCount(0);
    if (hasTouch) await expect(empty.getByRole('button', { name: 'Back', exact: true })).toBeFocused();
    else await expect(empty).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(empty).toHaveCount(0);
    await expect(head).toBeFocused();
  });

  test('a piece that would overload the gladiator turns Load red and says so, and Wear stays enabled', async ({ page, context }, info) => {
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 740 });
    const axe = piece('axe:1:common'), shield = piece('round-shield:1:common'), helmet = piece('iron-helmet:1:common'), light = piece('light-armor:1:common');
    const boots = piece('heavy-boots:1:common'), heavy = piece('heavy-armor:5:common');
    const flow = await gearFlow(context, state => {
      state.progression.level = 5;
      state.inventory = [axe, shield, helmet, light, boots, heavy];
      state.currentBuild.equipment = { weapon: axe.id, offHand: shield.id, head: helmet.id, body: light.id, feet: boots.id };
    });
    await page.goto('/game/');
    const menu = await openMenuSection(page, 'My gladiator', 'Worn equipment');
    await slotButton(menu, 'Body').click();
    const dialog = picker(menu, 'Body');
    await pick(dialog, heavy).click();
    await expectRow(dialog, 'Armor', ['2', '9', '+7']);
    await expectRow(dialog, 'Weight', ['3', '10', '+7']);
    await expectRow(dialog, 'Load', ['22', '29 / 24.7', '+7']);
    await expect(row(dialog, 'Load')).toHaveAttribute('data-over', '');
    const note = dialog.getByText('This would overload your gladiator (load 29 of 24.7).', { exact: true });
    await expect(note).toBeVisible();
    await expect(note).toHaveCSS('color', 'rgb(255, 169, 156)');
    await expect(row(dialog, 'Load').locator('td').nth(1)).toHaveCSS('color', 'rgb(255, 169, 156)');
    await expect(wearButton(dialog)).toBeEnabled();
    await wearButton(dialog).click();
    expect(flow.commands[0]).toMatchObject({ kind: 'queue-build', equipment: { weapon: axe.id, offHand: shield.id, head: helmet.id, body: heavy.id, feet: boots.id } });
    const load = wornRegion(menu).getByText(/^Load /);
    await expect(load).toHaveText('Load 29 / 24.7 (next slot)');
    await expect(load.locator('strong')).toHaveCSS('color', 'rgb(255, 169, 156)');
  });

  test('the Load heading reads the next build: "(next slot)" for added points too, not only for queued gear', async ({ page, context }, info) => {
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 740 });
    const sword = piece('sword:1:common');
    await gearFlow(context, state => {
      state.inventory = [sword];
      state.currentBuild.equipment = { ...state.currentBuild.equipment, weapon: sword.id };
      state.progression.earnedAttributePoints = 11;
      state.buildVersion = 2;
      // An Endurance point queued through the planner: the next build's capacity is 10 + 2 × (5 + 3) × 1.05.
      state.pendingBuild = { build: { ...state.currentBuild, version: 2, allocations: { ...state.currentBuild.allocations, endurance: 3 } },
        effectiveSlotIndex: state.processedSlotIndex + 1, reservedMoney: 0, reservedItemIds: [sword.id], operationId: randomUUID() };
    });
    await page.goto('/game/');
    const menu = await openMenuSection(page, 'My gladiator', 'Worn equipment');
    await expect(wornRegion(menu).getByText(/^Load /)).toHaveText('Load 4 / 26.8 (next slot)');
    await expect(pendingBox(menu)).toHaveCount(0);
  });

  test('the picker\'s own Undo, a conflict that reloads, and a transient refusal whose Retry reuses the operation id; the keyboard lands on the outcome', async ({ page, context }, info) => {
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 740 });
    await watchFocus(page);
    const sword = piece('sword:1:common'), spare1 = piece('sword:1:common'), spare2 = piece('sword:1:common'), uncommon = piece('sword:1:uncommon');
    const flow = await gearFlow(context, state => {
      state.inventory = [sword, spare1, spare2, uncommon];
      state.currentBuild.equipment = { ...state.currentBuild.equipment, weapon: sword.id };
    });
    await page.goto('/game/');
    const menu = await openMenuSection(page, 'My gladiator', 'Worn equipment');
    const weapon = slotButton(menu, 'Weapon'), worn = wornRegion(menu), dialog = picker(menu, 'Weapon');
    /**
     * Puts the keyboard focus on `button` the way the Inventory's spec does (away and back by keyboard), so its press is a keyboard one. Back
     * then forward (Patch 1.9.2): Tab from the picker's last control leaves the desktop popover, which closes it.
     */
    const reach = async (button: Locator) => { await button.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab'); await expect(button).toBeFocused(); };
    await weapon.click();
    await pick(dialog, spare1).click();
    await wearButton(dialog).click();
    await expect(worn.getByRole('status')).toHaveText('Sword will be worn from the next slot. 1 left in the stack.');
    // The picker's own Undo, by keyboard: it sends the undo, closes the picker and gives the focus back to the slot.
    await weapon.click();
    await pick(dialog, spare1).click();
    const undo = dialog.getByRole('button', { name: 'Undo wearing Sword, level 1 common', exact: true });
    await reach(undo);
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(weapon).toBeFocused();
    await expect(worn.getByRole('status')).toHaveText('Swap undone. Sword is back in the stack.');
    expect(flow.commands[1]).toMatchObject({ kind: 'cancel-build', expectedVersion: 2 });
    // Another session changed the build: the next command is a conflict, said in words with no Retry, and the gear is read again.
    flow.state.buildVersion++;
    await weapon.click();
    await pick(dialog, uncommon).click();
    await wearButton(dialog).click();
    await expect(worn.getByRole('alert')).toHaveText('Your build changed. The latest state has been loaded; review and try again.');
    await expect(worn.getByRole('button', { name: 'Retry request', exact: true })).toHaveCount(0);
    expect(flow.commands[2]).toMatchObject({ kind: 'queue-build', expectedVersion: 3, equipment: { weapon: uncommon.id } });
    await expect(pendingBox(menu)).toHaveCount(0);
    // A transient refusal offers Retry; Retry by keyboard sends the very same command (its operation id too) and the outcome takes the focus.
    flow.reject('processing');
    await weapon.click();
    await pick(dialog, uncommon).click();
    await wearButton(dialog).click();
    await expect(worn.getByRole('alert')).toHaveText('The world is processing previous results. Retry shortly.');
    const retry = worn.getByRole('button', { name: 'Retry request', exact: true });
    flow.reject('');
    await reach(retry);
    await page.keyboard.press('Enter');
    await expect(worn.getByRole('status')).toHaveText('Sword will be worn from the next slot.');
    await expect(worn.getByRole('status')).toBeFocused();
    expect(flow.commands).toHaveLength(5);
    expect(flow.commands[4]).toEqual(flow.commands[3]);
    expect(flow.commands[4]).toMatchObject({ kind: 'queue-build', expectedVersion: 4, equipment: { weapon: uncommon.id } });
    // Cancel changes by keyboard leaves with its box: the outcome takes the focus.
    await reach(pendingBox(menu).getByRole('button', { name: 'Cancel changes', exact: true }));
    await page.keyboard.press('Enter');
    await expect(worn.getByRole('status')).toHaveText('Gear changes canceled.');
    await expect(worn.getByRole('status')).toBeFocused();
    expect(flow.commands[5]).toMatchObject({ kind: 'cancel-build', expectedVersion: 5 });
    expect(await focusDrops(page)).toEqual([]);
  });

  test('an open picker leaves nothing it covers reachable: Tab from Wear never lands under it, and closing it restores the Tab order', async ({ page, context }, info) => {
    // Final review (Important 1): on the desktop the popover lies over "At the next slot" (Undo, Cancel changes), the outcome line, Retry
    // and the top of the build planner; Tab from Wear reached them unseen and Enter fired them blind. On a phone the sheet hides them.
    // Patch 1.9.2: on the desktop the build planner is no longer inert (it was dead while it looked normal), so Tab from Wear goes on to the
    // planner, and the popover closes as the focus leaves it: the focus never sits under an open popover.
    const phone = info.project.name === 'mobile';
    if (phone) await page.setViewportSize({ width: 360, height: 740 });
    const sword = piece('sword:1:common'), spare = piece('sword:1:common'), uncommon = piece('sword:1:uncommon');
    const flow = await gearFlow(context, state => {
      state.inventory = [sword, spare, uncommon];
      state.currentBuild.equipment = { ...state.currentBuild.equipment, weapon: sword.id };
    });
    await page.goto('/game/');
    const menu = await openMenuSection(page, 'My gladiator', 'Worn equipment');
    const weapon = slotButton(menu, 'Weapon'), worn = wornRegion(menu), dialog = picker(menu, 'Weapon');
    // A queued change (Undo, Cancel changes) and then a transient refusal (its outcome and Retry), all under the slot row.
    await weapon.click();
    await pick(dialog, spare).click();
    await wearButton(dialog).click();
    await expect(pendingBox(menu)).toBeVisible();
    flow.reject('processing');
    await weapon.click();
    await pick(dialog, uncommon).click();
    await wearButton(dialog).click();
    await expect(worn.getByRole('button', { name: 'Retry request', exact: true })).toBeVisible();
    flow.reject('');
    await weapon.click();
    await pick(dialog, uncommon).click();
    await wearButton(dialog).focus();
    /** Where the focus is: in the picker, elsewhere in the menu over (`covered`) or clear of the picker's box, or out of the menu. */
    const where = () => page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null, box = document.querySelector('[role="dialog"][aria-label="Change Weapon"]');
      const menu = box?.closest('[data-menu-surface]');
      if (!active || !box || !menu) return { at: 'gone', name: '' };
      const name = active.getAttribute('aria-label') ?? active.textContent?.trim().slice(0, 40) ?? '';
      if (box.contains(active)) return { at: 'picker', name };
      if (!menu.contains(active)) return { at: 'outside', name };
      const a = active.getBoundingClientRect(), b = box.getBoundingClientRect();
      return { at: a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top ? 'covered' : 'clear', name };
    });
    /** The controls the desktop popover lies over. */
    const COVERED = /^(Undo Weapon change|Cancel changes|Retry request)$/;
    const steps: { at: string; name: string }[] = [];
    for (let i = 0; i < 30; i += 1) {
      await page.keyboard.press('Tab');
      const step = await where();
      steps.push(step);
      if (step.at === 'outside' || step.at === 'gone') break;
    }
    expect(steps.filter(step => step.at === 'covered'), JSON.stringify(steps)).toEqual([]);
    expect(steps.filter(step => COVERED.test(step.name)), JSON.stringify(steps)).toEqual([]);
    if (phone) expect(steps.at(-1)?.at, JSON.stringify(steps)).toBe('outside');
    else {
      // The desktop: the focus went on to the build planner's first control, and the popover closed as it left, so nothing covers it.
      expect(steps.at(-1)?.at, JSON.stringify(steps)).toBe('gone');
      await expect(dialog).toHaveCount(0);
      await expect(menu.locator('.planning-form').getByRole('button', { name: 'Cancel pending build', exact: true })).toBeFocused();
      await weapon.click();
      await pick(dialog, uncommon).click();
    }
    // Escape closes the picker: the slot has the focus, and Tab reaches Undo and Cancel changes again. The Retry is gone: opening
    // the picker cleared the last outcome and its Retry (Task 21 item 6).
    await wearButton(dialog).focus();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(weapon).toBeFocused();
    const names: string[] = [];
    for (let i = 0; i < 15 && names.at(-1) !== 'Cancel changes'; i += 1) {
      await page.keyboard.press('Tab');
      names.push(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim() ?? ''));
    }
    expect(names.filter(name => COVERED.test(name)), JSON.stringify(names)).toEqual(['Undo Weapon change', 'Cancel changes']);
    await expect(worn.getByRole('button', { name: 'Retry request', exact: true })).toHaveCount(0);
  });

  test('opening a picker clears the last outcome and its Retry, so Retry cannot resend an older command once it closes (Task 21 item 6)', async ({ page, context }, info) => {
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 740 });
    const sword = piece('sword:1:common'), uncommon = piece('sword:1:uncommon');
    const flow = await gearFlow(context, state => {
      state.inventory = [sword, uncommon];
      state.currentBuild.equipment = { ...state.currentBuild.equipment, weapon: sword.id };
    });
    await page.goto('/game/');
    const menu = await openMenuSection(page, 'My gladiator', 'Worn equipment');
    const weapon = slotButton(menu, 'Weapon'), worn = wornRegion(menu), dialog = picker(menu, 'Weapon');
    const refusal = 'The world is processing previous results. Retry shortly.';
    flow.reject('processing');
    await weapon.click();
    await pick(dialog, uncommon).click();
    await wearButton(dialog).click();
    await expect(worn.getByRole('alert')).toHaveText(refusal);
    await expect(worn.getByRole('button', { name: 'Retry request', exact: true })).toBeVisible();
    flow.reject('');
    // The player opens the picker again (the old outcome and Retry hide at once, keeping their room under the desktop popover) and
    // closes it without choosing: they are gone.
    await weapon.click();
    await expect(dialog).toBeVisible();
    await expect(worn.getByText(refusal)).toBeHidden();
    await expect(worn.getByRole('button', { name: 'Retry request', exact: true })).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(worn.getByText(refusal)).toHaveCount(0);
    await expect(worn.getByRole('button', { name: 'Retry request', exact: true })).toHaveCount(0);
    expect(flow.commands).toHaveLength(1);
  });

  test('Escape that closes the Load tooltip leaves the picker open', async ({ page, context, hasTouch }, info) => {
    // Final review (Minor 11). On a phone the sheet hides the Load row, so this is the desktop's.
    test.skip(hasTouch || info.project.name === 'mobile', 'The phone sheet covers the Load heading.');
    const sword = piece('sword:1:common'), spare = piece('sword:1:common');
    await gearFlow(context, state => {
      state.inventory = [sword, spare];
      state.currentBuild.equipment = { ...state.currentBuild.equipment, weapon: sword.id };
    });
    await page.goto('/game/');
    const menu = await openMenuSection(page, 'My gladiator', 'Worn equipment');
    const weapon = slotButton(menu, 'Weapon'), dialog = picker(menu, 'Weapon');
    const load = wornRegion(menu).getByRole('button', { name: 'Load', exact: true });
    await weapon.focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    // By keyboard, back from the picker to the Load label: its tooltip opens.
    for (let i = 0; i < 10 && !(await load.evaluate(el => el === document.activeElement)); i += 1) await page.keyboard.press('Shift+Tab');
    await expect(load).toBeFocused();
    await expect(menu.getByRole('tooltip')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu.getByRole('tooltip')).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(weapon).toBeFocused();
  });

  test('the card and Wear agree on one of two same-name pieces as hover and keyboard focus move', async ({ page, context, hasTouch }, info) => {
    // AGENTS.md "Detail cards that apply an item": Sword level 1 (a stack of two) and Sword level 5, with different ids and stats. Task 33 fix 1:
    // hover and the keyboard's focus show a tile's card (they showed nothing before); Wear stays the chosen piece's and shows only beside its card.
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 740 });
    const low1 = piece('sword:1:common'), low2 = piece('sword:1:common'), high = piece('sword:5:common');
    const flow = await gearFlow(context, state => {
      state.progression.level = 5;
      state.inventory = [low1, low2, high];
    });
    await page.goto('/game/');
    const menu = await openMenuSection(page, 'My gladiator', 'Worn equipment');
    const weapon = slotButton(menu, 'Weapon');
    // By keyboard: Enter on the slot opens the picker with the focus on the first tile.
    await weapon.focus();
    await page.keyboard.press('Enter');
    const dialog = picker(menu, 'Weapon');
    await expect(pick(dialog, low1)).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(pick(dialog, high)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(pick(dialog, high)).toHaveAttribute('aria-pressed', 'true');
    await expectRow(dialog, 'Damage', ['–', '9', '+9']);
    await expect(wearButton(dialog)).toHaveAccessibleName('Wear Sword, level 5 common');
    // The focus moves to the stack without choosing it: its card shows, and the level 5 sword's Wear waits out of reach (never beside
    // the stack's card); back on the level 5 sword, its card and Wear again.
    await page.keyboard.press('ArrowLeft');
    await expect(pick(dialog, low1)).toBeFocused();
    await expect(pick(dialog, high)).toHaveAttribute('aria-pressed', 'true');
    await expectRow(dialog, 'Damage', ['–', '6', '+6']);
    await expectWearWaiting(dialog, 'Wear Sword, level 5 common');
    await page.keyboard.press('ArrowRight');
    await expectRow(dialog, 'Damage', ['–', '9', '+9']);
    await expect(wearButton(dialog)).toHaveAccessibleName('Wear Sword, level 5 common');
    await page.keyboard.press('Tab');
    await expect(wearButton(dialog)).toBeFocused();
    if (!hasTouch) {
      // The pointer over the other tile keeps the keyboard on Wear and the card on the chosen piece.
      await pick(dialog, low1).hover();
      await expect(wearButton(dialog)).toBeFocused();
      await expectRow(dialog, 'Damage', ['–', '9', '+9']);
      await expect(wearButton(dialog)).toHaveAccessibleName('Wear Sword, level 5 common');
    }
    await page.keyboard.press('Enter');
    await expect(weapon).toBeFocused();
    await expect(wornRegion(menu).getByRole('status')).toHaveText('Sword will be worn from the next slot.');
    expect(flow.commands[0]).toMatchObject({ kind: 'queue-build', equipment: { weapon: high.id } });
    // By pointer: the stack chosen, then the other piece hovered: its card, and the stack's Wear waiting unseen; the pointer leaving it brings
    // back the stack's card and Wear. A focus a script gives the other piece after a click may or may not show its card (it is not the
    // keyboard's); the arrow that follows is the keyboard's, and back on the chosen stack its card and Wear show.
    await weapon.click();
    await pick(dialog, low1).click();
    await expectRow(dialog, 'Damage', ['9', '6', '−3']);
    await expect(wearButton(dialog)).toHaveAccessibleName('Wear Sword, level 1 common (one of 2)');
    if (!hasTouch) {
      await pick(dialog, high).hover();
      await expectRow(dialog, 'Damage', ['9', '9', '=']);
      await expectWearWaiting(dialog, 'Wear Sword, level 1 common (one of 2)');
      await dialog.getByRole('heading', { name: 'Weapon', exact: true }).hover();
    }
    await expectRow(dialog, 'Damage', ['9', '6', '−3']);
    await expect(wearButton(dialog)).toHaveAccessibleName('Wear Sword, level 1 common (one of 2)');
    await pick(dialog, high).focus();
    await page.keyboard.press('ArrowLeft');
    await expect(pick(dialog, low1)).toBeFocused();
    await expectRow(dialog, 'Damage', ['9', '6', '−3']);
    await expect(wearButton(dialog)).toHaveAccessibleName('Wear Sword, level 1 common (one of 2)');
    await wearButton(dialog).click();
    await expect(wornRegion(menu).getByRole('status')).toHaveText('Sword will be worn from the next slot. 1 left in the stack.');
    expect(flow.commands[1]).toMatchObject({ kind: 'queue-build', equipment: { weapon: low1.id } });
  });

  test('hover and keyboard focus show a replacement\'s card, and Wear shows only beside the chosen piece\'s own card (Task 33 fix 1)', async ({ page, context, hasTouch }, info) => {
    // The 1.9 changelog: "hover, focus or tap worn gear and replacements". AGENTS.md "Detail cards that apply an item": the card shown and
    // the piece Wear sends always agree, and the pointer never takes a keyboard action away.
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 740 });
    const low1 = piece('sword:1:common'), low2 = piece('sword:1:common'), high = piece('sword:5:common');
    const flow = await gearFlow(context, state => {
      state.progression.level = 5;
      state.inventory = [low1, low2, high];
    });
    await page.goto('/game/');
    const menu = await openMenuSection(page, 'My gladiator', 'Worn equipment');
    const weapon = slotButton(menu, 'Weapon');
    // By keyboard: the picker opens with the focus on the first tile, and the focused tile's card shows (nothing is chosen yet).
    await weapon.focus();
    await page.keyboard.press('Enter');
    const dialog = picker(menu, 'Weapon');
    await expect(pick(dialog, low1)).toBeFocused();
    await expectRow(dialog, 'Damage', ['–', '6', '+6']);
    await expect(wearButton(dialog)).toHaveCount(0);
    await page.keyboard.press('ArrowRight');
    await expect(pick(dialog, high)).toBeFocused();
    await expectRow(dialog, 'Damage', ['–', '9', '+9']);
    await expect(pick(dialog, high)).toHaveAttribute('aria-pressed', 'false');
    await expect(chosenStatus(dialog)).toHaveText('');
    await page.keyboard.press('Enter');
    await expect(pick(dialog, high)).toHaveAttribute('aria-pressed', 'true');
    await expect(wearButton(dialog)).toHaveAccessibleName('Wear Sword, level 5 common');
    // The choice is announced (a polite status), the previews are not: the card itself is no live region.
    await expect(chosenStatus(dialog)).toHaveText(/^Sword, Level 5 · common/);
    await expect(chosenStatus(dialog)).toHaveAttribute('aria-live', 'polite');
    await expect(dialog.locator('[aria-live]:not([data-chosen-status])')).toHaveCount(0);
    // The focus on the stack shows its card; Wear (the level 5 sword's) waits unseen for its own card, and nothing new is announced.
    await page.keyboard.press('ArrowLeft');
    await expectRow(dialog, 'Damage', ['–', '6', '+6']);
    await expectWearWaiting(dialog, 'Wear Sword, level 5 common');
    await expect(chosenStatus(dialog)).toHaveText(/^Sword, Level 5 · common/);
    // Tab from the previewed stack reaches the waiting Wear: the preview ends, and the level 5 sword's card shows beside it (review Minor 2).
    await page.keyboard.press('Tab');
    await expect(wearButton(dialog)).toBeFocused();
    await expectRow(dialog, 'Damage', ['–', '9', '+9']);
    await expect(wearButton(dialog)).toHaveCSS('opacity', '1');
    await page.keyboard.press('Shift+Tab');
    await expect(pick(dialog, low1)).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expectRow(dialog, 'Damage', ['–', '9', '+9']);
    await page.keyboard.press('Tab');
    await expect(wearButton(dialog)).toBeFocused();
    if (!hasTouch) {
      // A pointer over the other tile while the keyboard is on Wear: the keyboard keeps Wear, the card stays the chosen piece's.
      await pick(dialog, low1).hover();
      await expect(wearButton(dialog)).toBeFocused();
      await expectRow(dialog, 'Damage', ['–', '9', '+9']);
      await expect(wearButton(dialog)).toHaveAccessibleName('Wear Sword, level 5 common');
      // With the keyboard elsewhere, hovering a tile shows its card, and leaving it brings back the chosen one's with its Wear.
      await dialog.getByRole('heading', { name: 'Weapon', exact: true }).click();
      await pick(dialog, low1).hover();
      await expectRow(dialog, 'Damage', ['–', '6', '+6']);
      await expect(dialog).toContainText('Level 1 · common · Tradable · 2 owned');
      await expectWearWaiting(dialog, 'Wear Sword, level 5 common');
      await dialog.getByRole('heading', { name: 'Weapon', exact: true }).hover();
      await expectRow(dialog, 'Damage', ['–', '9', '+9']);
      await expect(wearButton(dialog)).toHaveAccessibleName('Wear Sword, level 5 common');
    }
    await wearButton(dialog).click();
    await expect(wornRegion(menu).getByRole('status')).toHaveText('Sword will be worn from the next slot.');
    expect(flow.commands[0]).toMatchObject({ kind: 'queue-build', equipment: { weapon: high.id } });
  });

  test('desktop: a popover under the slot row with a caret; phone: a sheet over the panel body with Back and a Wear bar', async ({ page, context, hasTouch }, info) => {
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 740 });
    const swords = [piece('sword:1:common'), piece('sword:1:common')], extra = ['sword:1:uncommon', 'sword:5:common', 'axe:1:common', 'spear:1:common', 'bow:1:common']
      .map(id => piece(id));
    const shield = piece('round-shield:1:common');
    await gearFlow(context, state => {
      state.inventory = [...swords, ...extra, shield];
      state.currentBuild.equipment = { weapon: null, offHand: shield.id, head: null, body: null, feet: null };
    });
    await page.goto('/game/');
    const menu = await openMenuSection(page, 'My gladiator', 'Worn equipment');
    const weapon = slotButton(menu, 'Weapon');
    await weapon.click();
    const dialog = picker(menu, 'Weapon');
    await pick(dialog, swords[0]).click();
    await settled(menu);
    const wear = wearButton(dialog);
    await expect(wear).toBeInViewport();
    if (!hasTouch) {
      // Under the slot row, as wide as the row, the caret under the chosen slot; the grid on the left, the card and Wear on the right.
      const rowBox = (await wornRegion(menu).locator('[data-slot-row]').boundingBox())!, box = (await dialog.boundingBox())!;
      const slot = (await weapon.boundingBox())!, grid = (await dialog.getByRole('group', { name: 'Weapon pieces' }).boundingBox())!;
      expect(box.y).toBeGreaterThan(rowBox.y + rowBox.height);
      expect(Math.abs(box.x - rowBox.x)).toBeLessThan(2);
      expect(Math.abs(box.width - rowBox.width)).toBeLessThan(2);
      const caret = await dialog.evaluate(element => Number.parseFloat(getComputedStyle(element).getPropertyValue('--caret')));
      expect(Math.abs(box.x + caret - (slot.x + slot.width / 2))).toBeLessThan(2);
      const wearBox = (await wear.boundingBox())!;
      expect(wearBox.x).toBeGreaterThan(grid.x + grid.width);
      await expect(dialog.getByRole('button', { name: 'Close Weapon choices', exact: true })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Back', exact: true })).toBeHidden();
    } else {
      // Over the panel body (the menu's title stays), with Back; the Wear bar at the sheet's foot, also after the list scrolls.
      const body = (await menu.getByTestId('menu-body').boundingBox())!, box = (await dialog.boundingBox())!, surface = (await menu.boundingBox())!;
      expect(Math.abs(box.y - body.y)).toBeLessThan(2);
      expect(Math.abs(box.y + box.height - (surface.y + surface.height))).toBeLessThan(2);
      expect(Math.abs(box.width - surface.width)).toBeLessThan(3);
      await expect(dialog.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
      // (Task 33: the gladiator's name is on the Overview; what the sheet covers here is the Worn equipment section under it.)
      await expect(menu.getByRole('heading', { name: 'Worn equipment', exact: true })).toBeHidden();
      const before = (await wear.boundingBox())!;
      expect(before.y + before.height).toBeGreaterThan(box.y + box.height - 70);
      await dialog.locator('[data-picker-body]').evaluate(element => { element.scrollTop = element.scrollHeight; });
      const after = (await wear.boundingBox())!;
      expect(after.y).toBe(before.y);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await contrastIssues(dialog)).toEqual([]);
    await menu.screenshot({ path: info.outputPath(`equip-picker-${info.project.name}.png`) });
    if (shotDir) await page.screenshot({ path: `${shotDir}/task-6-${info.project.name === 'mobile' ? 'phone' : 'desktop'}.png` });
    if (hasTouch) await dialog.getByRole('button', { name: 'Back', exact: true }).click();
    else await dialog.getByRole('button', { name: 'Close Weapon choices', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(weapon).toBeFocused();
    await expect(menu.getByRole('heading', { name: 'Worn equipment', exact: true })).toBeVisible();
  });

  // Patch 1.9.2 (Avi, 2026-11-20; the diagnosis is logs/p191-attr-check-20261120/findings.md): on 1.9 and 1.9.1 a desktop player who left a
  // slot's picker open found the build planner under it dead. It was inert, as under a phone's sheet, while it looked normal: +1 and Queue
  // build did nothing and sent nothing. The desktop popover now closes when the player clicks or moves the focus outside it, and the planner
  // under it works with the first click; the focus stays where the player put it. A phone's sheet still covers the planner until Back.
  test('with the Weapon picker open, +1 Strength works on a desktop (the picker closes) and Queue build sends; a phone\'s sheet covers the planner until Back (1.9.2)', async ({ page, context, hasTouch }, info) => {
    const phone = info.project.name === 'mobile';
    await page.setViewportSize(phone ? { width: 360, height: 780 } : { width: 1280, height: 720 });
    // A level-12 Berserker as production has them: 58 points earned, 10 spent, 48 waiting, the starter sword and armor worn.
    const sword = piece('sword:1:common'), spare = piece('sword:1:uncommon'), armor = piece('light-armor:1:common');
    const flow = await gearFlow(context, state => {
      state.inventory = [sword, spare, armor];
      state.currentBuild = { ...state.currentBuild, classId: 'berserker', allocations: { strength: 5, agility: 1, vitality: 2, endurance: 1, precision: 1 },
        equipment: { weapon: sword.id, offHand: null, head: null, body: armor.id, feet: null } };
      state.progression = { ...state.progression, level: 12, earnedAttributePoints: 58, unspentAttributePoints: 48 };
    });
    await page.goto('/game/');
    const menu = await openMenuSection(page, 'My gladiator', 'Worn equipment');
    const weapon = slotButton(menu, 'Weapon'), dialog = picker(menu, 'Weapon');
    const form = menu.locator('.planning-form'), counter = form.locator('.build-counter');
    const plusOne = form.getByRole('button', { name: 'Add a point to Strength', exact: true });
    await expect(counter).toHaveText('48 of 58 left');
    await weapon.click();
    if (hasTouch) await page.mouse.move(0, 0);
    await expect(dialog).toBeVisible();
    if (phone) {
      // The sheet covers the panel body: the planner is hidden and out of reach until Back, which gives the focus back to the slot. (A CSS
      // locator: the hidden planner is out of the accessibility tree meanwhile.)
      const covered = form.locator('button[aria-label="Add a point to Strength"]');
      await expect(covered).toBeHidden();
      expect(await covered.evaluate(element => !!element.closest('[inert]'))).toBe(true);
      await dialog.getByRole('button', { name: 'Back', exact: true }).tap();
      await expect(dialog).toHaveCount(0);
      await expect(weapon).toBeFocused();
      await plusOne.tap();
    } else {
      // The popover lies over the top of the planner; the planner below it looks normal and is not inert, so the first click counts.
      expect(await plusOne.evaluate(element => !!element.closest('[inert]'))).toBe(false);
      const shots = process.env.HOTFIX_SHOTS;
      if (shots) {
        // The popover over the top of the planner, then the planner's points further down, the popover still open.
        await dialog.evaluate(element => element.scrollIntoView({ block: 'start' }));
        await page.screenshot({ path: `${shots}/desktop-1280x720-weapon-picker-open.png` });
        await plusOne.evaluate(element => element.scrollIntoView({ block: 'end' }));
        await page.screenshot({ path: `${shots}/desktop-1280x720-weapon-picker-open-planner-below.png` });
      }
      await plusOne.click();
      await expect(dialog).toHaveCount(0);
      // Closed by a click outside it, the picker leaves the focus where the player put it, never back on the slot.
      await expect(plusOne).toBeFocused();
      if (shots) {
        await expect(counter).toHaveText('47 of 58 left');
        await page.screenshot({ path: `${shots}/desktop-1280x720-plus-one-pressed-picker-closed.png` });
      }
    }
    await expect(counter).toHaveText('47 of 58 left');
    await form.getByRole('button', { name: 'Queue build', exact: true }).click();
    await expect(menu.getByRole('heading', { name: 'Pending build', exact: true })).toBeVisible();
    expect(flow.commands).toEqual([expect.objectContaining({ kind: 'queue-build', expectedVersion: 1,
      allocation: { strength: 6, agility: 1, vitality: 2, endurance: 1, precision: 1 }, equipment: { weapon: sword.id, offHand: null, head: null, body: armor.id, feet: null } })]);
    if (!phone) {
      // A click inside it (a tile) leaves it open; a click on something outside that is no control (the menu's title) closes it too.
      await weapon.click();
      await expect(dialog).toBeVisible();
      await pick(dialog, spare).click();
      await expect(dialog).toBeVisible();
      await menu.getByTestId('menu-title').click();
      await expect(dialog).toHaveCount(0);
      await expect(weapon).toHaveAttribute('aria-expanded', 'false');
      expect(flow.commands).toHaveLength(1);
    }
  });

  // 1.9.2 review (Important): after a gear command its outcome line stays under the slots; opening another picker hides it, keeping its room
  // (Task 21), and the picker's close removes it. When a press on the planner closed the picker, the line went before the press ended, the
  // planner moved up under the pointer, and the click was lost (it landed on their common parent). A window tall enough that the menu does not
  // scroll shows it (scroll anchoring hides it when the menu is scrolled, as at 1280 x 720 and 1280 x 1200).
  test('after a gear outcome, the first click on the planner under another open picker still counts (1.9.2 review)', async ({ page, context }, info) => {
    test.skip(info.project.name === 'mobile', 'A phone\'s sheet covers the planner: it closes with Back before a tap can reach the planner.');
    await page.setViewportSize({ width: 1280, height: 1800 });
    const sword = piece('sword:1:common'), spare = piece('sword:1:uncommon'), armor = piece('light-armor:1:common');
    const flow = await gearFlow(context, state => {
      state.inventory = [sword, spare, armor];
      state.currentBuild = { ...state.currentBuild, classId: 'berserker', allocations: { strength: 5, agility: 1, vitality: 2, endurance: 1, precision: 1 },
        equipment: { weapon: sword.id, offHand: null, head: null, body: armor.id, feet: null } };
      state.progression = { ...state.progression, level: 12, earnedAttributePoints: 58, unspentAttributePoints: 48 };
    });
    await page.goto('/game/');
    const menu = await openMenuSection(page, 'My gladiator', 'Worn equipment');
    const worn = wornRegion(menu), weapon = slotButton(menu, 'Weapon'), dialog = picker(menu, 'Weapon');
    const form = menu.locator('.planning-form'), counter = form.locator('.build-counter');
    // A Wear: its outcome line stays under the slots.
    await weapon.click();
    await pick(dialog, spare).click();
    await wearButton(dialog).click();
    const outcome = worn.getByRole('status');
    await expect(outcome).toHaveText('Sword will be worn from the next slot.');
    await expect(counter).toHaveText('48 of 58 left');
    // Another slot's picker hides the outcome (keeping its room); a click on +1 Strength in the planner closes the picker and counts. (A press
    // as a hand makes it, 120 ms from down to up: the line went in that time. Playwright's own click lets it go only after the click.)
    await slotButton(menu, 'Body').click();
    await expect(picker(menu, 'Body')).toBeVisible();
    await expect(outcome).toBeHidden();
    const plusOne = form.getByRole('button', { name: 'Add a point to Strength', exact: true });
    await plusOne.click({ delay: 120 });
    await expect(picker(menu, 'Body')).toHaveCount(0);
    await expect(counter).toHaveText('47 of 58 left');
    await expect(plusOne).toBeFocused();
    // The old outcome is gone once the press is over, as when the picker closes any other way.
    await expect(worn.getByText('Sword will be worn from the next slot.')).toHaveCount(0);
    expect(flow.commands).toHaveLength(1);
  });
});

test('the fixture preview opens the picker with stacked duplicates and says gear changes are unavailable', async ({ page }, info) => {
  test.skip(process.env.PLAYWRIGHT_STATIC === 'true', 'Production builds refuse the fixture preview.');
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/game/?mode=fixture&bag=demo');
  const menu = await openMenuSection(page, 'My gladiator', 'Worn equipment');
  await slotButton(menu, 'Feet').click();
  const dialog = picker(menu, 'Feet');
  const boots = dialog.getByRole('button', { name: /^Light boots, level 1 common, 3 owned/ });
  await expect(boots).toContainText('×3');
  await boots.click();
  await expect(dialog).toContainText('You own 3. Wear takes one.');
  await expect(wearButton(dialog)).toBeDisabled();
  await expect(wearButton(dialog)).toHaveAccessibleDescription('Gear changes are unavailable in this preview.');
});
