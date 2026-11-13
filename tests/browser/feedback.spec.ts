import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page, type TestInfo } from './fixtures';
import type { GameCommand } from '../../supabase/functions/_shared/contracts/commands';
import type { FeedbackCategory, FeedbackDetails, FeedbackStatus, GameMessage, Inbox, OwnFeedback, OwnerFeedbackItem, OwnerState } from '../../supabase/functions/_shared/contracts/reads';
import { ownerFixture, worldFixture } from '../fixtures/domain';
import { SUPABASE_URL, isPresence, routeLiveReads, seedSession } from './live-routes';
import { contrastIssues, noHorizontalScroll } from './a11y-helpers';
import { cornerChip, creationDialog, expectOwnerShown, openMenu, quietArrivals } from './shell-helpers';

// Patch 1.9 Task 23: Feedback (the approved mockup, .superpowers/design/2026-11-12-feedback-buyback, notes.md "Feedback"). A signed-in player
// sends feedback from a footer in the Messages panel or from Settings → Help (the same dialog), reads My feedback with its statuses, and gets
// the team's answer as a "Team reply" message. The owner (a Game Info editor) answers in a third Game Info tab. Live mode: the development-only
// intercepted transport stands in for the server (Task 22's M34: 5 a game day, `daily-limit`, the six readable columns, team replies).
test.skip(process.env.PLAYWRIGHT_STATIC === 'true', 'Feedback uses the development-only intercepted live transport.');
// The fixture world's server time is 00:40 UTC (02:40 in Israel): the dates below ("Today", "Yesterday") are read in one fixed zone.
test.use({ timezoneId: 'Asia/Jerusalem' });

const DAY = 14_400_000;
const MIN = 60_000;
const IDEA_TEXT = 'The schedule would be easier to use if I could copy Monday to the other days.';
const REPLY: GameMessage = { id: 31, kind: 'team-reply', title: 'Answer to your bug report', preview: 'Thank you, found it. It is fixed in the next patch.',
  body: [{ p: 'Thank you, found it. It is fixed in the next patch.' }], action: null, publishedAtMs: 0 };
const ADMIN: GameMessage = { id: 30, kind: 'admin', title: 'A note from the game master', preview: 'Thanks for playing: tell us what you would like to see next.',
  body: [{ p: 'Thanks for playing: tell us what you would like to see next.' }], action: null, publishedAtMs: 0 };

/** Saves a review screenshot as task-23-<name>-<project>.png into TASK23_SHOTS when it is set (and the test's own output folder). */
async function shot(page: Page, info: TestInfo, name: string) {
  // The camp behind the panels, as the player sees it.
  await expect(page.getByText('Opening the camp…')).toHaveCount(0, { timeout: 45_000 });
  const file = `task-23-${name}-${info.project.name === 'mobile' ? 'phone' : 'desktop'}.png`;
  await page.screenshot({ path: info.outputPath(file) });
  if (process.env.TASK23_SHOTS) {
    mkdirSync(process.env.TASK23_SHOTS, { recursive: true });
    await page.screenshot({ path: `${process.env.TASK23_SHOTS}/${file}` });
  }
}

type Server = { feedback: OwnFeedback[]; messages: GameMessage[]; readIds: number[] };
type Setup = {
  /** The account's own feedback, by minutes before the server's now and its status; the answered one gets REPLY. */
  feedback?: { minutesAgo: number; category: FeedbackCategory; status: FeedbackStatus; text: string }[];
  /** How the server answers each `send-feedback`, in order ('ok' once they run out). */
  sendReplies?: ('ok' | 'daily-limit' | 'unavailable')[];
  /** A signed-in account with no gladiator (Settings' Help only). */
  noGladiator?: boolean;
};

/** A signed-in player whose server keeps their feedback, the messages and the read marks; the clock is the fixture world's. */
async function player(page: Page, setup: Setup = {}) {
  const context = page.context();
  await quietArrivals(context);
  const user = await seedSession(context);
  const now = worldFixture.serverNowMs;
  const server: Server = { feedback: [], messages: [ADMIN], readIds: [] };
  (setup.feedback ?? []).forEach((f, index) => {
    const createdAtMs = now - f.minutesAgo * MIN;
    const answeredAtMs = f.status === 'answered' ? createdAtMs + 20 * MIN : null;
    server.feedback.push({ id: index + 1, category: f.category, text: f.text, status: f.status, createdAtMs, answeredAtMs });
    if (answeredAtMs !== null) server.messages.unshift({ ...REPLY, publishedAtMs: answeredAtMs });
  });
  ADMIN.publishedAtMs = now - 3 * 24 * 60 * MIN;
  const inbox = (): Inbox => ({ unread: server.messages.filter(m => !server.readIds.includes(m.id)).length, readIds: [...server.readIds].sort((a, b) => a - b),
    sinceMs: 0, newNotifications: 0, notificationsSeenMs: 0 });
  const ownerOf = (): OwnerState | null => (setup.noGladiator ? null : { ...structuredClone(ownerFixture), inbox: inbox() });
  const live = await routeLiveReads(context, { world: { ...worldFixture, revision: 'feedback-1' }, owner: ownerOf(), messages: server.messages,
    feedback: server.feedback, serverNowMs: () => now });
  const sync = () => { live.setMessages(server.messages); live.setFeedback(server.feedback); live.setOwner(ownerOf()); };
  const commands: GameCommand[] = [];
  const replies = [...(setup.sendReplies ?? [])];
  await context.route(`${SUPABASE_URL}/functions/v1/game-command`, async route => {
    if (route.request().method() !== 'POST' || isPresence(route.request())) return route.fallback();
    const command = route.request().postDataJSON() as GameCommand;
    commands.push(command);
    const answer = (status: number, body: unknown) => route.fulfill({ status, headers: { 'access-control-allow-origin': '*' }, contentType: 'application/json', body: JSON.stringify(body) });
    if (command.kind === 'read-message') {
      if (!server.readIds.includes(command.messageId)) server.readIds.push(command.messageId);
      sync();
      return answer(200, { ok: true, value: { messageId: command.messageId } });
    }
    if (command.kind === 'send-feedback') {
      const reply = replies.shift() ?? 'ok';
      if (reply === 'unavailable') return answer(503, { ok: false, code: 'unavailable' });
      const today = server.feedback.filter(f => Math.floor(f.createdAtMs / DAY) === Math.floor(now / DAY)).length;
      if (reply === 'daily-limit' || today >= 5) return answer(409, { ok: false, code: 'daily-limit' });
      const id = server.feedback.length + 1;
      server.feedback.push({ id, category: command.category, text: command.text.trim(), status: 'new', createdAtMs: now, answeredAtMs: null });
      sync();
      return answer(200, { ok: true, receiptId: randomUUID(), value: { feedbackId: id, leftToday: 4 - today } });
    }
    return answer(409, { ok: false, code: 'invalid' });
  });
  await page.goto('/game/');
  if (!setup.noGladiator) await expectOwnerShown(page, ownerFixture.name);
  return { live, commands, server, user, sync };
}

const sends = (commands: readonly GameCommand[]) => commands.filter((c): c is Extract<GameCommand, { kind: 'send-feedback' }> => c.kind === 'send-feedback');
const panelOf = (page: Page) => page.getByRole('region', { name: 'Messages', exact: true });
const feedbackDialog = (page: Page) => page.getByRole('dialog', { name: 'Send feedback', exact: true });
const sentDialog = (page: Page) => page.getByRole('dialog', { name: 'Feedback sent', exact: true });
async function openPanel(page: Page) {
  await cornerChip(page).getByRole('button', { name: /^Messages(, \d+ new)?$/ }).click();
  const panel = panelOf(page);
  await expect(panel).toBeVisible();
  return panel;
}
/** The three items of the mockup's My feedback: a Bug answered today, an Idea read yesterday, a Balance sent two days ago. */
const MINE: Setup['feedback'] = [
  { minutesAgo: 2 * 24 * 60, category: 'balance', status: 'new', text: 'Rest gives too little stamina when I have already trained twice in the morning.' },
  { minutesAgo: 24 * 60, category: 'idea', status: 'read', text: 'Please let me copy one day of the schedule to the other days.' },
  { minutesAgo: 90, category: 'bug', status: 'answered', text: 'After I sell an item the gold counter in the top bar still shows the old number until I close the panel.' },
];

test('Send feedback from Messages: categories, the counter, the minimum, the details, the limit line, and one command', async ({ page }, info) => {
  // Two sent earlier in this game day: 3 left.
  const flow = await player(page, { feedback: [{ minutesAgo: 30, category: 'bug', status: 'new', text: 'The first report of the day.' },
    { minutesAgo: 20, category: 'other', status: 'new', text: 'The second report of the day.' }] });
  const panel = await openPanel(page);
  const foot = panel.locator('[data-feedback-foot]');
  await expect(foot.getByRole('button', { name: 'Send feedback', exact: true })).toBeVisible();
  await expect(foot.getByRole('button', { name: /^My feedback/ })).toBeVisible();
  await foot.getByRole('button', { name: 'Send feedback', exact: true }).click();

  const dialog = feedbackDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Tell the team what you found or what you would like to see.');
  const kinds = dialog.getByRole('radiogroup', { name: 'What is it about?' });
  await expect(kinds.getByRole('radio')).toHaveCount(4);
  await expect(kinds.getByRole('radio', { name: 'Idea' })).toBeChecked();
  await expect(dialog).toContainText('Something you would like in the game.');
  await kinds.getByRole('radio', { name: 'Bug' }).click();
  await expect(kinds.getByRole('radio', { name: 'Bug' })).toBeChecked();
  await expect(dialog).toContainText('Something is broken or shows a wrong number.');
  await kinds.getByRole('radio', { name: 'Idea' }).click();

  const box = dialog.getByRole('textbox', { name: 'Your message' });
  const send = dialog.getByRole('button', { name: 'Send', exact: true });
  await expect(send).toBeDisabled();
  await expect(dialog).toContainText('Please do not include passwords or personal details.');
  await box.fill('Too short');
  await expect(dialog).toContainText('Write at least 10 characters.');
  await expect(dialog).toContainText('9 / 1,000');
  await expect(send).toBeDisabled();
  await box.fill(IDEA_TEXT);
  await expect(dialog).toContainText(`${IDEA_TEXT.length} / 1,000`);
  await expect(dialog).not.toContainText('Write at least 10 characters.');
  await expect(send).toBeEnabled();

  const include = dialog.getByRole('checkbox', { name: 'Include game details' });
  await expect(include).toBeChecked();
  await expect(dialog).toContainText('Helps the team find the problem.');
  await dialog.getByRole('button', { name: 'What is sent?' }).click();
  const details = dialog.locator('[data-feedback-details]');
  await expect(details).toContainText(/Patch\s*1\.9\s*·\s*Screen\s*Messages/);
  const phone = info.project.name === 'mobile';
  await expect(details).toContainText(phone ? /Device\s*Chrome \d+ on Android \(phone\)/ : /Device\s*Chrome \d+ on Windows \(desktop\)|Device\s*Chrome \d+ on \w+ \(desktop\)/);
  const size = page.viewportSize()!;
  await expect(details).toContainText(`Window ${size.width} x ${size.height}`);
  // Fix round 1 (controller ruling): only the gladiator's name is shown to the team, never an account.
  await expect(details).toContainText('Nothing else. The team sees your gladiator’s name, and the answer comes to your messages.');
  await expect(details).not.toContainText('account');
  await expect(dialog).toContainText('You can send 5 a game day; 3 left today.');
  expect(await noHorizontalScroll(page)).toBe(true);
  expect(await contrastIssues(dialog)).toEqual([]);
  await shot(page, info, 'feedback-dialog');
  // Final fix wave: the toggle names what a press does with what is shown: unchecked, nothing is shown, so it offers "What is sent?" again.
  await include.uncheck();
  await expect(details).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Hide' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'What is sent?' })).toHaveAttribute('aria-expanded', 'false');
  await include.check();
  await expect(details).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Hide' })).toHaveAttribute('aria-expanded', 'true');
  await dialog.getByRole('button', { name: 'Hide' }).click();
  await expect(details).toBeHidden();

  await send.click();
  const sent = sentDialog(page);
  await expect(sent).toBeVisible();
  await expect(sent.getByRole('status')).toHaveText('Thanks — your feedback was sent. The team’s answer will arrive in your messages.');
  await expect(sent).toContainText('You can send 5 a game day; 2 left today.');
  expect(sends(flow.commands)).toHaveLength(1);
  const [command] = sends(flow.commands);
  expect(Object.keys(command).sort()).toEqual(['category', 'details', 'kind', 'operationId', 'text']);
  expect(command).toMatchObject({ kind: 'send-feedback', category: 'idea', text: IDEA_TEXT });
  const sentDetails = command.details as FeedbackDetails;
  expect(Object.keys(sentDetails)).toEqual(['patch', 'screen', 'device', 'window', 'sentAtMs']);
  expect(sentDetails).toMatchObject({ patch: '1.9', screen: 'Messages', window: `${size.width} x ${size.height}` });
  for (const key of ['patch', 'screen', 'device', 'window'] as const) expect(sentDetails[key].length).toBeLessThanOrEqual(80);
  expect(Number.isSafeInteger(sentDetails.sentAtMs)).toBe(true);
  await shot(page, info, 'feedback-sent');

  // See my feedback: the panel shows My feedback with the new one on top.
  await sent.getByRole('button', { name: 'See my feedback' }).click();
  await expect(sent).toBeHidden();
  await expect(panel.getByRole('button', { name: 'Back to messages' })).toBeVisible();
  await expect(panel).toContainText('My feedback · 3 sent · 0 answered');
  await expect(panel.locator('[data-feedback-row]').first()).toContainText('The schedule would be easier');

  // Unchecked, the game details are not sent at all.
  await panel.locator('[data-feedback-foot]').getByRole('button', { name: 'Send feedback', exact: true }).click();
  await expect(feedbackDialog(page)).toContainText('You can send 5 a game day; 2 left today.');
  await feedbackDialog(page).getByRole('textbox', { name: 'Your message' }).fill('A second idea, sent without any game details.');
  await feedbackDialog(page).getByRole('checkbox', { name: 'Include game details' }).uncheck();
  await feedbackDialog(page).getByRole('button', { name: 'Send', exact: true }).click();
  await expect(sentDialog(page)).toContainText('1 left today.');
  expect(sends(flow.commands)[1].details).toBeNull();
  await sentDialog(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(sentDialog(page)).toBeHidden();
  await expect(panel).toBeVisible();
});

test('the daily limit: 5 sent shows the limit line with Send off, and a daily-limit answer keeps the text', async ({ page }) => {
  // Four sent today; another device sends the fifth before this one does: the server answers daily-limit.
  const four = [1, 2, 3, 4].map(n => ({ minutesAgo: 5 * n, category: 'idea' as const, status: 'new' as const, text: `Earlier feedback number ${n}.` }));
  const flow = await player(page, { feedback: four, sendReplies: ['daily-limit'] });
  const panel = await openPanel(page);
  await panel.locator('[data-feedback-foot]').getByRole('button', { name: 'Send feedback', exact: true }).click();
  const dialog = feedbackDialog(page);
  await expect(dialog).toContainText('You can send 5 a game day; 1 left today.');
  await dialog.getByRole('textbox', { name: 'Your message' }).fill(IDEA_TEXT);
  await dialog.getByRole('button', { name: 'Send', exact: true }).focus();
  await page.keyboard.press('Enter');
  // Fix round 1: the limit line is said (a polite status) and the focus stays on Send, which is off but focusable. Final fix wave: the status
  // holds only the static words; the minute countdown is shown after it, outside the live region, so it is not announced every minute.
  await expect(dialog.getByRole('status')).toHaveText('You have sent 5 today. You can send more on the next game day');
  await expect(dialog).toContainText(/You have sent 5 today\. You can send more on the next game day \(in \d+\s*h(?: \d+\s*min)?\)\./);
  await expect(dialog.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Send', exact: true })).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'Send', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Enter');
  expect(sends(flow.commands)).toHaveLength(1);
  await expect(dialog.getByRole('textbox', { name: 'Your message' })).toHaveValue(IDEA_TEXT);
  expect(sends(flow.commands)).toHaveLength(1);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();

  // Opened again with five sent today: the limit line at once.
  flow.server.feedback.push({ id: 5, category: 'bug', text: 'The fifth one from elsewhere.', status: 'new', createdAtMs: worldFixture.serverNowMs - MIN, answeredAtMs: null });
  flow.sync();
  await panel.locator('[data-feedback-foot]').getByRole('button', { name: 'Send feedback', exact: true }).click();
  await expect(dialog).toContainText(/You have sent 5 today\./);
  await dialog.getByRole('textbox', { name: 'Your message' }).fill(IDEA_TEXT);
  await expect(dialog.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();

  // Fix round 1: left open across the game day's end, the dialog counts the new game day (nothing sent in it yet).
  await page.evaluate(day => window.__cloudiatorShell!.clock.freeze((Math.floor(window.__cloudiatorShell!.clock.now() / day) + 1) * day + 60_000), DAY);
  await expect(dialog).toContainText('You can send 5 a game day; 5 left today.');
  await expect(dialog.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
});

test('a send that fails keeps the text, and Send again repeats the same operation', async ({ page }) => {
  const flow = await player(page, { sendReplies: ['unavailable'] });
  const panel = await openPanel(page);
  await panel.locator('[data-feedback-foot]').getByRole('button', { name: 'Send feedback', exact: true }).click();
  const dialog = feedbackDialog(page);
  await dialog.getByRole('textbox', { name: 'Your message' }).fill(IDEA_TEXT);
  await dialog.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Could not send. Your text is still here. Try again.');
  await expect(dialog.getByRole('textbox', { name: 'Your message' })).toHaveValue(IDEA_TEXT);
  await dialog.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(sentDialog(page)).toBeVisible();
  const [first, second] = sends(flow.commands);
  expect(second.operationId).toBe(first.operationId);
});

test('My feedback lists the statuses, opens the team answer, and the Team reply shows in the inbox with its tag', async ({ page }, info) => {
  const flow = await player(page, { feedback: MINE });
  const panel = await openPanel(page);
  // The team reply: a green "Team reply" tag on an unread row.
  const reply = panel.locator('[data-message-row]', { hasText: 'Answer to your bug report' });
  await expect(reply.locator('[data-message-tag]')).toHaveText('Team reply');
  await expect(reply.locator('[data-message-tag]')).toHaveCSS('background-color', 'rgb(23, 51, 37)');
  await expect(reply).toHaveAttribute('data-unread', '');
  const mine = panel.locator('[data-feedback-foot]').getByRole('button', { name: /^My feedback/ });
  await expect(mine).toHaveAccessibleName('My feedback, 1 new answer');
  expect(await contrastIssues(panel)).toEqual([]);
  await shot(page, info, 'team-reply');

  await mine.click();
  await expect(panel.getByRole('button', { name: 'Back to messages' })).toBeFocused();
  await expect(panel).toContainText('My feedback · 3 sent · 1 answered');
  const rows = panel.locator('[data-feedback-row]');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText(/Bug\s*Answered\s*Today/);
  await expect(rows.nth(1)).toContainText(/Idea\s*Read\s*Yesterday/);
  await expect(rows.nth(2)).toContainText(/Balance\s*Sent/);
  await expect(panel).toContainText('Statuses: Sent → Read → Answered. Answers also arrive as a message.');
  await expect(panel.locator('[data-feedback-foot]')).toContainText('5 left today');

  // The answered item opens on the team's answer, and that marks its reply message read.
  await rows.nth(0).click();
  await expect(rows.nth(0)).toHaveAttribute('aria-expanded', 'true');
  const answer = panel.locator('[data-feedback-answer]');
  await expect(answer).toContainText('Answer from the team');
  await expect(answer).toContainText('Thank you, found it. It is fixed in the next patch.');
  await expect.poll(() => flow.commands.filter(c => c.kind === 'read-message').map(c => (c as { messageId: number }).messageId)).toEqual([REPLY.id]);
  await rows.nth(1).click();
  await expect(panel).toContainText('The team has read it. An answer arrives in your messages if it needs one.');
  await rows.nth(2).click();
  await expect(panel).toContainText('Sent. The team has not opened it yet.');
  await rows.nth(0).click();
  expect(await noHorizontalScroll(page)).toBe(true);
  expect(await contrastIssues(panel)).toEqual([]);
  await shot(page, info, 'my-feedback');

  await panel.getByRole('button', { name: 'Back to messages' }).click();
  await expect(panel.getByRole('tab', { name: /^Messages/ })).toBeVisible();
  await expect(panel.locator('[data-feedback-foot]').getByRole('button', { name: 'My feedback', exact: true })).toBeVisible();
  // The reply itself opens as a message with its tag.
  await reply.click();
  await expect(panel.getByRole('heading', { name: 'Answer to your bug report' })).toBeVisible();
  await expect(panel).toContainText('Team reply');
});

test('Settings → Help opens the same dialog, and See my feedback opens My feedback in Messages', async ({ page }, info) => {
  const flow = await player(page);
  const settings = await openMenu(page, 'Settings');
  const help = settings.getByRole('region', { name: 'Help' });
  await expect(help).toContainText('Send feedback');
  await expect(help).toContainText('Report a bug or share an idea. The team answers in your messages.');
  await shot(page, info, 'settings-help');
  await help.getByRole('button', { name: /^Send/ }).click();
  const dialog = feedbackDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'What is sent?' }).click();
  await expect(dialog.locator('[data-feedback-details]')).toContainText(/Screen\s*Settings/);
  await dialog.getByRole('radiogroup', { name: 'What is it about?' }).getByRole('radio', { name: 'Bug' }).click();
  await dialog.getByRole('textbox', { name: 'Your message' }).fill('The Arena result says I lost but my record still shows a win.');
  await dialog.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(sentDialog(page)).toBeVisible();
  expect(sends(flow.commands)[0]).toMatchObject({ category: 'bug', details: { screen: 'Settings' } });
  await sentDialog(page).getByRole('button', { name: 'See my feedback' }).click();
  const panel = panelOf(page);
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('My feedback · 1 sent · 0 answered');
});

test('an account without a gladiator sends from Settings, with no "See my feedback"', async ({ page }) => {
  const flow = await player(page, { noGladiator: true });
  // The creation dialog opens once for a new account: Escape puts it away.
  await expect(creationDialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(creationDialog(page)).toBeHidden();
  await expect(cornerChip(page).getByRole('button', { name: 'Create your gladiator' })).toBeVisible();
  const settings = await openMenu(page, 'Settings');
  // Final fix wave: without a gladiator there is no inbox yet, so the answer arrives once there is one.
  const help = settings.getByRole('region', { name: 'Help' });
  await expect(help).toContainText('Report a bug or share an idea. The team’s answer will arrive in your messages once you have a gladiator.');
  await expect(help).not.toContainText('The team answers in your messages.');
  await help.getByRole('button', { name: /^Send/ }).click();
  const dialog = feedbackDialog(page);
  await dialog.getByRole('textbox', { name: 'Your message' }).fill('I cannot find where to create my gladiator.');
  await dialog.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(sentDialog(page)).toBeVisible();
  await expect(sentDialog(page).getByRole('status')).toHaveText('Thanks — your feedback was sent. The team’s answer will arrive in your messages once you have a gladiator.');
  // No Messages panel without a gladiator: no "See my feedback".
  await expect(sentDialog(page).getByRole('button', { name: 'See my feedback' })).toHaveCount(0);
  expect(sends(flow.commands)).toHaveLength(1);
});

test('a visitor sees no feedback entry anywhere', async ({ page }) => {
  await quietArrivals(page.context());
  await routeLiveReads(page.context(), { world: worldFixture });
  await page.goto('/game/');
  await expect(cornerChip(page).getByRole('button', { name: /^Sign in/ })).toBeVisible();
  await expect(cornerChip(page).getByRole('button', { name: /^Messages/ })).toHaveCount(0);
  const settings = await openMenu(page, 'Settings');
  await expect(settings).toContainText('Saved in this browser. Changes apply at once.');
  await expect(settings.getByRole('region', { name: 'Help' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Send feedback|^Send…$/ })).toHaveCount(0);
  // Final fix wave: a visitor's Game Info has no feedback count.
  await expect(cornerChip(page).getByRole('button', { name: 'Game Info', exact: true })).toBeVisible();
  await expect(page.getByTestId('info-feedback-badge')).toHaveCount(0);
});

test('the fixture preview shows no feedback entry', async ({ page }) => {
  await quietArrivals(page.context());
  await page.goto('/game/?mode=fixture');
  await expectOwnerShown(page, 'Aster');
  const panel = await openPanel(page);
  await expect(panel.locator('[data-feedback-foot]')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Close messages' }).click();
  const settings = await openMenu(page, 'Settings');
  await expect(settings.getByRole('region', { name: 'Help' })).toHaveCount(0);
  // Final fix wave: the fixture provides no feedback count, so Game Info shows none.
  await expect(cornerChip(page).getByRole('button', { name: 'Game Info', exact: true })).toBeVisible();
  await expect(page.getByTestId('info-feedback-badge')).toHaveCount(0);
});

// ---- The owner's Feedback tab in Game Info (Avi only: the Game Info editors). ----

type Owned = OwnerFeedbackItem & { who: string };
/** M36: Claude's suggestions in the fixture (saved through the Game Info MCP; only the owner sends them). */
const SUGGESTED = { 4: 'Thank you for the report. The Arena record is fixed in the next patch.', 2: 'Thank you. Heavy armor gets a look in the 2.0 balance work.' } as const;
/** The browser key the corner chip remembers an editor account under (the Game Info panel's own editor probe passed here before). */
const EDITOR_KEY = 'cloudiator.feedback-editor';
async function owner(page: Page, editor: boolean, options: { suggestions?: boolean; remembered?: boolean } = {}) {
  const remembered = options.remembered ?? false;
  const context = page.context();
  await quietArrivals(context);
  const user = await seedSession(context);
  if (remembered) await context.addInitScript(([key, id]) => { localStorage.setItem(key, id); }, [EDITOR_KEY, user.id]);
  await routeLiveReads(context, { world: worldFixture, owner: ownerFixture });
  const now = Date.now();
  const detail = (screen: string, device: string, window: string, minutesAgo: number): FeedbackDetails => ({ patch: '1.9', screen, device, window, sentAtMs: now - minutesAgo * MIN });
  const none = { answeredVia: null, suggestion: null, suggestedAtMs: null };
  const items: Owned[] = [
    { id: 4, category: 'bug', text: 'The Arena result says I lost but my record still shows a win. Screenshot is not possible on my phone.', details: detail('Arena', 'Chrome 131 on Android (phone)', '360 x 780', 5),
      status: 'new', createdAtMs: now - 5 * MIN, gladiatorName: 'Cassia', answer: null, answeredAtMs: null, ...none, who: 'Cassia' },
    { id: 3, category: 'idea', text: 'A way to rename the gladiator would be great. I picked the name in a hurry.', details: detail('My gladiator', 'Firefox 132 on Windows (desktop)', '1920 x 1080', 50),
      status: 'new', createdAtMs: now - 50 * MIN, gladiatorName: 'Varro', answer: null, answeredAtMs: null, ...none, who: 'Varro' },
    { id: 2, category: 'balance', text: 'Heavy armor is too heavy for the level 5 expedition.', details: null, status: 'read', createdAtMs: now - 200 * MIN, gladiatorName: null,
      answer: null, answeredAtMs: null, ...none, who: '' },
    { id: 1, category: 'other', text: 'Thanks for the game, my kids and I play it together.', details: null, status: 'answered', createdAtMs: now - 26 * 60 * MIN, gladiatorName: 'Aster',
      answer: 'Thank you, this made our day. Enjoy!', answeredAtMs: now - 25 * 60 * MIN, ...none, answeredVia: 'owner', who: 'Aster' },
  ];
  if (options.suggestions) {
    for (const item of items) {
      const suggestion = SUGGESTED[item.id as keyof typeof SUGGESTED];
      if (suggestion) Object.assign(item, { suggestion, suggestedAtMs: now - MIN });
    }
  }
  const actions: Record<string, unknown>[] = [];
  /** Every game-info post, an editor's or not (the corner chip's count reads are among them). */
  const posts: Record<string, unknown>[] = [];
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info' };
  await context.route(`${SUPABASE_URL}/functions/v1/game-info`, async route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-methods': 'POST' } });
    const body = route.request().postDataJSON() as Record<string, unknown>;
    posts.push(body);
    const answer = (status: number, json: unknown) => route.fulfill({ status, json, headers: cors });
    if (!editor) return answer(403, { ok: false, code: 'forbidden' });
    if (body.tab !== 'feedback') return answer(200, { ok: true, version: 0, document: { entries: [{ id: 'combat', title: 'Combat', body: 'Public combat guide.' }] } });
    actions.push(body);
    const newCount = () => items.filter(i => i.status === 'new').length;
    if (body.action === 'list') {
      const list = items.filter(i => body.filter === 'all' || i.status === body.filter).map(({ who: _who, ...item }) => item);
      return answer(200, { ok: true, items: list, newCount: newCount() });
    }
    const item = items.find(i => i.id === body.id);
    if (!item) return answer(404, { ok: false, code: 'not-found' });
    if (body.action === 'mark-read') {
      if (item.status === 'new') item.status = 'read';
      return answer(200, { ok: true, id: item.id, status: item.status });
    }
    if (item.status === 'answered') return answer(409, { ok: false, code: 'conflict' });
    // M36: an answer from Claude's suggestion (as is or edited) is recorded as an approved suggestion, and the suggestion is cleared.
    // M37: only the suggestion the owner saw (its time); one Claude replaced since is a conflict, and nothing is sent.
    if (body.fromSuggestion === true && (item.suggestion === null || body.suggestedAtMs !== item.suggestedAtMs)) return answer(409, { ok: false, code: 'conflict' });
    item.status = 'answered'; item.answer = String(body.text).trim(); item.answeredAtMs = Date.now();
    item.answeredVia = body.fromSuggestion === true ? 'claude-approved' : 'owner'; item.suggestion = null; item.suggestedAtMs = null;
    return answer(200, { ok: true, id: item.id, status: 'answered', messageId: 77 });
  });
  await page.goto('/game/');
  await expectOwnerShown(page, ownerFixture.name);
  const info = cornerChip(page).getByRole('button', { name: /^Game Info/ });
  if (remembered) return { panel: page.getByRole('dialog', { name: 'Game Info' }), actions, items, posts, info, user };
  // An account this browser has not seen as an editor: the chip asks the game-info function nothing at camp load.
  await expect(cornerChip(page).getByRole('button', { name: 'Game Info', exact: true })).toBeVisible();
  expect(posts).toEqual([]);
  await cornerChip(page).getByRole('button', { name: 'Game Info', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Game Info' });
  await expect(panel).toBeVisible();
  return { panel, actions, items, posts, info, user };
}

test('the Feedback tab is hidden from a player who is not an editor', async ({ page }) => {
  const { panel, actions, posts, info } = await owner(page, false);
  await expect(panel.getByRole('tab')).toHaveCount(2);
  await expect(panel.getByRole('tab', { name: /^Feedback/ })).toHaveCount(0);
  expect(actions).toEqual([]);
  // Final fix wave: no count on the chip for a player who is not an editor, and no feedback read for it, before or after Game Info closes.
  await panel.getByRole('button', { name: 'Close Game Info', exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(info).toHaveAccessibleName('Game Info');
  await expect(page.getByTestId('info-feedback-badge')).toHaveCount(0);
  expect(posts.filter(post => post.tab === 'feedback')).toEqual([]);
  expect(await page.evaluate(key => localStorage.getItem(key), EDITOR_KEY)).toBeNull();
});

// Final fix wave (notes.md Q5, "the red count on the Feedback tab and on Game Info"): an editor sees the number of New feedback on the corner
// chip's Game Info button. The Game Info panel's own editor probe makes an account an editor in this browser; the count is read then, again
// when Game Info closes, at every later camp load, and every 3 minutes while the camp is open.
test('the corner chip counts New feedback for an editor: after the editor probe, when Game Info closes and every 3 minutes', async ({ page }) => {
  await page.clock.install();
  const { panel, items, posts, info, user } = await owner(page, true);
  await expect(info).toHaveAccessibleName('Game Info, 2 new feedback');
  await expect(page.getByTestId('info-feedback-badge')).toHaveText('2');
  expect(await page.evaluate(key => localStorage.getItem(key), EDITOR_KEY)).toBe(user.id);
  // Mark one read in the tab, then close Game Info: the chip reads the count again.
  await panel.getByRole('tab', { name: /^Feedback/ }).click();
  await panel.locator('[data-feedback-item]').first().getByRole('button', { name: 'Mark read', exact: true }).click();
  await expect(panel.locator('[data-feedback-item]')).toHaveCount(1);
  await panel.getByRole('button', { name: 'Close Game Info', exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(info).toHaveAccessibleName('Game Info, 1 new feedback');
  await expect(page.getByTestId('info-feedback-badge')).toHaveText('1');
  expect(await noHorizontalScroll(page)).toBe(true);

  // Every 3 minutes while the camp is open, and not sooner.
  const reads = () => posts.filter(post => post.tab === 'feedback' && post.action === 'list').length;
  const before = reads();
  items.unshift({ ...items[0], id: 5, status: 'new', text: 'The countdown in the corner skipped a minute.', gladiatorName: 'Varro', who: 'Varro' });
  await page.clock.fastForward(2 * 60_000);
  await expect(info).toHaveAccessibleName('Game Info, 1 new feedback');
  expect(reads()).toBe(before);
  await page.clock.fastForward(60_000);
  await expect(info).toHaveAccessibleName('Game Info, 2 new feedback');
  expect(reads()).toBe(before + 1);
});

test('an editor seen in this browser before gets the count at camp load, without opening Game Info', async ({ page }, testInfo) => {
  const { info, posts } = await owner(page, true, { remembered: true });
  await expect(info).toHaveAccessibleName('Game Info, 2 new feedback');
  await expect(page.getByTestId('info-feedback-badge')).toHaveText('2');
  expect(posts.map(post => [post.tab, post.action, post.filter])).toEqual([['feedback', 'list', 'new']]);
  expect(await noHorizontalScroll(page)).toBe(true);
  expect(await contrastIssues(cornerChip(page))).toEqual([]);
  await shot(page, testInfo, 'info-feedback-badge');
});

test('the owner reads New, Answered and All, marks one read and answers one', async ({ page }, info) => {
  const { panel, actions } = await owner(page, true);
  const tab = panel.getByRole('tab', { name: /^Feedback/ });
  await expect(tab).toHaveAccessibleName('Feedback, 2 new');
  await tab.click();
  const show = panel.getByRole('group', { name: 'Show' });
  await expect(show.getByRole('button', { name: 'New', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const items = panel.locator('[data-feedback-item]');
  await expect(items).toHaveCount(2);
  await expect(panel).toContainText('Newest first · 2 shown');
  const first = items.nth(0), second = items.nth(1);
  // Fix round 1: the mockup's "gladiator <name>" (no account is shown).
  await expect(first).toContainText(/Bug\s*New\s*gladiator Cassia/);
  await expect(first).toContainText('The Arena result says I lost');
  await expect(first).toContainText('Sent with it: Patch 1.9 · Arena · Chrome 131 on Android (phone) · 360 x 780 ·');
  await expect(second).toContainText(/Idea\s*New\s*gladiator Varro/);
  expect(await noHorizontalScroll(page)).toBe(true);

  // Mark read: the item leaves New, and the count falls.
  await second.getByRole('button', { name: 'Mark read', exact: true }).click();
  await expect(items).toHaveCount(1);
  await expect(tab).toHaveAccessibleName('Feedback, 1 new');
  expect(actions).toContainEqual({ tab: 'feedback', action: 'mark-read', id: 3 });

  // Answer: a text box for that player, then Send answer.
  await first.getByRole('button', { name: 'Answer', exact: true }).click();
  const box = first.getByRole('textbox', { name: 'Answer to gladiator Cassia (they get a message)' });
  await expect(box).toBeFocused();
  await expect(first).toContainText('Sends a message and marks it Answered.');
  const reply = 'Thank you for the report. We are looking into it and will fix it in the next patch.';
  await box.fill(reply);
  await expect(first).toContainText(`${reply.length} / 1,000`);
  expect(await contrastIssues(panel)).toEqual([]);
  await shot(page, info, 'owner-feedback');
  await first.getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect(items).toHaveCount(0);
  await expect(panel).toContainText('Nothing here. New feedback from players shows up in this list.');
  await expect(tab).toHaveAccessibleName('Feedback');
  expect(actions).toContainEqual({ tab: 'feedback', action: 'answer', id: 4, text: reply });

  await show.getByRole('button', { name: 'Answered', exact: true }).click();
  await expect(items).toHaveCount(2);
  await expect(items.nth(0).locator('[data-feedback-answer]')).toContainText(/Your answer\s*Thank you for the report/);
  await expect(items.nth(0).getByRole('button', { name: 'Answer', exact: true })).toHaveCount(0);
  await show.getByRole('button', { name: 'All', exact: true }).click();
  await expect(items).toHaveCount(4);
  // A read item can still be answered, but not marked read again; an item without a gladiator says so.
  const read = items.filter({ hasText: 'Heavy armor is too heavy' });
  await expect(read).toContainText(/Balance\s*Read/);
  await expect(read.getByRole('button', { name: 'Mark read', exact: true })).toHaveCount(0);
  await expect(read.getByRole('button', { name: 'Answer', exact: true })).toBeVisible();
  await expect(read).toContainText('No gladiator');
  expect(actions.filter(a => a.action === 'list').map(a => a.filter)).toEqual(expect.arrayContaining(['new', 'answered', 'all']));
});

test('Claude’s suggestion: the owner approves it as is or edits it first, and the answer then says it was approved', async ({ page }, info) => {
  const { panel, actions, items: owned } = await owner(page, true, { suggestions: true });
  // M37: each approval names the time of the suggestion the owner saw.
  const [bugAt, balanceAt] = [owned.find(i => i.id === 4)!.suggestedAtMs, owned.find(i => i.id === 2)!.suggestedAtMs];
  const tab = panel.getByRole('tab', { name: /^Feedback/ });
  await tab.click();
  const items = panel.locator('[data-feedback-item]');
  await expect(items).toHaveCount(2);
  const bug = items.filter({ hasText: 'The Arena result says I lost' }), idea = items.filter({ hasText: 'A way to rename the gladiator' });
  // A suggestion shows under the player's text, with Approve and send and Edit; the owner may still write their own (Answer).
  const suggestion = bug.locator('[data-feedback-suggestion]');
  await expect(suggestion).toContainText(`Suggested by Claude${SUGGESTED[4]}`);
  await expect(bug.getByRole('button')).toHaveText(['Approve and send', 'Edit', 'Answer', 'Mark read']);
  // An item without a suggestion is as before.
  await expect(idea.locator('[data-feedback-suggestion]')).toHaveCount(0);
  await expect(idea.getByRole('button')).toHaveText(['Answer', 'Mark read']);
  expect(await noHorizontalScroll(page)).toBe(true);
  expect(await contrastIssues(panel)).toEqual([]);
  await shot(page, info, 'owner-feedback-suggestion');

  // Approve and send: the suggestion's text goes to that player as it is, marked as from the suggestion.
  await bug.getByRole('button', { name: 'Approve and send', exact: true }).click();
  await expect(items).toHaveCount(1);
  await expect(tab).toHaveAccessibleName('Feedback, 1 new');
  expect(actions).toContainEqual({ tab: 'feedback', action: 'answer', id: 4, text: SUGGESTED[4], fromSuggestion: true, suggestedAtMs: bugAt });

  // All: the approved answer says so; an answer the owner wrote says only Answered.
  const show = panel.getByRole('group', { name: 'Show' });
  await show.getByRole('button', { name: 'All', exact: true }).click();
  await expect(items).toHaveCount(4);
  const approved = items.filter({ hasText: 'The Arena result says I lost' });
  await expect(approved).toContainText(/Bug\s*Answered \(approved suggestion\)\s*gladiator Cassia/);
  await expect(approved.locator('[data-feedback-answer]')).toContainText(`Your answer${SUGGESTED[4]}`);
  await expect(approved.locator('[data-feedback-suggestion]')).toHaveCount(0);
  const thanked = items.filter({ hasText: 'Thanks for the game' });
  await expect(thanked).toContainText(/Other\s*Answered\s*gladiator Aster/);
  await expect(thanked).not.toContainText('approved suggestion');

  // Answer on an item with a suggestion opens an empty box (the owner's own words); Cancel closes it.
  const balance = items.filter({ hasText: 'Heavy armor is too heavy' });
  await expect(balance.locator('[data-feedback-suggestion]')).toContainText(SUGGESTED[2]);
  await balance.getByRole('button', { name: 'Answer', exact: true }).click();
  const box = balance.getByRole('textbox', { name: 'Answer to this player (they get a message)' });
  await expect(box).toHaveValue('');
  await expect(balance).toContainText('0 / 1,000');
  await balance.getByRole('button', { name: 'Cancel', exact: true }).click();
  // Edit fills the box with the suggestion (focused, up to the server's 2,000); the edited text is sent as an approved suggestion.
  await balance.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(box).toBeFocused();
  await expect(box).toHaveValue(SUGGESTED[2]);
  await expect(balance).toContainText('Sends your edit of Claude’s suggestion and marks it Answered.');
  await expect(balance).toContainText(`${SUGGESTED[2].length} / 2,000`);
  const edited = 'Thank you. Heavy armor gets a look in the 2.0 balance work, and the expedition limits with it.';
  await box.fill(edited);
  expect(await contrastIssues(panel)).toEqual([]);
  await shot(page, info, 'owner-feedback-suggestion-edit');
  await balance.getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect(balance).toContainText(/Balance\s*Answered \(approved suggestion\)/);
  await expect(balance.locator('[data-feedback-answer]')).toContainText(`Your answer${edited}`);
  expect(actions).toContainEqual({ tab: 'feedback', action: 'answer', id: 2, text: edited, fromSuggestion: true, suggestedAtMs: balanceAt });
  // Nothing else was sent.
  expect(actions.filter(a => a.action === 'answer')).toHaveLength(2);
  // The longer status pill wraps with its row at 360 px: no horizontal page scroll.
  await page.setViewportSize({ width: 360, height: 780 });
  await expect(approved).toContainText('Answered (approved suggestion)');
  expect(await noHorizontalScroll(page)).toBe(true);
  await shot(page, info, 'owner-feedback-approved-360');
});

// Task 25 (M37), from the Task 23b review: approving one item never closes or clears the answer the owner has open on another, and an
// approval of a suggestion Claude has replaced since is a conflict: nothing is sent, and the list shows the new suggestion.
test('Approve and send keeps another item’s open answer, and a suggestion Claude replaced is refused, not sent', async ({ page }, info) => {
  const { panel, actions, items: owned } = await owner(page, true, { suggestions: true });
  await panel.getByRole('tab', { name: /^Feedback/ }).click();
  const items = panel.locator('[data-feedback-item]');
  await expect(items).toHaveCount(2);
  const bug = items.filter({ hasText: 'The Arena result says I lost' }), idea = items.filter({ hasText: 'A way to rename the gladiator' });
  // The owner starts an answer on the idea in their own words…
  await idea.getByRole('button', { name: 'Answer', exact: true }).click();
  const box = idea.getByRole('textbox', { name: 'Answer to gladiator Varro (they get a message)' });
  const own = 'Renaming is planned for a later patch.';
  await box.fill(own);
  // …and meanwhile approves Claude's suggestion on the bug report: sent with that suggestion's time, the idea's box untouched.
  const bugAt = owned.find(i => i.id === 4)!.suggestedAtMs;
  await bug.getByRole('button', { name: 'Approve and send', exact: true }).click();
  await expect(items).toHaveCount(1);
  expect(actions).toContainEqual({ tab: 'feedback', action: 'answer', id: 4, text: SUGGESTED[4], fromSuggestion: true, suggestedAtMs: bugAt });
  await expect(box).toBeVisible();
  await expect(box).toHaveValue(own);
  await expect(idea).toContainText(`${own.length} / 1,000`);
  // Its own Send still sends the owner's words, as the owner's (no suggestion time).
  await idea.getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect(items).toHaveCount(0);
  expect(actions).toContainEqual({ tab: 'feedback', action: 'answer', id: 3, text: own });

  // All: the balance item shows Claude's suggestion; the owner opens Edit on it. Then Claude replaces the suggestion (a later time).
  await panel.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'All', exact: true }).click();
  const balance = items.filter({ hasText: 'Heavy armor is too heavy' });
  await expect(balance.locator('[data-feedback-suggestion]')).toContainText(SUGGESTED[2]);
  const shownAt = owned.find(i => i.id === 2)!.suggestedAtMs;
  await balance.getByRole('button', { name: 'Edit', exact: true }).click();
  const editBox = balance.getByRole('textbox', { name: 'Answer to this player (they get a message)' });
  await editBox.fill(`${SUGGESTED[2]} Edited.`);
  const replaced = 'Thank you. Heavy armor weight is lowered in the next patch.';
  Object.assign(owned.find(i => i.id === 2)!, { suggestion: replaced, suggestedAtMs: Date.now() });
  // Sending the edit of the old suggestion: refused (conflict), nothing sent, and the reloaded item shows the new suggestion.
  const answersBefore = actions.filter(a => a.action === 'answer').length;
  await balance.getByRole('button', { name: 'Send answer', exact: true }).click();
  await expect(balance.getByRole('alert')).toHaveText('Claude changed this suggestion after you opened it. Read the new one, then send again.');
  expect(actions.filter(a => a.action === 'answer')).toHaveLength(answersBefore + 1);
  expect(actions.filter(a => a.action === 'answer').at(-1)).toEqual({ tab: 'feedback', action: 'answer', id: 2, text: `${SUGGESTED[2]} Edited.`, fromSuggestion: true, suggestedAtMs: shownAt });
  await expect(balance.locator('[data-feedback-suggestion]')).toContainText(replaced);
  await expect(balance).toContainText(/Balance\s*Read/);
  expect(owned.find(i => i.id === 2)).toMatchObject({ status: 'read', answer: null });
  expect(await noHorizontalScroll(page)).toBe(true);
  await shot(page, info, 'owner-feedback-suggestion-replaced');
  // Approving the suggestion shown now sends it, with its own time.
  const nowAt = owned.find(i => i.id === 2)!.suggestedAtMs;
  await balance.getByRole('button', { name: 'Approve and send', exact: true }).click();
  await expect(balance).toContainText(/Balance\s*Answered \(approved suggestion\)/);
  expect(actions).toContainEqual({ tab: 'feedback', action: 'answer', id: 2, text: replaced, fromSuggestion: true, suggestedAtMs: nowAt });
});
