import { expect, test, type Page } from '@playwright/test';

const production = process.env.PLAYWRIGHT_STATIC === 'true';

async function openCamp(page: Page) {
  await page.goto('/game/?mode=fixture');
  await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
}
const campState = (page: Page) => page.evaluate(() => window.__cloudiatorCamp!.state()!);

test.describe('living isometric camp', () => {
  test.skip(production, 'The camp harness runs on the fixture preview only.');

  test('shows the full fixture population and every activity zone', async ({ page }, testInfo) => {
    await openCamp(page);
    const state = await campState(page);
    expect({ players: state.players, ambientNpcs: state.ambientNpcs }).toMatchObject({ players: 50, ambientNpcs: 6 });
    expect(state.away).toBe(6);
    expect([...state.zones].sort()).toEqual(['arena', 'expedition-gate', 'merchants', 'rest', 'training']);
    await page.waitForTimeout(400);
    await page.screenshot({ path: testInfo.outputPath('camp-overview.png') });
  });

  test('keeps the camera inside the map after panning far beyond its edges', async ({ page }) => {
    await openCamp(page);
    const box = (await page.locator('canvas').boundingBox())!;
    for (const [fx, fy, tx, ty] of [[0.9, 0.9, 0.05, 0.05], [0.9, 0.9, 0.05, 0.05], [0.1, 0.1, 0.95, 0.95], [0.1, 0.1, 0.95, 0.95], [0.1, 0.1, 0.95, 0.95]]) {
      await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * tx, box.y + box.height * ty, { steps: 6 });
      await page.mouse.up();
      const { camera } = await campState(page);
      const { worldView: v, bounds: b } = camera;
      expect(v.x).toBeGreaterThanOrEqual(b.x - 1);
      expect(v.y).toBeGreaterThanOrEqual(b.y - 1);
      expect(v.x + v.width).toBeLessThanOrEqual(b.x + b.width + 1);
      expect(v.y + v.height).toBeLessThanOrEqual(b.y + b.height + 1);
    }
  });

  test('zooms with the buttons and the keyboard within the zoom limits', async ({ page }) => {
    await openCamp(page);
    const zoomIn = page.getByRole('button', { name: 'Zoom in' });
    for (let i = 0; i < 12; i += 1) await zoomIn.click();
    expect((await campState(page)).camera.zoom).toBeCloseTo(3, 5);
    await page.getByRole('application').focus();
    for (let i = 0; i < 12; i += 1) await page.keyboard.press('-');
    expect((await campState(page)).camera.zoom).toBeCloseTo(0.5, 1);
    await page.getByRole('button', { name: 'Reset zoom' }).click();
    expect((await campState(page)).camera.zoom).toBeCloseTo(1, 1);
  });

  test('animates neighbouring gladiators out of sync', async ({ page }) => {
    await openCamp(page);
    await page.waitForTimeout(500);
    const { actors } = await campState(page);
    const players = actors.filter(a => a.kind === 'player');
    for (const action of ['weights', 'sleep', 'spar']) {
      const group = players.filter(a => a.action === action);
      if (group.length >= 3) expect(new Set(group.map(a => a.frame)).size, action).toBeGreaterThan(1);
    }
    expect(new Set(players.map(a => a.action)).size).toBeGreaterThanOrEqual(5);
  });

  test('re-entering the game keeps one canvas and no stale scene listeners', async ({ page }) => {
    await openCamp(page);
    expect(await page.evaluate(() => window.__cloudiatorCamp!.canvases())).toBe(1);
    const listeners = await page.evaluate(() => window.__cloudiatorCamp!.listeners());
    await page.getByRole('link', { name: /CLOUDIATOR/ }).first().click();
    await page.waitForURL(url => !url.pathname.startsWith('/game'));
    await page.goBack();
    await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__cloudiatorCamp!.canvases())).toBe(1);
    expect(await page.evaluate(() => window.__cloudiatorCamp!.listeners())).toBe(listeners);
  });

  test('draws walkers behind buildings and inside the arena wall in depth order', async ({ page }, testInfo) => {
    await openCamp(page);
    const { actors } = await campState(page);
    const sorted = [...actors].sort((a, b) => a.depth - b.depth);
    for (let i = 1; i < sorted.length; i += 1) expect(sorted[i].depth).toBeGreaterThanOrEqual(sorted[i - 1].depth);
    for (const a of actors) expect(a.depth, a.id).toBeCloseTo((a.x + a.y) * 16, 3);
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: testInfo.outputPath('camp-arena-closeup.png') });
  });

  test('keeps management usable when the camp art cannot load', async ({ page }) => {
    await page.route('**/assets/**/*.png', route => route.abort());
    await page.goto('/game/?mode=fixture');
    await expect(page.getByText(/camp art could not load/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Schedule', exact: true })).toBeEnabled();
  });
});
