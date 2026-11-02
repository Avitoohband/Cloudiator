import { expect, test, type Page } from './fixtures';
import { emptyWorld, PUBLISHABLE_KEY, routeLiveReads, SUPABASE_URL } from './live-routes';
import { watchSyncPoll } from './sync-poll';

type Probe = { armed: number; pending: number; idle: boolean };
const probe = (page: Page) => page.evaluate(() => (window as unknown as { __cloudiatorSyncPoll: () => Probe }).__cloudiatorSyncPoll());

test.describe('sync poll observation', () => {
  test.skip(process.env.PLAYWRIGHT_STATIC === 'true', 'The real sync controller needs development-only routed transport.');

  test('an independent revision read leaves an already armed poll idle', async ({ page, context }, testInfo) => {
    await page.clock.install();
    const poll = await watchSyncPoll(page);
    const live = await routeLiveReads(context, { world: emptyWorld() });
    await page.goto('/game/');
    await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true);
    await poll.idle();
    const before = await probe(page), reads = live.count('world_revision');
    // serverNow readers share this public endpoint with the sync controller, but do not own its poll.
    const status = await page.evaluate(async ({ url, key }) => {
      const response = await fetch(url, { headers: { apikey: key, authorization: `Bearer ${key}` } });
      await response.text(); return response.status;
    }, { url: `${SUPABASE_URL}/rest/v1/world_revision?select=revision`, key: PUBLISHABLE_KEY });
    expect(status).toBe(200);
    expect(live.count('world_revision')).toBe(reads + 1);
    const after = await probe(page);
    await testInfo.attach('independent-revision-poll', { body: JSON.stringify({ before, after, additionalReads: live.count('world_revision') - reads }), contentType: 'application/json' });
    expect(after).toEqual({ armed: before.armed, pending: 1, idle: true });
    await poll.nextSyncPoll();
    await poll.idle();
    expect((await probe(page)).armed).toBe(before.armed + 1);
  });

  test('a fired genuine poll stays busy until its held revision finishes and rearms', async ({ page, context }, testInfo) => {
    await page.clock.install();
    const poll = await watchSyncPoll(page);
    const live = await routeLiveReads(context, { world: emptyWorld() });
    await page.goto('/game/');
    await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true);
    await poll.idle();
    const before = await probe(page), reads = live.count('world_revision');
    const syncs = await page.evaluate(() => window.__cloudiatorShell!.syncs());
    const release = live.hold('world_revision');
    try {
      await poll.nextSyncPoll();
      await expect.poll(() => live.count('world_revision')).toBe(reads + 1);
      const held = await probe(page);
      expect(held).toEqual({ armed: before.armed, pending: 0, idle: false });
      expect(await page.evaluate(() => window.__cloudiatorShell!.syncs())).toBe(syncs);
      await testInfo.attach('held-genuine-poll', { body: JSON.stringify({ before, held }), contentType: 'application/json' });
    } finally { release(); }
    await poll.idle();
    expect(await probe(page)).toEqual({ armed: before.armed + 1, pending: 1, idle: true });
    expect(await page.evaluate(() => window.__cloudiatorShell!.syncs())).toBe(syncs + 1);
  });
});
