import { readFileSync } from 'node:fs';
import { PATCH } from '../../src/lib/patch';
import { ownerFixture, worldFixture } from '../fixtures/domain';
import { expect, test, type Locator, type Page } from './fixtures';
import { routeLiveReads, seedSession, SUPABASE_URL } from './live-routes';
import { cornerChip, expectOwnerShown, pageTo, quietArrivals } from './shell-helpers';

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
  const dungeons = panel.getByRole('option', { name: 'Dungeons', exact: true });
  await pageTo(panel, dungeons);
  await dungeons.click();
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
  await expect(panel.getByRole('status').filter({ hasText: 'is out' })).toContainText(`Patch ${newerPatch} is out`);
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
  // Patch 1.9 Task 31: the entries are paged (8 a page); the last one is on the last page, and that page still scrolls under the controls.
  await pageTo(panel, lastEntry);
  await lastEntry.scrollIntoViewIfNeeded();
  await expect(lastEntry).toBeInViewport();
});

test('Wiki topics are one short list a page, and the chosen topic and the keys follow it across pages', async ({ page }) => {
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
  const label = panel.getByRole('navigation', { name: 'Pages' }).locator('b').first();
  // Patch 1.9 Task 31: 5 topics a page instead of a box of 4 that scrolls; the page holding the chosen topic (Combat, 6th) shows first.
  await expect(options).toHaveCount(5);
  await expect(label).toHaveText(`Page 2 of ${Math.ceil(wiki.entries.length / 5)}`);
  await expect(panel.getByRole('navigation', { name: 'Wiki topics' })).toHaveCount(0);
  expect(wiki.entries.length).toBeGreaterThan(4);
  // A page does not scroll: every row of it is whole inside the list.
  expect(await list.evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);

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
  await expect(label).toHaveText(`Page ${Math.ceil(wiki.entries.length / 5)} of ${Math.ceil(wiki.entries.length / 5)}`);
  await expect.poll(() => inView(options.last())).toBe(true);
  await page.keyboard.press('Home');
  await heading(wiki.entries[0].title);
  await expect(label).toHaveText(`Page 1 of ${Math.ceil(wiki.entries.length / 5)}`);
  await expect.poll(() => inView(options.first())).toBe(true);

  const arena = list.getByRole('option', { name: 'Arena and renown' });
  await pageTo(panel, arena);
  await arena.click();
  await heading('Arena and renown');
  await expect(list.getByRole('option', { selected: true })).toHaveText(/✓\s*Arena and renown/);
  expect(await inView(list.getByRole('option', { selected: true }))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test('the Wiki topic list leaves Alt, Ctrl and Meta with an arrow key alone, and its active descendant is the chosen topic (Task 21 item 9)', async ({ page }) => {
  await page.goto('/game/');
  await cornerChip(page).getByRole('button', { name: 'Game Info', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Game Info' });
  const list = panel.getByRole('listbox', { name: 'Wiki topics' });
  const chosen = list.getByRole('option', { selected: true });
  await expect(chosen).toHaveCount(1);
  // The id of the chosen option, read after a frame (so a key that moved the choice has re-rendered).
  const idOf = async () => {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve(null))));
    return (await chosen.getAttribute('id'))!;
  };
  await list.focus();
  const first = await idOf();
  await expect(list).toHaveAttribute('aria-activedescendant', first);
  for (const key of ['Alt+ArrowDown', 'Control+ArrowDown', 'Meta+ArrowDown', 'Alt+ArrowUp', 'Control+End', 'Meta+Home']) {
    await page.keyboard.press(key);
    expect(await idOf(), key).toBe(first);
    await expect(list, key).toHaveAttribute('aria-activedescendant', first);
  }
  await page.keyboard.press('ArrowDown');
  const second = await idOf();
  expect(second).not.toBe(first);
  await expect(list).toHaveAttribute('aria-activedescendant', second);
  for (const key of ['Alt+ArrowUp', 'Control+ArrowUp', 'Meta+ArrowUp']) {
    await page.keyboard.press(key);
    expect(await idOf(), key).toBe(second);
  }
  await page.keyboard.press('End');
  await expect(list).toHaveAttribute('aria-activedescendant', await list.getByRole('option').last().getAttribute('id') as string);
  await list.getByRole('option').nth(1).click();
  await expect(list).toHaveAttribute('aria-activedescendant', await list.getByRole('option').nth(1).getAttribute('id') as string);
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
    const start = panel.getByRole('option', { name: 'Start in camp' });
    await pageTo(panel, start);
    await start.click();
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
    // The page holding Combat shows its marker once; Start in camp is on page 1 (Task 31: topics are paged), with none.
    await expect(list.getByText('▶')).toHaveCount(1);
    const start = list.getByRole('option', { name: 'Start in camp' });
    await pageTo(panel, start);
    await expect(start).toHaveAccessibleName('Start in camp');
    await expect(start).not.toContainText('▶');
    await expect(list.getByText('▶')).toHaveCount(0);
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

// Patch 1.9 Task 31 (menus with Back and Next): Wiki topics 5 a page, Future Updates entries 8 a page; the article keeps its scroll.
test.describe('Game Info by the page', () => {
  test.skip(process.env.PLAYWRIGHT_STATIC === 'true', 'The drafts and the intercepted transport are development-only.');
  const draft = (name: string) => JSON.parse(readFileSync(`docs/game-info/${name}.draft.json`, 'utf8')) as { entries: { id: string; title: string }[] };
  const pagesBar = (panel: Locator) => panel.getByRole('navigation', { name: 'Pages' });

  test('the Wiki lists 5 topics a page, the arrow keys follow the chosen topic across pages, and a tab change goes back to page 1', async ({ page }) => {
    const wiki = draft('wiki'), future = draft('future-updates');
    await page.goto('/game/?mode=fixture&info=draft');
    await cornerChip(page).getByRole('button', { name: 'Game Info', exact: true }).click();
    const panel = page.getByRole('dialog', { name: 'Game Info' });
    const options = panel.getByRole('listbox', { name: 'Wiki topics' }).getByRole('option');
    await expect(options).toHaveCount(5);
    // Combat, the chosen topic, is the 6th: its page (2) shows first.
    await expect(pagesBar(panel).locator('b').first()).toHaveText(`Page 2 of ${Math.ceil(wiki.entries.length / 5)}`);
    await expect(options.nth(0)).toHaveAccessibleName(new RegExp(`^${wiki.entries[5].title}`));
    // The article keeps its own text; Back turns the topics and keeps the article.
    await pagesBar(panel).getByRole('button', { name: 'Previous page', exact: true }).click();
    await expect(options).toHaveCount(5);
    await expect(options.nth(0)).toHaveAccessibleName(new RegExp(`^${wiki.entries[0].title}`));
    await expect(panel.getByRole('article', { name: wiki.entries[5].title })).toBeVisible();
    await expect(panel.getByRole('article')).toHaveCount(1);
    // ArrowDown from the last topic of page 1 chooses the first topic of page 2 and shows its page.
    await pagesBar(panel).getByRole('button', { name: 'Go to page 1', exact: true }).click();
    await options.first().click();
    await panel.getByRole('listbox', { name: 'Wiki topics' }).focus();
    for (let n = 0; n < 5; n++) await page.keyboard.press('ArrowDown');
    await expect(panel.getByRole('article', { name: wiki.entries[5].title })).toBeVisible();
    await expect(pagesBar(panel).locator('b').first()).toHaveText(`Page 2 of ${Math.ceil(wiki.entries.length / 5)}`);
    // Future Updates: 8 entries a page, from page 1, and the tab's own list.
    await panel.getByRole('tab', { name: 'Future Updates' }).click();
    const entries = panel.getByRole('tabpanel', { name: 'Future Updates' }).getByRole('listitem');
    await expect(entries).toHaveCount(8);
    await expect(pagesBar(panel).locator('b').first()).toHaveText(`Page 1 of ${Math.ceil(future.entries.length / 8)}`);
    await pagesBar(panel).getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(entries.first()).toContainText(future.entries[8].title);
    // Back on the Wiki, the chosen topic's page shows.
    await panel.getByRole('tab', { name: 'Wiki' }).click();
    await expect(panel.getByRole('article', { name: wiki.entries[5].title })).toBeVisible();
    await expect(pagesBar(panel).locator('b').first()).toHaveText(`Page 2 of ${Math.ceil(wiki.entries.length / 5)}`);
  });

  test('opens on a steady loading line, never the built-in Wiki before the published one', async ({ page, context }) => {
    await quietArrivals(context);
    const published = (title: string) => ({ version: 3, document: { entries: [{ id: 'zeta', title, body: 'Published text.' }] } });
    await routeLiveReads(context, { world: worldFixture, gameInfo: [{ tab: 'wiki', ...published('Zeta guide') }, { tab: 'future', ...published('Zeta plan') }] });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await context.route(`${SUPABASE_URL}/rest/v1/game_info_reads?**`, async route => { await gate; await route.fallback(); });
    await page.goto('/game/');
    await page.waitForFunction(revision => window.__cloudiatorCamp?.world()?.revision === revision, worldFixture.revision);
    await cornerChip(page).getByRole('button', { name: 'Game Info', exact: true }).click();
    const panel = page.getByRole('dialog', { name: 'Game Info' });
    await expect(panel.getByText('Loading Game Info…')).toBeVisible();
    // While the read is held no built-in topic shows (the built-in Wiki's first topic is Combat).
    await page.waitForTimeout(400);
    await expect(panel.getByRole('option')).toHaveCount(0);
    await expect(panel.getByText('Precision')).toHaveCount(0);
    release();
    await expect(panel.getByRole('option', { name: 'Zeta guide' })).toBeVisible();
    await expect(panel.getByText('Loading Game Info…')).toHaveCount(0);
    await expect(panel.getByRole('option', { name: 'Combat' })).toHaveCount(0);
  });

  test('a read that fails falls back to the built-in text, after the loading line', async ({ page, context }) => {
    await quietArrivals(context);
    await routeLiveReads(context, { world: worldFixture });
    await context.route(`${SUPABASE_URL}/rest/v1/game_info_reads?**`, route => route.fulfill({ status: 500, body: '{}', headers: { 'access-control-allow-origin': '*' } }));
    await page.goto('/game/');
    await page.waitForFunction(revision => window.__cloudiatorCamp?.world()?.revision === revision, worldFixture.revision);
    await cornerChip(page).getByRole('button', { name: 'Game Info', exact: true }).click();
    const panel = page.getByRole('dialog', { name: 'Game Info' });
    await expect(panel.getByRole('article', { name: 'Combat' })).toContainText('Precision');
    await expect(panel.getByText('Loading Game Info…')).toHaveCount(0);
  });
});
