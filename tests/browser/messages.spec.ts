import { expect, test, type Locator, type Page } from './fixtures';
import type { GameCommand } from '../../supabase/functions/_shared/contracts/commands';
import type { ActivitySummary } from '../../supabase/functions/_shared/contracts/events';
import type { GameMessage, Inbox, OwnerState } from '../../supabase/functions/_shared/contracts/reads';
import { ownerFixture, worldFixture } from '../fixtures/domain';
import { a11yShot, contrastIssues, expectNamedControls, focusDrops, focusedElement, noHorizontalScroll, watchFocus } from './a11y-helpers';
import { SUPABASE_URL, isPresence, routeLiveReads, seedSession, type LiveNotification } from './live-routes';
import { chipToggle, cornerChip, expectOwnerShown } from './shell-helpers';
import { watchSyncPoll } from './sync-poll';

// Task 6: the messages button and panel (spec "Game messages and a free look change", Layout and Accessibility; Avi approved the
// mockup). A signed-in player sees a button left of the HUD pill with a badge of their unread messages and new results; it opens a panel with
// two tabs, Messages (patch notes and Admin) and Notifications (their own training and expedition results). Live mode uses the
// development-only intercepted transport, which stands in for the server: it answers the owner's `inbox` as the database does
// (`publishedAtMs > sinceMs` and not read; results settled after the "seen up to" mark), so the badge follows what the player does.
const production = process.env.PLAYWRIGHT_STATIC === 'true';
const NOW = worldFixture.serverNowMs;
const MIN = 60_000;
/** A local-noon time on a day of 2026, so a posting date reads the same in every time zone ("27 Oct"). */
const at = (month: number, day: number) => new Date(2026, month, day, 12).getTime();
const SINCE = at(9, 1);

const WELCOME: GameMessage = { id: 4, kind: 'admin', title: 'Welcome to Cloudiator', preview: 'Thanks for playing while the game is new.',
  body: [{ p: 'Thanks for playing Cloudiator while it is new.' }, { p: 'Something looks wrong? Tell me and I’ll fix it. — Avi' }], action: null, publishedAtMs: at(8, 20) };
const EVENING: GameMessage = { id: 1, kind: 'patch-notes', title: 'Evening Arena, waiting monsters, clearer menus', preview: 'Arena and tournaments move to the evening; market sales pay at least 1 gold.',
  body: [{ p: 'What changed:' }, { li: 'Arena runs in the evening part of the day only.' }, { li: 'Market sales pay a fee of at least 1 gold.' },
    { li: 'On expeditions, each monster waits at its spot until its fight.' }, { li: 'Character creation, the schedule and equipped gear are easier to read and use.' }],
  action: null, publishedAtMs: at(9, 26) };
const LOOK: GameMessage = { id: 2, kind: 'patch-notes', title: 'New: choose your gladiator’s look', preview: 'Pick a body, hair and colours. Changing your look is free for now.',
  body: [{ p: 'Gladiators now have their own look: a male or female body; short, long, ponytail or bald hair; and your choice of skin, hair and clothes colours.' },
    { p: 'New gladiators choose a look when they are created. Yours keeps the original look until you change it.' }], action: 'change-look', publishedAtMs: at(9, 27) };
const RELEASE: GameMessage = { id: 3, kind: 'patch-notes', title: 'Messages, gold, fixed builds and bigger beds', preview: 'Game news arrives here, money is now called gold, and saved points stay put.',
  body: [{ p: 'What changed:' }, { li: 'Messages: patch notes and news from the game arrive here, with a count on the button.' }, { li: 'Money is now called gold. Your amount is unchanged.' }],
  action: null, publishedAtMs: at(9, 28) };
const AVI: GameMessage = { id: 5, kind: 'admin', title: 'A note from Avi', preview: 'The arena opens early on Saturday.', body: [{ p: 'The arena opens early on Saturday.' }],
  action: null, publishedAtMs: at(9, 29) };
/** Newest first, as the gateway lists them: two unread for a gladiator created on 1 Oct who has read the Evening note, the Welcome one older than the gladiator. */
const MESSAGES = [RELEASE, LOOK, EVENING, WELCOME];

/** A settled result of the owner's: its credited summary at `minutes` before the server's time. */
function settled(n: number, resolvedKind: ActivitySummary['resolvedKind'], result: ActivitySummary['result'], minutesAgo: number, rewards: Partial<ActivitySummary['rewards']>,
  extra: Partial<ActivitySummary> = {}, expeditionId?: string): LiveNotification {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const summary: ActivitySummary = { activityId: id, resolvedKind, result, success: result !== 'defeat', receiptId: `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`,
    rewards: { money: 0, renown: 0, xp: 0, attributePoints: 0, items: [], overflowMoney: 0, ...rewards }, settledAtMs: NOW - minutesAgo * MIN, replayExpiry: { state: 'expired' }, ...extra };
  return { summary, ...(expeditionId ? { expeditionId } : {}) };
}
/** Three results: an Arena victory, an expedition that raised the level to 2 (a Rare sword, extra items sold) and a training. The owner is level 2 with 150 XP: 250 XP in all. */
const RESULTS = [
  settled(3, 'arena', 'victory', 10, { renown: 30 }, { ratingDelta: 12 }),
  settled(2, 'expedition', 'victory', 70, { money: 120, xp: 250, overflowMoney: 35, items: [{ catalogId: 'sword:5:rare', catalogVersion: 'v1', tier: 5, rarity: 'rare', quantity: 1 }] }, {}, 'woodland'),
  settled(1, 'training', 'completed', 150, { attributePoints: 1 }),
];
const newest = (list: readonly LiveNotification[]) => Math.max(...list.map(n => n.summary.settledAtMs));

type Server = { messages: GameMessage[]; notifications: LiveNotification[]; readIds: number[]; seenMs: number; sinceMs: number; level: { level: number; xp: number } };
/** The inbox as the database computes it for this account: what `owner_state.inbox` carries. */
const inboxOf = (s: Server): Inbox => ({
  unread: s.messages.filter(m => m.publishedAtMs > s.sinceMs && !s.readIds.includes(m.id)).length,
  readIds: s.messages.map(m => m.id).filter(id => s.readIds.includes(id)).sort((a, b) => a - b), sinceMs: s.sinceMs,
  newNotifications: s.notifications.filter(n => n.summary.settledAtMs > s.seenMs).length, notificationsSeenMs: s.seenMs,
});
const ownerOf = (s: Server): OwnerState => ({ ...structuredClone(ownerFixture), progression: { ...ownerFixture.progression, ...s.level }, inbox: inboxOf(s) });

type Setup = { messages?: GameMessage[]; notifications?: LiveNotification[]; readIds?: number[]; seenMs?: number; sinceMs?: number; level?: Server['level'];
  /** Answers a read mark with this refusal instead of marking it (the message text must still show). */
  refuseRead?: 'rate-limited' | 'not-found' };
/** A signed-in player in live mode whose server (the transport and the command handler) keeps messages, read marks and the notifications mark. */
async function player(page: Page, setup: Setup = {}) {
  const context = page.context();
  await seedSession(context);
  const server: Server = { messages: [...(setup.messages ?? MESSAGES)], notifications: [...(setup.notifications ?? [])], readIds: [...(setup.readIds ?? [EVENING.id])],
    seenMs: setup.seenMs ?? 0, sinceMs: setup.sinceMs ?? SINCE, level: setup.level ?? { level: 2, xp: 150 } };
  const world = { ...worldFixture, revision: 'live-1' };
  const live = await routeLiveReads(context, { world, owner: ownerOf(server), messages: server.messages, notifications: server.notifications });
  const commands: GameCommand[] = [];
  /** Tells the transport what the database now says (after a command, or an operator's post). */
  const sync = () => { live.setMessages(server.messages); live.setNotifications(server.notifications); live.setOwner(ownerOf(server)); };
  await context.route(`${SUPABASE_URL}/functions/v1/game-command`, async route => {
    if (route.request().method() !== 'POST' || isPresence(route.request())) return route.fallback();
    const command = route.request().postDataJSON() as GameCommand;
    commands.push(command);
    const cors = { 'access-control-allow-origin': '*' };
    const answer = (status: number, body: unknown) => route.fulfill({ status, headers: cors, contentType: 'application/json', body: JSON.stringify(body) });
    if (command.kind === 'read-message') {
      if (setup.refuseRead) return answer(setup.refuseRead === 'rate-limited' ? 429 : 404, { ok: false, code: setup.refuseRead });
      if (!server.messages.some(m => m.id === command.messageId)) return answer(404, { ok: false, code: 'not-found' });
      if (!server.readIds.includes(command.messageId)) server.readIds.push(command.messageId);
      sync();
      return answer(200, { ok: true, value: { messageId: command.messageId } });
    }
    if (command.kind === 'see-notifications') {
      server.seenMs = Math.max(server.seenMs, Math.min(command.upToMs, live.serverNowMs()));
      sync();
      return answer(200, { ok: true, value: { seenMs: server.seenMs } });
    }
    return answer(409, { ok: false, code: 'invalid' });
  });
  return { live, commands, server, world, sync,
    /** The operator posts a message: the database now lists it and counts it; the page learns on its next owner read. */
    post(message: GameMessage) { server.messages.unshift(message); sync(); } };
}
const sent = (commands: readonly GameCommand[], kind: GameCommand['kind']) => commands.filter(c => c.kind === kind);

const messagesButton = (page: Page) => cornerChip(page).getByRole('button', { name: /^Messages(, \d+ new)?$/ });
const badge = (page: Page) => page.getByTestId('messages-badge');
const panelOf = (page: Page) => page.getByRole('region', { name: 'Messages', exact: true });
const rows = (panel: Locator) => panel.locator('[data-message-row]');
const row = (panel: Locator, title: RegExp | string) => panel.locator('[data-message-row]', { hasText: title });
const tab = (panel: Locator, name: RegExp) => panel.getByRole('tab', { name });
async function openPanel(page: Page) {
  await messagesButton(page).click();
  const panel = panelOf(page);
  await expect(panel).toBeVisible();
  return panel;
}
async function openLive(page: Page, url = '/game/') {
  await page.goto(url);
  await expectOwnerShown(page, 'Aster');
}

test.describe('in live mode', () => {
  test.skip(production, 'Live mode uses the development-only intercepted Supabase transport.');

  test('a visitor sees no messages button and reads no message', async ({ page, context }) => {
    const live = await routeLiveReads(context, { world: { ...worldFixture, revision: 'live-1' }, messages: MESSAGES });
    await page.goto('/game/');
    await expect(cornerChip(page).getByRole('button', { name: /^Sign in (with Google )?to join$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Messages/ })).toHaveCount(0);
    expect(live.count('game_messages')).toBe(0);
  });

  test('a player with 2 unread sees "Messages, 2 new" and a "2" badge, left of the pill', async ({ page }, testInfo) => {
    await player(page);
    await openLive(page);
    const button = messagesButton(page);
    await expect(button).toHaveAccessibleName('Messages, 2 new');
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(badge(page)).toHaveText('2');
    // Left of the pill (the account button), a 44 px round button on the same row.
    const [b, pill] = [await button.boundingBox(), await chipToggle(page).boundingBox()];
    expect(b!.x + b!.width).toBeLessThanOrEqual(pill!.x);
    expect(pill!.x - (b!.x + b!.width)).toBeLessThan(16);
    expect(Math.round(b!.width)).toBe(44);
    expect(Math.round(b!.height)).toBe(44);
    expect(Math.abs(b!.y + b!.height / 2 - (pill!.y + pill!.height / 2))).toBeLessThan(2);
    await a11yShot(page, testInfo, 'messages-button');
  });

  test('a player with nothing unread sees the button named "Messages" and no badge', async ({ page }) => {
    await player(page, { readIds: [EVENING.id, LOOK.id, RELEASE.id] });
    await openLive(page);
    await expect(messagesButton(page)).toHaveAccessibleName('Messages');
    await expect(badge(page)).toHaveCount(0);
  });

  test('12 unread show "9+" while the button names the real count', async ({ page }) => {
    const many = Array.from({ length: 12 }, (_, i): GameMessage => ({ ...AVI, id: 100 + i, title: `Note ${i}`, publishedAtMs: at(9, 2) + i * MIN }));
    await player(page, { messages: many, readIds: [] });
    await openLive(page);
    await expect(badge(page)).toHaveText('9+');
    await expect(messagesButton(page)).toHaveAccessibleName('Messages, 12 new');
  });

  test('the panel lists the messages newest first with tags, dates and previews, and marks the unread ones', async ({ page }, testInfo) => {
    await player(page, { messages: [AVI, ...MESSAGES], readIds: [EVENING.id] });
    await openLive(page);
    const panel = await openPanel(page);
    await expect(rows(panel)).toHaveCount(5);
    // Newest first.
    expect(await rows(panel).evaluateAll(els => els.map(el => el.getAttribute('data-message-row')))).toEqual(['5', '3', '2', '1', '4']);
    const avi = row(panel, 'A note from Avi'), look = row(panel, /New: choose your gladiator/), evening = row(panel, /Evening Arena/), welcome = row(panel, 'Welcome to Cloudiator');
    // Tag, date, title and one-line preview of each row.
    await expect(avi).toContainText('Admin');
    await expect(avi).toContainText('29 Oct');
    await expect(avi).toContainText('The arena opens early on Saturday.');
    await expect(look).toContainText('Patch notes');
    await expect(look).toContainText('27 Oct');
    await expect(look).toContainText('Pick a body, hair and colours. Changing your look is free for now.');
    await expect(welcome).toContainText('Admin');
    await expect(welcome).toContainText('20 Sep');
    // Unread: after the gladiator was created and not read; the Welcome note is older than the gladiator and the Evening one is read.
    for (const unread of [avi, look]) await expect(unread).toHaveAccessibleName(/Unread/);
    for (const read of [evening, welcome]) await expect(read).not.toHaveAccessibleName(/Unread/);
    const weight = (r: Locator) => r.locator('[data-message-title]').evaluate(el => Number(getComputedStyle(el).fontWeight));
    expect(await weight(look)).toBeGreaterThan(await weight(evening));
    // The gold dots add up to the badge.
    await expect(panel.locator('[data-unread-dot]')).toHaveCount(3);
    await expect(badge(page)).toHaveText('3');
    // The two tags differ in colour (gold for Patch notes, violet for Admin).
    const colour = (r: Locator) => r.locator('[data-message-tag]').evaluate(el => getComputedStyle(el).color);
    expect(await colour(look)).not.toBe(await colour(avi));
    await a11yShot(page, testInfo, 'messages-list');
  });

  test('opening a message sends its read mark, shows its text, and the badge drops after the owner is read again', async ({ page }) => {
    const { live, commands } = await player(page);
    await openLive(page);
    const panel = await openPanel(page);
    // Listing sends nothing: a read mark is for a message that was opened.
    expect(sent(commands, 'read-message')).toEqual([]);
    const owners = live.count('owner_state'), lists = live.count('game_messages');
    await row(panel, /New: choose your gladiator/).click();
    await expect(panel.getByRole('heading', { name: 'New: choose your gladiator’s look' })).toBeVisible();
    await expect(panel.getByText('New gladiators choose a look when they are created.')).toBeVisible();
    await expect.poll(() => sent(commands, 'read-message')).toEqual([{ kind: 'read-message', operationId: expect.stringMatching(/^[0-9a-f-]{36}$/), messageId: LOOK.id }]);
    await expect(badge(page)).toHaveText('1');
    await expect(messagesButton(page)).toHaveAccessibleName('Messages, 1 new');
    expect(live.count('owner_state')).toBeGreaterThan(owners);
    // Reading it left the list as it was: no reload of the messages.
    expect(live.count('game_messages')).toBe(lists);
    // Back to the list: the note is no longer marked, and the other unread one still is.
    await panel.getByRole('button', { name: 'Back to messages' }).click();
    await expect(row(panel, /New: choose your gladiator/)).not.toHaveAccessibleName(/Unread/);
    await expect(row(panel, /Messages, gold/)).toHaveAccessibleName(/Unread/);
    // Opening it again, or one that was already read, sends nothing more.
    await row(panel, /New: choose your gladiator/).click();
    await panel.getByRole('button', { name: 'Back to messages' }).click();
    await row(panel, /Evening Arena/).click();
    await expect(panel.getByRole('heading', { name: /Evening Arena/ })).toBeVisible();
    await page.waitForTimeout(300);
    expect(sent(commands, 'read-message')).toHaveLength(1);
  });

  test('a message opened while the read mark is refused still shows its text and keeps its mark', async ({ page }) => {
    const { commands } = await player(page, { refuseRead: 'rate-limited' });
    await openLive(page);
    const panel = await openPanel(page);
    await row(panel, /New: choose your gladiator/).click();
    await expect(panel.getByText('New gladiators choose a look when they are created.')).toBeVisible();
    await expect.poll(() => sent(commands, 'read-message').length).toBe(1);
    await expect(panel.getByRole('alert')).toHaveCount(0);
    await expect(badge(page)).toHaveText('2');
    // Opened again, it asks again (the first attempt did not take).
    await page.waitForTimeout(300);
    await panel.getByRole('button', { name: 'Back to messages' }).click();
    await row(panel, /New: choose your gladiator/).click();
    await expect.poll(() => sent(commands, 'read-message').length).toBe(2);
  });

  test('shows a bulleted body as a list and the look note with its Change look button and disclaimer', async ({ page }, testInfo) => {
    await player(page);
    await openLive(page);
    const panel = await openPanel(page);
    await row(panel, /Evening Arena/).click();
    await expect(panel.getByText('What changed:')).toBeVisible();
    const list = panel.getByRole('list');
    await expect(list.getByRole('listitem')).toHaveCount(4);
    await expect(list.getByRole('listitem').first()).toHaveText('Arena runs in the evening part of the day only.');
    // Only the look note offers the action.
    await expect(panel.getByRole('button', { name: 'Change look' })).toHaveCount(0);
    await panel.getByRole('button', { name: 'Back to messages' }).click();
    await row(panel, /New: choose your gladiator/).click();
    await expect(panel.getByRole('button', { name: 'Change look', exact: true })).toBeVisible();
    await expect(panel.getByText('Free for now, as often as you like. This is temporary: changing your look will cost something in the future.')).toBeVisible();
    await a11yShot(page, testInfo, 'messages-look-note');
    // Pressing it closes the panel and leaves the focus on the Messages button (the look dialog, when it opens, returns to it).
    await panel.getByRole('button', { name: 'Change look', exact: true }).click();
    await expect(panel).toBeHidden();
    await expect(messagesButton(page)).toBeFocused();
  });

  test('Back and Close work, Escape closes from the list or a message, and the focus returns to the button', async ({ page }) => {
    await watchFocus(page);
    await player(page);
    await openLive(page);
    const button = messagesButton(page);
    let panel = await openPanel(page);
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    // Opening a message moves the focus to Back (the row it came from is gone); Back returns to that row.
    await row(panel, /Evening Arena/).click();
    await expect(panel.getByRole('button', { name: 'Back to messages' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(rows(panel)).toHaveCount(4);
    await expect(row(panel, /Evening Arena/)).toBeFocused();
    // Close, from the list.
    await panel.getByRole('button', { name: 'Close messages' }).click();
    await expect(panel).toBeHidden();
    await expect(button).toBeFocused();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    // Close, from a message.
    panel = await openPanel(page);
    await row(panel, /Evening Arena/).click();
    await panel.getByRole('button', { name: 'Close messages' }).click();
    await expect(panel).toBeHidden();
    await expect(button).toBeFocused();
    // Escape, from the list and from a message.
    panel = await openPanel(page);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(button).toBeFocused();
    panel = await openPanel(page);
    await row(panel, /Evening Arena/).click();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(button).toBeFocused();
    // The keyboard reaches the button and opens it: Enter, then Escape.
    await page.keyboard.press('Enter');
    await expect(panelOf(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panelOf(page)).toBeHidden();
    await expect(button).toBeFocused();
    expect(await focusDrops(page)).toEqual([]);
    expect(await focusedElement(page)).toContain('Messages');
  });

  test('a press elsewhere closes the panel, and the account menu and the panel never show together', async ({ page }) => {
    await player(page);
    await openLive(page);
    let panel = await openPanel(page);
    await chipToggle(page).click();
    await expect(panel).toBeHidden();
    await expect(cornerChip(page).getByRole('group', { name: 'Account' })).toBeVisible();
    panel = await openPanel(page);
    await expect(cornerChip(page).getByRole('group', { name: 'Account' })).toBeHidden();
    const size = page.viewportSize()!;
    await page.mouse.click(Math.floor(size.width / 2), size.height - 40);
    await expect(panel).toBeHidden();
    await expect(messagesButton(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('shows a message\'s text literally: markup and script in a title or a body are characters', async ({ page }) => {
    const hostile: GameMessage = { id: 6, kind: 'admin', title: '<b>Bold</b> & <img src=x onerror="window.__title=1"> title', preview: '<i>Preview</i> <script>window.__preview=1</script>',
      body: [{ p: 'A <b>x</b> in a paragraph and <script>window.__body = 1</script> after it.' }, { li: '<script>window.__item = 1</script>' }, { li: '<a href="javascript:alert(1)">link</a>' }],
      action: null, publishedAtMs: at(9, 30) };
    await player(page, { messages: [hostile, ...MESSAGES] });
    await openLive(page);
    const panel = await openPanel(page);
    const listed = row(panel, 'Bold');
    await expect(listed.locator('[data-message-title]')).toHaveText('<b>Bold</b> & <img src=x onerror="window.__title=1"> title');
    await expect(listed).toContainText('<i>Preview</i> <script>window.__preview=1</script>');
    await listed.click();
    await expect(panel.getByText('A <b>x</b> in a paragraph and <script>window.__body = 1</script> after it.')).toBeVisible();
    await expect(panel.getByRole('listitem').first()).toHaveText('<script>window.__item = 1</script>');
    await expect(panel.getByRole('listitem').nth(1)).toHaveText('<a href="javascript:alert(1)">link</a>');
    // No element was made from the text, and no script ran.
    expect(await panel.evaluate(el => el.querySelectorAll('b, i, img, script, a').length)).toBe(0);
    expect(await page.evaluate(() => ['__title', '__preview', '__body', '__item'].map(key => (window as unknown as Record<string, unknown>)[key]))).toEqual([undefined, undefined, undefined, undefined]);
    expect(await panel.locator('article').innerHTML()).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  test('a message posted while the panel is open appears after the next owner read, without reopening the panel', async ({ page }) => {
    await page.clock.install();
    const poll = await watchSyncPoll(page);
    const { live, world, post, server, sync } = await player(page, { readIds: [EVENING.id, LOOK.id, RELEASE.id] });
    await openLive(page);
    await poll.idle();
    const panel = await openPanel(page);
    await expect(rows(panel)).toHaveCount(4);
    await expect(badge(page)).toHaveCount(0);
    const lists = live.count('game_messages');
    // The operator posts; the world revision moves with it, and the next poll reads the owner, whose inbox then counts one more unread.
    post(AVI);
    live.setWorld({ ...world, revision: 'live-2' });
    await poll.nextSyncPoll();
    await expect(rows(panel)).toHaveCount(5);
    await expect(row(panel, 'A note from Avi')).toHaveAccessibleName(/Unread/);
    expect(await rows(panel).first().getAttribute('data-message-row')).toBe(String(AVI.id));
    await expect(badge(page)).toHaveText('1');
    await expect.poll(() => live.count('game_messages')).toBe(lists + 1);
    // A message posted and already read on another device is listed too: the count is unchanged, but the inbox names an id the list lacks.
    const elsewhere: GameMessage = { ...AVI, id: 7, title: 'Read elsewhere', publishedAtMs: at(9, 30) };
    server.messages.unshift(elsewhere);
    server.readIds.push(elsewhere.id);
    sync();
    live.setWorld({ ...world, revision: 'live-3' });
    await poll.nextSyncPoll();
    await expect(rows(panel)).toHaveCount(6);
    await expect(row(panel, 'Read elsewhere')).not.toHaveAccessibleName(/Unread/);
    await expect(badge(page)).toHaveText('1');
    expect(live.count('game_messages')).toBe(lists + 2);
  });

  test('the badge change is announced politely and only when the count rises', async ({ page }) => {
    await page.clock.install();
    const poll = await watchSyncPoll(page);
    const { live, world, post, server, sync } = await player(page);
    await openLive(page);
    await poll.idle();
    const status = page.getByTestId('messages-live');
    await expect(status).toHaveAttribute('role', 'status');
    await expect(status).toHaveText('');
    post(AVI);
    live.setWorld({ ...world, revision: 'live-2' });
    await poll.nextSyncPoll();
    await expect(badge(page)).toHaveText('3');
    await expect(status).toHaveText('Messages, 3 new');
    // A fall is not announced (the player read something).
    server.readIds.push(AVI.id);
    sync();
    live.setWorld({ ...world, revision: 'live-3' });
    await poll.nextSyncPoll();
    await expect(badge(page)).toHaveText('2');
    await expect(status).toHaveText('');
  });

  test('a player created after a message was posted sees it as read with no badge', async ({ page }) => {
    // Created after all four were posted (and the Welcome one before): nothing counts, and every row is listed as read.
    await player(page, { sinceMs: at(9, 30), readIds: [] });
    await openLive(page);
    await expect(messagesButton(page)).toHaveAccessibleName('Messages');
    await expect(badge(page)).toHaveCount(0);
    const panel = await openPanel(page);
    await expect(rows(panel)).toHaveCount(4);
    await expect(panel.locator('[data-unread-dot]')).toHaveCount(0);
    for (const title of [/Messages, gold/, /New: choose your gladiator/, /Evening Arena/, /Welcome/]) await expect(row(panel, title)).not.toHaveAccessibleName(/Unread/);
  });

  test('an older player sees the same messages unread', async ({ page }) => {
    // Created before the Evening note, with nothing read: the three notes posted since count, the Welcome one (older still) does not.
    await player(page, { sinceMs: at(9, 1), readIds: [] });
    await openLive(page);
    await expect(messagesButton(page)).toHaveAccessibleName('Messages, 3 new');
    await expect(badge(page)).toHaveText('3');
    const panel = await openPanel(page);
    await expect(panel.locator('[data-unread-dot]')).toHaveCount(3);
    await expect(row(panel, /Welcome/)).not.toHaveAccessibleName(/Unread/);
  });

  test('the panel says so when messages cannot be loaded, and Try again loads them', async ({ page }) => {
    const { live } = await player(page);
    live.fail('game_messages');
    await openLive(page);
    const panel = await openPanel(page);
    await expect(panel.getByRole('alert')).toHaveText(/could not be loaded/i);
    live.fail('game_messages', false);
    await panel.getByRole('button', { name: 'Try again' }).click();
    await expect(rows(panel)).toHaveCount(4);
    await expect(panel.getByRole('alert')).toHaveCount(0);
  });

  test('has two tabs, Messages and Notifications, each with its count; the badge is their sum', async ({ page }, testInfo) => {
    await player(page, { notifications: RESULTS });
    await openLive(page);
    await expect(badge(page)).toHaveText('5');
    await expect(messagesButton(page)).toHaveAccessibleName('Messages, 5 new');
    const panel = await openPanel(page);
    await expect(panel.getByRole('tablist')).toBeVisible();
    await expect(tab(panel, /^Messages/)).toHaveAccessibleName('Messages, 2 new');
    await expect(tab(panel, /^Notifications/)).toHaveAccessibleName('Notifications, 3 new');
    await expect(tab(panel, /^Messages/)).toHaveAttribute('aria-selected', 'true');
    await expect(tab(panel, /^Notifications/)).toHaveAttribute('aria-selected', 'false');
    await a11yShot(page, testInfo, 'messages-tabs');
    // Arrow keys move between the tabs, as in the tabs pattern; Home and End go to the ends.
    await tab(panel, /^Messages/).focus();
    await page.keyboard.press('ArrowRight');
    await expect(tab(panel, /^Notifications/)).toBeFocused();
    await expect(tab(panel, /^Notifications/)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(tab(panel, /^Messages/)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('End');
    await expect(tab(panel, /^Notifications/)).toHaveAttribute('aria-selected', 'true');
    await expect(panel.getByRole('tabpanel')).toHaveAccessibleName(/Notifications/);
  });

  test('opens on Notifications when only results are new', async ({ page }) => {
    await player(page, { notifications: RESULTS, readIds: [EVENING.id, LOOK.id, RELEASE.id] });
    await openLive(page);
    await expect(badge(page)).toHaveText('3');
    const panel = await openPanel(page);
    await expect(tab(panel, /^Notifications/)).toHaveAttribute('aria-selected', 'true');
    await expect(panel.getByText('Arena victory')).toBeVisible();
  });

  test('opening Notifications lists each result and sends see-notifications once, with the newest shown time', async ({ page }, testInfo) => {
    const { live, commands } = await player(page, { notifications: RESULTS });
    await openLive(page);
    const panel = await openPanel(page);
    // On the Messages tab nothing is seen.
    expect(sent(commands, 'see-notifications')).toEqual([]);
    const notifications = live.count('activities');
    await tab(panel, /^Notifications/).click();
    const list = panel.getByRole('tabpanel');
    // The newest first: each with its title and its lines, items by rarity, name and tier.
    const titles = list.locator('[data-notification-title]');
    await expect(titles).toHaveText(['Arena victory', 'Expedition victory: Woodland Path', 'Training finished']);
    const arena = list.locator('[data-notification]').nth(0), expedition = list.locator('[data-notification]').nth(1), training = list.locator('[data-notification]').nth(2);
    await expect(arena.getByRole('listitem')).toHaveText(['+30 renown', 'Rating +12']);
    await expect(expedition.getByRole('listitem')).toHaveText(['+120 gold', '+250 XP', 'Level up! Now level 2', 'Rare Sword (tier 5)', '+35 gold for extra items sold']);
    await expect(training.getByRole('listitem')).toHaveText(['+1 attribute point']);
    expect(live.count('activities')).toBeGreaterThan(notifications);
    // The mark is sent once, with the newest result's time, and the count clears after the owner is read again.
    await expect.poll(() => sent(commands, 'see-notifications')).toEqual([{ kind: 'see-notifications', operationId: expect.stringMatching(/^[0-9a-f-]{36}$/), upToMs: newest(RESULTS) }]);
    await expect(badge(page)).toHaveText('2');
    await expect(tab(panel, /^Notifications/)).toHaveAccessibleName('Notifications');
    // The rows that were new when the panel opened stay marked while it is open, so the player sees which they were.
    await expect(list.locator('[data-unread-dot]')).toHaveCount(3);
    await tab(panel, /^Messages/).click();
    await tab(panel, /^Notifications/).click();
    await page.waitForTimeout(300);
    expect(sent(commands, 'see-notifications')).toHaveLength(1);
    await a11yShot(page, testInfo, 'notifications-list');
    // Closed and opened again, nothing is new any more.
    await panel.getByRole('button', { name: 'Close messages' }).click();
    const again = await openPanel(page);
    await tab(again, /^Notifications/).click();
    await expect(again.getByRole('tabpanel').locator('[data-unread-dot]')).toHaveCount(0);
    expect(sent(commands, 'see-notifications')).toHaveLength(1);
  });

  test('lists the newest 20 results while the badge counts every new one', async ({ page }) => {
    const many = Array.from({ length: 25 }, (_, i) => settled(100 + i, 'training', 'completed', 5 + i, { attributePoints: 1 }));
    const { commands } = await player(page, { notifications: many, readIds: [EVENING.id, LOOK.id, RELEASE.id] });
    await openLive(page);
    // Uncapped: 25, shown "9+".
    await expect(messagesButton(page)).toHaveAccessibleName('Messages, 25 new');
    await expect(badge(page)).toHaveText('9+');
    const panel = await openPanel(page);
    await expect(tab(panel, /^Notifications/)).toHaveAccessibleName('Notifications, 25 new');
    await expect(panel.locator('[data-notification]')).toHaveCount(20);
    // Everything up to the newest shown is seen, which clears the older ones too.
    await expect.poll(() => sent(commands, 'see-notifications').length).toBe(1);
    await expect(messagesButton(page)).toHaveAccessibleName('Messages');
    expect(sent(commands, 'see-notifications')).toEqual([{ kind: 'see-notifications', operationId: expect.any(String), upToMs: newest(many) }]);
  });

  test('a result credited while Notifications is open is listed after the next owner read and seen once more', async ({ page }) => {
    const { commands, server, sync } = await player(page, { notifications: RESULTS, readIds: [EVENING.id, LOOK.id, RELEASE.id] });
    await openLive(page);
    const panel = await openPanel(page);
    await expect.poll(() => sent(commands, 'see-notifications').length).toBe(1);
    await expect(panel.locator('[data-notification]')).toHaveCount(3);
    await expect(messagesButton(page)).toHaveAccessibleName('Messages');
    const credited = settled(9, 'training', 'completed', 1, { attributePoints: 2 });
    server.notifications.unshift(credited);
    sync();
    // The tab coming back to focus reads the owner (not within 2 s of the last owner read, which the mark just made).
    await page.waitForTimeout(2_500);
    await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
    await expect(panel.locator('[data-notification]')).toHaveCount(4);
    await expect(panel.locator('[data-notification]').first()).toContainText('+2 attribute points');
    await expect.poll(() => sent(commands, 'see-notifications').map(c => (c as { upToMs: number }).upToMs)).toEqual([newest(RESULTS), credited.summary.settledAtMs]);
    await expect(messagesButton(page)).toHaveAccessibleName('Messages');
    // The one that arrived while the panel was open is marked new, the others are not (they were seen).
    await expect(panel.locator('[data-notification]').first().locator('[data-unread-dot]')).toHaveCount(1);
  });

  test('a player with no results sees an empty Notifications tab and sends nothing', async ({ page }) => {
    const { commands } = await player(page, { readIds: [EVENING.id, LOOK.id, RELEASE.id] });
    await openLive(page);
    const panel = await openPanel(page);
    await tab(panel, /^Notifications/).click();
    await expect(panel.getByText(/No results yet/)).toBeVisible();
    await page.waitForTimeout(300);
    expect(sent(commands, 'see-notifications')).toEqual([]);
  });

  test('fits a 360 × 740 phone with no sideways scroll, a long title and a long word included', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 360, height: 740 });
    const long: GameMessage = { id: 8, kind: 'patch-notes', title: 'A very long title that goes on and on until it reaches the eighty character limit', preview: 'https://example.invalid/'.padEnd(120, 'a'),
      body: [{ p: 'Averyveryverylongwordwithoutanyspacesinitatalltomakesurethatitwrapsinsidethepanelinsteadofpushingthepagesideways'.repeat(2) }],
      action: null, publishedAtMs: at(9, 30) };
    await player(page, { messages: [long, ...MESSAGES], notifications: RESULTS });
    await openLive(page);
    const panel = await openPanel(page);
    const fits = async () => {
      const box = (await panel.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(360);
      expect(box.y + box.height).toBeLessThanOrEqual(740);
      // It stops above the ☰ button at the bottom left (the touch layout's menu button), which stays reachable.
      const burger = page.getByRole('button', { name: 'Menus', exact: true });
      if (await burger.isVisible()) expect(box.y + box.height).toBeLessThanOrEqual((await burger.boundingBox())!.y);
      expect(await noHorizontalScroll(page)).toBe(true);
      expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    };
    await fits();
    await a11yShot(page, testInfo, 'messages-list-360');
    await row(panel, /A very long title/).click();
    await fits();
    await panel.getByRole('button', { name: 'Back to messages' }).click();
    await row(panel, /New: choose your gladiator/).click();
    await fits();
    await a11yShot(page, testInfo, 'messages-look-note-360');
    await panel.getByRole('button', { name: 'Back to messages' }).click();
    await tab(panel, /^Notifications/).click();
    await fits();
    await a11yShot(page, testInfo, 'notifications-list-360');
  });

  test('the controls are named and the text and badge meet contrast, with no focus lost', async ({ page }) => {
    await watchFocus(page);
    await player(page, { notifications: RESULTS });
    await openLive(page);
    await messagesButton(page).focus();
    expect(await contrastIssues(cornerChip(page), { focusRing: true }), 'the corner chip with the messages button').toEqual([]);
    const panel = await openPanel(page);
    await expectNamedControls(panel, 'the messages list');
    expect(await contrastIssues(panel), 'the messages list').toEqual([]);
    await row(panel, /New: choose your gladiator/).click();
    await expectNamedControls(panel, 'a message');
    expect(await contrastIssues(panel), 'a message').toEqual([]);
    await panel.getByRole('button', { name: 'Back to messages' }).click();
    await tab(panel, /^Notifications/).click();
    await expectNamedControls(panel, 'the notifications');
    expect(await contrastIssues(panel), 'the notifications').toEqual([]);
    // The focus ring of a tab, reached by the keyboard (an arrow key moves the focus to the other tab).
    await tab(panel, /^Notifications/).focus();
    await page.keyboard.press('ArrowLeft');
    await expect(tab(panel, /^Messages/)).toBeFocused();
    expect(await contrastIssues(panel, { focusRing: true }), 'the focused tab').toEqual([]);
    // And of Close and of a row, reached by Tab from the tab.
    await page.keyboard.press('Tab');
    await expect(panel.getByRole('button', { name: 'Close messages' })).toBeFocused();
    expect(await contrastIssues(panel, { focusRing: true }), 'the focused Close button').toEqual([]);
    await page.keyboard.press('Tab');
    await expect(rows(panel).first()).toBeFocused();
    expect(await contrastIssues(panel, { focusRing: true }), 'the focused row').toEqual([]);
    expect(await focusDrops(page)).toEqual([]);
  });
});

test.describe('in the fixture preview', () => {
  test.skip(production, 'The production export carries no fixture preview data.');

  test('a visitor preview shows no messages button', async ({ page }) => {
    await page.goto('/game/?mode=fixture&as=visitor');
    await expect(page.getByRole('button', { name: /^Sign in/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Messages/ })).toHaveCount(0);
  });

  test('the sample messages and notifications open from the button, and the preview player\'s level agrees with them', async ({ page }) => {
    await page.goto('/game/?mode=fixture');
    await expectOwnerShown(page, 'Aster');
    // Two unread sample messages and two new sample results.
    await expect(messagesButton(page)).toHaveAccessibleName('Messages, 4 new');
    const panel = await openPanel(page);
    await expect(rows(panel)).toHaveCount(3);
    await expect(row(panel, 'A note from the game master')).toHaveAccessibleName(/Unread/);
    await tab(panel, /^Notifications/).click();
    await expect(panel.locator('[data-notification]')).toHaveCount(4);
    // The preview's gladiator is level 1: no sample result may claim a level it has not reached.
    await expect(panel.getByText(/Level up!/)).toHaveCount(0);
    await expect(panel.getByText('Rare Sword (tier 5)')).toBeVisible();
    // The preview takes no commands: a mark is refused quietly and the text still shows.
    await tab(panel, /^Messages/).click();
    await row(panel, /New: choose your gladiator/).click();
    await expect(panel.getByRole('button', { name: 'Change look', exact: true })).toBeVisible();
    await expect(panel.getByRole('alert')).toHaveCount(0);
  });
});
