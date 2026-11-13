import type { FeedbackCategory, FeedbackDetails } from '../contracts/reads.ts';

/**
 * Patch 1.9 (M34): the Feedback and Buy back limits. SQL restates every one of them and is the authority
 * (supabase/sql/28-feedback-buyback.sql); the Edge parser and the client use these to refuse early and to explain.
 * The game day is three 80-minute slots, floor(time / 14,400,000), as in SQL.
 */
export const FEEDBACK = Object.freeze({
  categories: Object.freeze(['bug', 'idea', 'balance', 'other'] as const),
  /** Characters (code points) of the text once leading and trailing white space is trimmed. */
  textMinimum: 10, textMaximum: 1000,
  /** Feedback per account and game day. */
  dailyLimit: 5,
  /** The game details: these keys exactly, each string at most this many characters; `sentAtMs` a whole time from 0. */
  detailKeys: Object.freeze(['patch', 'screen', 'device', 'window', 'sentAtMs'] as const),
  detailMaximum: 80,
  /** The owner's answer, characters once trimmed, and the most items one list answers. */
  answerMinimum: 1, answerMaximum: 2000, listMaximum: 100,
  gameDayMs: 14_400_000,
});
/** Buy back: the last this-many gear sales of the current game day can be bought back, until the next game day. */
export const BUY_BACK = Object.freeze({ recentSales: 10, gameDayMs: 14_400_000 });

/** Characters (code points, as SQL's char_length) of `text` once trimmed. */
export const trimmedLength = (text: string): number => [...text.trim()].length;
/** A string the database can store: no NUL (a JSON `\u0000` cannot become text). */
const storable = (value: unknown): value is string => typeof value === 'string' && !value.includes('\u0000');
export const isFeedbackCategory = (value: unknown): value is FeedbackCategory =>
  typeof value === 'string' && (FEEDBACK.categories as readonly string[]).includes(value);
/** A feedback text the server accepts: a storable string of 10 to 1,000 characters once trimmed. */
export const validFeedbackText = (value: unknown): value is string =>
  storable(value) && trimmedLength(value) >= FEEDBACK.textMinimum && trimmedLength(value) <= FEEDBACK.textMaximum;
/** Exactly the five game details: four storable strings of at most 80 characters and a whole `sentAtMs` from 0. */
export function validFeedbackDetails(value: unknown): value is FeedbackDetails {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== FEEDBACK.detailKeys.length || !FEEDBACK.detailKeys.every(key => Object.hasOwn(value, key))) return false;
  const details = value as Record<string, unknown>;
  return (['patch', 'screen', 'device', 'window'] as const).every(key => storable(details[key]) && [...(details[key] as string)].length <= FEEDBACK.detailMaximum)
    && typeof details.sentAtMs === 'number' && Number.isSafeInteger(details.sentAtMs) && details.sentAtMs >= 0;
}
/** An owner's answer the server accepts: a storable string of 1 to 2,000 characters once trimmed. */
export const validFeedbackAnswer = (value: unknown): value is string =>
  storable(value) && trimmedLength(value) >= FEEDBACK.answerMinimum && trimmedLength(value) <= FEEDBACK.answerMaximum;
/** M36: a suggested answer Claude may save through the Game Info MCP, with the same limits as the answer it may become. */
export const validFeedbackSuggestion = validFeedbackAnswer;
