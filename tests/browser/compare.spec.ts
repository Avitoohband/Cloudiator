import { mkdirSync } from 'node:fs';
import { CATALOG_V1 } from '../../supabase/functions/_shared/domain/catalog-v1';
import { expect, test, type BrowserContext, type Locator, type Page, type TestInfo } from './fixtures';
import type { OwnerState, PublicActor, WorldSnapshot } from '../../supabase/functions/_shared/contracts/reads';
import { ownerFixture, worldFixture } from '../fixtures/domain';
import { noHorizontalScroll } from './a11y-helpers';
import { emptyWorld, routeLiveReads, seedSession } from './live-routes';
import { creationDialog, expectOwnerShown, openMenu, quietArrivals, touchLayout, pageTo } from './shell-helpers';

// Patch 1.9 Task 23c (Avi, 2026-11-12: "add an option to compare stats with my gladiator and other gladiators in the camp"; the approved mockup
// `.superpowers/design/2026-11-12-compare-stats/`): "⇄ Compare with mine" in another gladiator's card, after Follow, for a player with a gladiator.
// On, the card's Attributes, Stats, Gear and Record give way to one table (Stat | You | <Name>) whose marks sit on your cell. The fixture preview's
// viewer is Aster (level 1 Guardian, balanced, 2 points in each attribute, nothing worn); Lucilla is level 6 (4/0/10/4/2); Ardea a level 1 Duelist (2/4/0/0/4).
const production = process.env.PLAYWRIGHT_STATIC === 'true';
/** The SDD workspace, when the run should save the review screenshots there. */
const shotDir = process.env.COMPARE_SHOT_DIR;
const MINUS = '−';

const profileCard = (page: Page, name: string) => page.getByRole('dialog', { name: `Profile: ${name}`, exact: true });
const compareButton = (card: Locator) => card.getByRole('button', { name: 'Compare with mine', exact: true });
const block = (card: Locator) => card.getByTestId('compare');
const statsTable = (card: Locator) => card.getByTestId('compare-stats');
const attributesTable = (card: Locator) => card.getByTestId('compare-attributes');
/** The fixture camp, ready. */
async function openCamp(page: Page, url = '/game/?mode=fixture') {
  await page.goto(url);
  await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
}
/** A gladiator's card from the Gladiators list. */
async function openCard(page: Page, name: string): Promise<Locator> {
  const roster = await openMenu(page, 'Gladiators');
  const row = roster.getByRole('button', { name: `Profile: ${name}`, exact: true }).first();
  await pageTo(roster, row);
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await expect(profileCard(page, name)).toBeVisible();
  return profileCard(page, name);
}
const actionTexts = (card: Locator) => card.locator('[data-card-actions] button').evaluateAll(nodes => nodes.map(node => node.textContent ?? ''));
/** A table's rows as `label | you | them` text (the marks are read separately). */
const rowsOf = (table: Locator) => table.locator('tbody tr').evaluateAll(rows => rows.map(row => [...row.children].map(cell => (cell.textContent ?? '').replace(/\s+/g, ' ').trim())));
/** The mark text of a row's "You" cell: what the eye sees (arrow, sign, number), and its tone. */
const markOf = async (table: Locator, label: string) => {
  const marks = table.locator('tbody tr').filter({ has: table.page().getByRole('rowheader', { name: label, exact: true }) }).locator('[data-mark]');
  const found = await marks.evaluateAll(nodes => nodes.map(node => ({ text: node.querySelector('[aria-hidden="true"]')?.textContent ?? null, tone: node.getAttribute('data-mark'), spoken: node.textContent })));
  return { count: found.length, text: found[0]?.text ?? null, tone: found[0]?.tone ?? null, spoken: found[0]?.spoken ?? null };
};
async function shot(page: Page, info: TestInfo, name: string) {
  if (!shotDir) return;
  mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: `${shotDir}/task-23c-${name}-${info.project.name === 'mobile' ? 'phone' : 'desktop'}.png` });
}

test.describe('Compare stats with mine (fixture)', () => {
  test.skip(production, 'The camp harness runs on the fixture preview only.');
  test.beforeEach(async ({ context }) => { await quietArrivals(context); });

  test('a player sees ⇄ Compare with mine after Follow on another gladiator\'s card, not pressed; Spar a copy follows it', async ({ page }, info) => {
    await openCamp(page);
    const lucilla = await openCard(page, 'Lucilla');
    await expect(lucilla.getByRole('region', { name: 'Stats', exact: true })).toContainText('Health');
    const button = compareButton(lucilla);
    await expect(button).toHaveText('⇄ Compare with mine');
    await expect(button).toBeEnabled();
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    const actions = await actionTexts(lucilla);
    expect(actions.indexOf('⇄ Compare with mine')).toBe(actions.indexOf('Follow') + 1);
    expect(actions.indexOf('⚔ Spar a copy')).toBe(actions.indexOf('⇄ Compare with mine') + 1);
    await expect(block(lucilla)).toHaveCount(0);
    await shot(page, info, 'compare-closed');
  });

  test('your own card has no Compare button, and a visitor is offered none', async ({ page }) => {
    await openCamp(page);
    const aster = await openCard(page, 'Aster');
    await expect(aster.getByRole('button', { name: 'Follow', exact: true })).toBeVisible();
    await expect(compareButton(aster)).toHaveCount(0);

    await openCamp(page, '/game/?mode=fixture&as=visitor');
    const lucilla = await openCard(page, 'Lucilla');
    await expect(lucilla.getByRole('region', { name: 'Stats', exact: true })).toContainText('Health');
    await expect(lucilla.getByRole('button', { name: 'Follow', exact: true })).toBeVisible();
    await expect(compareButton(lucilla)).toHaveCount(0);
  });

  test('on: Lucilla\'s card shows COMPARE · YOU AND LUCILLA, the table in the card\'s own words, and Gear and Record give way', async ({ page }, info) => {
    await openCamp(page);
    const lucilla = await openCard(page, 'Lucilla');
    // Final review (client minor, fix round 1): one live region is in the card before the toggle, empty, so its sentence is announced.
    const status = lucilla.locator('[data-compare-status]');
    await expect(status).toHaveCount(1);
    await expect(status).toHaveAttribute('role', 'status');
    await expect(status).toHaveText('');
    await compareButton(lucilla).click();
    await expect(compareButton(lucilla)).toHaveAttribute('aria-pressed', 'true');
    const compare = block(lucilla);
    await expect(compare).toBeVisible();
    await expect(compare.locator('.eyebrow').first()).toHaveText('COMPARE · YOU AND LUCILLA');
    await expect(compare.getByRole('button', { name: 'Back to their card', exact: true })).toBeVisible();
    await expect(status).toHaveText('Showing a comparison of your gladiator with Lucilla.');
    await expect(lucilla.getByRole('status').filter({ hasText: 'Showing a comparison' })).toHaveCount(1);
    for (const gone of ['Gear', 'Record', 'Stats']) await expect(lucilla.getByRole('region', { name: gone, exact: true })).toHaveCount(0);
    // The head and the actions stay.
    await expect(lucilla.getByRole('heading', { name: 'Lucilla', exact: true })).toBeVisible();
    await expect(lucilla.getByRole('button', { name: 'Follow', exact: true })).toBeVisible();
    await expect(lucilla.getByRole('button', { name: 'Spar a copy', exact: true })).toBeVisible();

    const heads = await statsTable(lucilla).locator('thead th').allTextContents();
    expect(heads.map(text => text.replace(/\s+/g, ' ').trim())).toEqual(['Stat', 'YouBalanced stance', 'LucillaBalanced stance']);
    const rows = await rowsOf(statsTable(lucilla));
    expect(rows.map(row => row[0])).toEqual(['Level', 'Health', 'Damage', 'Attack speed', 'Armor', 'Critical', 'Critical damage']);
    const them = (label: string) => rows.find(row => row[0] === label)![2];
    expect([them('Level'), them('Health'), them('Damage'), them('Attack speed'), them('Armor'), them('Critical'), them('Critical damage')])
      .toEqual(['6', '207', '12', 'every 1.14 s', '9 · blocks 18%', '7% of hits', '+50%']);
    expect(rows.find(row => row[0] === 'Armor')![1]).toContain('None');
    expect(rows.find(row => row[0] === 'Attack speed')![1]).toContain('every 0.94 s');

    // The marks sit on your cell: Level neutral, the rest better or worse; Critical and Critical damage are equal.
    expect(await markOf(statsTable(lucilla), 'Level')).toMatchObject({ count: 1, text: `(${MINUS}5)`, tone: 'neutral' });
    expect(await markOf(statsTable(lucilla), 'Health')).toMatchObject({ text: `▼ ${MINUS}84`, tone: 'worse' });
    expect(await markOf(statsTable(lucilla), 'Damage')).toMatchObject({ text: `▼ ${MINUS}8`, tone: 'worse' });
    expect(await markOf(statsTable(lucilla), 'Armor')).toMatchObject({ text: `▼ ${MINUS}9`, tone: 'worse' });
    expect(await markOf(statsTable(lucilla), 'Critical')).toMatchObject({ text: 'same', tone: 'same' });
    expect(await markOf(statsTable(lucilla), 'Critical damage')).toMatchObject({ text: 'same', tone: 'same' });
    // Attack speed: lower is better, so her slower 1.14 s makes your 0.94 s the better one.
    expect(await markOf(statsTable(lucilla), 'Attack speed')).toMatchObject({ text: `▲ ${MINUS}0.20 s`, tone: 'better' });
    // Colour is never the only signal: the sentence is for a screen reader.
    expect((await markOf(statsTable(lucilla), 'Health')).spoken).toContain('worse by 84');
    expect((await markOf(statsTable(lucilla), 'Attack speed')).spoken).toContain('better by 0.2 seconds');
    // Nothing is marked in their column.
    await expect(statsTable(lucilla).locator('td:nth-child(3) [data-mark]')).toHaveCount(0);

    await expect(compare.locator('.eyebrow').nth(1)).toHaveText('ATTRIBUTES · 10 AND 20 POINTS');
    const attributes = await rowsOf(attributesTable(lucilla));
    expect(attributes.map(row => [row[0], row[2]])).toEqual([['Strength', '4'], ['Agility', '0'], ['Vitality', '10'], ['Endurance', '4'], ['Precision', '2']]);
    expect(await markOf(attributesTable(lucilla), 'Strength')).toMatchObject({ text: `▼ ${MINUS}2`, tone: 'worse' });
    expect(await markOf(attributesTable(lucilla), 'Agility')).toMatchObject({ text: '▲ +2', tone: 'better' });
    expect(await markOf(attributesTable(lucilla), 'Precision')).toMatchObject({ text: 'same', tone: 'same' });
    // The stances are equal, so no Stance row.
    await expect(compare.getByRole('rowheader', { name: 'Stance', exact: true })).toHaveCount(0);
    await shot(page, info, 'compare');
  });

  test('a mixed comparison: Ardea is better in some stats and worse in others, and her level equals yours', async ({ page }, info) => {
    await openCamp(page);
    const ardea = await openCard(page, 'Ardea');
    await compareButton(ardea).click();
    const table = statsTable(ardea);
    await expect(block(ardea).locator('.eyebrow').first()).toHaveText('COMPARE · YOU AND ARDEA');
    // Level 1 against level 1: no difference to show.
    expect(await markOf(table, 'Level')).toMatchObject({ count: 0 });
    expect(await markOf(table, 'Health')).toMatchObject({ text: '▲ +23', tone: 'better' });
    expect(await markOf(table, 'Damage')).toMatchObject({ text: `▼ ${MINUS}6`, tone: 'worse' });
    // Her 0.91 s beats your 0.94 s: for you a higher time is the worse one.
    expect(await markOf(table, 'Attack speed')).toMatchObject({ text: '▼ +0.03 s', tone: 'worse' });
    expect(await markOf(table, 'Armor')).toMatchObject({ text: `▼ ${MINUS}3`, tone: 'worse' });
    expect(await markOf(table, 'Critical')).toMatchObject({ text: `▼ ${MINUS}1%`, tone: 'worse' });
    expect(await markOf(attributesTable(ardea), 'Vitality')).toMatchObject({ text: '▲ +2', tone: 'better' });
    expect(await markOf(attributesTable(ardea), 'Strength')).toMatchObject({ text: 'same', tone: 'same' });
    await shot(page, info, 'compare-ardea');
  });

  test('Compare stays on while other cards open, and Back to their card (or the button) turns it off and returns the focus', async ({ page }) => {
    await openCamp(page);
    const lucilla = await openCard(page, 'Lucilla');
    await compareButton(lucilla).click();
    await expect(block(lucilla)).toBeVisible();
    await lucilla.getByRole('button', { name: 'Close profile', exact: true }).click();
    await expect(lucilla).toHaveCount(0);

    // The state is the shell's: the next card opens already comparing (and a card of your own shows nothing).
    const ardea = await openCard(page, 'Ardea');
    await expect(block(ardea)).toBeVisible();
    await expect(compareButton(ardea)).toHaveAttribute('aria-pressed', 'true');
    await expect(block(ardea).locator('.eyebrow').first()).toHaveText('COMPARE · YOU AND ARDEA');
    await ardea.getByRole('button', { name: 'Close profile', exact: true }).click();
    const aster = await openCard(page, 'Aster');
    await expect(block(aster)).toHaveCount(0);
    await expect(aster.getByRole('region', { name: 'Stats', exact: true })).toContainText('Health');
    await aster.getByRole('button', { name: 'Close profile', exact: true }).click();

    // Back to their card: Gear and Record return, the button is not pressed, and the focus is on it.
    const again = await openCard(page, 'Lucilla');
    await again.getByRole('button', { name: 'Back to their card', exact: true }).click();
    await expect(block(again)).toHaveCount(0);
    for (const back of ['Attributes', 'Stats', 'Gear', 'Record']) await expect(again.getByRole('region', { name: back, exact: true })).toBeVisible();
    await expect(compareButton(again)).toHaveAttribute('aria-pressed', 'false');
    await expect(compareButton(again)).toBeFocused();
    // The next card opens off too, and the button turns it on and off again from the keyboard.
    await compareButton(again).press('Enter');
    await expect(block(again)).toBeVisible();
    await expect(again.locator('[data-compare-status]')).toHaveText('Showing a comparison of your gladiator with Lucilla.');
    await compareButton(again).press('Space');
    await expect(block(again)).toHaveCount(0);
    // Off: the live region stays, emptied (fix round 1).
    await expect(again.locator('[data-compare-status]')).toHaveText('');
  });

  test('a card whose build is not available keeps its words and the button is disabled', async ({ page }) => {
    await openCamp(page);
    const xanthe = await openCard(page, 'Xanthe');
    await expect(xanthe.getByRole('region', { name: 'Stats', exact: true })).toContainText('Not available');
    await expect(compareButton(xanthe)).toBeDisabled();
    await expect(block(xanthe)).toHaveCount(0);
  });

  test('desktop: the compare card stays inside a 1280 x 720 window (644 px at most); at 360 px nothing scrolls sideways', async ({ page }, info) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await openCamp(page);
    const touch = await touchLayout(page);
    const lucilla = await openCard(page, 'Lucilla');
    await compareButton(lucilla).click();
    await expect(block(lucilla)).toBeVisible();
    if (!touch) {
      const box = (await lucilla.boundingBox())!;
      expect(box.height).toBeLessThanOrEqual(644);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(720);
    }

    await page.setViewportSize({ width: 360, height: 740 });
    await page.waitForTimeout(400);
    await expect(block(lucilla)).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
    const body = lucilla.getByTestId('profile-body');
    const fits = await body.evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }));
    expect(fits.scroll).toBeLessThanOrEqual(fits.client);
    const table = (await statsTable(lucilla).boundingBox())!;
    const card = (await lucilla.boundingBox())!;
    expect(table.x).toBeGreaterThanOrEqual(card.x);
    expect(table.x + table.width).toBeLessThanOrEqual(card.x + card.width);
    // The compact head: the table starts on the first screen, and the actions stay at the foot.
    await expect(lucilla.getByRole('heading', { name: 'Lucilla', exact: true })).toBeVisible();
    await expect(lucilla.getByRole('button', { name: 'Follow', exact: true })).toBeVisible();
    await expect(lucilla.getByRole('button', { name: 'Back to their card', exact: true })).toBeVisible();
    await shot(page, info, 'compare-360');
    // Each tap target is at least 44 px tall on a touch sheet.
    if (await touchLayout(page)) for (const button of await lucilla.locator('[data-card-actions] button').all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });
});

// ---- Live: an account with no gladiator, a card still loading, and renown gear's Arena lines ---------------------------------------------------

test.describe('Compare stats in the live camp', () => {
  test.skip(production, 'Live UI uses the development-only intercepted Supabase transport.');

  type Build = { stance: string; allocations: Record<string, number>; equipment: Record<string, unknown> };
  const NONE = { weapon: null, offHand: null, head: null, body: null, feet: null };
  const BASIC: Build = { stance: 'balanced', allocations: { strength: 2, agility: 2, vitality: 2, endurance: 2, precision: 2 }, equipment: NONE };
  /** A camp with Aster (read live) and Lucilla, whose build is `lucillaBuild`; `owner` null is an account with no gladiator. */
  async function live(context: BrowserContext, { owner, lucillaBuild = BASIC }: { owner: OwnerState | null; lucillaBuild?: Build }) {
    await seedSession(context);
    await quietArrivals(context);
    const aster: PublicActor = worldFixture.actors[0];
    const lucilla: PublicActor = { ...worldFixture.actors[0], gladiatorId: '6c1f0d2e-0000-4000-8000-00000000c0de', name: 'Lucilla', classId: 'duelist', level: 3, location: 'training' };
    const world: WorldSnapshot = { ...emptyWorld(worldFixture.serverNowMs), revision: 'compare-live-1', actors: [aster, lucilla] };
    const profiles = Object.fromEntries([[aster, BASIC], [lucilla, lucillaBuild]].map(([actor, build]) => [(actor as PublicActor).gladiatorId,
      { actor, combatStrength: null, rating: 1000, prestige: [], build }]));
    await routeLiveReads(context, { world, owner, profiles: profiles as never, serverNowMs: () => worldFixture.serverNowMs });
  }

  test('an account with no gladiator is offered no Compare', async ({ page, context }) => {
    await live(context, { owner: null });
    await page.goto('/game/');
    await expect(creationDialog(page)).toBeVisible({ timeout: 45_000 });
    await creationDialog(page).getByRole('button', { name: 'Not now', exact: true }).click();
    const lucilla = await openCard(page, 'Lucilla');
    await expect(lucilla.getByRole('region', { name: 'Stats', exact: true })).toContainText('Health');
    await expect(compareButton(lucilla)).toHaveCount(0);
  });

  test('a card still loading offers Compare disabled until its build arrives', async ({ page, context }) => {
    await live(context, { owner: structuredClone(ownerFixture) });
    let release!: () => void;
    const loaded = new Promise<void>(resolve => { release = resolve; });
    await page.route(/\/rest\/v1\/public_profile_reads/, async route => { await loaded; await route.fallback(); });
    await page.goto('/game/');
    await expectOwnerShown(page, 'Aster');
    const lucilla = await openCard(page, 'Lucilla');
    await expect(lucilla.getByRole('region', { name: 'Stats', exact: true })).toContainText('Loading…');
    await expect(compareButton(lucilla)).toBeDisabled();
    release();
    await expect(lucilla.getByRole('region', { name: 'Stats', exact: true })).toContainText('Health');
    await expect(compareButton(lucilla)).toBeEnabled();
  });

  test('renown gear keeps the card\'s Arena sub-line in the cell, and the marks use the expedition figures', async ({ page, context }, info) => {
    const sword = CATALOG_V1.items['sword:5:uncommon'];
    const renownSword = { catalogId: 'sword:5:uncommon:renown', catalogVersion: 'v1', tier: sword.tier, rarity: sword.rarity, stats: structuredClone(sword.stats) };
    await live(context, { owner: structuredClone(ownerFixture), lucillaBuild: { ...BASIC, stance: 'offensive', equipment: { ...NONE, weapon: renownSword } } });
    await page.goto('/game/');
    await expectOwnerShown(page, 'Aster');
    const lucilla = await openCard(page, 'Lucilla');
    await expect(lucilla.getByRole('region', { name: 'Stats', exact: true })).toContainText('Arena');
    const card = await lucilla.getByRole('region', { name: 'Stats', exact: true }).getByTestId('arena-line').first().textContent();
    await compareButton(lucilla).click();
    // Her Damage cell keeps its Arena line; yours has none; the stances differ, so a Stance row says so.
    const damage = statsTable(lucilla).locator('tbody tr').filter({ has: page.getByRole('rowheader', { name: 'Damage', exact: true }) });
    await expect(damage.locator('td').nth(1).getByTestId('arena-line')).toHaveText(card!.trim());
    await expect(damage.locator('td').nth(0).getByTestId('arena-line')).toHaveCount(0);
    expect(await rowsOf(statsTable(lucilla))).toContainEqual(['Stance', 'Balanced', 'Offensive']);
    await expect(statsTable(lucilla).locator('thead')).toContainText('Offensive stance');
    // One mark, on the expedition figure: there is no second set of arrows.
    await expect(damage.locator('[data-mark]')).toHaveCount(1);
    await expect(damage.locator('[data-mark]')).not.toContainText('Arena');
    await shot(page, info, 'compare-arena-lines');
  });
});
