// The pure rules behind the messages button and panel (spec "Game messages and a free look change", Decisions and Layout): the
// badge, which messages are unread, the tags and dates, and when a list the panel holds no longer agrees with the owner's inbox.
// No markup anywhere: every title and text here is data, shown by the panel as plain text.
import type { GameMessage, GameNotification, Inbox } from '@contracts/reads';
import type { NotificationsRead } from '../../lib/api/reads';

/**
 * What the messages button and panel need from the shell: the two lists, and the two marks a player's reading sends. `read` marks a
 * message read and then reads the owner again (the badge then drops); `seeNotifications` marks the results shown as seen the same way.
 * Both reject when the mark or the re-read fails, and the panel then asks again the next time the same thing happens.
 */
export type MessagingActions = {
  load(): Promise<GameMessage[]>;
  /** The results to show, and the newest settled time of every row read (the mark `seeNotifications` is sent up to). */
  loadNotifications(): Promise<NotificationsRead>;
  read(messageId: number): Promise<void>;
  seeNotifications(upToMs: number): Promise<void>;
};

/** The badge's text: the number, "9+" above 9, and nothing (null) at 0 or for a count that cannot be true. */
export function badgeText(unread: number): string | null {
  if (!Number.isFinite(unread) || unread <= 0) return null;
  return unread > 9 ? '9+' : String(Math.floor(unread));
}

/** What the button's badge counts: the unread messages and the new notifications together, with no cap on the sum. */
export const newCount = (inbox: Inbox): number => inbox.unread + inbox.newNotifications;

/** The button's accessible name: it says the real count ("Messages, 12 new") where the badge says "9+". */
export const buttonName = (count: number): string => (count > 0 ? `Messages, ${count} new` : 'Messages');

/**
 * Whether a message is unread for this account: published after the gladiator was created (`sinceMs`, so a new player starts at
 * no badge) and not read on any device. The same rule as the server's `inbox.unread`, so the gold dots add up to the badge.
 */
export const isUnread = (message: GameMessage, inbox: Inbox): boolean => message.publishedAtMs > inbox.sinceMs && !inbox.readIds.includes(message.id);

const TAGS: Record<GameMessage['kind'], string> = { 'patch-notes': 'Patch notes', admin: 'Admin' };
/** The tag a message shows: "Patch notes" (gold) or "Admin" (violet). */
export const tagName = (kind: GameMessage['kind']): string => TAGS[kind];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
/**
 * A posting date as day and month ("27 Oct"), in the viewer's own time zone (as the schedule's times are). The month names are
 * this table's, not a locale's (some locales say "Sept").
 */
export function messageDate(ms: number): string {
  const date = new Date(ms);
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/**
 * Whether a message list the panel holds disagrees with the owner's inbox, so the list must be read again (the world revision does
 * not carry it): the inbox counts a different number of unread messages than the list holds (one was posted, or an unread one was
 * hidden), or it names a read message the list lacks (one was posted and read on another device). Reading a message here leaves
 * the list in agreement, so it costs no reload.
 */
export function messagesStale(held: readonly GameMessage[], inbox: Inbox): boolean {
  const ids = new Set(held.map(message => message.id));
  if (inbox.readIds.some(id => !ids.has(id))) return true;
  return held.filter(message => isUnread(message, inbox)).length !== inbox.unread;
}

/** Whether a result settled after the time the account last saw them (`notificationsSeenMs`): the server's rule for a new notification. */
export const isNewNotification = (notification: GameNotification, seenMs: number): boolean => notification.settledAtMs > seenMs;

/**
 * Whether the notification list the panel holds lacks results the inbox counts as new: it holds fewer new results than
 * `inbox.newNotifications` says (the count is uncapped, the list shows at most 20, so a longer backlog stays stale until it is seen).
 */
export function notificationsStale(held: readonly GameNotification[], inbox: Inbox): boolean {
  return held.filter(notification => isNewNotification(notification, inbox.notificationsSeenMs)).length < inbox.newNotifications;
}
