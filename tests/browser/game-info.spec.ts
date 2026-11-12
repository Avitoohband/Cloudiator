import { readFileSync } from 'node:fs';
import { PATCH } from '../../src/lib/patch';
import { ownerFixture, worldFixture } from '../fixtures/domain';
import { expect, test, type Page } from './fixtures';
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
  await expect(panel.getByText('Video guide coming soon')).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'YouTube guides' })).toHaveCount(0);
  await expect(panel.getByText('In planning')).toHaveCount(0);

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
  await panel.getByRole('option', { name: 'Dungeons', exact: true }).click();
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
  const newerPatch = `${Number(PATCH.split('.')[0]) + 1}.0`;
  await routeLiveReads(page.context(), { world: worldFixture, owner: { ...ownerFixture, name }, latestPatch: newerPatch });
  await page.goto('/game/');
  await expectOwnerShown(page, name);
  const chip = cornerChip(page);
  const trigger = chip.getByRole('button', { name: 'Game Info', exact: true });
  const nameBox = (await chip.getByTestId('chip-name').boundingBox())!;
  expect((await trigger.boundingBox())!.y).toBeGreaterThan(nameBox.y + nameBox.height);
  const notice = page.locator('[data-patch-notice]');
  await expect(notice).toContainText(`Patch ${newerPatch} is out`);
  await expect.poll(async () => {
    const [noticeBox, chipBox] = await Promise.all([notice.boundingBox(), chip.boundingBox()]);
    return noticeBox!.y - (chipBox!.y + chipBox!.height);
  }).toBeGreaterThanOrEqual(0);
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

test('Wiki topics are one short scrolling list', async ({ page }) => {
  test.skip(process.env.PLAYWRIGHT_STATIC === 'true', 'The published Wiki uses the development-only intercepted transport.');
  const wiki = JSON.parse(readFileSync('docs/game-info/wiki.draft.json', 'utf8')) as { entries: { id: string; title: string; body: string }[] };
  await quietArrivals(page.context());
  await routeLiveReads(page.context(), { world: worldFixture, gameInfo: [{ tab: 'wiki', version: 1, document: wiki }] });
  await page.setViewportSize({ width: 360, height: 700 });
  await page.goto('/game/');
  await cornerChip(page).getByRole('button', { name: 'Game Info', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Game Info' });
  const list = panel.getByRole('listbox', { name: 'Wiki topics' });
  const options = list.getByRole('option');
  await expect(options).toHaveCount(wiki.entries.length);
  await expect(panel.getByRole('navigation', { name: 'Wiki topics' })).toHaveCount(0);
  expect(wiki.entries.length).toBeGreaterThan(4);
  const rowHeight = (await options.first().boundingBox())!.height;
  const sizes = await list.evaluate(element => ({ client: element.clientHeight, scroll: element.scrollHeight }));
  expect(sizes.client).toBeLessThan(rowHeight * 5);
  expect(sizes.scroll).toBeGreaterThan(sizes.client);
  // Four whole rows and the list's padding fit inside its border (border-box sizing; final review Minor 9): the 4th row is never clipped.
  const fit = await list.evaluate(element => {
    const style = getComputedStyle(element), rows = Array.from(element.querySelectorAll('[role="option"]')).slice(0, 4);
    return { client: element.clientHeight, needed: rows.reduce((sum, row) => sum + row.getBoundingClientRect().height, 0) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) };
  });
  expect(fit.client, JSON.stringify(fit)).toBeGreaterThanOrEqual(Math.floor(fit.needed));

  const inView = async (option: ReturnType<typeof options.nth>) => {
    const [o, l] = [(await option.boundingBox())!, (await list.boundingBox())!];
    return o.y >= l.y - 1 && o.y + o.height <= l.y + l.height + 1;
  };
  const chosen = list.getByRole('option', { selected: true });
  await expect(chosen).toHaveCount(1);
  await expect(chosen).toHaveText(/✓\s*Combat, dodge, and critical hits/);
  await expect(chosen).toBeVisible();
  await expect.poll(() => inView(chosen)).toBe(true);
  await expect(panel.getByRole('article', { name: 'Combat, dodge, and critical hits' })).toBeVisible();

  const heading = (title: string) => expect(panel.getByRole('article')).toHaveAccessibleName(title);
  await list.focus();
  await expect(list).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await heading('Gear and builds');
  await expect(list.getByRole('option', { selected: true })).toHaveText(/Gear and builds/);
  await page.keyboard.press('ArrowUp');
  await heading('Combat, dodge, and critical hits');
  await page.keyboard.press('End');
  await heading(wiki.entries.at(-1)!.title);
  await expect.poll(() => inView(options.last())).toBe(true);
  await page.keyboard.press('Home');
  await heading(wiki.entries[0].title);
  await expect.poll(() => inView(options.first())).toBe(true);

  await list.getByRole('option', { name: 'Arena and renown' }).click();
  await heading('Arena and renown');
  await expect(list.getByRole('option', { selected: true })).toHaveText(/✓\s*Arena and renown/);
  expect(await inView(list.getByRole('option', { selected: true }))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
});

// A 1x1 PNG, so the guide thumbnails (https://i.ytimg.com/vi/<id>/mqdefault.jpg) load offline.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
type WikiDoc = { entries: { id: string; title: string; body: string; video?: string; videoLength?: string }[] };

async function openGuides(page: Page, { length = '1:12', thumbnails = 'load' }: { length?: string | null; thumbnails?: 'load' | 'fail' } = {}) {
  test.skip(process.env.PLAYWRIGHT_STATIC === 'true', 'The published Wiki uses the development-only intercepted transport.');
  const wiki = JSON.parse(readFileSync('docs/game-info/wiki.draft.json', 'utf8')) as WikiDoc;
  const entries = wiki.entries.map(({ video, videoLength, ...entry }) => entry.id === 'combat'
    ? { ...entry, video: 'https://youtu.be/AAAAAAAAAAA', ...(length ? { videoLength: length } : {}) } : entry);
  await quietArrivals(page.context());
  await routeLiveReads(page.context(), { world: worldFixture, gameInfo: [{ tab: 'wiki', version: 1, document: { entries } }] });
  const thumbnailRequests: string[] = [];
  await page.context().route('https://i.ytimg.com/**', route => {
    thumbnailRequests.push(route.request().url());
    return thumbnails === 'fail' ? route.abort() : route.fulfill({ body: PIXEL, contentType: 'image/png' });
  });
  await page.setViewportSize({ width: 360, height: 700 });
  await page.goto('/game/');
  await cornerChip(page).getByRole('button', { name: 'Game Info', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Game Info' });
  await expect(panel.getByRole('article', { name: 'Combat, dodge, and critical hits' })).toBeVisible();
  return { panel, entries, thumbnailRequests };
}

test.describe('Wiki guide cards', () => {
  test('a topic with a guide shows a card between its heading and its text, with the length', async ({ page }) => {
    const { panel, thumbnailRequests } = await openGuides(page);
    const article = panel.getByRole('article', { name: 'Combat, dodge, and critical hits' });
    const card = article.getByRole('link', { name: 'Watch the guide, 1:12, on YouTube (opens in a new tab)' });
    await expect(card).toHaveAttribute('href', 'https://youtu.be/AAAAAAAAAAA');
    await expect(card).toHaveAttribute('target', '_blank');
    await expect(card).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(card).toContainText('Watch the guide · 1:12');
    await expect(card).toContainText('Combat, dodge, and critical hits');
    await expect(card).toContainText('YouTube ↗');
    await expect(card).toContainText('▶');
    const image = card.locator('img');
    await expect(image).toHaveAttribute('src', 'https://i.ytimg.com/vi/AAAAAAAAAAA/mqdefault.jpg');
    await expect(image).toHaveAttribute('alt', '');
    await expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
    await expect(image).toHaveAttribute('loading', 'lazy');
    await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1);
    expect(thumbnailRequests).toEqual(['https://i.ytimg.com/vi/AAAAAAAAAAA/mqdefault.jpg']);
    expect(await article.evaluate(element => Array.from(element.children).map(child => child.tagName))).toEqual(['H3', 'A', 'P']);
    await expect(panel.getByText('Video guide coming soon')).toHaveCount(0);
    await expect(panel.getByRole('heading', { name: 'YouTube guides' })).toHaveCount(0);
  });

  test('a guide without a length reads Watch the guide', async ({ page }) => {
    const { panel } = await openGuides(page, { length: null });
    const card = panel.getByRole('article').getByRole('link', { name: 'Watch the guide on YouTube (opens in a new tab)' });
    await expect(card).toContainText('Watch the guide');
    await expect(card).not.toContainText('·');
  });

  test('a topic without a guide says the video is coming soon, and the old two slots are gone', async ({ page }) => {
    const { panel } = await openGuides(page);
    await panel.getByRole('option', { name: 'Start in camp' }).click();
    const article = panel.getByRole('article', { name: 'Start in camp' });
    await expect(article.getByText('Video guide coming soon')).toBeVisible();
    await expect(article.getByRole('link')).toHaveCount(0);
    await expect(panel.getByRole('heading', { name: 'YouTube guides' })).toHaveCount(0);
    await expect(panel.getByText(/Video [12]$/)).toHaveCount(0);
  });

  test('only topics with a guide carry a play marker hidden from readers and end their name with video guide', async ({ page }) => {
    const { panel } = await openGuides(page);
    const list = panel.getByRole('listbox', { name: 'Wiki topics' });
    const combat = list.getByRole('option', { name: 'Combat, dodge, and critical hits' });
    await expect(combat).toHaveAccessibleName('Combat, dodge, and critical hits, video guide');
    const marker = combat.locator('[aria-hidden="true"]', { hasText: '▶' });
    await expect(marker).toHaveCount(1);
    await expect(marker).toBeVisible();
    const start = list.getByRole('option', { name: 'Start in camp' });
    await expect(start).toHaveAccessibleName('Start in camp');
    await expect(start).not.toContainText('▶');
    await expect(list.getByText('▶')).toHaveCount(1);
  });

  test('a thumbnail that fails to load leaves the dark frame and the play mark, without a broken image', async ({ page }) => {
    const { panel } = await openGuides(page, { thumbnails: 'fail' });
    const card = panel.getByRole('article').getByRole('link', { name: /Watch the guide, 1:12/ });
    await expect(card).toContainText('▶');
    await expect(card.locator('img')).toBeHidden();
    const frame = card.locator('span').first();
    const box = (await frame.boundingBox())!;
    expect(box.width).toBeGreaterThan(80);
    expect(box.height).toBeGreaterThan(40);
    await expect(frame).toHaveCSS('background-color', 'rgb(0, 0, 0)');
    await expect(card).toContainText('YouTube ↗');
  });

  test('on a 360 px phone the card fits with a 96 px picture and the rows stay 44 px', async ({ page }) => {
    const { panel } = await openGuides(page);
    const card = panel.getByRole('article').getByRole('link', { name: /Watch the guide, 1:12/ });
    await expect(card).toBeVisible();
    const thumb = await card.locator('img').evaluate(element => element.parentElement!.getBoundingClientRect().width);
    expect(Math.round(thumb)).toBe(96);
    const [cardBox, panelBox] = await Promise.all([card.boundingBox(), panel.boundingBox()]);
    expect(cardBox!.x).toBeGreaterThanOrEqual(panelBox!.x);
    expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width);
    const rows = panel.getByRole('listbox', { name: 'Wiki topics' }).getByRole('option');
    expect(await rows.evaluateAll(all => all.every(row => Math.abs(row.getBoundingClientRect().height - 44) < 1.5))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  });
});
