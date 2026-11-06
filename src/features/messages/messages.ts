// The pure rules behind the messages button and panel (spec "Game messages and a free look change", Decisions and Layout): the
// badge, which messages are unread, the tags and dates, and when a list the panel holds no longer agrees with the owner's inbox.
// No markup anywhere: every title and text here is data, shown by the panel as plain text.
import type { GameMessage, GameNotification, Inbox } from '@contracts/reads';
import type { NotificationsRead, ShownMessage } from '../../lib/api/reads';
import type { PatchEntry } from '../../lib/patch';
export type { ShownMessage } from '../../lib/api/reads';

/** Undefined while identity loads, null for a known visitor or missing gladiator. */
type RequestIdentity = string | null | undefined;
export type MessagesRequest = { tab: 'notifications'; n: number; account: RequestIdentity; owner: RequestIdentity };

/**
 * The request this account/owner may consume now. Bootstrap may adopt its first authenticated account, then its first owner;
 * once either is known it cannot be adopted again. Use this during render as well as when settling stored identity, so another
 * account's first ready render cannot consume a stale request before the cleanup effect runs.
 */
export function messagesRequestFor(request: MessagesRequest | null, account: RequestIdentity, owner: RequestIdentity): MessagesRequest | null {
  if (!request) return null;
  if (request.account !== account && !(request.account === undefined && typeof account === 'string')) return null;
  if (request.owner !== owner && !(request.owner === undefined && typeof owner === 'string')) return null;
  return request.account === account && request.owner === owner ? request : { ...request, account, owner };
}

/**
 * What the messages button and panel need from the shell: the two lists, and the two marks a player's reading sends. `read` marks a
 * message read and then reads the owner again (the badge then drops); `seeNotifications` marks the results shown as seen the same way.
 * Both reject when the mark or the re-read fails, and the panel then asks again the next time the same thing happens.
 */
export type MessagingActions = {
  /** Watch uses the shared server clock; the popover closes before open is called. */
  watch?: { kept(note: GameNotification): boolean; open(note: GameNotification): void };
  /** The messages, each patch note with its patch number (null when it has none, or the numbers read failed). */
  load(): Promise<ShownMessage[]>;
  /** One page of Patch history: 20 patches, newest first, older than `beforeSortKey` when given; `more` when there are older ones. */
  loadPatches(beforeSortKey?: number): Promise<{ items: PatchEntry[]; more: boolean }>;
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

/** A title notice as the counts see it (patch 1.7, `TitleNotice`): its time. */
type Timed = { atMs: number };

/**
 * Whether the notification list the panel holds lacks results the inbox counts as new: it holds fewer new results and new title notices
 * (the owner's, patch 1.7: the server counts them in `newNotifications`) than `inbox.newNotifications` says (the count is uncapped, the
 * list shows at most 20, so a longer backlog stays stale until it is seen).
 */
export function notificationsStale(held: readonly GameNotification[], inbox: Inbox, notices: readonly Timed[] = []): boolean {
  return freshNotifications(held, notices, inbox.notificationsSeenMs) < inbox.newNotifications;
}

/** How many of these results and title notices are new after `seenMs` (the server's rule for both). */
export function freshNotifications(results: readonly GameNotification[], notices: readonly Timed[], seenMs: number): number {
  return results.filter(result => isNewNotification(result, seenMs)).length + notices.filter(notice => notice.atMs > seenMs).length;
}

/**
 * The time the Notifications tab is marked seen up to: the newest of the results read (`newestSettledMs`, every row fetched, shown or
 * not) and the title notices listed; null when there is neither.
 */
export function notificationsMark(newestSettledMs: number | null, notices: readonly Timed[]): number | null {
  const times = [...(newestSettledMs === null ? [] : [newestSettledMs]), ...notices.map(notice => notice.atMs)];
  return times.length ? Math.max(...times) : null;
}
