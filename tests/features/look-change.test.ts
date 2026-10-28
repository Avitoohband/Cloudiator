import { expect, it } from 'vitest';
import type { Appearance } from '@domain/appearance';
import { legacyAppearance } from '../../src/game/actors';
import {
  LOOK_REFUSED, attemptFor, currentLook, keepsAttempt, lookSavedLine, sameLook,
} from '../../src/features/character/look-change';

// The pure rules behind the change-look dialog (spec "Game messages and a free look change", Goal 4 and Decisions): which look it opens
// on, when Save is on, which operation id a send uses, and the words it says.
const ID = '0d5f8471-d919-428f-9ab7-058c95821757';
const CHOSEN: Appearance = { body: 'female', hair: 'ponytail', skin: 2, hairColor: 3, cloth: 11 };

it('opens a gladiator with a chosen look on that look, and a legacy one (no stored look) on the look it already shows', () => {
  expect(currentLook({ gladiatorId: ID, appearance: CHOSEN })).toEqual(CHOSEN);
  expect(currentLook({ gladiatorId: ID, appearance: null })).toEqual(legacyAppearance(ID));
  // A stored look that is not a valid one is no look either (the camp draws it as legacy), so the dialog opens on the legacy look.
  expect(currentLook({ gladiatorId: ID, appearance: { ...CHOSEN, hair: 'mohawk' } as never })).toEqual(legacyAppearance(ID));
  expect(currentLook({ gladiatorId: ID, appearance: { ...CHOSEN, skin: 5 } })).toEqual(legacyAppearance(ID));
  // A copy: editing the dialog's draft can never change the owner state it came from.
  const owner = { gladiatorId: ID, appearance: CHOSEN };
  expect(currentLook(owner)).not.toBe(CHOSEN);
  expect(owner.appearance).toBe(CHOSEN);
});

it('compares two looks by all five choices', () => {
  expect(sameLook(CHOSEN, { ...CHOSEN })).toBe(true);
  for (const change of [{ body: 'male' }, { hair: 'bald' }, { skin: 0 }, { hairColor: 0 }, { cloth: 0 }] as Partial<Appearance>[]) {
    expect(sameLook(CHOSEN, { ...CHOSEN, ...change }), JSON.stringify(change)).toBe(false);
  }
});

it('says what the player saw: the saved line names the gladiator, and the refusal tells them to try again', () => {
  expect(lookSavedLine('Aster')).toBe('Look saved. Aster wears it in camp now.');
  expect(lookSavedLine('Bellator_9')).toBe('Look saved. Bellator_9 wears it in camp now.');
  expect(LOOK_REFUSED).toBe('Your look could not be saved. Try again.');
});

it('keeps one operation id for the same look and starts another for a different one', () => {
  let made = 0;
  const newId = () => `id-${++made}`;
  const first = attemptFor(null, CHOSEN, newId);
  expect(first).toEqual({ look: CHOSEN, command: { kind: 'change-appearance', operationId: 'id-1', appearance: CHOSEN } });
  // A retry of the same look (a failure that left the outcome unknown) is the same command: the server then replays its answer.
  expect(attemptFor(first, { ...CHOSEN }, newId)).toBe(first);
  expect(made).toBe(1);
  // Another look under the old id would be a conflict on the server: it gets a new id.
  const other = attemptFor(first, { ...CHOSEN, hair: 'bald' }, newId);
  expect(other.command.operationId).toBe('id-2');
  expect(other.command.appearance).toEqual({ ...CHOSEN, hair: 'bald' });
  // The command holds its own copy of the look, so a later edit of the draft cannot change what was sent.
  const draft = { ...CHOSEN };
  const sent = attemptFor(null, draft, newId);
  draft.hair = 'long';
  expect(sent.command.appearance.hair).toBe('ponytail');
});

it('retries the same command only after an answer that left the outcome open', () => {
  for (const code of ['processing', 'unavailable', 'rate-limited']) expect(keepsAttempt(code), code).toBe(true);
  for (const code of ['invalid', 'conflict', 'not-found', 'unauthenticated']) expect(keepsAttempt(code), code).toBe(false);
});
