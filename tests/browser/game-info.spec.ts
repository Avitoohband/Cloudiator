import { PATCH } from '../../src/lib/patch';
import { ownerFixture, worldFixture } from '../fixtures/domain';
import { expect, test } from './fixtures';
import { routeLiveReads, seedSession } from './live-routes';
import { cornerChip, expectOwnerShown, quietArrivals } from './shell-helpers';

test('visitors can read Game Info and switch tabs with the keyboard', async ({ page }) => {
  await page.goto('/game/');
  const trigger = cornerChip(page).getByRole('button', { name: 'Game Info', exact: true });
  await expect(trigger).toBeVisible();
  await trigger.click();

  const panel = page.getByRole('dialog', { name: 'Game Info' });
  const wiki = panel.getByRole('tab', { name: 'Wiki' });
  const future = panel.getByRole('tab', { name: 'Future Updates' });
  await expect(wiki).toBeFocused();
  const article = panel.getByRole('article', { name: 'Combat' });
  await expect(article).toContainText('Precision');
  await expect(panel.getByText('In planning')).toHaveCount(2);

  const copy = (element: Element) => element.dispatchEvent(new Event('copy', { bubbles: true, cancelable: true }));
  await expect(article).toHaveCSS('user-select', 'none');
  expect(await article.evaluate(copy)).toBe(false);
  expect(await wiki.evaluate(copy)).toBe(true);

  await wiki.press('ArrowRight');
  await expect(future).toBeFocused();
  await expect(future).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByRole('tabpanel', { name: 'Future Updates' })).toContainText('Dungeon party invitations');
  await expect(article).toBeHidden();

  await future.press('Escape');
  await expect(panel).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('signed-in fixture players can open Game Info beside their account controls', async ({ page }) => {
  test.skip(process.env.PLAYWRIGHT_STATIC === 'true', 'The signed-in fixture is only used for this development check.');
  await page.goto('/game/?mode=fixture');
  const chip = cornerChip(page);
  await expect(chip.getByTestId('chip-name')).toBeVisible();
  await chip.getByRole('button', { name: 'Game Info', exact: true }).click();

  const panel = page.getByRole('dialog', { name: 'Game Info' });
  await panel.getByRole('button', { name: 'Dungeons', exact: true }).click();
  await expect(panel.getByRole('article', { name: 'Dungeons' })).toContainText('Wolf Den');
  await panel.getByRole('button', { name: 'Close Game Info' }).click();
  await expect(chip.getByRole('button', { name: 'Game Info', exact: true })).toBeFocused();
});

test('a newer patch still offers Reload to visitors with Game Info open', async ({ page }) => {
  test.skip(process.env.PLAYWRIGHT_STATIC === 'true', 'The patch change uses the development-only intercepted transport.');
  await quietArrivals(page.context());
  const live = await routeLiveReads(page.context(), { world: worldFixture, latestPatch: PATCH });
  await page.goto('/game/');
  await page.waitForFunction(revision => window.__cloudiatorCamp?.world()?.revision === revision, worldFixture.revision);
  await cornerChip(page).getByRole('button', { name: 'Game Info', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Game Info' });
  await expect(panel.getByRole('button', { name: 'Reload', exact: true })).toHaveCount(0);

  const newerPatch = `${Number(PATCH.split('.')[0]) + 1}.0`;
  live.setLatestPatch(newerPatch);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(panel.getByRole('status')).toContainText(`Patch ${newerPatch} is out`);
  await expect(panel.getByRole('button', { name: 'Reload', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reload', exact: true })).toHaveCount(1);
});

test('a short phone can scroll the full reader below wrapped signed-in controls', async ({ page }) => {
  test.skip(process.env.PLAYWRIGHT_STATIC === 'true', 'The long signed-in name uses the development-only intercepted transport.');
  await page.setViewportSize({ width: 360, height: 300 });
  await seedSession(page.context());
  await quietArrivals(page.context());
  const name = 'WWWWWWWWWWWWWWWWWWWW';
  await routeLiveReads(page.context(), { world: worldFixture, owner: { ...ownerFixture, name } });
  await page.goto('/game/');
  await expectOwnerShown(page, name);
  const chip = cornerChip(page);
  const trigger = chip.getByRole('button', { name: 'Game Info', exact: true });
  const nameBox = (await chip.getByTestId('chip-name').boundingBox())!;
  expect((await trigger.boundingBox())!.y).toBeGreaterThan(nameBox.y + nameBox.height);
  await trigger.click();

  const panel = page.getByRole('dialog', { name: 'Game Info' });
  await panel.getByRole('tab', { name: 'Future Updates' }).click();
  await expect.poll(async () => {
    const box = (await panel.boundingBox())!;
    return box.y + box.height;
  }).toBeLessThanOrEqual(288);
  const lastEntry = panel.getByRole('heading', { name: 'Seasonal camp themes' });
  await lastEntry.scrollIntoViewIfNeeded();
  await expect(lastEntry).toBeInViewport();
});
