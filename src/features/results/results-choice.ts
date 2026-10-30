// The Results tab and the My bouts chip, as the shell keeps them (Arena replays Task 4): they belong to one owner, so another account (or
// none) starts on My bouts and All. A choice made while the viewer is still loading (Back from a scene right after a reload, which opens
// the scene's tab and chip) is not anyone's yet: it waits, the first owner that loads adopts it, and a visitor or an account without a
// gladiator drops it (fix round 1, review Important 1; AGENTS.md React async state). Pure: no React.
import type { BoutFilter } from '../../lib/api/reads';
import type { Viewer } from '../character/useGameState';

/** Which of a player's two tabs Results shows. */
export type ResultsTab = 'mine' | 'everyone';
/** Whose choice it is: a player's gladiator id; null for a viewer with no bouts (a visitor, no gladiator, a failed owner read); undefined while the viewer loads. */
export type ChoiceOwner = string | null | undefined;
export type ResultsChoice = { owner: ChoiceOwner; view: ResultsTab; filter: BoutFilter };

/** Where Results opens for an owner who has chosen nothing: My bouts, All. */
export const FIRST_RESULTS = { view: 'mine', filter: 'all' } as const satisfies Pick<ResultsChoice, 'view' | 'filter'>;

/** The owner a choice made now belongs to. */
export function choiceOwner(viewer: Viewer, gladiatorId: string | null | undefined): ChoiceOwner {
  if (viewer === 'loading') return undefined;
  return viewer === 'player' ? gladiatorId ?? null : null;
}

/**
 * The choice `owner` sees: their own; one made while the viewer loaded, which the first owner that loads adopts; else My bouts and All
 * (another owner, a visitor, or an owner whose account changed, which goes through a loading viewer and so starts again).
 */
export function choiceFor(state: ResultsChoice, owner: ChoiceOwner): ResultsChoice {
  if (state.owner === owner) return state;
  if (state.owner === undefined && typeof owner === 'string') return { ...state, owner };
  return { owner, ...FIRST_RESULTS };
}

/** `owner` changes the tab or the chip. */
export function choose(state: ResultsChoice, owner: ChoiceOwner, next: Partial<Pick<ResultsChoice, 'view' | 'filter'>>): ResultsChoice {
  return { ...choiceFor(state, owner), ...next, owner };
}
