// Patch 1.9 (Task 23): the owner's feedback actions through the `game-info` Edge function (Task 22's M34), for the Game Info editors only:
// list (New, Answered or All: newest first, at most 100, and how many are new in all), mark read and answer (one answer per item; it is
// sent to the player as a team-reply message). A refusal is its code: `forbidden` (not an editor), `invalid`, `not-found`, `conflict` (already
// answered) or `unavailable`. The items are read defensively: a malformed one is left out rather than failing the list.
// M36 (Task 23b): an item may carry Claude's suggested answer (saved through the Game Info MCP), which only the owner sends: as shown or
// edited, with `fromSuggestion` (then `answeredVia` is 'claude-approved'; the owner's own words are 'owner').
import type { FeedbackAnsweredVia, FeedbackDetails, FeedbackStatus, OwnerFeedbackItem } from '@contracts/reads';
import { isFeedbackCategory, validFeedbackDetails } from '@domain/feedback';
import { getBrowserClient } from '../../lib/api/client';

export type FeedbackFilter = 'new' | 'answered' | 'all';
export type ReviewCode = 'forbidden' | 'invalid' | 'not-found' | 'conflict' | 'unavailable';
type Refusal = { ok: false; code: ReviewCode };

const STATUSES: readonly string[] = ['new', 'read', 'answered'] satisfies FeedbackStatus[];
const ANSWERED_VIA: readonly string[] = ['owner', 'claude-approved'] satisfies FeedbackAnsweredVia[];
const whole = (value: unknown, min = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** One posted action: its JSON answer on success, or the refusal its status names. */
async function invoke(body: Record<string, unknown>): Promise<{ ok: true; data: Record<string, unknown> } | Refusal> {
  const unavailable: Refusal = { ok: false, code: 'unavailable' };
  try {
    const client = getBrowserClient();
    if (!client) return unavailable;
    const { data, error } = await client.functions.invoke('game-info', { body });
    if (error) {
      const response = 'context' in error ? error.context : null;
      if (!(response instanceof Response)) return unavailable;
      const code: ReviewCode = response.status === 403 ? 'forbidden' : response.status === 400 ? 'invalid' : response.status === 404 ? 'not-found'
        : response.status === 409 ? 'conflict' : 'unavailable';
      return { ok: false, code };
    }
    return record(data) && data.ok === true ? { ok: true, data } : unavailable;
  } catch { return unavailable; }
}

/** One item of the list, or null when any part of it is malformed. */
export function feedbackItemOf(value: unknown): OwnerFeedbackItem | null {
  if (!record(value) || !whole(value.id, 1) || !isFeedbackCategory(value.category) || typeof value.text !== 'string' || typeof value.status !== 'string'
    || !STATUSES.includes(value.status) || !whole(value.createdAtMs) || (value.gladiatorName !== null && typeof value.gladiatorName !== 'string')
    || (value.answer !== null && typeof value.answer !== 'string') || (value.answeredAtMs !== null && !whole(value.answeredAtMs))) return null;
  // M36's fields: absent (a server before M36) reads as none; present, they must be well formed, and a suggestion has its time.
  const answeredVia = value.answeredVia ?? null, suggestion = value.suggestion ?? null, suggestedAtMs = value.suggestedAtMs ?? null;
  if ((answeredVia !== null && (typeof answeredVia !== 'string' || !ANSWERED_VIA.includes(answeredVia)))
    || (suggestion !== null && (typeof suggestion !== 'string' || !whole(suggestedAtMs))) || (suggestion === null && suggestedAtMs !== null)) return null;
  const details = value.details === null || !validFeedbackDetails(value.details) ? null : value.details as FeedbackDetails;
  return { id: value.id, category: value.category, text: value.text, details, status: value.status as FeedbackStatus, createdAtMs: value.createdAtMs,
    gladiatorName: value.gladiatorName as string | null, answer: value.answer as string | null, answeredAtMs: value.answeredAtMs as number | null,
    answeredVia: answeredVia as FeedbackAnsweredVia | null, suggestion: suggestion as string | null, suggestedAtMs: suggestedAtMs as number | null };
}

/** The feedback with that status (or all), newest first, and how many are new in all. */
export async function listFeedback(filter: FeedbackFilter): Promise<{ ok: true; items: OwnerFeedbackItem[]; newCount: number } | Refusal> {
  const answer = await invoke({ tab: 'feedback', action: 'list', filter });
  if (!answer.ok) return answer;
  const { items, newCount } = answer.data;
  if (!Array.isArray(items) || !whole(newCount)) return { ok: false, code: 'unavailable' };
  return { ok: true, items: items.map(feedbackItemOf).filter((item): item is OwnerFeedbackItem => item !== null), newCount };
}

/** New becomes Read (Read and Answered stay). */
export async function markFeedbackRead(id: number): Promise<{ ok: true } | Refusal> {
  const answer = await invoke({ tab: 'feedback', action: 'mark-read', id });
  return answer.ok ? { ok: true } : answer;
}

/**
 * The one answer: the player gets it as a message and the item is Answered (a second answer is `conflict`). `fromSuggestion` when the
 * text is Claude's suggestion, as shown or edited (recorded as an approved suggestion; `conflict` if the item no longer holds one).
 */
export async function answerFeedback(id: number, text: string, fromSuggestion = false): Promise<{ ok: true } | Refusal> {
  const answer = await invoke({ tab: 'feedback', action: 'answer', id, text, ...(fromSuggestion ? { fromSuggestion: true } : {}) });
  return answer.ok ? { ok: true } : answer;
}
