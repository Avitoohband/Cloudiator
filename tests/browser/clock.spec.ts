// Patch A item 7: one clock for every time of day. A live player's Schedule (the estimated next starts) and the Results
// list (each row's settlement time) both follow the clock setting stored on the device (`cloudiator.clock.v1`), and a change
// of it reaches them without a reload. With storage that throws, the page runs on the device's own choice. The account menu
// changes the setting (Task 3): its Clock switch is pressed here as a player does; a stored value, and the `storage` event another
// tab would send, stand in for a change made elsewhere.
import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type Locator, type Page } from './fixtures';
import type { ResultRow } from '../../supabase/functions/_shared/contracts/reads';
import { ownerFixture } from '../fixtures/domain';
import { SLOT_MS, emptyWorld, routeLiveReads, seedSession } from './live-routes';
import { reviewShot, reviewShot360 } from './review-shots';
import { cornerChip, openChipMenu, openMenu } from './shell-helpers';

const production = process.env.PLAYWRIGHT_STATIC === 'true';
const KEY = 'cloudiator.clock.v1';
/** The settlement time of the first result below (the specs run in UTC): Sat 10 Oct, 15:40; the second settled one slot (80 minutes) earlier. */
const SETTLED = Date.UTC(2026, 9, 10, 15, 40);
const TWENTY_FOUR = /\b\d{2}:\d{2}\b/;
const TWELVE = /\d{1,2}:\d{2}\s[AP]M/;
const RESULTS_24 = ['Training · Sat 10 Oct, 15:40', 'Arena · Sat 10 Oct, 14:20'];
const RESULTS_12 = ['Training · Sat 10 Oct, 3:40 PM', 'Arena · Sat 10 Oct, 2:20 PM'];

test.describe('the clock setting in a live camp', () => {
  test.skip(production, 'Live UI uses development-only intercepted Supabase transport.');
  test.use({ timezoneId: 'UTC', locale: 'en-US' });

  /**
   * A signed-in player with a Schedule to show and two recent results. `stored` is put in the device's storage when the page first
   * loads (not on a later load, so a spec can change it and reload); null stores nothing.
   */
  async function player(context: BrowserContext, stored: string | null) {
    await seedSession(context);
    if (stored !== null) await context.addInitScript(([key, value]) => { if (localStorage.getItem(key) === null) localStorage.setItem(key, value); }, [KEY, stored]);
    const owner = structuredClone(ownerFixture);
    owner.processedSlotIndex = Math.floor(Date.now() / SLOT_MS);
    const recent: ResultRow[] = [
      { gladiatorId: owner.gladiatorId, name: owner.name, summary: { activityId: randomUUID(), resolvedKind: 'training', result: 'completed', success: true,
        settledAtMs: SETTLED, replayExpiry: { state: 'expired' } } },
      { gladiatorId: randomUUID(), name: 'Varro', summary: { activityId: randomUUID(), resolvedKind: 'arena', result: 'victory', success: true,
        settledAtMs: SETTLED - SLOT_MS, replayExpiry: { state: 'expired' } } },
    ];
    await routeLiveReads(context, { world: emptyWorld(), owner, recent });
  }
  const starts = (page: Page) => page.locator('.planning-form p').filter({ hasText: /^Estimated next start:/ });
  /** The "kind · day, time" line of each Results row (the time's no-break space read as an ordinary one). */
  async function resultTimes(page: Page) {
    const lines = (await openMenu(page, 'Results')).locator('p', { hasText: /^(Training|Arena) · / });
    await expect(lines).toHaveCount(2);
    return (await lines.allTextContents()).map(text => text.replace(/\s/g, ' '));
  }
  async function openSchedule(page: Page) {
    await page.goto('/game/');
    await openMenu(page, 'Schedule');
    await expect(starts(page)).toHaveCount(3);
    await page.waitForFunction(() => window.__cloudiatorShell?.clock.synced() === true);
  }
  /** What another tab does when it changes the setting: the stored value, then the `storage` event this page hears. */
  const otherTabSets = (page: Page, value: string) =>
    page.evaluate(([key, mode]) => { localStorage.setItem(key, mode); window.dispatchEvent(new StorageEvent('storage', { key, newValue: mode })); }, [KEY, value]);

  /** The account menu's Clock group, and one of its two buttons. */
  const clockGroup = (menu: Locator) => menu.getByRole('group', { name: 'Clock', exact: true });
  const clockButton = (menu: Locator, label: '12-hour' | '24-hour') => clockGroup(menu).getByRole('button', { name: label, exact: true });
  const expectStarts = async (page: Page, form: 'twelve' | 'twenty-four') => {
    for (const index of [0, 1, 2]) {
      if (form === 'twelve') await expect(starts(page).nth(index)).toHaveText(TWELVE);
      else { await expect(starts(page).nth(index)).toHaveText(TWENTY_FOUR); await expect(starts(page).nth(index)).not.toHaveText(/[AP]M/); }
    }
  };

  test('switches every time on the screen at once from the account menu, and remembers it on this device', async ({ page, context }, testInfo) => {
    await player(context, null);
    await openSchedule(page);
    // The device (en-US) starts on the 12-hour clock.
    await expectStarts(page, 'twelve');
    let menu = await openChipMenu(page);
    await expect(clockGroup(menu)).toContainText('Clock');
    await expect(clockButton(menu, '12-hour')).toHaveAttribute('aria-pressed', 'true');
    await expect(clockButton(menu, '24-hour')).toHaveAttribute('aria-pressed', 'false');
    await reviewShot(page, testInfo, 'clockmenu-12');

    // 24-hour: the estimated starts lose AM/PM at once, with no reload, and the menu stays open with the button pressed.
    await clockButton(menu, '24-hour').click();
    await expectStarts(page, 'twenty-four');
    await expect(clockButton(menu, '24-hour')).toHaveAttribute('aria-pressed', 'true');
    await expect(clockButton(menu, '12-hour')).toHaveAttribute('aria-pressed', 'false');
    await expect(menu).toBeVisible();
    await reviewShot(page, testInfo, 'clockmenu-24');
    await reviewShot360(page, testInfo, 'clockmenu-24');
    // The Results list follows too (opening it closes the menu, which a press elsewhere does).
    expect(await resultTimes(page)).toEqual(RESULTS_24);
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key), KEY)).toBe('24');

    // A reload: still 24-hour, and the device holds it.
    await openSchedule(page);
    await expectStarts(page, 'twenty-four');
    menu = await openChipMenu(page);
    await expect(clockButton(menu, '24-hour')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(key => localStorage.getItem(key), KEY)).toBe('24');

    // 12-hour: AM/PM is back.
    await clockButton(menu, '12-hour').click();
    await expectStarts(page, 'twelve');
    await expect(clockButton(menu, '12-hour')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(key => localStorage.getItem(key), KEY)).toBe('12');
    expect(await resultTimes(page)).toEqual(RESULTS_12);
  });

  test.describe('starts on the device hour cycle', () => {
    test.describe('with en-GB', () => {
      test.use({ locale: 'en-GB' });
      test('24-hour is pressed, and the times are written that way', async ({ page, context }) => {
        await player(context, null);
        await openSchedule(page);
        await expectStarts(page, 'twenty-four');
        const menu = await openChipMenu(page);
        await expect(clockButton(menu, '24-hour')).toHaveAttribute('aria-pressed', 'true');
        await expect(clockButton(menu, '12-hour')).toHaveAttribute('aria-pressed', 'false');
      });
    });
    test.describe('with en-US', () => {
      test.use({ locale: 'en-US' });
      test('12-hour is pressed, and the times are written that way', async ({ page, context }) => {
        await player(context, null);
        await openSchedule(page);
        await expectStarts(page, 'twelve');
        const menu = await openChipMenu(page);
        await expect(clockButton(menu, '12-hour')).toHaveAttribute('aria-pressed', 'true');
        await expect(clockButton(menu, '24-hour')).toHaveAttribute('aria-pressed', 'false');
      });
    });
  });

  test('keeps working when storage throws', async ({ page, context }) => {
    await player(context, null);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    // Only this key is refused (the signed-in session lives in the same storage).
    await context.addInitScript(key => {
      const { getItem, setItem } = Storage.prototype;
      Storage.prototype.getItem = function (name: string) { if (name === key) throw new Error('blocked'); return getItem.call(this, name); };
      Storage.prototype.setItem = function (name: string, value: string) { if (name === key) throw new Error('blocked'); return setItem.call(this, name, value); };
    }, KEY);
    await openSchedule(page);
    const menu = await openChipMenu(page);
    await clockButton(menu, '24-hour').click();
    await expectStarts(page, 'twenty-four');
    await expect(clockButton(menu, '24-hour')).toHaveAttribute('aria-pressed', 'true');
    await clockButton(menu, '12-hour').click();
    await expectStarts(page, 'twelve');
    await expect(clockButton(menu, '12-hour')).toHaveAttribute('aria-pressed', 'true');
    await expect(cornerChip(page)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('every time of day follows the stored clock setting', async ({ page, context }, testInfo) => {
    await player(context, '24');
    await openSchedule(page);
    for (const line of await starts(page).allTextContents()) {
      expect(line).toMatch(TWENTY_FOUR);
      expect(line).not.toMatch(/[AP]M/);
    }
    await reviewShot(page, testInfo, 'clock-schedule-24');
    await reviewShot360(page, testInfo, 'clock-schedule-24', starts(page).first());
    expect(await resultTimes(page)).toEqual(RESULTS_24);
    await reviewShot(page, testInfo, 'clock-results-24');
    await reviewShot360(page, testInfo, 'clock-results-24');

    // The same player with the other choice stored: the lines match /\d{1,2}:\d{2}\s[AP]M/ and end on AM or PM.
    await page.evaluate(([key, value]) => localStorage.setItem(key, value), [KEY, '12']);
    await openSchedule(page);
    for (const line of await starts(page).allTextContents()) {
      expect(line).toMatch(TWELVE);
      expect(line).toMatch(/[AP]M$/);
    }
    await reviewShot(page, testInfo, 'clock-schedule-12');
    await reviewShot360(page, testInfo, 'clock-schedule-12', starts(page).first());
    expect(await resultTimes(page)).toEqual(RESULTS_12);
    await reviewShot(page, testInfo, 'clock-results-12');
    await reviewShot360(page, testInfo, 'clock-results-12');
  });

  test('a change of the setting moves the times on screen without a reload', async ({ page, context }) => {
    await player(context, '24');
    await openSchedule(page);
    await expect(starts(page).first()).toHaveText(TWENTY_FOUR);
    await otherTabSets(page, '12');
    for (const index of [0, 1, 2]) await expect(starts(page).nth(index)).toHaveText(TWELVE);
    expect(await resultTimes(page)).toEqual(RESULTS_12);
    await otherTabSets(page, '24');
    await expect.poll(() => resultTimes(page)).toEqual(RESULTS_24);
  });

  test('a stored value it does not know falls back to the device\'s own choice', async ({ page, context }) => {
    await player(context, 'x');
    await openSchedule(page);
    // The device (en-US) writes a 12-hour clock.
    for (const line of await starts(page).allTextContents()) expect(line).toMatch(TWELVE);
    expect(await resultTimes(page)).toEqual(RESULTS_12);
  });

  test('keeps working when the device\'s storage refuses the setting', async ({ page, context }) => {
    await player(context, null);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    // Only this key is refused (the signed-in session lives in the same storage).
    await context.addInitScript(key => {
      const { getItem, setItem } = Storage.prototype;
      Storage.prototype.getItem = function (name: string) { if (name === key) throw new Error('blocked'); return getItem.call(this, name); };
      Storage.prototype.setItem = function (name: string, value: string) { if (name === key) throw new Error('blocked'); return setItem.call(this, name, value); };
    }, KEY);
    await openSchedule(page);
    for (const line of await starts(page).allTextContents()) expect(line).toMatch(TWELVE);
    expect(await resultTimes(page)).toEqual(RESULTS_12);
    // A storage event for the refused key still re-reads, without a throw.
    await page.evaluate(key => window.dispatchEvent(new StorageEvent('storage', { key })), KEY);
    await openMenu(page, 'Schedule');
    await expect(starts(page).first()).toHaveText(TWELVE);
    expect(errors).toEqual([]);
  });
});
