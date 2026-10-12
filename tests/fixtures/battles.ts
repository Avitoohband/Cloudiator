// Revealed replay timelines for the fixture preview. The battle logs are JSON files produced by the
// real Task 3 engine (see tests/domain/replay-fixtures.test.ts); this module only reads them, so the
// browser never runs combat. Summaries are sample data: the renderer shows them, never computes them.
import type { ActivitySummary, BattleLog, RevealedStage, RevealedTimeline } from '../../supabase/functions/_shared/contracts/events.ts';
import { worldFixture } from './domain.ts';
import pvp from './battles/pvp.json';
import npc from './battles/npc.json';
import tie from './battles/tie.json';
import expedition1 from './battles/expedition-1.json';
import expedition2 from './battles/expedition-2.json';
import expedition3 from './battles/expedition-3.json';
import { REPLAY_FIXTURES } from './replay-ids.ts';

export { REPLAY_FIXTURES };

export const FIXTURE_BATTLE_LOGS: Record<string, BattleLog> = {
  pvp: pvp as unknown as BattleLog, npc: npc as unknown as BattleLog, tie: tie as unknown as BattleLog,
  'expedition-1': expedition1 as unknown as BattleLog, 'expedition-2': expedition2 as unknown as BattleLog, 'expedition-3': expedition3 as unknown as BattleLog,
};

const MIN = 60_000;
const DAY = 86_400_000;
const SLOT_MS = 4_800_000;
const NOW = worldFixture.serverNowMs;
const SLOT_START = NOW - (NOW % SLOT_MS);
const RETAIN_MS = 7 * DAY;
const noRewards = { money: 0, renown: 0, xp: 0, attributePoints: 0, items: [], overflowMoney: 0 };

function stage(id: string, kind: RevealedStage['kind'], start: number, fromMin: number, toMin: number, label: string, battleLog?: BattleLog): RevealedStage {
  return { id, kind, revealedAtMs: start + fromMin * MIN, startedAtMs: start + fromMin * MIN, endsAtMs: start + toMin * MIN, label, ...(battleLog ? { battleLog } : {}) };
}
function arena(key: 'pvp' | 'npc' | 'tie', start: number, opponent: string, summary: Omit<ActivitySummary, 'activityId' | 'resolvedKind' | 'receiptId' | 'settledAtMs' | 'replayExpiry'> | null): RevealedTimeline {
  const { activityId } = REPLAY_FIXTURES[key];
  const settledAtMs = start + 80 * MIN;
  const stages = [
    stage(`${key}-staging`, 'staging', start, 0, 60, 'Warm-up in the arena staging area'),
    stage(`${key}-bout`, 'bout', start, 60, 80, `Arena bout against ${opponent}`, FIXTURE_BATTLE_LOGS[key]),
  ];
  if (summary) stages.push(stage(`${key}-settlement`, 'settlement', start, 80, 80, 'Result credited'));
  return {
    activityId, serverNowMs: NOW, visibleThroughMs: NOW, stages,
    ...(summary ? { summary: { activityId, resolvedKind: 'arena', receiptId: `fixture-receipt-${key}`, settledAtMs,
      replayExpiry: { state: 'available', expiresAtMs: settledAtMs + RETAIN_MS }, ...summary } } : {}),
  };
}

const expeditionStart = SLOT_START - 3 * SLOT_MS;
const expeditionTimeline: RevealedTimeline = {
  activityId: REPLAY_FIXTURES.expedition.activityId, serverNowMs: NOW, visibleThroughMs: NOW,
  stages: [
    stage('woodland-depart', 'depart', expeditionStart, 0, 2, 'Departed through the camp gate'),
    stage('woodland-travel', 'travel', expeditionStart, 2, 20, 'Travelling the Woodland Path'),
    stage('woodland-encounter-1', 'encounter', expeditionStart, 20, 22, 'Encounter 1: Dire Wolf', FIXTURE_BATTLE_LOGS['expedition-1']),
    stage('woodland-encounter-2', 'encounter', expeditionStart, 40, 42, 'Encounter 2: Timber Wolf', FIXTURE_BATTLE_LOGS['expedition-2']),
    stage('woodland-encounter-3', 'encounter', expeditionStart, 60, 62, 'Encounter 3: Dire Wolf', FIXTURE_BATTLE_LOGS['expedition-3']),
    stage('woodland-return', 'return', expeditionStart, 62, 80, 'Returned to camp'),
    stage('woodland-settlement', 'settlement', expeditionStart, 80, 80, 'Rewards credited'),
  ],
  summary: {
    activityId: REPLAY_FIXTURES.expedition.activityId, resolvedKind: 'expedition', result: 'completed', success: true,
    rewards: { money: 20, renown: 0, xp: 100, attributePoints: 0, overflowMoney: 0,
      items: [{ catalogId: 'light-boots:1:uncommon', catalogVersion: 'v1', tier: 1, rarity: 'uncommon', quantity: 1 }] },
    receiptId: 'fixture-receipt-expedition', settledAtMs: expeditionStart + 80 * MIN,
    replayExpiry: { state: 'available', expiresAtMs: expeditionStart + 80 * MIN + RETAIN_MS },
  },
};

const expiredStart = SLOT_START - 10 * DAY;
const expiredTimeline: RevealedTimeline = {
  // Detailed events are pruned after seven days; the 90-day summary remains.
  activityId: REPLAY_FIXTURES.expired.activityId, serverNowMs: NOW, visibleThroughMs: NOW, stages: [],
  summary: {
    activityId: REPLAY_FIXTURES.expired.activityId, resolvedKind: 'arena', result: 'defeat', success: false,
    rewards: { ...noRewards, renown: 2 }, receiptId: 'fixture-receipt-expired', settledAtMs: expiredStart + 80 * MIN,
    replayExpiry: { state: 'expired' }, ratingDelta: -9,
  },
};

/** Timelines by activity id, as gateway.timeline(id) returns them. */
export const REPLAY_TIMELINES: Record<string, RevealedTimeline> = {
  [REPLAY_FIXTURES.pvp.activityId]: arena('pvp', SLOT_START - SLOT_MS, 'Varro',
    { result: 'victory', success: true, rewards: { ...noRewards, renown: 10 }, ratingDelta: 14 }),
  [REPLAY_FIXTURES.npc.activityId]: arena('npc', SLOT_START - 2 * SLOT_MS, 'Iron Warden (NPC)',
    { result: 'victory', success: true, rewards: { ...noRewards, renown: 3 }, ratingDelta: 0 }),
  // Revealed at minute 60, rewards not yet credited at minute 65: no summary.
  [REPLAY_FIXTURES.tie.activityId]: arena('tie', NOW - 65 * MIN, 'Cassia', null),
  [REPLAY_FIXTURES.expedition.activityId]: expeditionTimeline,
  [REPLAY_FIXTURES.expired.activityId]: expiredTimeline,
};

/** Sample replays listed on the fixture game page. */
export const REPLAY_SAMPLES: { activityId: string; label: string }[] = Object.values(REPLAY_FIXTURES).map(({ activityId, label }) => ({ activityId, label }));
