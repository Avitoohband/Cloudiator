import { expect, it } from 'vitest';
import type { GameMessage, GameNotification, Inbox } from '@contracts/reads';
import {
  badgeText, buttonName, isNewNotification, isUnread, messageDate, messagesStale, newCount, notificationsStale, tagName,
} from '../../src/features/messages/messages';

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

it('marks a result new when it settled after the time the account last saw them', () => {
  expect(isNewNotification(result(1, 5_000), 4_999)).toBe(true);
  expect(isNewNotification(result(1, 5_000), 5_000)).toBe(false);
  expect(isNewNotification(result(1, 5_000), 9_000)).toBe(false);
});
