// Arena fixtures for the local preview, built from the committed engine-generated battle logs (see
// tests/domain/arena-fixtures.test.ts and tests/fixtures/arena-build.ts). The browser never runs combat: it only
// reads these logs. Browser specs read the log files with fs and call buildArenaFixtures themselves, since their
// loader cannot import JSON modules.
import type { BattleLog } from '../../supabase/functions/_shared/contracts/events.ts';
import ownerHumanWin from './arena/ownerHumanWin.json';
import ownerHumanLoss from './arena/ownerHumanLoss.json';
import ownerNpcWin from './arena/ownerNpcWin.json';
import ownerNpcLoss from './arena/ownerNpcLoss.json';
import ownerTieBreak from './arena/ownerTieBreak.json';
import campOne from './arena/campOne.json';
import campTieBreak from './arena/campTieBreak.json';
import campThree from './arena/campThree.json';
import campFour from './arena/campFour.json';
import campFive from './arena/campFive.json';
import campNpcOne from './arena/campNpcOne.json';
import campNpcTwo from './arena/campNpcTwo.json';
import type { ArenaBoutKey } from './arena-ids.ts';
import { buildArenaFixtures } from './arena-build.ts';

export * from './arena-ids.ts';
export { ARENA_BOUT_RATINGS, ARENA_OWNER, ARENA_SAMPLES, ARENA_STANDINGS, arenaStandingsPage, buildArenaFixtures } from './arena-build.ts';

const log = (json: unknown) => json as BattleLog;
export const ARENA_BATTLE_LOGS: Record<ArenaBoutKey, BattleLog> = {
  ownerHumanWin: log(ownerHumanWin), ownerHumanLoss: log(ownerHumanLoss), ownerNpcWin: log(ownerNpcWin), ownerNpcLoss: log(ownerNpcLoss),
  ownerTieBreak: log(ownerTieBreak), campOne: log(campOne), campTieBreak: log(campTieBreak), campThree: log(campThree),
  campFour: log(campFour), campFive: log(campFive), campNpcOne: log(campNpcOne), campNpcTwo: log(campNpcTwo),
};

const built = buildArenaFixtures(ARENA_BATTLE_LOGS);
/** Timelines by activity id, as gateway.timeline(id) returns them. */
export const ARENA_TIMELINES = built.timelines;
/** The current slot's Arena entrants, added to the fixture camp world. */
export const ARENA_WORLD_ACTORS = built.worldActors;
/** Public profiles of every fixture gladiator, as gateway.profile(id) returns them. */
export const ARENA_PROFILES = built.profiles;
