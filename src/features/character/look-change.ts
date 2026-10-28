// The pure rules behind the change-look dialog (spec "Game messages and a free look change", Goal 4 and Decisions): the look it opens on,
// when its command is the same one sent again, and the words it says. Changing a look is free and unlimited for now, for the player's own
// gladiator only, and validated as at creation (the Edge parser and SQL decide; the dialog only offers valid looks).
import type { GameCommand } from '@contracts/commands';
import type { OwnerState } from '@contracts/reads';
import { validAppearance, type Appearance } from '@domain/appearance';
import { legacyAppearance } from '../../game/actors';

export type ChangeLookCommand = Extract<GameCommand, { kind: 'change-appearance' }>;

/** What the dialog says when the look could not be saved. */
export const LOOK_REFUSED = 'Your look could not be saved. Try again.';
/** What the fixture preview says: it takes no commands (like its other panels). */
export const LOOK_PREVIEW = 'Look changes are unavailable in this preview. Your look is unchanged.';
/** The status line the camp shows once the look is saved. */
export const lookSavedLine = (name: string): string => `Look saved. ${name} wears it in camp now.`;

/**
 * The look the dialog opens on, as a copy: the gladiator's stored look, or for a legacy gladiator (none stored, or one that is not a valid
 * look, which the camp also draws as legacy) the male body, short hair and the palette indices `tintFor` picks, so opening the dialog
 * and saving without a change keeps exactly what it wears.
 */
export const currentLook = (owner: Pick<OwnerState, 'gladiatorId' | 'appearance'>): Appearance =>
  ({ ...(validAppearance(owner.appearance) ? owner.appearance : legacyAppearance(owner.gladiatorId)) });

/** Whether two looks make all five of the same choices. */
export const sameLook = (a: Appearance, b: Appearance): boolean =>
  a.body === b.body && a.hair === b.hair && a.skin === b.skin && a.hairColor === b.hairColor && a.cloth === b.cloth;

/** One send of a look: the look and the immutable command that carries it (its own copy, so a later edit of the draft cannot change it). */
export type LookAttempt = { look: Appearance; command: ChangeLookCommand };

/**
 * The attempt to send `look`: the previous one when it carried the same look (a retry after an answer that left the outcome open, whose
 * operation id the server then replays), else a new one with a new operation id (the server refuses another look under a used id).
 */
export function attemptFor(previous: LookAttempt | null, look: Appearance, newOperationId: () => string): LookAttempt {
  if (previous && sameLook(previous.look, look)) return previous;
  return { look: { ...look }, command: { kind: 'change-appearance', operationId: newOperationId(), appearance: { ...look } } };
}

/** Whether the next send of the same look reuses the operation id: after an answer that decided nothing (the world busy, the answer lost, a rate limit). */
export const keepsAttempt = (code: string): boolean => code === 'processing' || code === 'unavailable' || code === 'rate-limited';
