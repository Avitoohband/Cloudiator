import { describe, expect, it } from 'vitest';
import { FIRST_RESULTS, choiceFor, choiceOwner, choose, type ResultsChoice } from '@/features/results/results-choice';

// Arena replays Task 4, fix round 1 (review Important 1; AGENTS.md React async state): the Results tab and My bouts chip belong to one
// owner. A choice made while the viewer is still loading (Back from a scene right after a reload) waits for the owner: the first loaded
// owner adopts it, a visitor or an account without a gladiator drops it, and another owner starts on My bouts and All.
const A = 'gladiator-a', B = 'gladiator-b';
const pending = (over: Partial<ResultsChoice> = {}): ResultsChoice => ({ account: undefined, owner: undefined, ...FIRST_RESULTS, ...over });

describe('the Results choice', () => {
  it('binds a pending choice to its account before owner resolution and rejects another during render', () => {
    const waiting = choose(pending(), undefined, { filter: 'lost' }, 'account-a');
    expect(choiceFor(waiting, undefined, 'account-a')).toBe(waiting);
    expect(choiceFor(waiting, undefined, 'account-b')).toMatchObject({ account: 'account-b', ...FIRST_RESULTS });
    expect(choiceFor(waiting, B, 'account-b')).toMatchObject({ owner: B, ...FIRST_RESULTS });
    const bootstrap = choiceFor(pending({ filter: 'lost' }), undefined, 'account-a');
    expect(choiceFor(bootstrap, A, 'account-a')).toMatchObject({ account: 'account-a', owner: A, filter: 'lost' });
  });
  it('names whose choice it is: undefined while the viewer loads, the gladiator of a player, null for anyone else', () => {
    expect(choiceOwner('loading', null)).toBeUndefined();
    expect(choiceOwner('player', A)).toBe(A);
    for (const viewer of ['visitor', 'no-gladiator', 'unavailable'] as const) expect(choiceOwner(viewer, null), viewer).toBeNull();
    expect(FIRST_RESULTS).toEqual({ view: 'mine', filter: 'all' });
  });

  it('keeps a choice made while the owner loads, for the first owner that loads', () => {
    // Back from a `from=bouts-lost` scene while the owner read is out: the chip waits, and the owner who arrives gets it.
    const waiting = choose(pending(), undefined, { view: 'mine', filter: 'lost' });
    expect(waiting).toEqual({ account: undefined, owner: undefined, view: 'mine', filter: 'lost' });
    expect(choiceFor(waiting, undefined)).toBe(waiting);
    expect(choiceFor(waiting, A)).toEqual({ account: undefined, owner: A, view: 'mine', filter: 'lost' });
    // Everyone's origin waits the same way.
    expect(choiceFor(choose(pending(), undefined, { view: 'everyone' }), A)).toEqual({ account: undefined, owner: A, view: 'everyone', filter: 'all' });
  });

  it('drops a waiting choice for a visitor or an account without a gladiator', () => {
    const waiting = pending({ filter: 'won' });
    expect(choiceFor(waiting, null)).toEqual({ account: undefined, owner: null, ...FIRST_RESULTS });
    // And a player who signs in after that starts on My bouts and All.
    expect(choiceFor(choiceFor(waiting, null), A)).toEqual({ account: undefined, owner: A, ...FIRST_RESULTS });
  });

  it('keeps one owner’s choice, and starts another owner, or a sign-out, on My bouts and All', () => {
    const mine = choose(choiceFor(pending(), A), A, { filter: 'lost' });
    expect(mine).toEqual({ account: undefined, owner: A, view: 'mine', filter: 'lost' });
    expect(choiceFor(mine, A)).toBe(mine);
    expect(choose(mine, A, { view: 'everyone' })).toEqual({ account: undefined, owner: A, view: 'everyone', filter: 'lost' });
    // An account switch goes through a loading viewer: the old owner's choice is not carried over to the new one.
    const switching = choiceFor(mine, undefined);
    expect(switching).toEqual(pending());
    expect(choiceFor(switching, B)).toEqual({ account: undefined, owner: B, ...FIRST_RESULTS });
    expect(choiceFor(mine, B)).toEqual({ account: undefined, owner: B, ...FIRST_RESULTS });
    expect(choiceFor(mine, null)).toEqual({ account: undefined, owner: null, ...FIRST_RESULTS });
  });
});
