// Task 23.9: the idle rest seen in the camp (Task 23.8's contracts, the database budget design's "In the camp" and "Waking
// up") and the owner's presence. The fixture preview shows a gladiator resting at home (Otho), and `?as=resting` the
// owner's own gladiator resting until the next boundary; live mode (development transport) shows the presence a signed-in
// player sends. 360 x 740 screenshots of the three resting states are for Avi's review (`reviewShot360`; PERF_SHOTS keeps a copy).
import { expect, test, type Locator, type Page } from './fixtures';
import type { OwnerState, WorldSnapshot } from '../../supabase/functions/_shared/contracts/reads';
import { ownerFixture, worldFixture } from '../fixtures/domain';
import { RESTING_ACTOR, restingActor } from '../fixtures/resting';
import { contrastIssues, focusDrops, watchFocus } from './a11y-helpers';
import { SLOT_MS, SUPABASE_URL, isPresence, routeLiveReads, seedSession, testUser } from './live-routes';
import { reviewShot360 } from './review-shots';
import { expectOwnerShown, joinButton, openMenu } from './shell-helpers';

const production = process.env.PLAYWRIGHT_STATIC === 'true';
const HOUR = 3_600_000;
const OTHO = "Resting at home: back when Otho's owner returns.";
const ASTER = "Resting at home: back when Aster's owner returns.";

async function openFixtureCamp(page: Page, url: string) {
  await page.goto(url);
  await page.waitForFunction(() => window.__cloudiatorCamp?.state()?.ready === true, null, { timeout: 45_000 });
  await expectOwnerShown(page, 'Aster');
}
/** Whether the camp scene draws the gladiator `id`, and whether the shared world lists it as resting. */
const drawn = (page: Page, id: string) => page.evaluate(gladiatorId => window.__cloudiatorCamp!.state()!.actors.some(a => a.id === gladiatorId), id);
const listedResting = (page: Page, id: string) => page.evaluate(gladiatorId => window.__cloudiatorCamp!.world()!.actors.some(a => a.gladiatorId === gladiatorId && a.resting), id);
/** A gladiator's row in the Gladiators list, found by its name button. */
const rosterRow = (page: Page, roster: Locator, name: string) =>
  roster.getByRole('listitem').filter({ has: page.getByRole('button', { name: `Profile: ${name}`, exact: true }) });
/** The value beside a profile card's fact (`Now`, `Rating`). */
const fact = (card: Locator, term: string) => card.locator('dt', { hasText: new RegExp(`^${term}$`) }).locator('xpath=following-sibling::dd[1]');
/** The owner's activity line in My gladiator. */
const activityLine = (panel: Locator) => panel.locator('p[role="status"]').filter({ hasText: /^(Resting at home|Scheduled|In progress|Processing results|Preparing|Completed)/ });
/** Waits for a panel's or card's opening animation to end, so its colours are the ones it keeps (as release.spec.ts). */
const settled = async (locator: Locator) => { await locator.evaluate(el => Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished))); return locator; };
/** The local date and time the Schedule panel would show for the start of slot `slot`, in the page's own locale and zone. */
const slotTime = (page: Page, slot: number) => page.evaluate(ms => new Date(ms).toLocaleString(), slot * SLOT_MS);

test.describe('a gladiator resting at home in the fixture preview', () => {
  test.skip(production, 'The fixture preview is a development build feature.');

  test('lists a resting gladiator with where it is, draws it nowhere in the camp, and says so on its profile card', async ({ page }, testInfo) => {
    await watchFocus(page);
    await openFixtureCamp(page, '/game/?mode=fixture');
    expect(await listedResting(page, RESTING_ACTOR.gladiatorId)).toBe(true);
    expect(await drawn(page, RESTING_ACTOR.gladiatorId)).toBe(false);

    const roster = await settled(await openMenu(page, 'Gladiators'));
    const row = rosterRow(page, roster, 'Otho');
    await expect(row).toContainText(OTHO);
    await expect(row).not.toContainText('Not in the camp right now.');
    for (const name of ['Find Otho', 'Follow Otho']) {
      const button = row.getByRole('button', { name, exact: true });
      await expect(button).toBeDisabled();
      await expect(button).toHaveAccessibleDescription(OTHO);
    }
    expect(await contrastIssues(row), 'the resting row').toEqual([]);
    await reviewShot360(page, testInfo, 'resting-gladiators-row', row);

    // The keyboard path of a camp click: the card takes the focus, says where Otho is, and why Follow is off.
    await row.getByRole('button', { name: 'Profile: Otho', exact: true }).focus();
    await page.keyboard.press('Enter');
    const card = page.getByRole('dialog', { name: 'Profile: Otho', exact: true });
    await expect(card).toBeFocused();
    await settled(card);
    await expect(fact(card, 'Now')).toHaveText(OTHO);
    await expect(fact(card, 'Rating')).toHaveText('1000');
    const follow = card.getByRole('button', { name: 'Follow', exact: true });
    await expect(follow).toBeDisabled();
    await expect(follow).toHaveAccessibleDescription('Otho is not in the camp right now.');
    expect(await contrastIssues(card), 'the resting profile card').toEqual([]);
    await reviewShot360(page, testInfo, 'resting-profile-card', card);
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    expect(await focusDrops(page)).toEqual([]);
  });

  test('stops drawing a gladiator in the camp when it starts resting, and draws it again when it wakes', async ({ page }) => {
    await openFixtureCamp(page, '/game/?mode=fixture');
    const sleeper = await page.evaluate(() => {
      const hook = window.__cloudiatorCamp!;
      const shown = new Set(hook.state()!.actors.filter(a => a.kind === 'player').map(a => a.id));
      return hook.world()!.actors.find(a => shown.has(a.gladiatorId) && a.location === 'training')!;
    });
    const players = await page.evaluate(() => window.__cloudiatorCamp!.state()!.players);
    await page.evaluate(id => {
      const hook = window.__cloudiatorCamp!;
      const world = hook.world()!;
      hook.setWorld({ ...world, actors: world.actors.map(a => (a.gladiatorId === id
        ? { ...a, location: 'camp', activityId: null, activityStatus: 'idle', startsAtMs: null, endsAtMs: null, visibleStage: null, resting: true } : a)) });
    }, sleeper.gladiatorId);
    await expect.poll(() => drawn(page, sleeper.gladiatorId)).toBe(false);
    expect(await page.evaluate(() => window.__cloudiatorCamp!.state()!.players)).toBe(players - 1);
    await page.evaluate(gladiator => {
      const hook = window.__cloudiatorCamp!;
      const world = hook.world()!;
      hook.setWorld({ ...world, actors: world.actors.map(a => (a.gladiatorId === gladiator.gladiatorId ? gladiator : a)) });
    }, sleeper);
    await expect.poll(() => drawn(page, sleeper.gladiatorId)).toBe(true);
    expect(await page.evaluate(() => window.__cloudiatorCamp!.state()!.players)).toBe(players);
  });

  test('previews the owner resting at home: back on its schedule at the next boundary once its presence is answered', async ({ page }, testInfo) => {
    await openFixtureCamp(page, '/game/?mode=fixture&as=resting');
    expect(await listedResting(page, ownerFixture.gladiatorId)).toBe(true);
    expect(await drawn(page, ownerFixture.gladiatorId)).toBe(false);
    const mine = await settled(await openMenu(page, 'My gladiator'));
    // The presence sent on load is answered, and the owner read again says when the gladiator returns: the start of the
    // next slot, as the Schedule panel formats its starts.
    const line = `Resting at home: back on your schedule at ${await slotTime(page, worldFixture.slotIndex + 1)}`;
    await expect(activityLine(mine)).toHaveText(line);
    await expect(mine.getByText('Training at the practice yard')).toHaveCount(0);
    expect(await contrastIssues(mine), 'My gladiator while resting').toEqual([]);
    await reviewShot360(page, testInfo, 'resting-owner-line', activityLine(mine));
    // Everyone, the owner too, sees the public sentence in the list; its own gladiator cannot be found in the camp.
    const roster = await openMenu(page, 'Gladiators');
    // (The demo crowd has another Aster: the owner's row is the one marked "(you)".)
    await expect(rosterRow(page, roster, 'Aster').filter({ hasText: '(you)' })).toContainText(ASTER);
    await expect(roster.getByRole('button', { name: 'Find my gladiator' })).toBeDisabled();
    // At that boundary its schedule applies again: the line no longer says it rests.
    const back = await openMenu(page, 'My gladiator');
    await page.evaluate(ms => window.__cloudiatorShell!.clock.freeze(ms), (worldFixture.slotIndex + 1) * SLOT_MS);
    await expect(activityLine(back)).toHaveText('Preparing your next activity');
  });
});

test.describe('the owner presence in live mode', () => {
  test.skip(production, 'Live mode uses development-only intercepted Supabase transport.');

  test('sends one presence after sign-in, then one 6 hours later with a new operation id', async ({ page, context }) => {
    // A session that outlives the 6 hours, and a gladiator with an activity: its presence needs no owner read.
    const user = await seedSession(context, testUser(), { expiresIn: 86_400 });
    const live = await routeLiveReads(context, { world: { ...worldFixture, revision: 'live-1' }, owner: ownerFixture });
    await page.clock.install();
    await page.goto('/game/');
    await expectOwnerShown(page, 'Aster');
    await expect.poll(() => live.presences.length).toBe(1);
    expect(live.presences[0].reader).toBe(user.id);
    const owners = live.count('owner_state');
    await page.waitForTimeout(1_000);
    expect(live.presences).toHaveLength(1);
    expect(live.count('owner_state'), 'no owner read for an active gladiator\'s presence').toBe(owners);
    // Not again before the 6 hours.
    await page.clock.fastForward(HOUR);
    await page.waitForTimeout(500);
    expect(live.presences).toHaveLength(1);
    await page.clock.fastForward(5 * HOUR);
    await expect.poll(() => live.presences.length).toBe(2);
    expect(live.presences[1].reader).toBe(user.id);
    expect(live.presences[1].operationId).not.toBe(live.presences[0].operationId);
  });

  test('sends no presence for a visitor', async ({ page, context }) => {
    const live = await routeLiveReads(context, { world: { ...worldFixture, revision: 'live-1' } });
    const sent: string[] = [];
    page.on('request', request => { if (request.url().includes('/functions/v1/')) sent.push(request.url()); });
    await page.goto('/game/');
    await expect(joinButton(page)).toBeVisible({ timeout: 45_000 });
    await page.waitForTimeout(1_500);
    expect(live.presences).toEqual([]);
    expect(sent).toEqual([]);
  });

  test('reads a resting owner once more after its presence, and shows when it returns', async ({ page, context }, testInfo) => {
    await seedSession(context);
    const slot = worldFixture.slotIndex;
    // Resting at home in the current slot (40 minutes in, held), with no signal since it began: the server cannot say yet
    // when it returns.
    const resting: OwnerState = { ...structuredClone(ownerFixture), currentActivity: null, processedSlotIndex: slot, restingUntilSlot: null };
    const world: WorldSnapshot = { ...worldFixture, revision: 'live-resting', actors: [restingActor(worldFixture.actors[0])] };
    const live = await routeLiveReads(context, { world, owner: resting, serverNowMs: () => worldFixture.serverNowMs });
    // The presence records the signal: the next owner read says the next boundary returns it (Task 23.8).
    await context.route(`${SUPABASE_URL}/functions/v1/game-command`, async route => {
      if (isPresence(route.request())) live.setOwner({ ...resting, restingUntilSlot: slot + 1 });
      await route.fallback();
    });
    await page.goto('/game/');
    await expectOwnerShown(page, 'Aster');
    const mine = await openMenu(page, 'My gladiator');
    await expect(activityLine(mine)).toHaveText(`Resting at home: back on your schedule at ${await slotTime(page, slot + 1)}`);
    expect(live.presences).toHaveLength(1);
    expect(live.count('owner_state'), 'the first read and the one after the presence').toBe(2);
    await page.waitForTimeout(1_000);
    expect(live.count('owner_state')).toBe(2);
    await page.screenshot({ path: testInfo.outputPath(`resting-${testInfo.project.name}-live-owner-line.png`) });
  });
});

test.describe('the exported game', () => {
  test.skip(!production, 'Runs against the static production export.');

  test('refuses the resting preview and sends no presence without a session', async ({ page }) => {
    const sent: string[] = [];
    page.on('request', request => { if (request.url().includes('/functions/v1/')) sent.push(request.url()); });
    await page.goto('/game/?mode=fixture&as=resting');
    await expect(page.getByText('Fixture preview is unavailable in this build.')).toBeVisible({ timeout: 45_000 });
    await page.waitForTimeout(1_000);
    expect(sent).toEqual([]);
    await expect(page.getByText(/Resting at home/)).toHaveCount(0);
  });
});
