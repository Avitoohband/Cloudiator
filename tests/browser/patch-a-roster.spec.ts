// Patch A item 8: the number of players over the Gladiators list. The fixture preview's world has 50 public rows (6 away); the
// line says how many players there are and where they are now, "away" in the touch layout, and how many match a name typed
// in the filter. Zero matches keep the "No gladiator matches" line and no count.
import { expect, test } from './fixtures';
import { contrastIssues, noHorizontalScroll } from './a11y-helpers';
import { openMenu, touchLayout } from './shell-helpers';

const production = process.env.PLAYWRIGHT_STATIC === 'true';

test.describe('Patch A: the players count', () => {
  test.skip(production, 'The production export carries no fixture preview data.');

  test('counts the players over the Gladiators list, on a desktop, on a phone and with a filter', async ({ page }) => {
    await page.goto('/game/?mode=fixture');
    await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
    const roster = await openMenu(page, 'Gladiators');
    // `innerText` reads what is shown: the wide and the narrow form of the line are both in the page, one of them hidden.
    const count = page.getByTestId('players-count');
    const shown = () => count.evaluate(el => (el as HTMLElement).innerText);

    // Over the list, below the filter.
    await expect(count).toBeVisible();
    expect(await shown()).toMatch(/^50 players · \d+ in camp/);
    // The menu fades in: its colours are the ones it keeps once the opening animation has ended (as release.spec.ts).
    await roster.evaluate(el => Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished)));
    expect(await contrastIssues(count)).toEqual([]);
    const filterBox = (await roster.getByRole('searchbox', { name: 'Filter by name' }).boundingBox())!;
    const countBox = (await count.boundingBox())!;
    const listBox = (await roster.getByRole('list', { name: 'Gladiators' }).boundingBox())!;
    expect(countBox.y).toBeGreaterThanOrEqual(filterBox.y + filterBox.height);
    expect(countBox.y + countBox.height).toBeLessThanOrEqual(listBox.y);
    // The desktop says "on expeditions"; the touch layout (the mobile project, or a window under 481 px) says "away".
    if (!(await touchLayout(page))) {
      expect(await shown()).toMatch(/ · 6 on expeditions/);
      expect(await shown()).not.toContain('away');
    }

    // A phone: "away", not "on an expedition".
    await page.setViewportSize({ width: 390, height: 844 });
    await openMenu(page, 'Gladiators');
    await expect(count).toBeVisible();
    expect(await shown()).toMatch(/^50 players · \d+ in camp · 6 away/);
    expect(await shown()).not.toContain('on expedition');
    expect(await noHorizontalScroll(page)).toBe(true);

    // With a name in the filter it says how many match.
    const filter = (await openMenu(page, 'Gladiators')).getByRole('searchbox', { name: 'Filter by name' });
    await filter.fill('ar');
    await expect(count).toHaveText(/^\d+ of 50 players match “ar”$/);
    expect(await shown()).toMatch(/^\d+ of 50 players match “ar”$/);
    const matches = Number(/^(\d+) of/.exec(await shown())![1]);
    expect(matches).toBeGreaterThan(0);
    expect(await page.getByRole('list', { name: 'Gladiators' }).getByRole('listitem').count()).toBe(matches);

    // No match: today's line, and no count.
    await filter.fill('zzz');
    await expect(page.getByText('No gladiator matches “zzz”.')).toBeVisible();
    await expect(count).toHaveCount(0);

    // Clearing the filter brings the whole count back; at 360 × 740 nothing scrolls sideways and the line fits its panel.
    await filter.fill('');
    await page.setViewportSize({ width: 360, height: 740 });
    await openMenu(page, 'Gladiators');
    await expect(count).toBeVisible();
    expect(await shown()).toMatch(/^50 players · \d+ in camp · 6 away/);
    expect(await count.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await noHorizontalScroll(page)).toBe(true);
  });
});
