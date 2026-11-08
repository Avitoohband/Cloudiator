import type { PublicActivitySummary, RevealedTimeline } from '@contracts/events';
import { CATALOG_V1 } from '@domain/catalog-v1';
import type { ClockMode } from '../../lib/clock-setting';
import { timeOfDay } from '../../lib/time-format';
import { DUNGEON_FIGHT_INTERVAL_MS, type DungeonSceneState } from '../../game/dungeon-stage';
import type { TripMark } from '../character/trip-text';

export function dungeonOutcome(summary: PublicActivitySummary, member: string): string | null {
  const result = summary.dungeon;
  if (!result) return null;
  const dungeon = CATALOG_V1.dungeons[result.id];
  if (!dungeon) return null;

  if (result.partyWon) {
    if (result.terminalFight < 4) return `${dungeon.name}: the party won Room ${result.terminalFight} with no fighters left to continue`;
    return summary.success ? `${dungeon.name} cleared: the ${dungeon.major.name} fell`
      : `${dungeon.name}: ${member} fell before the party cleared the dungeon`;
  }
  if (result.terminalFight < 4) return `${dungeon.name}: the party lost in Room ${result.terminalFight}`;
  const opponent = dungeon.id === 'wolf-den' ? 'Alpha' : dungeon.major.name;
  return `${dungeon.name}: the party lost to the ${opponent}`;
}

export function dungeonFrom(timeline: RevealedTimeline) {
  const id = timeline.completion?.dungeon?.id ?? timeline.summary?.dungeon?.id;
  if (id && Object.hasOwn(CATALOG_V1.dungeons, id)) return CATALOG_V1.dungeons[id];
  const departure = timeline.stages.find(stage => stage.kind === 'depart');
  return Object.values(CATALOG_V1.dungeons).find(dungeon => departure?.label.startsWith(`Enter ${dungeon.name} with `)) ?? null;
}

export function dungeonTripMarks(state: DungeonSceneState, major: string, clock: ClockMode): TripMark[] {
  if (!state.progress) return [];
  const { startMs, endMs } = state.progress;
  const named = (label: string, ms: number) => [label, timeOfDay(ms, clock)].filter(Boolean).join(' · ');
  return [
    { id: 'leaving', fight: null, replay: false, text: named('Left camp', startMs) },
    ...([1, 2, 3, 4] as const).map(fight => ({
      id: `fight-${fight}`, fight, replay: state.stages.some(stage => stage.ordinal === fight && stage.replay),
      text: named(fight === 4 ? major : `Room ${fight}`, startMs + fight * DUNGEON_FIGHT_INTERVAL_MS),
    })),
    { id: 'back', fight: null, replay: false, text: named('Back in camp', endMs) },
  ];
}
