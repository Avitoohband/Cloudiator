import { expect, test, type Locator, type Page, type TestInfo } from './fixtures';
import { randomUUID } from 'node:crypto';
import { CATALOG_V1 } from '../../supabase/functions/_shared/domain/catalog-v1';
import { itemFixture, ownerFixture, worldFixture } from '../fixtures/domain';
import type { OwnerState } from '../../supabase/functions/_shared/contracts/reads';
import { contrastIssues, expectNamedControls, noHorizontalScroll } from './a11y-helpers';
import { routeLiveReads, seedSession } from './live-routes';
import { cornerChip, expectOwnerShown, openMenu } from './shell-helpers';

// Patch 1.9 Task 10 (the approved xp-help mockups): My gladiator's XP bar under Stamina with the next expedition's XP as a ghost segment and
// its line, a thin unlabeled XP line under the name in the corner chip, and the Attributes and Stats blocks with help on every label. Live mode
// with the v2 rules (expedition XP 30 / 75 / 150), the owner below: Aster, a Guardian with 2 points in each attribute and nothing worn.
const production = process.env.PLAYWRIGHT_STATIC === 'true';
const SLOT_MS = 4_800_000;
const shotDir = process.env.XP_SHOT_DIR;

async function openLive(page: Page, change: (owner: OwnerState) => void, where?: string) {
  const context = page.context();
  await seedSession(context);
  const owner = structuredClone(ownerFixture);
  change(owner);
  // `where` is the owner's world actor's location (`expedition:<id>` while away): it names a running expedition.
  const world = { ...worldFixture, revision: 'live-1', actors: worldFixture.actors.map(actor => (where ? { ...actor, location: where as typeof actor.location } : actor)) };
  await routeLiveReads(context, { world, owner, rulesVersion: 'v2' });
  await page.goto('/game/');
  await expectOwnerShown(page, 'Aster');
  return openMenu(page, 'My gladiator');
}
const level = (state: OwnerState, levelNumber: number, xp: number) => { state.progression = { ...state.progression, level: levelNumber, xp }; };
const rest = (state: OwnerState) => { state.schedule = { morning: { kind: 'rest' }, afternoon: { kind: 'rest' }, evening: { kind: 'rest' } }; };
const bar = (menu: Locator) => menu.getByRole('progressbar', { name: 'Experience', exact: true });
const widthOf = async (locator: Locator) => (await locator.boundingBox())!.width;
/** A segment's share of its bar, to a hundredth. */
const share = async (segment: Locator, track: Locator) => Math.round((await widthOf(segment) / await widthOf(track)) * 100) / 100;
async function shot(page: Page, info: TestInfo, name: string) {
  if (shotDir) await page.screenshot({ path: `${shotDir}/${name}.png` });
}

test.describe('the XP bar (live)', () => {
  test.skip(production, 'Live UI uses the development-only intercepted Supabase transport.');

  test('a scheduled expedition that can finish the level: the gold ghost, the level-up line and the chip\'s line', async ({ page }, info) => {
    if (info.project.name === 'mobile') await page.setViewportSize({ width: 360, height: 740 });
    const menu = await openLive(page, state => { level(state, 1, 80); });
    const block = menu.getByTestId('xp-block');
    await expect(block).toContainText('Level 1');
    await expect(block).toContainText('80 / 100 XP');
    await expect(block).toContainText('20 XP to Level 2');
    await expect(block).toContainText('Each level costs 100 × your level');
    await expect(menu.getByTestId('xp-hint')).toHaveText('Your next expedition (up to +30 XP) can level you up to Level 2');
    const xp = bar(menu);
    await expect(xp).toHaveAttribute('aria-valuenow', '80');
    await expect(xp).toHaveAttribute('aria-valuemax', '100');
    await expect(xp).toHaveAccessibleDescription(/can level you up to Level 2/);
    // The stamina bar stays above it, and the XP bar is the next thing under it.
    const stamina = menu.getByRole('progressbar', { name: 'Stamina', exact: true });
    expect((await xp.boundingBox())!.y).toBeGreaterThan((await stamina.boundingBox())!.y);
    expect(await share(menu.getByTestId('xp-fill'), xp)).toBe(0.8);
    const ghost = menu.getByTestId('xp-ghost');
    expect(await share(ghost, xp)).toBe(0.2);
    await expect(ghost).toHaveAttribute('data-crosses', 'true');
    await expect(menu.getByTestId('xp-hint')).toHaveCSS('font-weight', '600');
    // The chip: a thin line with the same shares, no label.
    const line = cornerChip(page).getByTestId('chip-xp');
    await expect(line).toBeVisible();
    expect((await line.boundingBox())!.height).toBe(4);
    await expect(line).toHaveAttribute('aria-hidden', 'true');
    await expect(line).toHaveText('');
    expect(await share(cornerChip(page).getByTestId('chip-xp-fill'), line)).toBe(0.8);
    expect(await share(cornerChip(page).getByTestId('chip-xp-ghost'), line)).toBe(0.2);
    await expect(cornerChip(page).getByTestId('chip-xp-ghost')).toHaveAttribute('data-crosses', 'true');
    await expectNamedControls(menu, 'My gladiator');
    expect(await contrastIssues(menu), 'My gladiator').toEqual([]);
    await shot(page, info, info.project.name === 'mobile' ? 'xp-levelup-phone' : 'xp-levelup-desktop');
  });

  test('a scheduled expedition that cannot: the blue ghost and "more to Level"', async ({ page }) => {
    const menu = await openLive(page, state => { level(state, 5, 230); rest(state); state.schedule.evening = { kind: 'expedition', expeditionId: 'outpost' }; });
    await expect(menu.getByTestId('xp-block')).toContainText('Level 5');
    await expect(menu.getByTestId('xp-block')).toContainText('230 / 500 XP');
    await expect(menu.getByTestId('xp-block')).toContainText('270 XP to Level 6');
    await expect(menu.getByTestId('xp-hint')).toHaveText('Next expedition: up to +75 XP · 195 more to Level 6');
    await expect(menu.getByTestId('xp-hint')).not.toHaveCSS('font-weight', '600');
    expect(await share(menu.getByTestId('xp-fill'), bar(menu))).toBe(0.46);
    expect(await share(menu.getByTestId('xp-ghost'), bar(menu))).toBe(0.15);
    await expect(menu.getByTestId('xp-ghost')).not.toHaveAttribute('data-crosses', /.*/);
    await expect(cornerChip(page).getByTestId('chip-xp-ghost')).not.toHaveAttribute('data-crosses', /.*/);
  });

  test('with nothing scheduled it names the highest expedition the level allows', async ({ page }) => {
    const menu = await openLive(page, state => { level(state, 5, 440); rest(state); });
    await expect(menu.getByTestId('xp-hint')).toHaveText('Your next Ruined Outpost expedition (up to +75 XP) can level you up to Level 6');
  });

  test('an expedition running now is "your current expedition"', async ({ page }) => {
    const menu = await openLive(page, state => {
      level(state, 5, 100); rest(state);
      // The running part was edited to Rest after it began: the destination is where the gladiator is, not the schedule.
      state.currentActivity = { id: '9fce3cd5-e831-4a66-8ca1-16b4576b1499', kind: 'expedition', status: 'active', startsAtMs: 373_248 * SLOT_MS, endsAtMs: 373_249 * SLOT_MS, label: 'Expedition' };
    }, 'expedition:outpost');
    await expect(menu.getByTestId('xp-hint')).toHaveText('Current expedition: up to +75 XP · 325 more to Level 6');
  });

  test('a running expedition the world has not placed yet is named with no number and no ghost', async ({ page }) => {
    const unknown = await openLive(page, state => {
      level(state, 5, 100); rest(state);
      state.currentActivity = { id: '9fce3cd5-e831-4a66-8ca1-16b4576b1499', kind: 'expedition', status: 'active', startsAtMs: 373_248 * SLOT_MS, endsAtMs: 373_249 * SLOT_MS, label: 'Expedition' };
    }, 'camp');
    await expect(unknown.getByTestId('xp-hint')).toHaveText('Current expedition');
    await expect(unknown.getByTestId('xp-ghost')).toHaveCount(0);
  });

  test('at the maximum level the bar says so and offers no hint', async ({ page }) => {
    const menu = await openLive(page, state => { level(state, 1_000_000_000, 0); });
    await expect(menu.getByTestId('xp-block')).toContainText('Level 1,000,000,000');
    await expect(menu.getByTestId('xp-block')).toContainText('Max level');
    await expect(menu.getByTestId('xp-hint')).toHaveCount(0);
    await expect(menu.getByTestId('xp-ghost')).toHaveCount(0);
    expect(await share(menu.getByTestId('xp-fill'), bar(menu))).toBe(1);
    await expect(cornerChip(page).getByTestId('chip-xp-ghost')).toHaveCount(0);
  });
});

test.describe('help on stats and attributes (live)', () => {
  test.skip(production, 'Live UI uses the development-only intercepted Supabase transport.');

  test('the Attributes and Stats blocks list the build and explain each label by pointer, keyboard or tap', async ({ page }, info) => {
    const phone = info.project.name === 'mobile';
    if (phone) await page.setViewportSize({ width: 360, height: 740 });
    const menu = await openLive(page, state => { level(state, 1, 80); });
    const attributes = menu.getByRole('region', { name: 'Attributes', exact: true });
    const stats = menu.getByRole('region', { name: 'Stats', exact: true });
    await expect(attributes.getByRole('heading')).toHaveText('Attributes · 10 points');
    await expect(attributes.getByRole('button')).toHaveText(['Strength', 'Agility', 'Vitality', 'Endurance', 'Precision']);
    await expect(stats.getByRole('heading')).toHaveText('Stats');
    await expect(stats.getByRole('button')).toHaveText(['Health', 'Damage', 'Attack speed', 'Armor', 'Critical', 'Critical damage']);
    // A Guardian with 2 points in each and nothing worn: the stats are the rules' own (the profile card's functions).
    await expect(stats.getByRole('listitem').filter({ hasText: 'Health' })).toContainText('Health123');
    await expect(stats.getByRole('listitem').filter({ hasText: 'Armor' })).toContainText('None');
    await expect(stats.getByRole('listitem').filter({ hasText: 'Critical damage' })).toContainText('+50%');
    await expect(stats.getByTestId('arena-line')).toHaveCount(0);
    await expect(attributes.getByRole('listitem').filter({ hasText: 'Vitality' })).toContainText('+5%');
    const tip = menu.getByRole('tooltip');
    const health = stats.getByRole('button', { name: 'Health', exact: true });
    const agility = attributes.getByRole('button', { name: 'Agility', exact: true });
    await expect(tip).toHaveCount(0);
    if (phone) {
      await health.tap();
      await expect(tip).toContainText('Maximum health in combat. Vitality raises it.');
      await expect(tip).toContainText('Base 50, plus 10 for each Vitality.');
      await expect(health).toHaveAccessibleDescription(/Base 50, plus 10 for each Vitality\./);
      await expect(tip).toBeInViewport({ ratio: 1 });
      await agility.tap();
      await expect(tip).toHaveCount(1);
      await expect(tip).toContainText('Speeds up attacks and makes you harder to hit.');
      await expect(tip).toContainText('Each point speeds attacks by 1% and lowers enemies’ chance to hit you by 0.3%.');
      await shot(page, info, 'xp-help-phone');
      await agility.tap();
      await expect(tip).toHaveCount(0);
      await stats.getByRole('button', { name: 'Critical damage', exact: true }).tap();
      await expect(tip).toContainText('How much more a critical hit deals than a normal hit.');
      await expect(tip).toContainText('A critical hit deals 1.5 times the damage of a normal hit.');
      await stats.getByRole('button', { name: 'Critical damage', exact: true }).tap();
      await expect(tip).toHaveCount(0);
      expect(await noHorizontalScroll(page)).toBe(true);
    } else {
      await health.hover();
      await expect(tip).toHaveCount(1);
      await expect(tip).toContainText('Maximum health in combat. Vitality raises it.');
      await expect(tip).toContainText('Base 50, plus 10 for each Vitality.');
      await tip.hover();
      await expect(tip).toBeVisible();
      await menu.getByRole('heading', { name: 'Aster' }).hover();
      await expect(tip).toHaveCount(0);
      await attributes.getByRole('button', { name: 'Strength', exact: true }).focus();
      await page.keyboard.press('Tab');
      await expect(agility).toBeFocused();
      await expect(tip).toContainText('Speeds up attacks and makes you harder to hit.');
      await expect(agility).toHaveAccessibleDescription(/lowers enemies’ chance to hit you by 0\.3%/);
      await page.keyboard.press('Escape');
      await expect(tip).toHaveCount(0);
      await expect(menu).toBeVisible();
      // The exact sentences of the profile card, then the rules' numbers.
      await stats.getByRole('button', { name: 'Critical', exact: true }).hover();
      await expect(tip).toContainText('Chance for a landed hit to be a critical hit, which deals 50% more damage. Precision raises it.');
      await expect(tip).toContainText('Base 5%, plus 0.3% for each Precision, up to 40%.');
      await stats.getByRole('button', { name: 'Critical damage', exact: true }).hover();
      await expect(tip).toHaveCount(1);
      await expect(tip).toContainText('How much more a critical hit deals than a normal hit.');
      await expect(tip).toContainText('A critical hit deals 1.5 times the damage of a normal hit.');
      await shot(page, info, 'xp-help-desktop');
    }
  });

  // Patch 1.9 Task 13 (the approved crit-armour mockup): Aster in a shop Sword, Round shield and Light boots, and renown Iron helmet and Heavy armor.
  const WORN = ['sword:1:common', 'round-shield:1:common', 'light-boots:1:common', 'iron-helmet:1:renown', 'heavy-armor:1:renown'];
  const wear = (state: OwnerState, ids: string[]) => {
    state.inventory = ids.map(id => ({ ...itemFixture(CATALOG_V1.items[id]), id: randomUUID() }));
    const worn = Object.fromEntries(state.inventory.map((item, index) => [CATALOG_V1.items[ids[index]].slot, item.id]));
    state.currentBuild.equipment = { weapon: null, offHand: null, head: null, body: null, feet: null, ...worn };
    state.inventory.forEach(item => { item.reservation = { kind: 'equipment', referenceId: state.gladiatorId }; });
  };

  test('renown armor shows its Arena figures under Armor, with both contexts in the tooltip; a gold weapon shows none under Damage', async ({ page }, info) => {
    const phone = info.project.name === 'mobile';
    if (phone) await page.setViewportSize({ width: 360, height: 740 });
    const menu = await openLive(page, state => { level(state, 1, 0); wear(state, WORN); });
    const stats = menu.getByRole('region', { name: 'Stats', exact: true });
    const armor = stats.getByRole('listitem').filter({ hasText: 'Armor' });
    await expect(armor).toContainText('13 · blocks 26%');
    await expect(armor.getByTestId('arena-line')).toHaveText('Arena 13.9 · blocks 28%');
    await expect(stats.getByRole('listitem').filter({ hasText: /^Damage/ }).getByTestId('arena-line')).toHaveCount(0);
    await expect(stats.getByTestId('arena-line')).toHaveCount(1);
    // The sub-line is not a help button of its own.
    await expect(stats.getByRole('button')).toHaveText(['Health', 'Damage', 'Attack speed', 'Armor', 'Critical', 'Critical damage']);
    const tip = menu.getByRole('tooltip');
    const label = stats.getByRole('button', { name: 'Armor', exact: true });
    if (phone) await label.tap(); else await label.hover();
    await expect(tip).toContainText('Equipped armor reduces the damage you take from landed hits. Renown armor counts 10% more in the Arena.');
    await expect(tip).toContainText('Each armor point blocks 2% of a hit, up to 70%.');
    await expect(tip).toContainText('Expeditions and dungeons · 13 armor · blocks 26%');
    await expect(tip).toContainText('Arena and tournaments · 13.9 armor · blocks 28%');
    if (phone) expect(await noHorizontalScroll(page)).toBe(true);
    await shot(page, info, phone ? 'arena-armor-phone' : 'arena-armor-desktop');
  });

  test('a renown weapon adds the Arena line to Damage, and the tooltip names both figures', async ({ page }, info) => {
    const phone = info.project.name === 'mobile';
    if (phone) await page.setViewportSize({ width: 360, height: 740 });
    const menu = await openLive(page, state => { level(state, 1, 0); wear(state, ['sword:10:renown']); });
    const stats = menu.getByRole('region', { name: 'Stats', exact: true });
    const damage = stats.getByRole('listitem').filter({ hasText: /^Damage/ });
    const [, hit, arena] = (/^Damage(\d+)Arena (\d+)$/.exec((await damage.textContent())!) ?? []).map(Number);
    expect(arena).toBeGreaterThan(hit);
    await expect(stats.getByRole('listitem').filter({ hasText: 'Armor' })).toContainText('None');
    await expect(stats.getByRole('listitem').filter({ hasText: 'Armor' }).getByTestId('arena-line')).toHaveCount(0);
    const tip = menu.getByRole('tooltip');
    const label = stats.getByRole('button', { name: 'Damage', exact: true });
    if (phone) await label.tap(); else await label.hover();
    await expect(tip).toContainText('A renown weapon deals 10% more in the Arena.');
    await expect(tip).toContainText(`Expeditions and dungeons · ${hit}`);
    await expect(tip).toContainText(`Arena and tournaments · ${arena}`);
  });

  test('Stamina and Load have help too, and one tooltip is open at a time', async ({ page }, info) => {
    const phone = info.project.name === 'mobile';
    if (phone) await page.setViewportSize({ width: 360, height: 740 });
    const menu = await openLive(page, state => { level(state, 1, 0); });
    const tip = menu.getByRole('tooltip');
    const staminaButton = menu.getByRole('button', { name: 'Stamina', exact: true });
    const loadButton = menu.getByRole('button', { name: 'Load', exact: true });
    await loadButton.scrollIntoViewIfNeeded();
    await staminaButton.click();
    await expect(tip).toContainText('What your activities spend; resting gives it back. Endurance raises it.');
    await expect(tip).toContainText('Base 90, plus 2 for each Endurance.');
    await loadButton.click();
    await expect(tip).toHaveCount(1);
    await expect(tip).toContainText('How much your worn gear weighs against what you can carry.');
    await expect(tip).toContainText('Capacity is 10, plus 2 for each Endurance.');
    await expect(tip).toContainText('down to 50%');
    await expect(tip).toBeInViewport({ ratio: 1 });
    await page.keyboard.press('Escape');
    await expect(tip).toHaveCount(0);
    await expect(menu.getByRole('region', { name: 'Worn equipment' })).toContainText('Load 0 / 24.7');
    expect(await noHorizontalScroll(page)).toBe(true);
  });
});
