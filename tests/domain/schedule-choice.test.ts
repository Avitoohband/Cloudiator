import { describe, expect, it } from 'vitest';
import type { ActivityChoice, Phase } from '@contracts/commands';
import { RULES_V1 } from '@domain/rules-v1.ts';
import { choiceAllowedInPhase } from '@domain/schedule-choice.ts';
import type { Rules } from '@domain/types.ts';

// Launch feedback (2026-10-25): Arena is scheduled only in the evening part. Every other choice stays open in every part.
const PHASES: readonly Phase[] = ['morning', 'afternoon', 'evening'];
const ARENA: ActivityChoice = { kind: 'arena' };
const OTHERS: readonly ActivityChoice[] = [{ kind: 'training' }, { kind: 'rest' },
  { kind: 'expedition', expeditionId: 'woodland' }, { kind: 'expedition', expeditionId: 'outpost' }, { kind: 'expedition', expeditionId: 'mountain' }];

describe('choiceAllowedInPhase', () => {
  it('names the evening as the only Arena part in the v1 rules', () => {
    expect(RULES_V1.schedule.arenaPhases).toEqual(['evening']);
  });

  it('allows Arena in the evening and refuses it in the morning and the afternoon', () => {
    expect(choiceAllowedInPhase('evening', ARENA)).toBe(true);
    expect(choiceAllowedInPhase('morning', ARENA)).toBe(false);
    expect(choiceAllowedInPhase('afternoon', ARENA)).toBe(false);
  });

  it('allows every non-Arena choice in every part', () => {
    for (const phase of PHASES) for (const choice of OTHERS) expect(choiceAllowedInPhase(phase, choice), `${phase} ${JSON.stringify(choice)}`).toBe(true);
  });

  it('reads the Arena parts from the rules it is given, defaulting to v1', () => {
    const wider = { ...RULES_V1, schedule: { arenaPhases: ['afternoon', 'evening'] } } as unknown as Rules;
    expect(choiceAllowedInPhase('afternoon', ARENA, wider)).toBe(true);
    expect(choiceAllowedInPhase('morning', ARENA, wider)).toBe(false);
    const none = { ...RULES_V1, schedule: { arenaPhases: [] } } as unknown as Rules;
    expect(choiceAllowedInPhase('evening', ARENA, none)).toBe(false);
    expect(choiceAllowedInPhase('evening', { kind: 'rest' }, none)).toBe(true);
    expect(choiceAllowedInPhase('morning', ARENA, RULES_V1)).toBe(false);
  });
});
