// Patch 1.9 (Task 23): the pure rules behind Feedback (the approved mockup, notes.md "Feedback"): the categories and their hints, what is
// left of the 5 a game day, the limit line, the 10-character minimum, the five game details (each at most 80 characters, nothing else), the
// statuses as the player and the owner read them, the dates of the rows, and the team's answer, which arrives as a `team-reply` message
// whose posting time is the item's `answeredAtMs`. Every text here is data, shown as plain text.
import type { CommandResult, GameCommand, SendFeedbackValue } from '@contracts/commands';
import type { FeedbackCategory, FeedbackDetails, FeedbackStatus, GameMessage, Inbox, OwnFeedback } from '@contracts/reads';
import { FEEDBACK, trimmedLength, validFeedbackText } from '@domain/feedback';
import type { DisplayClock } from '../../game/display-clock';
import type { ClockMode } from '../../lib/clock-setting';
import { gameDayOf, nextGameDayMs, waitText } from '../../lib/game-day';
import { PATCH } from '../../lib/patch';
import { timeOfDay } from '../../lib/time-format';
import { isUnread, messageDate } from './messages';

export type SendFeedbackCommand = Extract<GameCommand, { kind: 'send-feedback' }>;
/**
 * What the dialog and My feedback need from the shell, for a signed-in account of the live game only (a visitor and the fixture preview
 * have none, so they show no feedback entry): the account's own feedback, newest first; one `send-feedback`; the shared display clock
 * (server time), which the game day is counted on.
 */
export type FeedbackActions = {
  load(): Promise<OwnFeedback[]>;
  send(command: SendFeedbackCommand): Promise<CommandResult<SendFeedbackValue>>;
  clock: DisplayClock;
};

/** The four kinds, in the dialog's order, each with the line under the choice. */
export const CATEGORIES: readonly { id: FeedbackCategory; label: string; hint: string }[] = [
  { id: 'bug', label: 'Bug', hint: 'Something is broken or shows a wrong number.' },
  { id: 'idea', label: 'Idea', hint: 'Something you would like in the game.' },
  { id: 'balance', label: 'Balance', hint: 'Something feels too strong, too weak or unfair.' },
  { id: 'other', label: 'Other', hint: 'Anything else.' },
];
export const categoryLabel = (category: FeedbackCategory): string => CATEGORIES.find(c => c.id === category)?.label ?? 'Other';
/** The text box's placeholder: a bug asks what happened. */
export const placeholderFor = (category: FeedbackCategory): string =>
  (category === 'bug' ? 'What happened? What did you expect? What were you doing?' : 'Write it in your own words. The team reads every message.');

/** How many of these were sent in the game day of `nowMs` (the server's count for the limit). */
export const sentToday = (list: readonly Pick<OwnFeedback, 'createdAtMs'>[], nowMs: number): number =>
  list.filter(item => gameDayOf(item.createdAtMs) === gameDayOf(nowMs)).length;
/** What is left of the 5 a game day. */
export const leftToday = (list: readonly Pick<OwnFeedback, 'createdAtMs'>[], nowMs: number): number => Math.max(0, FEEDBACK.dailyLimit - sentToday(list, nowMs));

/**
 * Where the team's answer arrives for an account without a gladiator (final fix wave): it has no inbox yet. The sent line ends with it, and
 * the Settings Help row says it in place of "The team answers in your messages."
 */
export const FEEDBACK_ANSWER_LATER = 'The team’s answer will arrive in your messages once you have a gladiator.';

/** The dialog's limit line: what is left (unknown: the rule alone), or at 0 when the next game day starts. */
export function limitLine(left: number | null, nowMs: number): string {
  const { said, wait } = limitLineParts(left, nowMs);
  return said + wait;
}
/**
 * The limit line in two parts (final fix wave): `said`, the static words the dialog's polite status announces, and `wait`, the minute
 * countdown at 0 (" (in 2 h 20 min).") shown right after it outside the live region, so it is not announced every minute; else ''.
 */
export function limitLineParts(left: number | null, nowMs: number): { said: string; wait: string } {
  if (left === null) return { said: `You can send ${FEEDBACK.dailyLimit} a game day.`, wait: '' };
  if (left > 0) return { said: `You can send ${FEEDBACK.dailyLimit} a game day; ${left} left today.`, wait: '' };
  return { said: `You have sent ${FEEDBACK.dailyLimit} today. You can send more on the next game day`, wait: ` (in ${waitText(nextGameDayMs(nowMs) - nowMs)}).` };
}

/** What the text box says is wrong: under 10 characters once trimmed (nothing typed is not wrong yet). */
export const textProblem = (text: string): string | null => {
  const length = trimmedLength(text);
  return length > 0 && length < FEEDBACK.textMinimum ? `Write at least ${FEEDBACK.textMinimum} characters.` : null;
};
/** Whether Send may go: a text the server takes, and something left today (null: not known yet, the server decides). */
export const canSendFeedback = (text: string, left: number | null): boolean => validFeedbackText(text) && left !== 0;

/** At most `max` characters (code points, as the server counts). */
const cut = (text: string, max: number = FEEDBACK.detailMaximum) => [...text].slice(0, max).join('');

const BROWSERS: readonly [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\/(\d+)/, 'Edge'], [/\bOPR\/(\d+)/, 'Opera'], [/\bSamsungBrowser\/(\d+)/, 'Samsung Internet'],
  [/\b(?:Firefox|FxiOS)\/(\d+)/, 'Firefox'], [/\b(?:Chrome|CriOS)\/(\d+)/, 'Chrome'], [/\bVersion\/(\d+)[\d.]*(?: Mobile\/\S+)? Safari\//, 'Safari'],
];
const SYSTEMS: readonly [RegExp, string][] = [
  [/Android/, 'Android'], [/iPhone|iPod/, 'iOS'], [/iPad/, 'iPadOS'], [/CrOS/, 'ChromeOS'], [/Windows/, 'Windows'], [/Macintosh|Mac OS X/, 'macOS'], [/Linux/, 'Linux'],
];
/** The device line: the browser and its major version, the system, and whether the game shows its phone (touch) layout. */
export function deviceText(userAgent: string, phone: boolean): string {
  let browser = 'A browser';
  for (const [pattern, name] of BROWSERS) {
    const match = pattern.exec(userAgent);
    if (match) { browser = `${name} ${match[1]}`; break; }
  }
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  return cut(`${browser}${system ? ` on ${system}` : ''} (${phone ? 'phone' : 'desktop'})`);
}

/** The game details sent with feedback: exactly the five keys the server stores, each string at most 80 characters. */
export function feedbackDetails(input: { screen: string; userAgent: string; phone: boolean; width: number; height: number; sentAtMs: number }): FeedbackDetails {
  return {
    patch: cut(PATCH),
    screen: cut(input.screen),
    device: deviceText(input.userAgent, input.phone),
    window: cut(`${Math.round(input.width)} x ${Math.round(input.height)}`),
    sentAtMs: Math.max(0, Math.floor(input.sentAtMs)),
  };
}

/** The status as the player reads it in My feedback. */
export const playerStatus = (status: FeedbackStatus): string => (status === 'new' ? 'Sent' : status === 'read' ? 'Read' : 'Answered');
/** The status as the owner reads it in the Feedback tab. */
export const ownerStatus = (status: FeedbackStatus): string => (status === 'new' ? 'New' : status === 'read' ? 'Read' : 'Answered');

/** My feedback's summary line. */
export const mineSummary = (list: readonly OwnFeedback[]): string =>
  `My feedback · ${list.length} sent · ${list.filter(item => item.status === 'answered').length} answered`;

const DAY_MS = 86_400_000;
/** The viewer's local calendar day of `ms` (exact through daylight-saving changes). */
const localDay = (ms: number) => { const date = new Date(ms); return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()); };
/**
 * A row's date against `nowMs`, in the viewer's time zone: "Today 14:12", "Yesterday" and "10 Nov"; `withTime` (the owner's list) adds the
 * time to every day ("Yesterday 21:03", "10 Nov 09:00").
 */
export function feedbackDate(ms: number, nowMs: number, clock: ClockMode, withTime = false): string {
  const time = timeOfDay(ms, clock);
  const days = (localDay(nowMs) - localDay(ms)) / DAY_MS;
  const day = days === 0 ? 'Today' : days === 1 ? 'Yesterday' : messageDate(ms);
  return days === 0 || withTime ? `${day} ${time}`.trim() : day;
}

/** The team's answer to an answered item: the `team-reply` message posted at its `answeredAtMs`, or null when the list does not hold it. */
export function replyFor(item: Pick<OwnFeedback, 'answeredAtMs'>, messages: readonly GameMessage[]): GameMessage | null {
  if (item.answeredAtMs === null) return null;
  return messages.find(message => message.kind === 'team-reply' && message.publishedAtMs === item.answeredAtMs) ?? null;
}
/** How many team answers the player has not seen yet: the unread `team-reply` messages (the green count on My feedback). */
export const unseenAnswers = (messages: readonly GameMessage[], inbox: Inbox): number =>
  messages.filter(message => message.kind === 'team-reply' && isUnread(message, inbox)).length;

/** What the owner sees of the game details in one line ("Patch 1.9 · Arena · … · 360 x 780 · 15:42"), or null when none were sent. */
export function ownerDetails(details: FeedbackDetails | null, clock: ClockMode): string | null {
  if (!details) return null;
  const time = timeOfDay(details.sentAtMs, clock);
  return [`Patch ${details.patch}`, details.screen, details.device, details.window, time].filter(Boolean).join(' · ');
}
