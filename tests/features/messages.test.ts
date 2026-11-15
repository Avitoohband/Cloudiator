import { expect, it } from 'vitest';
import type { GameMessage, GameNotification, Inbox, OwnFeedback } from '@contracts/reads';
import {
  badgeText, buttonName, freshNotifications, messagesRequestFor, isNewNotification, isUnread, messageDate, messagesStale, newCount, notificationsMark,
  notificationsStale, tagName,
} from '../../src/features/messages/messages';
import {
  CATEGORIES, canSendFeedback, deviceText, feedbackDate, feedbackDetails, leftToday, limitLine, limitLineParts, mineSummary, ownerDetails, ownerStatus, playerStatus, replyFor,
  sentToday, textProblem, unseenAnswers,
} from '../../src/features/messages/feedback';
import { nextGameDayMs, waitText } from '../../src/lib/game-day';

// The pure rules behind the messages button and panel (spec "Decisions": badge, unread, tags, dates), and when a list the panel holds no
// longer agrees with the owner's inbox (the world revision does not carry the list, so the panel reloads it when the inbox says so).
const message = (id: number, publishedAtMs: number, over: Partial<GameMessage> = {}): GameMessage =>
  ({ id, kind: 'patch-notes', title: `Message ${id}`, preview: 'Preview', body: [{ p: 'Text' }], action: null, publishedAtMs, ...over });
const inbox = (over: Partial<Inbox> = {}): Inbox => ({ unread: 0, readIds: [], sinceMs: 1_000, newNotifications: 0, notificationsSeenMs: 0, ...over });
const result = (n: number, settledAtMs: number): GameNotification => ({
  activityId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, kind: 'training', settledAtMs, destination: null, levelAfter: null,
  summary: { activityId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, resolvedKind: 'training', result: 'completed', success: true,
    rewards: { money: 0, renown: 0, xp: 0, attributePoints: 1, items: [], overflowMoney: 0 }, receiptId: `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`,
    settledAtMs, replayExpiry: { state: 'expired' } },
});

it('shows the number on the badge, "9+" above 9, and nothing at 0', () => {
  expect(badgeText(0)).toBeNull();
  expect(badgeText(1)).toBe('1');
  expect(badgeText(2)).toBe('2');
  expect(badgeText(9)).toBe('9');
  expect(badgeText(10)).toBe('9+');
  expect(badgeText(12)).toBe('9+');
  expect(badgeText(1_000)).toBe('9+');
  // A count that cannot be true (negative, not a whole number) shows no badge rather than a wrong one.
  expect(badgeText(-1)).toBeNull();
  expect(badgeText(Number.NaN)).toBeNull();
});

it('names the button with the count it shows, never "9+"', () => {
  expect(buttonName(0)).toBe('Messages');
  expect(buttonName(2)).toBe('Messages, 2 new');
  expect(buttonName(12)).toBe('Messages, 12 new');
  // The badge counts the unread messages and the new notifications together, with no cap on the sum.
  expect(newCount(inbox({ unread: 2, newNotifications: 25 }))).toBe(27);
  expect(newCount(inbox())).toBe(0);
});

it('counts a message unread only when it came after the gladiator and has not been read: the server\'s rule', () => {
  const state = inbox({ sinceMs: 1_000, readIds: [3] });
  expect(isUnread(message(1, 2_000), state)).toBe(true);
  expect(isUnread(message(3, 2_000), state)).toBe(false);          // read, on any device
  expect(isUnread(message(2, 500), state)).toBe(false);            // older than the gladiator: listed, already read
  expect(isUnread(message(4, 1_000), state)).toBe(false);          // posted at the creation time: not after it (strict)
  expect(isUnread(message(5, 1_001), state)).toBe(true);
});

it('names the two kinds of message', () => {
  expect(tagName('patch-notes')).toBe('Patch notes');
  expect(tagName('admin')).toBe('Admin');
});

it('shows a posting date as day and month, like "27 Oct", in the viewer\'s own time zone', () => {
  expect(messageDate(new Date(2026, 9, 27, 12).getTime())).toBe('27 Oct');
  expect(messageDate(new Date(2026, 0, 5, 12).getTime())).toBe('5 Jan');
  expect(messageDate(new Date(2026, 8, 30, 12).getTime())).toBe('30 Sep');
  expect(messageDate(new Date(2027, 11, 1, 12).getTime())).toBe('1 Dec');
  // Every month has its own short name, never a locale's variant (some locales say "Sept").
  expect(Array.from({ length: 12 }, (_, month) => messageDate(new Date(2026, month, 15, 12).getTime()))).toEqual(
    ['15 Jan', '15 Feb', '15 Mar', '15 Apr', '15 May', '15 Jun', '15 Jul', '15 Aug', '15 Sep', '15 Oct', '15 Nov', '15 Dec']);
});

it('says a held message list is stale when the inbox counts an unread message it does not hold, or a read id it lacks', () => {
  const held = [message(2, 3_000), message(1, 2_000)];
  // Agreeing: both held messages unread, none read.
  expect(messagesStale(held, inbox({ unread: 2 }))).toBe(false);
  // A message was posted: one more unread than the list holds.
  expect(messagesStale(held, inbox({ unread: 3 }))).toBe(true);
  // One was read here: the list still agrees (it counts that message as read with the new inbox).
  expect(messagesStale(held, inbox({ unread: 1, readIds: [1] }))).toBe(false);
  // One was hidden by the operator while unread: the list holds a message the inbox no longer counts.
  expect(messagesStale(held, inbox({ unread: 1 }))).toBe(true);
  // A message was posted and read on another device: the count is unchanged but the inbox names an id the list lacks.
  expect(messagesStale(held, inbox({ unread: 2, readIds: [9] }))).toBe(true);
  // An older message (before the gladiator) is not counted either way.
  expect(messagesStale([message(1, 500)], inbox({ unread: 0 }))).toBe(false);
  expect(messagesStale([], inbox())).toBe(false);
});

it('says a held notification list is stale when the inbox counts more new results than it holds', () => {
  const held = [result(2, 5_000), result(1, 4_000)];
  expect(notificationsStale(held, inbox({ notificationsSeenMs: 4_500, newNotifications: 1 }))).toBe(false);
  expect(notificationsStale(held, inbox({ notificationsSeenMs: 0, newNotifications: 2 }))).toBe(false);
  // Seen up to the newest: nothing is new.
  expect(notificationsStale(held, inbox({ notificationsSeenMs: 5_000, newNotifications: 0 }))).toBe(false);
  // A result was credited since the list was read.
  expect(notificationsStale(held, inbox({ notificationsSeenMs: 5_000, newNotifications: 1 }))).toBe(true);
  expect(notificationsStale([], inbox({ newNotifications: 1 }))).toBe(true);
  expect(notificationsStale([], inbox())).toBe(false);
});

// Patch 1.7 Task 11: the server's `newNotifications` counts the title notices too (distinct source and time, after the mark), so a held
// list agrees with it only when its new results and the owner's new notices add up; the summary's "new" counts both, and the mark goes up
// to the newest of the results read and the notices listed.
it('counts the title notices with the results when it decides that a held list is stale', () => {
  const held = [result(2, 5_000), result(1, 4_000)];
  const notices = [{ atMs: 6_000 }, { atMs: 3_000 }];
  expect(notificationsStale(held, inbox({ notificationsSeenMs: 0, newNotifications: 4 }), notices)).toBe(false);
  expect(notificationsStale(held, inbox({ notificationsSeenMs: 4_500, newNotifications: 2 }), notices)).toBe(false);
  // A notice that the owner read does not carry yet (or a result the list lacks): stale.
  expect(notificationsStale(held, inbox({ notificationsSeenMs: 4_500, newNotifications: 3 }), notices)).toBe(true);
  // Without the notices, the inbox's notice is a result the list lacks.
  expect(notificationsStale(held, inbox({ notificationsSeenMs: 4_500, newNotifications: 2 }))).toBe(true);
});

it('counts the new results and title notices together', () => {
  expect(freshNotifications([result(2, 5_000), result(1, 4_000)], [{ atMs: 6_000 }, { atMs: 3_000 }], 3_500)).toBe(3);
  expect(freshNotifications([result(2, 5_000)], [{ atMs: 5_000 }], 5_000)).toBe(0);
  expect(freshNotifications([], [], 0)).toBe(0);
});

it('marks the tab seen up to the newest of the results read and the notices listed', () => {
  expect(notificationsMark(5_000, [{ atMs: 6_000 }, { atMs: 3_000 }])).toBe(6_000);
  expect(notificationsMark(7_000, [{ atMs: 6_000 }])).toBe(7_000);
  expect(notificationsMark(null, [{ atMs: 6_000 }])).toBe(6_000);
  expect(notificationsMark(5_000, [])).toBe(5_000);
  expect(notificationsMark(null, [])).toBeNull();
});

it('marks a result new when it settled after the time the account last saw them', () => {
  expect(isNewNotification(result(1, 5_000), 4_999)).toBe(true);
  expect(isNewNotification(result(1, 5_000), 5_000)).toBe(false);
  expect(isNewNotification(result(1, 5_000), 9_000)).toBe(false);
});

// Task 7 review fix: the account can change while both gladiator identities are still unknown.
it('adopts the first bootstrap account, then binds it before the owner resolves', () => {
  const bootstrap = { tab: 'notifications' as const, n: 1, account: undefined, owner: undefined };
  expect(messagesRequestFor(bootstrap, undefined, undefined)).toBe(bootstrap);
  const a = messagesRequestFor(bootstrap, 'account-a', undefined);
  expect(a).toEqual({ ...bootstrap, account: 'account-a' });
  expect(messagesRequestFor(a, 'account-a', undefined)).toBe(a);
  const ready = messagesRequestFor(a, 'account-a', 'gladiator-a');
  expect(ready).toEqual({ ...bootstrap, account: 'account-a', owner: 'gladiator-a' });
  // Effective render gating must reject B even before a cleanup effect changes stored state.
  expect(messagesRequestFor(a, 'account-b', undefined)).toBeNull();
  expect(messagesRequestFor(a, 'account-b', 'gladiator-b')).toBeNull();
  expect(messagesRequestFor(ready, 'account-b', 'gladiator-b')).toBeNull();
});

it('drops a bootstrap visitor and preserves same-account delayed-owner adoption only', () => {
  const bootstrap = { tab: 'notifications' as const, n: 2, account: undefined, owner: undefined };
  expect(messagesRequestFor(bootstrap, null, null)).toBeNull();
  expect(messagesRequestFor(bootstrap, 'account-a', null)).toBeNull();
  const pending = { ...bootstrap, account: 'account-a' };
  const ready = messagesRequestFor(pending, 'account-a', 'gladiator-a');
  expect(ready).toEqual({ ...pending, owner: 'gladiator-a' });
  expect(messagesRequestFor(pending, null, null)).toBeNull();
  expect(messagesRequestFor(ready, 'account-a', 'gladiator-b')).toBeNull();
  expect(messagesRequestFor(null, 'account-b', 'gladiator-b')).toBeNull();
});

// Patch 1.9 (Task 23): a request may open the panel on My feedback (Settings' "See my feedback"), bound to its account like the others.
it('binds a My feedback request to its account and owner like a Notifications one', () => {
  const request = { tab: 'feedback' as const, n: 3, account: 'account-a', owner: 'gladiator-a' };
  expect(messagesRequestFor(request, 'account-a', 'gladiator-a')).toBe(request);
  expect(messagesRequestFor(request, 'account-b', 'gladiator-a')).toBeNull();
});

// Patch 1.9 (Task 23): Feedback (the approved mockup, notes.md "Feedback"). The game day is three 80-minute slots, floor(time / 14,400,000),
// as the server counts it; the details are exactly the five keys, each at most 80 characters.
const DAY = 14_400_000;
const own = (id: number, createdAtMs: number, over: Partial<OwnFeedback> = {}): OwnFeedback =>
  ({ id, category: 'idea', text: `Feedback number ${id}`, status: 'new', createdAtMs, answeredAtMs: null, ...over });
const plain = (text: string) => text.replace(/ /g, ' ');

it('counts the feedback sent in the current game day and what is left of 5', () => {
  const now = 100 * DAY + 2 * 3_600_000;
  expect(sentToday([], now)).toBe(0);
  expect(leftToday([], now)).toBe(5);
  const list = [own(4, now - 60_000), own(3, 100 * DAY), own(2, 100 * DAY - 1), own(1, 99 * DAY)];
  expect(sentToday(list, now)).toBe(2);
  expect(leftToday(list, now)).toBe(3);
  expect(leftToday([1, 2, 3, 4, 5, 6].map(n => own(n, 100 * DAY + n)), now)).toBe(0);
  // The next game day starts afresh.
  expect(leftToday(list, 101 * DAY)).toBe(5);
});

it('writes the limit line, and at 0 when the next game day starts', () => {
  const now = 101 * DAY - (2 * 3_600_000 + 20 * 60_000);
  expect(limitLine(3, now)).toBe('You can send 5 a game day; 3 left today.');
  expect(limitLine(null, now)).toBe('You can send 5 a game day.');
  expect(plain(limitLine(0, now))).toBe('You have sent 5 today. You can send more on the next game day (in 2 h 20 min).');
  // Final fix wave: the dialog's polite status says only the static words; the minute countdown is shown after it, outside the live region.
  const parts = limitLineParts(0, now);
  expect(parts.said).toBe('You have sent 5 today. You can send more on the next game day');
  expect(plain(parts.wait)).toBe(' (in 2 h 20 min).');
  expect(limitLineParts(0, now + 60_000).said).toBe(parts.said);
  for (const left of [null, 0, 3]) expect(plain(limitLineParts(left, now).said + limitLineParts(left, now).wait)).toBe(plain(limitLine(left, now)));
  expect(limitLineParts(3, now)).toEqual({ said: 'You can send 5 a game day; 3 left today.', wait: '' });
  expect(plain(waitText(45 * 60_000 + 59_000))).toBe('45 min');
  expect(plain(waitText(3_600_000))).toBe('1 h');
  expect(waitText(30_000)).toBe('under a minute');
  expect(nextGameDayMs(100 * DAY)).toBe(101 * DAY);
  expect(nextGameDayMs(101 * DAY - 1)).toBe(101 * DAY);
});

it('asks for at least 10 characters once trimmed and refuses a send at 0 left', () => {
  expect(textProblem('')).toBeNull();
  expect(textProblem('   short  ')).toBe('Write at least 10 characters.');
  expect(textProblem('ten chars!')).toBeNull();
  expect(canSendFeedback('ten chars!', 3)).toBe(true);
  expect(canSendFeedback('ten chars!', null)).toBe(true);
  expect(canSendFeedback('ten chars!', 0)).toBe(false);
  expect(canSendFeedback('  nine ch  ', 3)).toBe(false);
  expect(CATEGORIES.map(c => c.label)).toEqual(['Bug', 'Idea', 'Balance', 'Other']);
  expect(CATEGORIES.find(c => c.id === 'bug')?.hint).toBe('Something is broken or shows a wrong number.');
});

it('names the browser, the system and phone or desktop, and builds exactly the five details', () => {
  const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const firefox = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0';
  const edge = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';
  expect(deviceText(chrome, false)).toBe('Chrome 131 on Windows (desktop)');
  expect(deviceText(android, true)).toBe('Chrome 131 on Android (phone)');
  expect(deviceText(iphone, true)).toBe('Safari 18 on iOS (phone)');
  expect(deviceText(firefox, false)).toBe('Firefox 132 on Windows (desktop)');
  expect(deviceText(edge, false)).toBe('Edge 131 on Windows (desktop)');
  expect(deviceText('', false)).toBe('A browser (desktop)');
  const details = feedbackDetails({ screen: 'Messages', userAgent: chrome, phone: false, width: 1280, height: 720, sentAtMs: 1_791_592_800_000 });
  expect(details).toEqual({ patch: '1.9.1', screen: 'Messages', device: 'Chrome 131 on Windows (desktop)', window: '1280 x 720', sentAtMs: 1_791_592_800_000 });
  expect(Object.keys(details)).toEqual(['patch', 'screen', 'device', 'window', 'sentAtMs']);
  const long = feedbackDetails({ screen: 'S'.repeat(200), userAgent: `${'x'.repeat(300)} Chrome/1`, phone: true, width: 360.4, height: 780.6, sentAtMs: 5 });
  for (const key of ['patch', 'screen', 'device', 'window'] as const) expect([...long[key]].length).toBeLessThanOrEqual(80);
  expect(long.window).toBe('360 x 781');
});

it('summarises My feedback, names the statuses for the player and the owner, and dates the rows', () => {
  expect(mineSummary([own(3, 3, { status: 'answered', answeredAtMs: 9 }), own(2, 2, { status: 'read' }), own(1, 1)])).toBe('My feedback · 3 sent · 1 answered');
  expect(mineSummary([])).toBe('My feedback · 0 sent · 0 answered');
  expect((['new', 'read', 'answered'] as const).map(playerStatus)).toEqual(['Sent', 'Read', 'Answered']);
  expect((['new', 'read', 'answered'] as const).map(ownerStatus)).toEqual(['New', 'Read', 'Answered']);
  const now = new Date(2026, 10, 12, 15, 42).getTime();
  expect(feedbackDate(new Date(2026, 10, 12, 14, 12).getTime(), now, '24')).toBe('Today 14:12');
  expect(feedbackDate(new Date(2026, 10, 11, 21, 3).getTime(), now, '24')).toBe('Yesterday');
  expect(feedbackDate(new Date(2026, 10, 11, 21, 3).getTime(), now, '24', true)).toBe('Yesterday 21:03');
  expect(feedbackDate(new Date(2026, 10, 10, 9, 0).getTime(), now, '24')).toBe('10 Nov');
  expect(feedbackDate(new Date(2026, 10, 10, 9, 0).getTime(), now, '24', true)).toBe('10 Nov 09:00');
});

it('finds the team reply of an answered item and counts the replies not yet seen', () => {
  const reply = message(7, 5_000, { kind: 'team-reply', title: 'Answer to your bug report' });
  const other = message(8, 5_000, { kind: 'admin' });
  const answered = own(1, 1_000, { status: 'answered', answeredAtMs: 5_000 });
  expect(replyFor(answered, [other, reply])).toBe(reply);
  expect(replyFor(own(2, 1_000), [other, reply])).toBeNull();
  expect(replyFor({ ...answered, answeredAtMs: 6_000 }, [other, reply])).toBeNull();
  expect(unseenAnswers([reply, other], inbox())).toBe(1);
  expect(unseenAnswers([reply, other], inbox({ readIds: [7] }))).toBe(0);
  expect(tagName('team-reply')).toBe('Team reply');
});

it('writes the details the owner sees in one line', () => {
  const at = new Date(2026, 10, 12, 15, 42).getTime();
  expect(ownerDetails({ patch: '1.9', screen: 'Arena', device: 'Chrome 131 on Android (phone)', window: '360 x 780', sentAtMs: at }, '24'))
    .toBe('Patch 1.9 · Arena · Chrome 131 on Android (phone) · 360 x 780 · 15:42');
  expect(ownerDetails(null, '24')).toBeNull();
});
