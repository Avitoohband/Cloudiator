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
    // Every row, in both parts of the list: the newcomers (in orientation) are listed first, under "New in camp", and once.
    expect(await (await openMenu(page, 'Gladiators')).getByRole('listitem').count()).toBe(matches);
    // And with a name that matches a newcomer ("Ursa", in orientation in the preview): she is counted once, in the first part.
    await filter.fill('urs');
    await expect(count).toHaveText(/^\d+ of 50 players match “urs”$/);
    const withNewcomer = Number(/^(\d+) of/.exec(await shown())![1]);
    expect(await page.getByRole('list', { name: 'New in camp' }).getByRole('listitem').count()).toBe(1);
    expect(await (await openMenu(page, 'Gladiators')).getByRole('listitem').count()).toBe(withNewcomer);

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

  // Patch 1.7 (spec "Where a title shows"): the title worn now, after the name (and "(you)"), in gold italic; a long one wraps under the name;
  // the filter matches names only. The fixture world wears the mockup's titles (Aster Founder, Atticus Pathfinder; Ilaria none).
  test('shows each gladiator’s worn title after the name in italic, wraps a long one on a phone and filters by name only', async ({ page }) => {
    await page.goto('/game/?mode=fixture');
    await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
    const roster = await openMenu(page, 'Gladiators');
    const rowOf = (name: string) => roster.getByRole('listitem').filter({ has: page.getByRole('button', { name: `Profile: ${name}`, exact: true }) });
    await expect(rowOf('Atticus')).toContainText('Atticus Pathfinder');
    await expect(rowOf('Aster').filter({ hasText: '(you)' })).toContainText('Aster (you) Founder');
    // The title is its own italic element, and it is the only title in Ilaria's row.
    const title = rowOf('Atticus').locator('em');
    await expect(title).toHaveText('Pathfinder');
    expect(await title.evaluate(el => getComputedStyle(el).fontStyle)).toBe('italic');
    await expect(rowOf('Ilaria').locator('em')).toHaveCount(0);
    await expect(rowOf('Ilaria')).not.toContainText(/Pathfinder|Founder|Tiro/);
    // The list shows the title's name only; the card's "Champion · Season 1 Silver" is the card's own words.
    await expect(roster.getByText('Champion ·')).toHaveCount(0);

    // The filter looks at names only: a title's name matches no row.
    const filter = roster.getByRole('searchbox', { name: 'Filter by name' });
    await filter.fill('path');
    await expect(page.getByText('No gladiator matches “path”.')).toBeVisible();
    await filter.fill('');

    // 360 × 740: "Lion of the Arena" stays whole in its row (under the name when it does not fit beside it), and nothing scrolls sideways.
    await page.setViewportSize({ width: 360, height: 740 });
    const phone = await openMenu(page, 'Gladiators');
    const lionRow = phone.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Profile: Octavia', exact: true }) }).first();
    await lionRow.scrollIntoViewIfNeeded();
    const lion = lionRow.locator('em');
    await expect(lion).toHaveText('Lion of the Arena');
    const name = (await lionRow.getByRole('button', { name: 'Profile: Octavia', exact: true }).boundingBox())!;
    const wrapped = (await lion.boundingBox())!;
    // Beside the name when it fits, else under it; never over it, and never cut or past the row.
    expect(wrapped.y >= name.y + name.height - 1 || wrapped.x >= name.x + name.width - 1).toBe(true);
    expect(wrapped.height).toBeLessThan(2 * 16 * 1.6);
    const list = (await lionRow.boundingBox())!;
    expect(wrapped.x + wrapped.width).toBeLessThanOrEqual(list.x + list.width);
    expect(await noHorizontalScroll(page)).toBe(true);
  });
});
