import { ownerFixture, worldFixture } from '../fixtures/domain';
import { expect, test, type Page } from './fixtures';
import { routeLiveReads, seedSession, SUPABASE_URL } from './live-routes';
import { cornerChip, expectOwnerShown, quietArrivals } from './shell-helpers';

type Tab = 'wiki' | 'future';
type Document = { entries: { id: string; title: string; body: string; patch?: string }[]; videos?: [null, null] };

async function setup(page: Page, editor = true) {
  const context = page.context();
  await seedSession(context);
  await quietArrivals(context);
  await routeLiveReads(context, { world: worldFixture, owner: ownerFixture });
  const wiki: Document = { entries: [{ id: 'combat', title: 'Combat', body: 'Public combat guide.' }], videos: [null, null] };
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
    const draft = drafts[tab];
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
    drafts.wiki.document = { entries: [{ id: 'combat', title: 'Combat', body: 'Newer MCP draft.' }], videos: [null, null] };
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
});
