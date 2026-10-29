import { describe, expect, it } from 'vitest';
import { committedPoints, typedPoints } from '@/features/character/points-field';

// Points hotfix (Avi, 2026-10-29): on a phone every keystroke was applied at once, so a digit typed after the value already there
// was capped and an emptied field went straight back to the floor. A points field now applies only a whole number it can take, and
// leaves anything else as typed until Enter or blur.

describe('typedPoints: what a typed text applies at once', () => {
  it('applies a whole number from the floor to the cap, both included', () => {
    expect(typedPoints('5', 4, 7)).toBe(5);
    expect(typedPoints('4', 4, 7)).toBe(4);
    expect(typedPoints('7', 4, 7)).toBe(7);
    expect(typedPoints('0', 0, 10)).toBe(0);
    expect(typedPoints('10', 0, 10)).toBe(10);
    expect(typedPoints('05', 0, 10)).toBe(5);
  });

  it('waits on a number above the cap or below the floor (the build step: strength 4, cap 7)', () => {
    expect(typedPoints('9', 4, 7)).toBeNull();
    expect(typedPoints('45', 4, 7)).toBeNull();
    expect(typedPoints('1', 4, 7)).toBeNull();
    expect(typedPoints('11', 0, 10)).toBeNull();
  });

  it('waits on an empty field, a fraction, a sign or an exponent', () => {
    for (const text of ['', ' ', '2.5', '2.', '5.0', '-1', '+3', '1e1', ' 5', 'x']) expect(typedPoints(text, 0, 10), text).toBeNull();
  });
});

describe('committedPoints: what a waiting text asks for on Enter or blur', () => {
  it('asks for nothing when the field is empty, so its value comes back with no change and no line', () => {
    expect(committedPoints('')).toBeNull();
    expect(committedPoints('  ')).toBeNull();
  });

  it('asks for nothing when the text is no number at all', () => {
    expect(committedPoints('-')).toBeNull();
    expect(committedPoints('abc')).toBeNull();
  });

  it('asks for any other number as typed: the panel then raises, caps or floors it with its line', () => {
    expect(committedPoints('9')).toBe(9);
    expect(committedPoints('99')).toBe(99);
    expect(committedPoints('-1')).toBe(-1);
    expect(committedPoints('2.5')).toBe(2.5);
    expect(committedPoints('1')).toBe(1);
  });
});
