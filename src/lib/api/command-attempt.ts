// One send of a player's choice as a command, and when a send is the same command again (the change-look dialog's rule, Task 7; shared
// with the title picker, patch 1.7 ruling R1). A retry after an answer that decided nothing reuses the operation id, so the server
// replays its stored answer instead of applying the choice twice; any other choice is a new operation (the server refuses another body
// under a used id).

/** Whether the next send of the same choice reuses the operation id: after an answer that decided nothing (the world busy, the answer lost, a rate limit). */
export const keepsAttempt = (code: string): boolean => code === 'processing' || code === 'unavailable' || code === 'rate-limited';

/**
 * The attempt to send a choice: `previous` when it carried the same choice (`same`), else `fresh`, made with a new operation id
 * (`newOperationId`, called only then).
 */
export function attemptOf<A>(previous: A | null, same: (attempt: A) => boolean, fresh: (operationId: string) => A, newOperationId: () => string): A {
  return previous && same(previous) ? previous : fresh(newOperationId());
}
