import { describe, expect, it } from 'vitest';
import type { OwnerState } from '@contracts/reads';
import { RULES_V1 } from '@domain/rules-v1';
import { RULES_V2 } from '@domain/rules-v2';
import { xpView } from '../../src/features/character/xp-progress';
import { ownerFixture } from '../fixtures/domain';

// The XP bar's words and widths (Patch 1.9 Task 10). Expected texts are written out from the approved mockup, never derived by the helper.
const SLOT_MS = RULES_V1.clock.slotMs;
const NOW = 373_248 * SLOT_MS + 1000; // morning of a game day (373248 % 3 = 0)
type Over = { level: number; xp: number; schedule?: Partial<OwnerState['schedule']>; current?: OwnerState['currentActivity'] };
function owner({ level, xp, schedule, current }: Over): Pick<OwnerState, 'progression' | 'schedule' | 'currentActivity'> {
  const state = structuredClone(ownerFixture);
  return { progression: { ...state.progression, level, xp }, schedule: { morning: { kind: 'rest' }, afternoon: { kind: 'rest' }, evening: { kind: 'rest' }, ...schedule },
    currentActivity: current ?? null };
}
const expedition = (expeditionId: 'woodland' | 'outpost' | 'mountain') => ({ kind: 'expedition' as const, expeditionId });

describe('xpView', () => {
  it('a scheduled expedition that reaches the level shows the level-up line and a gold ghost', () => {
    const view = xpView(owner({ level: 1, xp: 80, schedule: { afternoon: expedition('woodland') } }), RULES_V2, NOW);
    expect(view.max).toBe(false);
    expect(view.levelText).toBe('Level 1');
    expect(view.valueText).toBe('80 / 100 XP');
    expect(view.toNextText).toBe('20 XP to Level 2');
    expect(view.ruleText).toBe('Each level costs 100 × your level');
    expect(view.hint).toBe('Your next expedition (up to +30 XP) can level you up to Level 2');
    expect(view.crosses).toBe(true);
    expect(view.fill).toBeCloseTo(0.8);
    expect(view.ghost).toBeCloseTo(0.2);
    expect(view.need).toBe(100);
  });

  it('a scheduled expedition that does not reach the level shows the more-to-go line and a blue ghost', () => {
    const view = xpView(owner({ level: 5, xp: 230, schedule: { evening: expedition('outpost') } }), RULES_V2, NOW);
    expect(view.levelText).toBe('Level 5');
    expect(view.valueText).toBe('230 / 500 XP');
    expect(view.toNextText).toBe('270 XP to Level 6');
    expect(view.hint).toBe('Next expedition: up to +75 XP · 195 more to Level 6');
    expect(view.crosses).toBe(false);
    expect(view.fill).toBeCloseTo(0.46);
    expect(view.ghost).toBeCloseTo(0.15);
  });

  it('the first expedition in the saved schedule counts, in the day\'s order', () => {
    const view = xpView(owner({ level: 10, xp: 0, schedule: { afternoon: expedition('mountain'), evening: expedition('woodland') } }), RULES_V2, NOW);
    expect(view.hint).toBe('Next expedition: up to +150 XP · 850 more to Level 11');
  });

  it('with none scheduled it names the highest expedition the level allows', () => {
    const outpost = xpView(owner({ level: 5, xp: 440 }), RULES_V2, NOW);
    expect(outpost.hint).toBe('Your next Ruined Outpost expedition (up to +75 XP) can level you up to Level 6');
    expect(outpost.crosses).toBe(true);
    expect(outpost.ghost).toBeCloseTo(0.12); // only the 60 XP that finish the level are drawn
    expect(xpView(owner({ level: 4, xp: 0 }), RULES_V2, NOW).hint).toBe('Next Woodland Path expedition: up to +30 XP · 370 more to Level 5');
    expect(xpView(owner({ level: 12, xp: 0 }), RULES_V2, NOW).hint).toBe('Next Mountain Pass expedition: up to +150 XP · 1,050 more to Level 13');
  });

  it('a dungeon-only schedule falls back to the highest the level allows', () => {
    const view = xpView(owner({ level: 1, xp: 0, schedule: { morning: { kind: 'dungeon', dungeonId: 'wolf-den' } } }), RULES_V2, NOW);
    expect(view.hint).toBe('Next Woodland Path expedition: up to +30 XP · 70 more to Level 2');
  });

  const running = { id: 'a', kind: 'expedition' as const, status: 'active' as const, startsAtMs: 373_248 * SLOT_MS, endsAtMs: 373_249 * SLOT_MS, label: 'Expedition' };

  it('a running expedition is "your current expedition", with the reward of where its gladiator is', () => {
    const levels = xpView(owner({ level: 5, xp: 440, current: running }), RULES_V2, NOW, 'expedition:outpost');
    expect(levels.hint).toBe('Your current expedition (up to +75 XP) can level you up to Level 6');
    const short = xpView(owner({ level: 5, xp: 0, current: running }), RULES_V2, NOW, 'expedition:outpost');
    expect(short.hint).toBe('Current expedition: up to +75 XP · 425 more to Level 6');
    // A finished one is no longer current: the schedule decides.
    const done = { ...running, status: 'completed' as const };
    expect(xpView(owner({ level: 5, xp: 0, schedule: { morning: expedition('outpost') }, current: done }), RULES_V2, NOW + SLOT_MS, 'camp').hint).toBe('Next expedition: up to +75 XP · 425 more to Level 6');
  });

  it('a running phase edited since it began does not change the reward: the world location names the destination', () => {
    for (const edited of [expedition('woodland'), { kind: 'rest' as const }, { kind: 'training' as const }, { kind: 'arena' as const }]) {
      const view = xpView(owner({ level: 5, xp: 440, schedule: { morning: edited }, current: running }), RULES_V2, NOW, 'expedition:outpost');
      expect(view.hint).toBe('Your current expedition (up to +75 XP) can level you up to Level 6');
    }
  });

  it('a running expedition whose place is not known yet says so, with no number and no ghost', () => {
    for (const where of [undefined, null, 'camp', 'expedition:nowhere']) {
      const view = xpView(owner({ level: 5, xp: 440, schedule: { morning: expedition('outpost') }, current: running }), RULES_V2, NOW, where);
      expect(view.hint).toBe('Current expedition');
      expect(view.ghost).toBe(0);
      expect(view.crosses).toBe(false);
    }
  });

  it('an activity that has not started yet is not the current expedition', () => {
    const queued = { ...running, status: 'queued' as const, startsAtMs: NOW + 60_000, endsAtMs: NOW + SLOT_MS };
    const view = xpView(owner({ level: 5, xp: 0, schedule: { evening: expedition('outpost') }, current: queued }), RULES_V2, NOW, 'camp');
    expect(view.hint).toBe('Next expedition: up to +75 XP · 425 more to Level 6');
  });

  it('the next expedition is the next to run: the phases after the current slot, then the next day', () => {
    const afternoon = 373_249 * SLOT_MS + 1000; // the day's second part: next to run are the evening, then tomorrow's morning
    const view = xpView(owner({ level: 10, xp: 0, schedule: { morning: expedition('mountain'), evening: expedition('woodland') } }), RULES_V2, afternoon);
    expect(view.hint).toBe('Next expedition: up to +30 XP · 970 more to Level 11');
    // From the evening, tomorrow's morning comes first.
    const evening = 373_250 * SLOT_MS + 1000;
    expect(xpView(owner({ level: 10, xp: 0, schedule: { morning: expedition('mountain'), evening: expedition('woodland') } }), RULES_V2, evening).hint)
      .toBe('Next expedition: up to +150 XP · 850 more to Level 11');
  });

  it('gives the XP still needed and the level it opens as parts', () => {
    const view = xpView(owner({ level: 5, xp: 230 }), RULES_V2, NOW);
    expect(view.leftText).toBe('270 XP');
    expect(view.nextLevelText).toBe('Level 6');
  });

  it('words the active rules\' reward: v1 pays the catalog\'s', () => {
    expect(xpView(owner({ level: 1, xp: 0, schedule: { morning: expedition('woodland') } }), RULES_V1, NOW).hint).toBe('Your next expedition (up to +100 XP) can level you up to Level 2');
  });

  it('a reward that carries past several levels says the level it reaches', () => {
    const view = xpView(owner({ level: 1, xp: 99, schedule: { morning: expedition('mountain') } }), RULES_V2, NOW);
    // 99 + 150 = 249: 100 to Level 2, then 100 × 2 = 200 more is out of reach, so Level 2.
    expect(view.hint).toBe('Your next expedition (up to +150 XP) can level you up to Level 2');
    expect(view.ghost).toBeCloseTo(0.01);
  });

  it('the maximum level has no bar to fill and no hint', () => {
    const view = xpView(owner({ level: RULES_V1.attributes.maximumLevel, xp: 0 }), RULES_V2, NOW);
    expect(view.max).toBe(true);
    expect(view.levelText).toBe('Level 1,000,000,000');
    expect(view.valueText).toBe('Max level');
    expect(view.hint).toBeNull();
    expect(view.fill).toBe(1);
    expect(view.ghost).toBe(0);
  });
});
