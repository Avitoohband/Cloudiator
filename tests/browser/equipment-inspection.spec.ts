import { test, expect } from './fixtures';
import { CATALOG_V1 } from '../../supabase/functions/_shared/domain/catalog-v1';
import { itemFixture, ownerFixture } from '../fixtures/domain';
import { SUPABASE_URL, emptyWorld, isPresence, routeLiveReads, seedSession } from './live-routes';
import { openMenu } from './shell-helpers';

test.beforeEach(() => {
  test.skip(process.env.PLAYWRIGHT_STATIC === 'true', 'Live UI uses development-only intercepted identity transport.');
});

test('inspects worn and replacement equipment stats and weight', async ({ page, context, hasTouch }) => {
  const owner = structuredClone(ownerFixture);
  const sword = itemFixture(CATALOG_V1.items['sword:1:common']);
  const shield = itemFixture(CATALOG_V1.items['round-shield:1:common']);
  const axe = itemFixture(CATALOG_V1.items['axe:1:common']);
  const spear = itemFixture(CATALOG_V1.items['spear:1:uncommon']);
  const otherSpear = { ...itemFixture(CATALOG_V1.items['spear:1:uncommon']), id: `${spear.id}-second` };
  const highLevelSword = itemFixture(CATALOG_V1.items['sword:5:rare']);
  const listedBow = itemFixture(CATALOG_V1.items['bow:1:common']);
  sword.stats = { ...sword.stats, damage: 9.25, weight: 3.75 };
  shield.stats = { ...shield.stats, armor: 4.25, weight: 5.5 };
  spear.stats = { ...spear.stats, damage: 13.25, weight: 7.5 };
  otherSpear.stats = { ...otherSpear.stats, damage: 8.75, weight: 5.5 };
  for (const item of [sword, shield]) item.reservation = { kind: 'equipment', referenceId: owner.gladiatorId };
  listedBow.reservation = { kind: 'listing', referenceId: 'listed-bow' };
  owner.inventory = [sword, shield, axe, spear, otherSpear, highLevelSword, listedBow];
  owner.currentBuild.equipment = { ...owner.currentBuild.equipment, weapon: sword.id, offHand: shield.id };
  const world = emptyWorld();
  owner.buildVersion = 2;
  owner.pendingBuild = {
    build: { ...owner.currentBuild, version: 2, equipment: { ...owner.currentBuild.equipment, weapon: axe.id } },
    effectiveSlotIndex: world.slotIndex + 1,
    reservedMoney: 0,
    reservedItemIds: [axe.id, shield.id],
    operationId: 'pending-build',
  };
  const user = await seedSession(context);
  await routeLiveReads(context, { world, owner, ownerAccountId: user.id });
  const commandUrl = `${SUPABASE_URL}/functions/v1/game-command`;
  await context.route(commandUrl, async route => {
    const request = route.request();
    if (request.method() !== 'POST' || isPresence(request)) return route.fallback();
    return route.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: { ok: true, receiptId: 'equipment-build', value: {} } });
  });
  if (hasTouch) await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/game/');
  const mine = await openMenu(page, 'My gladiator');

  const worn = mine.getByRole('region', { name: 'Worn equipment' });
  const wornSword = worn.getByRole('button', { name: 'Weapon: Sword' });
  const wornShield = worn.getByRole('button', { name: 'Off hand: Round shield' });
  const wornDetails = worn.getByRole('group', { name: 'Worn equipment details' });
  await expect(wornSword).toBeVisible();
  if (hasTouch) await wornSword.tap();
  else await wornSword.hover();
  await expect(wornDetails).toContainText(/Damage\s*9\.25/);
  await expect(wornDetails).toContainText(/Weight\s*3\.75/);
  if (hasTouch) {
    const width = await wornDetails.evaluate(element => element.getBoundingClientRect().width);
    await wornShield.tap();
    expect(await wornDetails.evaluate(element => element.getBoundingClientRect().width)).toBe(width);
    await expect(wornDetails).toBeInViewport();
  } else {
    await wornSword.focus();
    await page.keyboard.press('Tab');
    await expect(wornShield).toBeFocused();
  }
  await expect(wornDetails).toContainText(/Armor\s*4\.25/);
  await expect(wornDetails).toContainText(/Weight\s*5\.5/);

  const weapon = mine.locator('[data-equipment-slot="weapon"]');
  if (hasTouch) await weapon.tap();
  else await weapon.press('Enter');
  const details = mine.getByRole('group', { name: 'Build equipment details' });
  const spearOption = mine.locator(`[data-equipment-option="${spear.id}"]`);
  if (hasTouch) await spearOption.tap();
  else await spearOption.hover();
  await expect(details).toContainText(/Damage\s*13\.25/);
  await expect(details).toContainText(/Weight\s*7\.5/);
  await expect(details).toContainText(/two-handed/i);
  await expect(weapon).toHaveAccessibleName('Weapon: Axe');
  await expect(mine.locator(`[data-equipment-option="${highLevelSword.id}"]`)).toBeDisabled();
  await expect(mine.locator(`[data-equipment-option="${listedBow.id}"]`)).toBeDisabled();
  const useSpear = details.getByRole('button', { name: 'Use Spear · Item 1', exact: true });
  const otherSpearOption = mine.locator(`[data-equipment-option="${otherSpear.id}"]`);
  await expect(spearOption).toHaveAccessibleName(/Spear.*Item 1/);
  await expect(otherSpearOption).toHaveAccessibleName(/Spear.*Item 2/);
  if (hasTouch) {
    await expect(useSpear).toBeVisible();
    await otherSpearOption.focus();
  } else {
    await spearOption.click();
    await expect(useSpear).toBeVisible();
    await otherSpearOption.hover();
  }
  await expect(details).toContainText(/Damage\s*8\.75/);
  await expect(useSpear).toBeHidden();
  if (hasTouch) {
    await spearOption.tap();
    await expect(details).toBeInViewport();
    await useSpear.tap();
  } else {
    await details.hover();
    await spearOption.press('Enter');
    await expect(useSpear).toBeFocused();
    await otherSpearOption.hover();
    await expect(useSpear).toBeFocused();
    await expect(details).toContainText(/Damage\s*13\.25/);
    await page.keyboard.press('Enter');
    await expect(weapon).toBeFocused();
  }
  await expect(weapon).toHaveAccessibleName('Weapon: Spear, Item 1');
  const draftShield = mine.locator('[data-equipment-slot="offHand"]');
  await expect(draftShield).toBeDisabled();
  await expect(draftShield).toHaveAccessibleName('Off hand: Empty');
  if (hasTouch) await weapon.tap();
  else await weapon.press('Enter');
  await expect(otherSpearOption).toHaveAccessibleName(/Spear.*Item 2/);
  await expect(wornSword).toBeVisible();
  await expect(wornShield).toBeVisible();
  await expect(mine.getByTestId('pending-build')).toContainText('Axe');
  expect(await mine.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);

  const queue = page.waitForRequest(request => request.url() === commandUrl && request.method() === 'POST' && !isPresence(request));
  await mine.getByRole('button', { name: 'Queue build' }).click();
  expect((await queue).postDataJSON()).toMatchObject({ kind: 'queue-build', expectedVersion: 2, equipment: { weapon: spear.id, offHand: null } });
});
