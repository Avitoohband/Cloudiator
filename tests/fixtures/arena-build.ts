// Builds the Arena fixtures from engine-generated battle logs: revealed timelines with the stage sequence proposed to
// Codex for Task 16, the camp's current-slot entrants, public profiles and league standings. It imports no JSON,
// so browser specs can build the same data from the log files they read; tests/fixtures/arena.ts builds it from
// the committed logs for the fixture gateway. Each timeline holds every stage of its run, because the fixture
// gateway has no clock: views show only the stages revealed by their display time. NPC fallbacks approximate the
// spec §7 template until Task 16's makeFallback lands. Summaries are sample data: views show them, never compute them.
import type { ActivitySummary, BattleLog, RevealedStage, RevealedTimeline } from '../../supabase/functions/_shared/contracts/events.ts';
import type { ClassId, LeagueId } from '../../supabase/functions/_shared/contracts/commands.ts';
import type { EquipmentSilhouette, PublicActor, PublicProfile, StandingRow, StandingsPage } from '../../supabase/functions/_shared/contracts/reads.ts';
import { worldFixture } from './domain.ts';
import {
  ARENA_ACTIVITIES, ARENA_BOUTS, ARENA_CAMP_KEYS, ARENA_GLADIATORS, ARENA_SAMPLE_KEYS, arenaActivityId, fixtureUuid,
  type ArenaActivityKey, type ArenaBoutKey, type ArenaGladiatorKey,
} from './arena-ids.ts';

const MIN = 60_000;
const SLOT_MS = 4_800_000;
const REPLAY_KEPT_MS = 604_800_000;
const NOW = worldFixture.serverNowMs;
/** The fixture world's current slot starts 40 minutes before its server time. */
const SLOT_START = NOW - (NOW % SLOT_MS);

/** Ratings of both entrants just before each credited human bout of the owner (for its Elo delta). */
export const ARENA_BOUT_RATINGS: Partial<Record<ArenaBoutKey, { entrant: number; opponent: number }>> = {
  ownerHumanWin: { entrant: 1000, opponent: 1040 },
  ownerHumanLoss: { entrant: 1013, opponent: 990 },
  ownerTieBreak: { entrant: 1000, opponent: 1100 },
};
/** Elo K=24 deltas for those ratings, recomputed independently by the generator test. */
const RATING_DELTAS: Partial<Record<ArenaBoutKey, number>> = { ownerHumanWin: 13, ownerHumanLoss: -13, ownerTieBreak: 15 };
const RENOWN = { humanWin: 10, humanLoss: 2, npcWin: 3, npcLoss: 0 };

function stage(activityId: string, index: 0 | 1 | 2, kind: RevealedStage['kind'], startedAtMs: number, endsAtMs: number, label: string, battleLog?: BattleLog): RevealedStage {
  return { id: `${activityId}:${index}`, kind, revealedAtMs: startedAtMs, startedAtMs, endsAtMs, label, ...(battleLog ? { battleLog } : {}) };
}

/** Public look and standing of each fixture gladiator (silhouettes match the gear in their battle logs). */
type PublicInfo = { classId: ClassId; silhouettes: EquipmentSilhouette[]; league: LeagueId; level: number; rating: number; combatStrength: number; humanWins: number; humanLosses: number };
const INFO: Record<ArenaGladiatorKey, PublicInfo> = {
  aster: { classId: 'guardian', silhouettes: ['weapon-sword', 'offhand-shield', 'head-helmet', 'armor-light'], league: 'bronze', level: 1, rating: 1000, combatStrength: 412, humanWins: 2, humanLosses: 1 },
  varro: { classId: 'berserker', silhouettes: ['weapon-spear', 'head-hood', 'armor-heavy'], league: 'bronze', level: 3, rating: 1052, combatStrength: 455, humanWins: 6, humanLosses: 3 },
  cassia: { classId: 'duelist', silhouettes: ['weapon-sword', 'head-hood', 'armor-light'], league: 'bronze', level: 2, rating: 1003, combatStrength: 398, humanWins: 4, humanLosses: 4 },
  severus: { classId: 'guardian', silhouettes: ['weapon-sword', 'offhand-shield', 'head-helmet', 'armor-light'], league: 'bronze', level: 4, rating: 1085, combatStrength: 430, humanWins: 8, humanLosses: 2 },
  bellator: { classId: 'berserker', silhouettes: ['weapon-axe', 'armor-light'], league: 'bronze', level: 2, rating: 1021, combatStrength: 401, humanWins: 3, humanLosses: 2 },
  corvina: { classId: 'duelist', silhouettes: ['weapon-sword', 'offhand-shield', 'head-hood'], league: 'bronze', level: 2, rating: 988, combatStrength: 377, humanWins: 2, humanLosses: 3 },
  faustina: { classId: 'duelist', silhouettes: ['weapon-sword'], league: 'bronze', level: 1, rating: 1000, combatStrength: 344, humanWins: 1, humanLosses: 1 },
  gallus: { classId: 'duelist', silhouettes: ['weapon-sword'], league: 'bronze', level: 1, rating: 1000, combatStrength: 344, humanWins: 0, humanLosses: 0 },
  lucilla: { classId: 'guardian', silhouettes: ['weapon-spear', 'head-helmet', 'armor-heavy'], league: 'silver', level: 6, rating: 1040, combatStrength: 610, humanWins: 7, humanLosses: 4 },
  marcellus: { classId: 'berserker', silhouettes: ['weapon-axe', 'offhand-shield', 'armor-light'], league: 'silver', level: 5, rating: 1012, combatStrength: 584, humanWins: 5, humanLosses: 5 },
  nerva: { classId: 'duelist', silhouettes: ['weapon-bow', 'head-hood', 'armor-light'], league: 'bronze', level: 3, rating: 1031, combatStrength: 420, humanWins: 5, humanLosses: 2 },
  titus: { classId: 'guardian', silhouettes: ['weapon-sword', 'offhand-shield', 'armor-heavy'], league: 'bronze', level: 3, rating: 979, combatStrength: 409, humanWins: 2, humanLosses: 5 },
  aurelia: { classId: 'duelist', silhouettes: ['weapon-spear', 'armor-light'], league: 'bronze', level: 2, rating: 1016, combatStrength: 392, humanWins: 3, humanLosses: 1 },
  decimus: { classId: 'berserker', silhouettes: ['weapon-axe', 'head-helmet', 'armor-heavy'], league: 'bronze', level: 4, rating: 994, combatStrength: 446, humanWins: 4, humanLosses: 5 },
  valeria: { classId: 'guardian', silhouettes: ['weapon-sword', 'head-helmet', 'armor-light'], league: 'gold', level: 9, rating: 1120, combatStrength: 905, humanWins: 11, humanLosses: 3 },
  cato: { classId: 'berserker', silhouettes: ['weapon-bow', 'head-hood'], league: 'bronze', level: 2, rating: 970, combatStrength: 366, humanWins: 1, humanLosses: 4 },
  ardea: { classId: 'duelist', silhouettes: ['weapon-sword', 'offhand-shield'], league: 'bronze', level: 1, rating: 1000, combatStrength: 351, humanWins: 0, humanLosses: 0 },
};

/** Arena samples listed on the fixture game page, with the entrant whose activity each one is. */
export const ARENA_SAMPLES: { activityId: string; label: string; gladiatorId: string }[] = ARENA_SAMPLE_KEYS.map(key => ({
  activityId: arenaActivityId(key), label: ARENA_ACTIVITIES[key].label, gladiatorId: ARENA_GLADIATORS[ARENA_ACTIVITIES[key].gladiator].id,
}));

export type ArenaFixtureSet = {
  /** Timelines by activity id, as gateway.timeline(id) returns them. */
  timelines: Record<string, RevealedTimeline>;
  /** The current slot's Arena entrants, added to the fixture camp world: seven bouts and one delayed worker. */
  worldActors: PublicActor[];
  /** Public profiles of every fixture gladiator, as gateway.profile(id) returns them. */
  profiles: Record<string, PublicProfile>;
};

/** Assembles the timelines, camp entrants and profiles from the engine-generated battle logs. */
export function buildArenaFixtures(logs: Readonly<Record<ArenaBoutKey, BattleLog>>): ArenaFixtureSet {
  function timelineFor(key: ArenaActivityKey): RevealedTimeline {
    const { gladiator, bout, slotsAgo, owner } = ARENA_ACTIVITIES[key];
    const activityId = arenaActivityId(key);
    const start = SLOT_START - slotsAgo * SLOT_MS;
    const stages = [stage(activityId, 0, 'staging', start, start + 60 * MIN, 'Warming up')];
    const base = { activityId, serverNowMs: NOW, visibleThroughMs: NOW };
    if (bout === null) return { ...base, stages };
    const battle = logs[bout];
    const me = battle.participants.find(p => p.gladiatorId === ARENA_GLADIATORS[gladiator].id)!;
    const won = battle.winnerId === me.id;
    const boutAt = start + 60 * MIN;
    stages.push(stage(activityId, 1, 'bout', boutAt, boutAt + battle.durationMs, won ? 'Bout: victory' : 'Bout: defeat', battle));
    stages.push(stage(activityId, 2, 'return', start + 80 * MIN, start + 80 * MIN, 'Results credited'));
    if (!owner) return { ...base, stages };
    const npc = ARENA_BOUTS[bout].opponent === null;
    const settledAtMs = start + 80 * MIN;
    const renown = npc ? (won ? RENOWN.npcWin : RENOWN.npcLoss) : won ? RENOWN.humanWin : RENOWN.humanLoss;
    const summary: ActivitySummary = {
      activityId, resolvedKind: 'arena', result: won ? 'victory' : 'defeat', success: won,
      rewards: { money: 0, renown, xp: 0, attributePoints: 0, items: [], overflowMoney: 0 },
      receiptId: fixtureUuid(`arena-receipt-${key}`), settledAtMs,
      replayExpiry: { state: 'available', expiresAtMs: settledAtMs + REPLAY_KEPT_MS },
      // NPC fights never change rating, so their summaries carry no rating delta.
      ...(npc ? {} : { ratingDelta: RATING_DELTAS[bout]! }),
    };
    return { ...base, stages, summary };
  }

  const KEYS = Object.keys(ARENA_ACTIVITIES) as ArenaActivityKey[];
  const timelines: Record<string, RevealedTimeline> = Object.fromEntries(KEYS.map(key => [arenaActivityId(key), timelineFor(key)]));

  const campActor = (key: ArenaActivityKey): PublicActor => {
    const { gladiator } = ARENA_ACTIVITIES[key];
    const g = ARENA_GLADIATORS[gladiator];
    const info = INFO[gladiator];
    const timeline = timelines[arenaActivityId(key)];
    // The camp projection carries the latest revealed stage without its battle log; at minute 40 that is the warm-up.
    const { battleLog: _omitted, ...visibleStage } = timeline.stages.filter(s => s.revealedAtMs <= NOW).at(-1)!;
    return {
      gladiatorId: g.id, name: g.name, classId: info.classId, equipmentSilhouettes: [...info.silhouettes], league: info.league, level: info.level,
      phase: worldFixture.actors[0].phase, location: 'arena', activityId: timeline.activityId, activityStatus: 'active',
      startsAtMs: SLOT_START, endsAtMs: SLOT_START + SLOT_MS, visibleStage,
    };
  };
  const worldActors: PublicActor[] = ARENA_CAMP_KEYS.map(campActor);
  const profiles: Record<string, PublicProfile> = Object.fromEntries((Object.keys(ARENA_GLADIATORS) as ArenaGladiatorKey[]).map(key => {
    const g = ARENA_GLADIATORS[key];
    const info = INFO[key];
    const actor: PublicActor = worldActors.find(a => a.gladiatorId === g.id)
      ?? worldFixture.actors.find(a => a.gladiatorId === g.id)
      ?? { gladiatorId: g.id, name: g.name, classId: info.classId, equipmentSilhouettes: [...info.silhouettes], league: info.league, level: info.level,
        phase: worldFixture.actors[0].phase, location: 'rest', activityId: null, activityStatus: 'idle', startsAtMs: null, endsAtMs: null, visibleStage: null };
    return [g.id, { actor, combatStrength: info.combatStrength, rating: info.rating, prestige: [] }];
  }));
  return { timelines, worldActors, profiles };
}

// ------------------------------------------------------------------ standings

const FIRST = ['Al', 'Bel', 'Cor', 'Dru', 'Fel', 'Gra', 'Hor', 'Ius', 'Lae', 'Mar', 'Nov', 'Pol'];
const LAST = ['ix', 'us', 'ana', 'ion', 'ora', 'en'];
const fillerName = (i: number) => `${FIRST[i % FIRST.length]}${LAST[Math.floor(i / FIRST.length) % LAST.length]}`;
const FILLERS: Record<LeagueId, number> = { bronze: 44, silver: 10, gold: 2, champion: 0 };
const OFFSET: Record<LeagueId, number> = { bronze: 0, silver: 44, gold: 54, champion: 56 };

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Rating, then human wins, then fewer human losses, then the stable gladiator id (spec §8.3). */
const ranked = (rows: Omit<StandingRow, 'rank'>[]): StandingRow[] => [...rows]
  .sort((p, q) => q.rating - p.rating || q.humanWins - p.humanWins || p.humanLosses - q.humanLosses || p.gladiatorId.localeCompare(q.gladiatorId))
  .map((row, i) => ({ rank: i + 1, ...row }));

function leagueRows(league: LeagueId): StandingRow[] {
  const named = (Object.keys(ARENA_GLADIATORS) as ArenaGladiatorKey[]).filter(key => INFO[key].league === league).map(key => {
    const info = INFO[key];
    return { gladiatorId: ARENA_GLADIATORS[key].id, name: ARENA_GLADIATORS[key].name, rating: info.rating, humanWins: info.humanWins, humanLosses: info.humanLosses };
  });
  const fillers = Array.from({ length: FILLERS[league] }, (_, i) => {
    const h = hash(`${league}-${i}`);
    const bouts = i % 9 === 4 ? 0 : 1 + (h % 12);
    const humanWins = bouts === 0 ? 0 : (h >>> 4) % (bouts + 1);
    return { gladiatorId: fixtureUuid(`arena-filler-${league}-${i}`), name: fillerName(OFFSET[league] + i), rating: bouts === 0 ? 1000 : 900 + ((h >>> 8) % 220), humanWins, humanLosses: bouts - humanWins };
  });
  return ranked([...named, ...fillers].map((row, i) => ({
    ...row,
    // A few fillers moved up a league this season; their record here stays listed.
    promoted: i >= named.length && (i - named.length) % 17 === 3,
    inactive: row.humanWins + row.humanLosses === 0,
    rewardEligible: row.humanWins + row.humanLosses >= 5,
  })));
}

/** Current-season standings of every league, already ranked. */
export const ARENA_STANDINGS: Record<LeagueId, StandingRow[]> = {
  bronze: leagueRows('bronze'), silver: leagueRows('silver'), gold: leagueRows('gold'), champion: leagueRows('champion'),
};

const PAGE = 50;
const SEASON = 'fixture-season-1';
/** One standings page of at most 50 rows; the cursor is opaque, and a foreign or unknown cursor starts again. */
export function arenaStandingsPage(league: LeagueId, cursor?: string): StandingsPage {
  const all = ARENA_STANDINGS[league];
  const match = /^fixture-standings:([a-z]+):(\d+)$/.exec(cursor ?? '');
  const offset = match && match[1] === league && Number(match[2]) < all.length ? Number(match[2]) : 0;
  const rows = all.slice(offset, offset + PAGE);
  const next = offset + PAGE < all.length ? `fixture-standings:${league}:${offset + PAGE}` : null;
  return { league, seasonId: SEASON, archived: false, rows: structuredClone(rows), nextCursor: next };
}
