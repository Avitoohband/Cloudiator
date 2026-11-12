import { ownerFixture, worldFixture } from '../fixtures/domain';
import { expect, test, type Page } from './fixtures';
import { routeLiveReads, seedSession, SUPABASE_URL } from './live-routes';
import { cornerChip, expectOwnerShown, quietArrivals } from './shell-helpers';

type Tab = 'wiki' | 'future';
type Document = { entries: { id: string; title: string; body: string; patch?: string; video?: string; videoLength?: string }[] };

async function setup(page: Page, editor = true, rejectSave = false) {
  const context = page.context();
  await seedSession(context);
  await quietArrivals(context);
  await routeLiveReads(context, { world: worldFixture, owner: ownerFixture });
  const wiki: Document = { entries: [{ id: 'combat', title: 'Combat', body: 'Public combat guide.' }] };
  const future: Document = { entries: [{ id: 'parties', title: 'Party invitations', body: 'Public plan.' }] };
  const published = { wiki: { version: 0, document: wiki }, future: { version: 0, document: future } };
  const drafts = structuredClone(published);
  const writes: string[] = [];
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info' };
  await context.route(`${SUPABASE_URL}/rest/v1/game_info_reads?**`, route => route.fulfill({ json: Object.entries(published).map(([tab, value]) => ({ tab, ...value })), headers: cors }));
  await context.route(`${SUPABASE_URL}/functions/v1/game-info`, async route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-methods': 'POST' } });
    const { tab, action, expectedVersion, document } = route.request().postDataJSON() as {
      tab: Tab; action: string; expectedVersion?: number; document?: Document;
    };
    const answer = (status: number, json: unknown) => route.fulfill({ status, json, headers: cors });
    if (!editor) return answer(403, { ok: false, code: 'forbidden' });
    // Patch 1.9: an editor's panel also reads the Feedback tab's count (no feedback here).
    if ((tab as string) === 'feedback') return answer(200, { ok: true, items: [], newCount: 0 });
    const draft = drafts[tab];
    if (rejectSave && action === 'save') return answer(400, { ok: false, code: 'invalid' });
    if (action !== 'read') {
      writes.push(`${tab}/${action}`);
      if (expectedVersion !== draft.version) return answer(409, { ok: false, code: 'conflict' });
      draft.version++;
      if (action === 'save' && document) draft.document = document;
      if (action === 'publish') published[tab] = structuredClone(draft);
    }
    return answer(200, { ok: true, ...draft });
  });
  await page.goto('/game/');
  await expectOwnerShown(page, ownerFixture.name);
  const denied = editor ? null : page.waitForResponse(response => response.url().endsWith('/functions/v1/game-info') && response.status() === 403);
  await cornerChip(page).getByRole('button', { name: 'Game Info', exact: true }).click();
  if (denied) await denied;
  return { panel: page.getByRole('dialog', { name: 'Game Info' }), published, drafts, writes };
}

test.describe('Game Info editor', () => {
  test.skip(process.env.PLAYWRIGHT_STATIC === 'true', 'The editor uses intercepted authenticated development transport.');

  test('the editor saves and publishes either tab with separate actions', async ({ page }) => {
    const { panel, published, drafts, writes } = await setup(page);
    await expect(panel.getByText('Public combat guide.')).toBeVisible();
    await panel.getByRole('button', { name: 'Edit Wiki', exact: true }).click();
    await expect(panel.getByLabel('Title', { exact: true })).toBeFocused();
    await panel.getByLabel('Text', { exact: true }).fill('Updated combat guide.');
    await expect(panel.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
    await panel.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Publish', exact: true })).toBeEnabled();
    expect(published.wiki.document.entries[0].body).toBe('Public combat guide.');
    expect(drafts.wiki.document.entries[0].body).toBe('Updated combat guide.');
    await panel.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(panel.getByText('Updated combat guide.')).toBeVisible();

    await panel.getByRole('tab', { name: 'Future Updates' }).click();
    await panel.getByRole('button', { name: 'Edit Future Updates', exact: true }).click();
    await panel.getByRole('button', { name: 'Add entry' }).click();
    await panel.getByLabel('Title', { exact: true }).fill('New public plan');
    await panel.getByLabel('Text', { exact: true }).fill('A short description.');
    await panel.getByRole('button', { name: 'Save draft', exact: true }).click();
    await panel.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(panel.getByRole('heading', { name: 'New public plan' })).toBeVisible();
    expect(writes).toEqual(['wiki/save', 'wiki/publish', 'future/save', 'future/publish']);
  });

  test('keeps concurrent edits on screen and keeps ordinary players out of drafts', async ({ page, browser }) => {
    const { panel, drafts, published } = await setup(page);
    await panel.getByRole('button', { name: 'Edit Wiki', exact: true }).click();
    await panel.getByLabel('Text', { exact: true }).fill('Unsaved owner text.');
    await page.keyboard.press('Escape');
    await page.mouse.click(2, 100);
    await expect(panel.getByLabel('Text', { exact: true })).toHaveValue('Unsaved owner text.');
    page.once('dialog', dialog => dialog.dismiss());
    await panel.getByRole('button', { name: 'Close Game Info', exact: true }).click();
    await expect(panel.getByLabel('Text', { exact: true })).toHaveValue('Unsaved owner text.');
    drafts.wiki.version++;
    drafts.wiki.document = { entries: [{ id: 'combat', title: 'Combat', body: 'Newer MCP draft.' }] };
    await panel.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('changed elsewhere');
    await expect(panel.getByLabel('Text', { exact: true })).toHaveValue('Unsaved owner text.');
    expect(published.wiki.document.entries[0].body).toBe('Public combat guide.');

    const ordinary = await browser.newPage({ baseURL: new URL(page.url()).origin });
    try {
      const other = await setup(ordinary, false);
      await expect(other.panel.getByText('Public combat guide.')).toBeVisible();
      await expect(other.panel.getByRole('button', { name: 'Edit Wiki', exact: true })).toHaveCount(0);
      expect(other.writes).toEqual([]);
    } finally { await ordinary.close(); }
  });

  test('the Wiki editor edits the selected topic guide link and length, and saves and publishes them', async ({ page }) => {
    const { panel, published, drafts } = await setup(page);
    await panel.getByRole('button', { name: 'Edit Wiki', exact: true }).click();
    await expect(panel.getByLabel(/YouTube video [12]/)).toHaveCount(0);
    const link = panel.getByLabel('YouTube guide', { exact: true });
    const length = panel.getByLabel('Guide length', { exact: true });
    await expect(length).toBeDisabled();
    await link.fill('https://example.com/watch?v=AAAAAAAAAAA');
    await expect(panel.getByText('Enter a YouTube video URL.')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
    await link.fill('https://youtu.be/AAAAAAAAAAA');
    await expect(panel.getByText('Enter a YouTube video URL.')).toHaveCount(0);
    await expect(length).toBeEnabled();
    await length.fill('1:99');
    await expect(panel.getByText('Enter the length as minutes:seconds, like 1:12.')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
    await length.fill('1:12');
    await expect(panel.getByText('Enter the length as minutes:seconds, like 1:12.')).toHaveCount(0);
    await panel.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(panel.getByRole('status')).toHaveText('Draft saved.');
    expect(drafts.wiki.document.entries[0]).toEqual({ id: 'combat', title: 'Combat', body: 'Public combat guide.', video: 'https://youtu.be/AAAAAAAAAAA', videoLength: '1:12' });
    expect('videos' in drafts.wiki.document).toBe(false);
    await panel.getByRole('button', { name: 'Publish', exact: true }).click();
    expect(published.wiki.document.entries[0].video).toBe('https://youtu.be/AAAAAAAAAAA');
    await expect(panel.getByRole('link', { name: 'Watch the guide, 1:12, on YouTube (opens in a new tab)' })).toHaveAttribute('href', 'https://youtu.be/AAAAAAAAAAA');
  });

  test('clearing the link removes both guide keys from the saved document', async ({ page }) => {
    const { panel, drafts } = await setup(page);
    drafts.wiki.document.entries[0].video = 'https://youtu.be/AAAAAAAAAAA';
    drafts.wiki.document.entries[0].videoLength = '1:12';
    await panel.getByRole('button', { name: 'Edit Wiki', exact: true }).click();
    const link = panel.getByLabel('YouTube guide', { exact: true });
    await expect(link).toHaveValue('https://youtu.be/AAAAAAAAAAA');
    await expect(panel.getByLabel('Guide length', { exact: true })).toHaveValue('1:12');
    await link.fill('');
    await expect(panel.getByLabel('Guide length', { exact: true })).toBeDisabled();
    await panel.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(panel.getByRole('status')).toHaveText('Draft saved.');
    expect(Object.keys(drafts.wiki.document.entries[0]).sort()).toEqual(['body', 'id', 'title']);
  });

  test('the Future tab has no guide fields, and a refused save names the guide link and length', async ({ page }) => {
    const { panel } = await setup(page, true, true);
    await panel.getByRole('tab', { name: 'Future Updates' }).click();
    await panel.getByRole('button', { name: 'Edit Future Updates', exact: true }).click();
    await expect(panel.getByLabel('YouTube guide', { exact: true })).toHaveCount(0);
    await expect(panel.getByLabel('Guide length', { exact: true })).toHaveCount(0);
    await panel.getByRole('button', { name: 'Close editor' }).click();
    await panel.getByRole('tab', { name: 'Wiki' }).click();
    await panel.getByRole('button', { name: 'Edit Wiki', exact: true }).click();
    await panel.getByLabel('Text', { exact: true }).fill('Changed.');
    await panel.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(panel.getByRole('alert')).toHaveText('Check the title, text, patch number, guide link and length before saving.');
  });
});
