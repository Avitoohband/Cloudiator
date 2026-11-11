import { test, expect, type BrowserContext, type Locator, type Page } from './fixtures';
import { randomUUID } from 'node:crypto';
import { ownerFixture, itemFixture } from '../fixtures/domain';
import type { ItemInstance, OwnerState } from '../../supabase/functions/_shared/contracts/reads';
import type { GameCommand } from '../../supabase/functions/_shared/contracts/commands';
import { CATALOG_V1 } from '../../supabase/functions/_shared/domain/catalog-v1';
import { SLOT_MS, emptyWorld, isPresence, routeLiveReads } from './live-routes';
import { openMenu } from './shell-helpers';
import { slotTime } from './slot-time';
import { contrastIssues } from './a11y-helpers';

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
  return { state, commands };
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
const clockNow = (page: Page) => page.evaluate(() => window.__cloudiatorShell!.clock.now());
const effectiveTime = async (page: Page, processedSlotIndex: number) => slotTime(page, (processedSlotIndex + 1) * SLOT_MS, await clockNow(page));
/** Waits for the phone sheet's rise (0.2 s) so boxes and screenshots read the settled layout. */
const settled = async (locator: Locator) => { await locator.evaluate(el => Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished))); return locator; };
const shotDir = process.env.EQUIP_SHOT_DIR;

test.describe('equip from My gladiator (live)', () => {
  test.beforeEach(() => { test.skip(process.env.PLAYWRIGHT_STATIC === 'true', 'Live UI uses development-only intercepted identity transport.'); });

  test('a worn slot opens a picker of the pieces that fit, one tile per stack, and Wear, Undo, Remove and Cancel changes queue the Inventory\'s commands', async ({ page, context }, info) => {
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 740 });
    const sword = piece('sword:1:common'), spare1 = piece('sword:1:common'), spare2 = piece('sword:1:common'), uncommon = piece('sword:1:uncommon');
    const high = piece('sword:5:common'), spear = piece('spear:1:common'), bow = piece('bow:1:common', { reservation: listing() });
    const shield = piece('round-shield:1:common'), armor = piece('light-armor:1:common'), hood = piece('leather-hood:1:common');
    const flow = await gearFlow(context, state => {
      state.inventory = [sword, spare1, uncommon, high, spear, bow, shield, armor, spare2, hood];
      state.currentBuild.equipment = { weapon: sword.id, offHand: shield.id, head: null, body: armor.id, feet: null };
    });
    await page.goto('/game/');
    const menu = await openMenu(page, 'My gladiator');
    const weapon = slotButton(menu, 'Weapon'), worn = wornRegion(menu);
    await expect(weapon).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(weapon).toHaveAttribute('aria-expanded', 'false');
    await expect(weapon.locator('[data-chevron]')).toHaveText('▾');
    await expect(worn).toContainText('Load 12 / 24.7');
    await weapon.click();
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
    // The queued piece has its own → tile and Undo; the stack is down to one piece. Escape closes the picker, not the menu.
    await weapon.click();
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

  test('a two-handed weapon names the off-hand piece that comes off, blocks the off-hand picker, and Undo brings the shield back', async ({ page, context }, info) => {
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 740 });
    const sword = piece('sword:1:common'), spear = piece('spear:1:common'), shield = piece('round-shield:1:common'), shield2 = piece('round-shield:1:common');
    const armor = piece('light-armor:1:common');
    const flow = await gearFlow(context, state => {
      state.inventory = [sword, spear, shield, shield2, armor];
      state.currentBuild.equipment = { weapon: sword.id, offHand: shield.id, head: null, body: armor.id, feet: null };
    });
    await page.goto('/game/');
    const menu = await openMenu(page, 'My gladiator');
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
    const menu = await openMenu(page, 'My gladiator');
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

  test('the card and Wear stay on the chosen one of two same-name pieces as hover and keyboard focus move', async ({ page, context, hasTouch }, info) => {
    // AGENTS.md "Detail cards that apply an item": Sword level 1 (a stack of two) and Sword level 5, with different ids and stats.
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 740 });
    const low1 = piece('sword:1:common'), low2 = piece('sword:1:common'), high = piece('sword:5:common');
    const flow = await gearFlow(context, state => {
      state.progression.level = 5;
      state.inventory = [low1, low2, high];
    });
    await page.goto('/game/');
    const menu = await openMenu(page, 'My gladiator');
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
    // The focus moves to the stack without choosing it: the card and Wear stay on the level 5 sword.
    await page.keyboard.press('ArrowLeft');
    await expect(pick(dialog, low1)).toBeFocused();
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
    // By pointer: the stack chosen, then the other piece hovered and focused: still the stack's card and Wear.
    await weapon.click();
    await pick(dialog, low1).click();
    await expectRow(dialog, 'Damage', ['9', '6', '−3']);
    await expect(wearButton(dialog)).toHaveAccessibleName('Wear Sword, level 1 common (one of 2)');
    if (!hasTouch) await pick(dialog, high).hover();
    await pick(dialog, high).focus();
    await expectRow(dialog, 'Damage', ['9', '6', '−3']);
    await expect(wearButton(dialog)).toHaveAccessibleName('Wear Sword, level 1 common (one of 2)');
    await wearButton(dialog).click();
    await expect(wornRegion(menu).getByRole('status')).toHaveText('Sword will be worn from the next slot. 1 left in the stack.');
    expect(flow.commands[1]).toMatchObject({ kind: 'queue-build', equipment: { weapon: low1.id } });
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
    const menu = await openMenu(page, 'My gladiator');
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
      await expect(menu.getByRole('heading', { name: 'Aster' })).toBeHidden();
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
    await expect(menu.getByRole('heading', { name: 'Aster' })).toBeVisible();
  });
});

test('the fixture preview opens the picker with stacked duplicates and says gear changes are unavailable', async ({ page }, info) => {
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/game/?mode=fixture&bag=demo');
  const menu = await openMenu(page, 'My gladiator');
  await slotButton(menu, 'Feet').click();
  const dialog = picker(menu, 'Feet');
  const boots = dialog.getByRole('button', { name: /^Light boots, level 1 common, 3 owned/ });
  await expect(boots).toContainText('×3');
  await boots.click();
  await expect(dialog).toContainText('You own 3. Wear takes one.');
  await expect(wearButton(dialog)).toBeDisabled();
  await expect(wearButton(dialog)).toHaveAccessibleDescription('Gear changes are unavailable in this preview.');
});
