import { expect, test, type Page, type TestInfo } from './fixtures';
import { contrastIssues, expectNamedControls, noHorizontalScroll } from './a11y-helpers';
import { reviewShot } from './review-shots';
import { openMenu, quietArrivals, touchLayout } from './shell-helpers';

// Task 11c (Patch A spec, "A richer profile card"; Avi approved the mockup, 2026-10-29): the card a gladiator's name opens, filled in
// sections: the look, the class chips, the attributes, the stats, the gear and the record. The fixture preview's profiles carry sample
// builds (tests/fixtures/profile-cards.ts); the crowd has no profile, so its card says what is not available.
const production = process.env.PLAYWRIGHT_STATIC === 'true';
/** Words that only an owner's private state holds; no card shows them. */
const PRIVATE = /Stamina|Gold|Money|Renown|Inventory|wallet|combat strength/i;
const card = (page: Page, name: string) => page.getByRole('dialog', { name: `Profile: ${name}`, exact: true });
const section = (page: Page, name: string, label: string) => card(page, name).getByRole('region', { name: label, exact: true });

async function openCamp(page: Page) {
  await quietArrivals(page.context());
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/game/?mode=fixture');
  await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
}
async function openFromList(page: Page, name: string) {
  const roster = await openMenu(page, 'Gladiators');
  const row = roster.getByRole('button', { name: `Profile: ${name}`, exact: true }).first();
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await expect(card(page, name)).toBeVisible();
  return card(page, name);
}
const shot = (page: Page, testInfo: TestInfo, name: string) => reviewShot(page, testInfo, `card-${name}`);

test.describe('the richer profile card', () => {
  test.skip(production, 'These checks use the fixture preview.');

  test('opens the full card from a name in the Gladiators list, on a desktop', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCamp(page);
    const lucilla = await openFromList(page, 'Lucilla');
    await expect(section(page, 'Lucilla', 'Stats')).toContainText('Health');
    // A pointer window: 520 px beside the menus. (The mobile project has no hover, so its card is the touch sheet, checked below.)
    const box = (await lucilla.boundingBox())!;
    if (!(await touchLayout(page))) {
      expect(Math.round(box.width)).toBe(520);
      expect(Math.round(box.x)).toBe(458);
      expect(Math.round(box.y)).toBe(64);
      expect(box.y + box.height).toBeLessThan(900);
    } else {
      // A wide touch screen: the sheet keeps the card's 520 px, centred (fix round).
      expect(Math.round(box.width)).toBe(520);
      expect(Math.abs(box.x + box.width / 2 - 720)).toBeLessThanOrEqual(1);
    }
    expect(await lucilla.getByTestId('profile-look').locator('[data-layer]').count()).toBeGreaterThanOrEqual(3);
    await expect(lucilla.getByTestId('profile-look')).toHaveAttribute('aria-hidden', 'true');
    for (const label of ['Attributes', 'Stats', 'Gear', 'Record']) await expect(section(page, 'Lucilla', label)).toBeVisible();
    await expect(section(page, 'Lucilla', 'Stats').getByRole('term')).toHaveText(['Health', 'Damage', 'Speed', 'Armor', 'Critical']);
    // Avi, 2026-11-04: Damage is a number, as Health is.
    await expect(section(page, 'Lucilla', 'Stats').getByRole('definition').nth(1)).toHaveText(/^\d+$/);
    // Patch 1.6: Lucilla owns no Arena banner, so her card has no banner pill.
    await expect(lucilla.getByText('Arena banner')).toHaveCount(0);
    await expect(section(page, 'Lucilla', 'Gear')).toContainText('Spear · Level 1 · common');
    await expect(section(page, 'Lucilla', 'Gear')).toContainText('Two-handed weapon');
    const record = section(page, 'Lucilla', 'Record');
    await expect(record).toContainText(/Arena record\s*7–4 · all seasons/);
    // Made 6 days (her level) before the fixture's clock: the card's minute clock follows the synced display clock.
    await expect(record).toContainText(/In camp since\s*\d+ \w+ · 6 days/);
    await expect(lucilla).not.toContainText(PRIVATE);
    await expect(lucilla.getByTestId('class-bonus')).toHaveText(['Vitality +5%', 'Endurance +5%']);
    await expectNamedControls(lucilla, 'the profile card');
    expect(await contrastIssues(lucilla), 'the profile card').toEqual([]);
    await shot(page, testInfo, 'lucilla');
  });

  test('adds the season record from a standings row', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCamp(page);
    const arena = await openMenu(page, 'Arena');
    const table = arena.getByRole('table', { name: 'Bronze league standings' });
    const row = table.getByRole('row', { name: /Cassia/ });
    const season = (await row.locator('td').nth(2).textContent())!.trim();
    await row.getByRole('button', { name: 'Profile: Cassia', exact: true }).click();
    const cassia = card(page, 'Cassia');
    await expect(section(page, 'Cassia', 'Record')).toContainText(new RegExp(`This season\\s*${season}`));
    await expect(cassia).not.toContainText('Rating · record');
    await shot(page, testInfo, 'cassia-season');
  });

  test('shows your own card as others see it', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCamp(page);
    const roster = await openMenu(page, 'Gladiators');
    const own = roster.getByRole('button', { name: 'Profile: Aster', exact: true }).filter({ hasText: '(you)' });
    await (own.or(roster.getByRole('button', { name: 'Profile: Aster', exact: true }))).first().click();
    const aster = card(page, 'Aster');
    await expect(aster).toContainText('YOUR GLADIATOR');
    await expect(section(page, 'Aster', 'Gear')).toContainText('Nothing worn yet.');
    await expect(aster).toContainText('Other players see this card too.');
    await expect(aster.getByRole('button', { name: 'My gladiator', exact: true })).toBeVisible();
    await expect(aster.getByRole('button', { name: 'Schedule', exact: true })).toBeVisible();
    await expect(aster).not.toContainText(PRIVATE);
    // Patch 1.6 (spec "The Arena banner"): Aster owns the banner, so her card shows the pill after the name line, its flag decorative.
    const pill = aster.locator('p').filter({ hasText: 'Arena banner' });
    await expect(pill).toHaveText('🚩 Arena banner');
    await expect(pill.locator('[aria-hidden="true"]')).toHaveText('🚩');
    expect(await aster.evaluate(el => {
      const name = el.querySelector('h2')!, banner = [...el.querySelectorAll('p')].find(p => p.textContent?.includes('Arena banner'))!;
      return name.nextElementSibling === banner;
    }), 'the pill right after the name').toBe(true);
    await shot(page, testInfo, 'own');
    await aster.screenshot({ path: `.superpowers/sdd/2026-10-30-economy-1-6/task-9-shots/profile-banner-${testInfo.project.name}.png` });
    await page.setViewportSize({ width: 360, height: 740 });
    await expect(pill).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
    await page.screenshot({ path: `.superpowers/sdd/2026-10-30-economy-1-6/task-9-shots/profile-banner-${testInfo.project.name}-360.png` });
  });

  test('says Not available without a profile', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCamp(page);
    const xanthe = await openFromList(page, 'Xanthe');
    await expect(xanthe.getByTestId('profile-look')).toBeVisible();
    await expect(section(page, 'Xanthe', 'Attributes')).toContainText('Not available');
    await expect(section(page, 'Xanthe', 'Stats')).toContainText('Not available');
    await expect(section(page, 'Xanthe', 'Record')).toContainText(/Rating\s*Not available/);
    await expect(section(page, 'Xanthe', 'Gear')).toContainText(/Equipped\s*\S/);
    await shot(page, testInfo, 'xanthe');
  });

  test('a narrow pointer window keeps the card and its × on screen', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'A pointer window (the mobile project has no hover).');
    await page.setViewportSize({ width: 540, height: 800 });
    await openCamp(page);
    expect(await touchLayout(page)).toBe(false);
    const lucilla = await openFromList(page, 'Lucilla');
    await expect(section(page, 'Lucilla', 'Stats')).toContainText('Health');
    const box = (await lucilla.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(540 - 12);
    await expect(lucilla.getByRole('button', { name: 'Close profile' })).toBeInViewport({ ratio: 1 });
    expect(await noHorizontalScroll(page)).toBe(true);
    await expect(section(page, 'Lucilla', 'Record')).toContainText(/In camp since\s*\d+ \w+ · 6 days/);
    await shot(page, testInfo, 'lucilla-540');
  });

  test('phone 360 × 740: the sheet scrolls and keeps Follow in reach', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await openCamp(page);
    expect(await touchLayout(page)).toBe(true);
    const lucilla = await openFromList(page, 'Lucilla');
    await expect(section(page, 'Lucilla', 'Stats')).toContainText('Health');
    const box = (await lucilla.boundingBox())!;
    expect(Math.round(box.x)).toBe(10);
    expect(Math.round(box.x + box.width)).toBe(350);
    expect(Math.round(box.y + box.height)).toBe(664);
    expect(box.height).toBeLessThanOrEqual(600);
    const body = lucilla.getByTestId('profile-body');
    expect(await body.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    const follow = lucilla.getByRole('button', { name: 'Follow', exact: true });
    await expect(follow).toBeInViewport();
    expect((await follow.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await lucilla.getByRole('button', { name: 'Close profile' }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await noHorizontalScroll(page)).toBe(true);
    await expect(section(page, 'Lucilla', 'Record')).toContainText(/In camp since\s*\d+ \w+ · 6 days/);
    await shot(page, testInfo, 'lucilla-360');
    await body.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect(lucilla.getByText('In camp since', { exact: true })).toBeInViewport();
    await expect(follow).toBeInViewport();
    await shot(page, testInfo, 'lucilla-360-end');
  });
});
