import { expect, test, type Locator, type Page } from './fixtures';
import { ownerFixture } from '../fixtures/domain';
import { ownBuild } from '../../src/features/character/profile-card';
import { cardFighter, comparisonRows, dummyFighter, presetSetup } from '../../src/features/practice/practice';
import { noHorizontalScroll } from './a11y-helpers';
import { menuDialog, openMenu, quietArrivals, touchLayout } from './shell-helpers';

// Patch 1.9 Task 18 (additions spec section 3, the approved practice mockups): a gold ⚔ Practice fight button under Stats in My gladiator
// opens the dummy dialog; ⚔ Fight runs a local fight under the Arena's rules and plays it in the replay viewer over the camp, one history
// entry deep. Nothing is sent or saved. The fixture preview's Aster: a Guardian, level 1, 2 points in each attribute, nothing worn.
const production = process.env.PLAYWRIGHT_STATIC === 'true';
/** The SDD workspace, when the run should save the review screenshots there. */
const shotDir = process.env.PRACTICE_SHOT_DIR;

const INTRO = 'Test your build against a training dummy you set up. Free: no stamina, no schedule slot, no rating. Nothing is saved.';
const ENTRY = 'Test this build against a training dummy you set up. Free: no stamina, no schedule slot, no rating. Nothing is saved.';
const HELP_1 = '14 attribute points: the most a level 1 gladiator can have from Training (10 + 4 per level). Levels 5 and 10 open better gear.';
const NOTE = 'Practice fights give no rewards and change nothing. Close this and the fight is gone.';
const ATTRIBUTES = ['strength', 'agility', 'vitality', 'endurance', 'precision'] as const;

const practiceButton = (page: Page) => menuDialog(page, 'My gladiator').getByRole('button', { name: 'Practice fight', exact: true });
const practiceDialog = (page: Page) => page.getByRole('dialog', { name: 'Practice fight', exact: true });
const resultScene = (page: Page) => page.getByRole('dialog', { name: 'Practice replay', exact: true });
const presets = (dialog: Locator) => dialog.getByRole('group', { name: 'Dummy', exact: true });
const stances = (dialog: Locator) => dialog.getByRole('group', { name: 'Stance', exact: true });
const level = (dialog: Locator) => dialog.getByTestId('practice-level');
const pointsLine = (dialog: Locator) => dialog.getByTestId('practice-points');
const fightButton = (dialog: Locator) => dialog.getByRole('button', { name: 'Fight', exact: true });
const gearSelect = (dialog: Locator, label: string) => dialog.getByRole('combobox', { name: label, exact: true });
const hook = async (page: Page) => (await page.evaluate(() => window.__cloudiatorReplay?.state() ?? null))!;
const replayReady = (page: Page) => page.waitForFunction(() => window.__cloudiatorReplay !== undefined, null, { timeout: 45_000 });
const seedOf = (page: Page) => resultScene(page).getAttribute('data-practice-seed');
const box = async (locator: Locator) => (await locator.boundingBox())!;

/** Every request to the game's Edge Functions or database (a command, a write): practice must send none. */
function watchGateway(page: Page) {
  const sent: string[] = [];
  page.on('request', request => { if (/\/(functions|rest)\/v1\//.test(request.url())) sent.push(`${request.method()} ${request.url()}`); });
  return sent;
}

/** The fixture camp with My gladiator open, once the owner has loaded (the practice button is there). */
async function openGladiator(page: Page): Promise<Locator> {
  await page.goto('/game/?mode=fixture');
  const menu = await openMenu(page, 'My gladiator');
  await expect(practiceButton(page)).toBeVisible({ timeout: 45_000 });
  return menu;
}
async function openPractice(page: Page): Promise<Locator> {
  await practiceButton(page).click();
  const dialog = practiceDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}
/** The pressed pill of a group. */
const pressed = (group: Locator) => group.getByRole('button', { pressed: true });
async function setLevel(dialog: Locator, target: number) {
  for (let now = Number(await level(dialog).textContent()); now !== target; now = Number(await level(dialog).textContent())) {
    await dialog.getByRole('button', { name: now < target ? 'Higher level' : 'Lower level', exact: true }).click();
  }
}
/** Fights, then waits for the replay to load and skips to its result card. */
async function fightToEnd(page: Page, dialog: Locator) {
  await fightButton(dialog).click();
  await expect(resultScene(page)).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await replayReady(page);
  await skipToEnd(page);
}
async function skipToEnd(page: Page) {
  await resultScene(page).getByRole('button', { name: 'Skip to the result', exact: true }).click();
  await expect(resultScene(page).locator('[data-end-card]')).toBeVisible();
}
async function shot(page: Page, name: string) {
  if (shotDir) await page.screenshot({ path: `${shotDir}/${name}.png` });
}

test.describe('practice fights from My gladiator (fixture)', () => {
  test.skip(production, 'The camp harness runs on the fixture preview only.');
  test.beforeEach(async ({ context }) => { await quietArrivals(context); });

  test('My gladiator offers a gold Practice fight button under Stats', async ({ page }) => {
    const menu = await openGladiator(page);
    const button = practiceButton(page);
    await expect(button).toHaveText('⚔ Practice fight');
    await expect(button).toHaveAccessibleDescription(ENTRY);
    await expect(menu.getByText(ENTRY, { exact: true })).toBeVisible();
    // Gold: the shell's accent with its dark ink.
    await expect(button).toHaveCSS('background-color', 'rgb(230, 180, 80)');
    await expect(button).toHaveCSS('color', 'rgb(42, 29, 5)');
    // Under Stats.
    const stats = menu.getByRole('region', { name: 'Stats', exact: true });
    expect((await box(button)).y).toBeGreaterThan((await box(stats)).y + (await box(stats)).height - 1);
  });

  test('the dialog: its parts, the dummy at the owner\'s level, the comparison, and Escape, Cancel and Tab', async ({ page }, info) => {
    await openGladiator(page);
    const touch = await touchLayout(page);
    const dialog = await openPractice(page);
    await expect(dialog.getByRole('heading', { level: 2 })).toHaveText('⚔ Practice fight');
    // The focus is inside, and the page behind is a modal's (inert).
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
    expect(await dialog.evaluate(element => element instanceof HTMLDialogElement && element.matches(':modal'))).toBe(true);
    await expect(dialog.getByText(INTRO, { exact: true })).toBeVisible();

    await expect(presets(dialog).getByRole('button')).toHaveText(['Balanced', 'Tank', 'Glass cannon', 'Custom']);
    await expect(pressed(presets(dialog))).toHaveText(['Balanced']);
    await expect(level(dialog)).toHaveText('1');
    await expect(dialog.getByRole('button', { name: 'Lower level', exact: true })).toHaveAttribute('aria-disabled', 'true');
    await expect(dialog.getByRole('button', { name: 'Higher level', exact: true })).not.toHaveAttribute('aria-disabled', 'true');
    await expect(stances(dialog).getByRole('button')).toHaveText(['Offensive', 'Balanced', 'Defensive']);
    await expect(pressed(stances(dialog))).toHaveText(['Balanced']);
    await expect(dialog.getByText(HELP_1, { exact: true })).toBeVisible();
    // Balanced at level 1: 14 points, 20% each, floored, the rest to the first shares.
    const values = await Promise.all(ATTRIBUTES.map(key => dialog.getByTestId(`practice-${key}`).textContent()));
    expect(values).toEqual(['3', '3', '3', '3', '2']);
    for (const key of ATTRIBUTES) {
      await expect(dialog.getByRole('button', { name: `Less ${key}`, exact: true })).toBeVisible();
      await expect(dialog.getByRole('button', { name: `More ${key}`, exact: true })).toBeVisible();
    }
    await expect(pointsLine(dialog)).toHaveText('Points left: 0 of 14');

    await expect(gearSelect(dialog, 'Weapon').locator('option')).toHaveText(['None', 'Sword', 'Axe', 'Spear (two hands)', 'Bow (two hands)']);
    await expect(gearSelect(dialog, 'Off hand').locator('option')).toHaveText(['None', 'Round shield']);
    await expect(gearSelect(dialog, 'Head').locator('option')).toHaveText(['None', 'Leather hood', 'Iron helmet']);
    await expect(gearSelect(dialog, 'Body').locator('option')).toHaveText(['None', 'Light armor', 'Heavy armor']);
    await expect(gearSelect(dialog, 'Feet').locator('option')).toHaveText(['None', 'Light boots', 'Heavy boots']);
    await expect(gearSelect(dialog, 'Gear level').locator('option')).toHaveText(['Level 1']);
    // The Balanced preset's gear.
    await expect(gearSelect(dialog, 'Weapon')).toHaveValue('sword');
    await expect(gearSelect(dialog, 'Off hand')).toHaveValue('round-shield');
    await expect(gearSelect(dialog, 'Head')).toHaveValue('leather-hood');
    await expect(gearSelect(dialog, 'Body')).toHaveValue('light-armor');
    await expect(gearSelect(dialog, 'Feet')).toHaveValue('light-boots');

    const preview = dialog.getByTestId('practice-preview');
    await expect(preview.getByText('Training dummy', { exact: true })).toBeVisible();
    await expect(preview.getByText('Level 1 · no class bonus · balanced stance', { exact: true })).toBeVisible();
    const table = dialog.getByRole('table', { name: 'You vs the dummy under Arena rules' });
    await expect(table.locator('thead th')).toHaveText(['Arena rules', 'You', 'Dummy']);
    const rows = comparisonRows(cardFighter('guardian', ownBuild(ownerFixture)), dummyFighter(presetSetup('balanced', 1)));
    await expect(table.locator('tbody tr')).toHaveText(rows.map(row => row.join('')));
    const footer = dialog.getByTestId('practice-footer');
    await expect(footer.locator('p')).toHaveText(touch ? 'Your current build, Arena rules.'
      : 'You fight with your current build (Guardian, level 1). Arena rules: renown gear counts 10% more.');
    await expect(footer.getByRole('button')).toHaveText(['Cancel', '⚔ Fight']);
    await shot(page, info.project.name === 'mobile' ? 'task-18-dialog-phone' : 'task-18-dialog-desktop');

    // Tab stays inside: from ⚔ Fight (the last) to × (the first), and back.
    const close = dialog.getByRole('button', { name: 'Close', exact: true });
    await fightButton(dialog).focus();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(fightButton(dialog)).toBeFocused();

    // Escape and Cancel close it and give the focus back to the button.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(practiceButton(page)).toBeFocused();
    await openPractice(page);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(practiceButton(page)).toBeFocused();
    await expect(resultScene(page)).toHaveCount(0);
  });

  test('any change makes the dummy Custom; a two-handed weapon empties the off hand; heavy gear overloads it', async ({ page }) => {
    await openGladiator(page);
    const dialog = await openPractice(page);
    await stances(dialog).getByRole('button', { name: 'Offensive', exact: true }).click();
    await expect(pressed(presets(dialog))).toHaveText(['Custom']);
    await expect(pressed(stances(dialog))).toHaveText(['Offensive']);

    await presets(dialog).getByRole('button', { name: 'Tank', exact: true }).click();
    await expect(pressed(presets(dialog))).toHaveText(['Tank']);
    await expect(pressed(stances(dialog))).toHaveText(['Defensive']);
    await expect(gearSelect(dialog, 'Head')).toHaveValue('iron-helmet');
    await expect(gearSelect(dialog, 'Body')).toHaveValue('heavy-armor');
    await expect(gearSelect(dialog, 'Feet')).toHaveValue('heavy-boots');
    await expect(dialog.getByTestId('practice-preview')).toContainText('Level 1 · no class bonus · defensive stance');
    await dialog.getByRole('button', { name: 'Less vitality', exact: true }).click();
    await expect(pressed(presets(dialog))).toHaveText(['Custom']);
    await expect(pointsLine(dialog)).toHaveText('Points left: 1 of 14');

    await presets(dialog).getByRole('button', { name: 'Tank', exact: true }).click();
    await gearSelect(dialog, 'Feet').selectOption('light-boots');
    await expect(pressed(presets(dialog))).toHaveText(['Custom']);

    // A two-handed weapon: the off hand is off, and says why.
    await gearSelect(dialog, 'Weapon').selectOption('spear');
    const offHand = gearSelect(dialog, 'Off hand');
    await expect(offHand).toBeDisabled();
    await expect(offHand.locator('option:checked')).toHaveText('Two-handed weapon');
    await gearSelect(dialog, 'Weapon').selectOption('sword');
    await expect(offHand).toBeEnabled();
    await expect(offHand).toHaveValue('round-shield');

    // Glass cannon (no Endurance: carries 20) with a spear, an iron helmet, heavy armor and heavy boots: load 24, a fifth over.
    await presets(dialog).getByRole('button', { name: 'Glass cannon', exact: true }).click();
    await expect(dialog.getByTestId('practice-overload')).toHaveCount(0);
    await gearSelect(dialog, 'Body').selectOption('heavy-armor');
    await gearSelect(dialog, 'Head').selectOption('iron-helmet');
    await gearSelect(dialog, 'Feet').selectOption('heavy-boots');
    await expect(dialog.getByTestId('practice-overload')).toHaveText('Overloaded: load 24 of 20, fighting at 90%.');
    await gearSelect(dialog, 'Body').selectOption('');
    await expect(dialog.getByTestId('practice-overload')).toHaveCount(0);
  });

  test('a lower level clamps the gear level, and too many points show the line and stop the fight (Review Focus 3)', async ({ page }) => {
    const sent = watchGateway(page);
    await openGladiator(page);
    const dialog = await openPractice(page);
    await presets(dialog).getByRole('button', { name: 'Tank', exact: true }).click();
    await setLevel(dialog, 10);
    await expect(pressed(presets(dialog))).toHaveText(['Tank']);
    await expect(gearSelect(dialog, 'Gear level').locator('option')).toHaveText(['Level 1', 'Level 5', 'Level 10']);
    await expect(gearSelect(dialog, 'Gear level')).toHaveValue('10');
    await expect(pointsLine(dialog)).toHaveText('Points left: 0 of 50');
    await setLevel(dialog, 4);
    await expect(pressed(presets(dialog))).toHaveText(['Tank']);
    await expect(gearSelect(dialog, 'Gear level').locator('option')).toHaveText(['Level 1']);
    await expect(gearSelect(dialog, 'Gear level')).toHaveValue('1');
    await expect(pointsLine(dialog)).toHaveText('Points left: 0 of 26');
    await expect(dialog.getByText('26 attribute points: the most a level 4 gladiator can have from Training (10 + 4 per level). Levels 5 and 10 open better gear.',
      { exact: true })).toBeVisible();

    // Custom keeps its points when the level drops: too many for the level.
    await setLevel(dialog, 10);
    await gearSelect(dialog, 'Gear level').selectOption('5');
    await expect(pressed(presets(dialog))).toHaveText(['Custom']);
    await setLevel(dialog, 4);
    await expect(gearSelect(dialog, 'Gear level')).toHaveValue('1');
    await expect(pointsLine(dialog)).toHaveText('24 points too many for level 4');
    await expect(fightButton(dialog)).toHaveAttribute('aria-disabled', 'true');
    // The preview does not fight a dummy the rules would refuse: it says why instead of the table.
    await expect(dialog.getByRole('table')).toHaveCount(0);
    await expect(dialog.getByTestId('practice-preview')).toContainText('24 points too many for level 4');
    // Playwright waits for an aria-disabled button to be enabled: force the press, as a player's tap would land.
    await fightButton(dialog).click({ force: true });
    await expect(dialog).toBeVisible();
    await expect(resultScene(page)).toHaveCount(0);
    await fightButton(dialog).focus();
    await page.keyboard.press('Enter');
    await expect(resultScene(page)).toHaveCount(0);
    // Taking the points back makes it a fight again.
    await setLevel(dialog, 10);
    await expect(pointsLine(dialog)).toHaveText('Points left: 0 of 50');
    await expect(fightButton(dialog)).not.toHaveAttribute('aria-disabled', 'true');
    await expect(dialog.getByRole('table')).toHaveCount(1);
    expect(sent).toEqual([]);
  });

  test('Fight plays the fight over the camp: header, end card, Fight again, Change dummy, and nothing is sent', async ({ page }, info) => {
    const sent = watchGateway(page);
    await openGladiator(page);
    const touch = await touchLayout(page);
    let dialog = await openPractice(page);
    await presets(dialog).getByRole('button', { name: 'Tank', exact: true }).click();
    await setLevel(dialog, 3);
    await fightToEnd(page, dialog);

    const scene = resultScene(page);
    const back = scene.getByRole('button', { name: 'Back to My gladiator', exact: true });
    await expect(back).toHaveText('← My gladiator');
    await expect(scene.locator('header p.eyebrow')).toHaveText('PRACTICE · TRAINING DUMMY · ARENA RULES');
    await expect(scene.getByRole('heading', { level: 2, name: 'Aster vs Training dummy', exact: true })).toBeVisible();
    const tag = scene.getByText('Practice — not saved', { exact: true });
    await expect(tag).toBeVisible();
    // The fixture banner's amber, which already means "not saved".
    await expect(tag).toHaveCSS('background-color', 'rgba(71, 54, 35, 0.92)');
    await expect(tag).toHaveCSS('color', 'rgb(255, 225, 163)');
    const kinds = await scene.locator('[data-fighter-kind]').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).innerText));
    expect(kinds).toEqual(['GUARDIAN', 'DUMMY']);

    const state = await hook(page);
    expect(state.endCard).toBe(true);
    const winner = state.winnerId === 'practice-you' ? 'Aster' : 'Training dummy';
    const loser = winner === 'Aster' ? 'Training dummy' : 'Aster';
    const card = scene.locator('[data-end-card]');
    await expect(card.locator('p.eyebrow')).toHaveText(touch ? [] : ['RESULT · PRACTICE']);
    await expect(card.getByText(`${winner} wins`, { exact: true })).toBeVisible();
    await expect(card.getByText(new RegExp(`^(${loser} is defeated\\.|Time ran out .*|.*tie-break chose ${winner}\\.)$`))).toBeVisible();
    await expect(card.getByRole('list').getByRole('listitem')).toHaveText(['No rewards · no rating · not saved']);
    await expect(card.getByRole('button')).toHaveText([touch ? '↺ Again' : '↺ Watch again', '⚔ Fight again', 'Change dummy']);
    await expect(card.getByRole('button', { name: 'Fight again', exact: true })).toHaveCSS('background-color', 'rgb(242, 198, 107)');
    const result = scene.getByRole('region', { name: 'Result', exact: true });
    await expect(result).toContainText(NOTE);
    await expect(result).toContainText(`${winner} wins`);
    await expect(result).not.toContainText('Rewards are credited');
    await expect(result).not.toContainText('kept until');
    await expect(result).not.toContainText('Credited rewards');
    await expect(scene).not.toContainText('TOURNAMENT');
    // The end card sits on the arena.
    const arena = await box(card.locator('xpath=..'));
    const shown = await box(card);
    expect(shown.y + shown.height).toBeLessThanOrEqual(arena.y + arena.height + 1);
    await shot(page, info.project.name === 'mobile' ? 'task-18-end-phone' : 'task-18-end-desktop');

    // Watch again replays the same fight.
    const first = await seedOf(page);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    await card.getByRole('button', { name: touch ? 'Again' : 'Watch again', exact: true }).click();
    await expect(card).toHaveCount(0);
    expect(await seedOf(page)).toBe(first);

    // Fight again: a new roll with the same builds.
    await skipToEnd(page);
    await card.getByRole('button', { name: 'Fight again', exact: true }).click();
    await expect.poll(() => seedOf(page)).not.toBe(first);
    await replayReady(page);
    await expect(card).toHaveCount(0);
    const again = await hook(page);
    expect(again.endCard).toBe(false);
    expect(again.positionMs).toBeLessThan(1500);
    await expect(scene.getByRole('heading', { level: 2, name: 'Aster vs Training dummy', exact: true })).toBeVisible();
    await expect(scene.getByRole('button', { name: 'Pause', exact: true })).toBeFocused();

    // Change dummy reopens the dialog with its settings.
    await skipToEnd(page);
    await card.getByRole('button', { name: 'Change dummy', exact: true }).click();
    await expect(scene).toHaveCount(0);
    dialog = practiceDialog(page);
    await expect(dialog).toBeVisible();
    await expect(pressed(presets(dialog))).toHaveText(['Tank']);
    await expect(level(dialog)).toHaveText('3');
    await expect(pressed(stances(dialog))).toHaveText(['Defensive']);
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(practiceButton(page)).toBeFocused();
    expect(sent).toEqual([]);
  });

  test('one history entry: Back, the back button and Escape each close it to My gladiator; a reload shows no fight', async ({ page }) => {
    await openGladiator(page);
    const length = await page.evaluate(() => history.length);
    const fight = async () => {
      const dialog = await openPractice(page);
      await fightButton(dialog).click();
      await expect(resultScene(page)).toBeVisible();
      await replayReady(page);
      expect(await page.evaluate(() => history.length)).toBe(length + 1);
    };
    const closed = async () => {
      await expect(resultScene(page)).toHaveCount(0);
      await expect(menuDialog(page, 'My gladiator')).toBeVisible();
      await expect(practiceButton(page)).toBeFocused();
    };

    await fight();
    await page.evaluate(() => history.back());
    await closed();
    await fight();
    await resultScene(page).getByRole('button', { name: 'Back to My gladiator', exact: true }).click();
    await closed();
    await fight();
    await page.keyboard.press('Escape');
    await closed();

    await fight();
    await page.reload();
    await expect(page.getByTestId('chip-name')).toHaveText('Aster', { timeout: 45_000 });
    await expect(resultScene(page)).toHaveCount(0);
    await expect(practiceDialog(page)).toHaveCount(0);
  });

  test('a 360 px phone: the dialog scrolls inside itself with its footer in reach, and the result uses the touch layout', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await openGladiator(page);
    const dialog = await openPractice(page);
    expect(await noHorizontalScroll(page)).toBe(true);
    const shape = await dialog.evaluate(element => {
      const body = element.querySelector('[data-practice-body]') as HTMLElement;
      const rect = element.getBoundingClientRect();
      return { overflowY: getComputedStyle(body).overflowY, scrolls: body.scrollHeight > body.clientHeight, left: rect.left, right: rect.right, bottom: rect.bottom,
        wider: element.scrollWidth > element.clientWidth || body.scrollWidth > body.clientWidth };
    });
    expect(shape).toMatchObject({ overflowY: 'auto', scrolls: true, wider: false });
    expect(shape.left).toBeGreaterThanOrEqual(0);
    expect(shape.right).toBeLessThanOrEqual(360);
    expect(shape.bottom).toBeLessThanOrEqual(740);
    const footer = dialog.getByTestId('practice-footer');
    await expect(footer.locator('p')).toHaveText('Your current build, Arena rules.');
    for (const button of [dialog.getByRole('button', { name: 'Cancel', exact: true }), fightButton(dialog)]) {
      await expect(button).toBeInViewport();
      expect((await box(button)).height).toBeGreaterThanOrEqual(44);
    }
    // The gear at the bottom of the body scrolls into view; the footer stays where it is.
    const before = await box(fightButton(dialog));
    await gearSelect(dialog, 'Gear level').scrollIntoViewIfNeeded();
    await expect(gearSelect(dialog, 'Gear level')).toBeInViewport();
    expect((await box(fightButton(dialog))).y).toBe(before.y);
    for (const key of ATTRIBUTES) expect((await box(dialog.getByRole('button', { name: `More ${key}`, exact: true }))).height).toBeGreaterThanOrEqual(44);

    await fightToEnd(page, dialog);
    const scene = resultScene(page);
    expect(await noHorizontalScroll(page)).toBe(true);
    const heading = await box(scene.getByRole('heading', { level: 2, name: 'Aster vs Training dummy', exact: true }));
    const tag = await box(scene.getByText('Practice — not saved', { exact: true }));
    expect(tag.y).toBeGreaterThanOrEqual(heading.y + heading.height - 1);
    const card = scene.locator('[data-end-card]');
    await expect(card.getByRole('button')).toHaveText(['↺ Again', '⚔ Fight again', 'Change dummy']);
    for (const button of await card.getByRole('button').all()) expect((await box(button)).height).toBeGreaterThanOrEqual(44);
  });
});
