// The Results tab and the My bouts chip, as the shell keeps them (Arena replays Task 4): they belong to one owner, so another account (or
// none) starts on My bouts and All. A choice made during bootstrap may adopt the first authenticated account and its first owner;
// once the account is known it binds immediately, even while the owner loads. A visitor drops it. Pure: no React.
import type { BoutFilter } from '../../lib/api/reads';
import type { Viewer } from '../character/useGameState';

/** Which of a player's two tabs Results shows. */
export type ResultsTab = 'mine' | 'everyone';
/** Whose choice it is: a player's gladiator id; null for a viewer with no bouts (a visitor, no gladiator, a failed owner read); undefined while the viewer loads. */
export type ChoiceOwner = string | null | undefined;
export type ResultsChoice = { account: ChoiceOwner; owner: ChoiceOwner; view: ResultsTab; filter: BoutFilter };

/** Where Results opens for an owner who has chosen nothing: My bouts, All. */
export const FIRST_RESULTS = { view: 'mine', filter: 'all' } as const satisfies Pick<ResultsChoice, 'view' | 'filter'>;

/** The owner a choice made now belongs to. */
export function choiceOwner(viewer: Viewer, gladiatorId: string | null | undefined): ChoiceOwner {
  if (viewer === 'loading') return undefined;
  return viewer === 'player' ? gladiatorId ?? null : null;
}

/**
 * The choice this account and owner may see now. Check during render as well as when committing identity; a direct authenticated
 * account switch can leave both owner ids undefined, so owner identity alone cannot authorize adoption.
 */
export function choiceFor(state: ResultsChoice, owner: ChoiceOwner, account: ChoiceOwner = undefined): ResultsChoice {
  const sameAccount = state.account === account || (state.account === undefined && typeof account === 'string');
  const sameOwner = state.owner === owner || (state.owner === undefined && typeof owner === 'string');
  if (!sameAccount || !sameOwner) return { account, owner, ...FIRST_RESULTS };
  return state.account === account && state.owner === owner ? state : { ...state, account, owner };
}

/** `owner` changes the tab or the chip. */
export function choose(state: ResultsChoice, owner: ChoiceOwner, next: Partial<Pick<ResultsChoice, 'view' | 'filter'>>, account: ChoiceOwner = undefined): ResultsChoice {
  return { ...choiceFor(state, owner, account), ...next, account, owner };
}
