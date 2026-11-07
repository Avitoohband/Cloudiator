import { describe, expect, it } from 'vitest';
import { BOT_CATALOG_ORACLE, BOT_KEYS, BOT_KITS, BOT_ROUTINE_ORACLE } from '../fixtures/bots.ts';
import { slotAt } from '../../supabase/functions/_shared/domain/clock.ts';
import { RULES_V2 } from '../../supabase/functions/_shared/domain/rules-v2.ts';
import { CATALOG_V1 } from '../../supabase/functions/_shared/domain/catalog-v1.ts';
import { validateBuild } from '../../supabase/functions/_shared/domain/build.ts';
import { deriveStats } from '../../supabase/functions/_shared/domain/stats.ts';
import { historicalGearScore } from '../../supabase/functions/_shared/domain/inventory.ts';
import { leagueFor } from '../../supabase/functions/_shared/domain/arena.ts';

const monday = slotAt(Date.parse('2026-11-02T00:00:00Z')).index;
const bots = () => import('../../supabase/functions/_shared/domain/bots.ts');

describe('Ludus Nimbus fixed v2 catalog', () => {
  it('pins each complete kit, point budget, gear history and stamina', async () => {
    const { BOT_TEAM, BOT_CATALOG, botBuild } = await bots();
    expect(BOT_TEAM).toBe('ludus-nimbus');
    expect(BOT_CATALOG).toEqual(BOT_CATALOG_ORACLE);
    for (const [key, , level, , , , , earned, cap, , gearScore, leagueIndex, maxStamina, league] of BOT_KITS) {
      const { draft, inventory } = botBuild(key);
      expect(Object.values(inventory).every(item => CATALOG_V1.items[item.catalogId]?.stats === item.stats)).toBe(true);
      expect(historicalGearScore(inventory, 0)).toBe(gearScore);
      const build = validateBuild(draft, inventory, earned, level, RULES_V2);
      expect(build.ok).toBe(true);
      if (!build.ok) throw new Error('fixed bot build was refused');
      expect(RULES_V2.progression.trainingCapBase + level * RULES_V2.progression.trainingCapPerLevel).toBe(cap);
      expect(build.unspentPoints).toBe(0);
      expect(2 * level + Math.floor(earned / 5) + Math.floor(gearScore / 10)).toBe(leagueIndex);
      expect(leagueFor(level, earned, gearScore, RULES_V2)).toBe(league);
      expect(deriveStats(build.snapshot, RULES_V2)).toMatchObject({ maxStamina, overload: 0 });
    }
  });
});

describe('Ludus Nimbus weekly UTC routine', () => {
  it('matches all 630 independent cells in two consecutive weeks', async () => {
    const { botRoutine } = await bots();
    for (const key of BOT_KEYS) {
      const week = Array.from({ length: 126 }, (_, i) => botRoutine(key, monday + i));
      expect(week).toEqual(BOT_ROUTINE_ORACLE[key]);
      expect(Array.from({ length: 126 }, (_, i) => botRoutine(key, monday + 126 + i))).toEqual(week);
      const counts = Object.fromEntries(['off-duty', 'rest', 'on-call', 'arena', 'training'].map(
        choice => [choice, week.filter(directive => directive === choice).length]));
      expect(counts).toEqual({ 'off-duty': 42, rest: 28, 'on-call': 28,
        arena: key === 'tullia' ? 28 : 14, training: key === 'tullia' ? 0 : 14 });
    }
  });

  it.each([
    ['2026-11-02T00:00:00Z', 0, []],
    ['2026-11-02T06:40:00Z', 5, []],
    ['2026-11-02T07:59:59.999Z', 5, []],
    ['2026-11-02T08:00:00Z', 6, []],
    ['2026-11-02T09:20:00Z', 7, []],
    ['2026-11-02T10:40:00Z', 8, ['tullia', 'grit', 'rufus']],
    ['2026-11-04T18:40:00Z', 50, ['tullia', 'grit', 'rufus']],
    ['2026-11-07T18:40:00Z', 104, ['tullia', 'grit', 'pip']],
    ['2026-11-08T22:40:00Z', 125, ['tullia', 'ash', 'rufus']],
    ['2026-11-09T00:00:00Z', 0, []],
  ])('starts UTC slot %s at weekly index %d', async (timestamp, index, arena) => {
    const { botRoutine, botRoutineIndex } = await bots();
    const slot = slotAt(Date.parse(timestamp)).index;
    expect(botRoutineIndex(slot)).toBe(index);
    expect(BOT_KEYS.filter(key => botRoutine(key, slot) === 'arena')).toEqual(arena);
  });

  it('handles the epoch offset and refuses slots outside the clock contract', async () => {
    const { botRoutineIndex } = await bots();
    expect(botRoutineIndex(0)).toBe(54);
    for (const slot of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])
      expect(() => botRoutineIndex(slot)).toThrow(RangeError);
  });
});
