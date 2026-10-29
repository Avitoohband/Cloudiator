// What a typed attribute points field does with its text (points hotfix, Avi, 2026-10-29). On a phone every keystroke used to be
// applied at once: a digit typed after the value already there was capped, and an emptied field went straight back to its floor.
// Now only a whole number the field can take is applied as it is typed; anything else waits for Enter or blur, and then goes
// through the panel's own `changePoints` (`setPoints` with its capped or raised line).

/**
 * The number a typed text applies at once: a whole number (digits only) from `floor` to `cap`, both included. Null for anything
 * else (an empty field, a fraction, a sign, a number out of range), which stays as typed until Enter or blur.
 */
export function typedPoints(text: string, floor: number, cap: number): number | null {
  if (!/^\d+$/.test(text)) return null;
  const count = Number(text);
  return count >= floor && count <= cap ? count : null;
}

/**
 * What a field's waiting text asks for on Enter or blur: null for an empty field or a text that is no number at all (the field
 * then shows its value again, with no change and no line), otherwise the number as typed, for the panel to raise, cap or floor.
 */
export function committedPoints(text: string): number | null {
  if (text.trim() === '') return null;
  const count = Number(text);
  return Number.isFinite(count) ? count : null;
}
