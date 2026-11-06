// Wearing a title (patch 1.7, spec "Earning, wearing and notices" and "My gladiator: the Title button"): the `wear-title` command a choice
// sends, when a send is the same command again (the look change's rule, shared: ruling R1), the words a refusal says, and which worn title
// the client shows while a wear's answer and owner reads cross (Review Focus 5; AGENTS.md: only the latest read lands, and a read that
// started before an answer never undoes it). The Edge parser and SQL decide what may be worn; the picker only offers earned titles.
import type { GameCommand, WearTitleValue } from '@contracts/commands';
import type { OwnerState } from '@contracts/reads';
import { titleById } from '@domain/titles';
import { attemptOf, keepsAttempt } from '../../lib/api/command-attempt';

export type WearCommand = Extract<GameCommand, { kind: 'wear-title' }>;
/** One send of a title (null: no title) and the immutable command that carries it. */
export type WearAttempt = { titleId: string | null; command: WearCommand };

/**
 * The attempt to wear `titleId`: the previous one when it carried the same title (a retry after an answer that left the outcome open, whose
 * operation id the server then replays), else a new one with a new operation id.
 */
export function wearAttemptFor(previous: WearAttempt | null, titleId: string | null, newOperationId: () => string): WearAttempt {
  return attemptOf(previous, attempt => attempt.titleId === titleId,
    operationId => ({ titleId, command: { kind: 'wear-title', operationId, titleId } }), newOperationId);
}

/** Whether the next wear of the same title reuses the operation id: after an answer that decided nothing (the look change's rule). */
export const keepsWearAttempt: (code: string) => boolean = keepsAttempt;

/** What the picker says when the title was not worn. */
export const WEAR_REFUSED = 'That title could not be worn. Try again.';
/** What the fixture preview says: it takes no commands (as its look dialog says). */
export const WEAR_PREVIEW = 'Title changes are unavailable in this preview. Your title is unchanged.';

/** The title an accepted wear answered: its `titleId` when it is none or a title this client knows, else the one that was sent. */
export function answeredTitle(value: Partial<WearTitleValue> | null | undefined, sent: string | null): string | null {
  const id = value?.titleId;
  if (id === null) return null;
  return titleById(id) ? (id as string) : sent;
}

/**
 * A wear the server accepted, for the gladiator that wore it: the title, and how many owner reads had started when the answer arrived
 * (`GameUiState.ownerReadsStarted()`).
 */
export type WornAnswer = { gladiatorId: string; titleId: string | null; afterRead: number };

/**
 * The title the client shows as worn: the answer's from the moment it arrived until an owner read that started after it lands
 * (`ownerReadStart` is the start number of the read on screen); before that, a read that started earlier is ignored for the worn title,
 * whatever it carries. Another gladiator's answer is never used.
 */
export function shownWornTitle(owner: Pick<OwnerState, 'gladiatorId' | 'wornTitle'>, ownerReadStart: number, answer: WornAnswer | null): string | null {
  if (answer && answer.gladiatorId === owner.gladiatorId && ownerReadStart <= answer.afterRead) return answer.titleId;
  return owner.wornTitle;
}
