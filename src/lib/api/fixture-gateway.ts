import type { RevealedTimeline } from '@contracts/events';
import type { OwnerState, PublicActor, SeasonView } from '@contracts/reads';
import { validAppearance } from '@domain/appearance';
import { RULES_V1 } from '@domain/rules-v1';
import { RULES_V2 } from '@domain/rules-v2';
import type { GameGateway } from './gateway';
import { BOUTS_PAGE, GatewayReadError, boutOf, nextBoutsCursor, parseBoutsRead, parseMarketRead, parseResultsCursor, parseRestAfter, parseStandingOf, parseStandingsRead, type LastBout } from './reads';
import { replayKept } from '../replay-retention';
import { worldFixture } from '../../../tests/fixtures/domain';
import { REPLAY_SAMPLES, REPLAY_TIMELINES } from '../../../tests/fixtures/battles';
import { EXPEDITION_FIXTURES, EXPEDITION_SAMPLES, EXPEDITION_TIMELINES } from '../../../tests/fixtures/expeditions';
import { EXPEDITION_GLADIATORS } from '../../../tests/fixtures/expedition-ids';
import { ARENA_OWNER, ARENA_PROFILES, ARENA_SAMPLES, ARENA_STANDINGS, ARENA_TIMELINES, ARENA_WORLD_ACTORS, arenaStandingsPage } from '../../../tests/fixtures/arena';
import { TOURNAMENT_OWNER_TIMELINES, TOURNAMENT_SAMPLES, TOURNAMENT_VIEWS_BY_ID } from '../../../tests/fixtures/tournaments';
import { RESULTS_FIXTURE } from '../../../tests/fixtures/results';
import { FIXTURE_MARKET, marketPages } from '../../../tests/fixtures/market';
import { FIXTURE_SEASONS } from '../../../tests/fixtures/seasons';
import { RESTING_ACTOR, RESTING_OWNER, RESTING_PROFILE, restingActor } from '../../../tests/fixtures/resting';
import { FIXTURE_INBOX, FIXTURE_MESSAGES, FIXTURE_NOTIFICATIONS } from '../../../tests/fixtures/messages';
import { myBoutTimelines } from '../../../tests/fixtures/my-bouts';
import { PATCH_1_4, SEED_PATCHES, linkNotes } from '../../../tests/fixtures/patches';
import { profileCards } from '../../../tests/fixtures/profile-cards';
import { ASTER_TITLES, titleNoticeCount, withAsterTitles } from '../../../tests/fixtures/titles';
import { PATCH } from '../patch';
import { withoutTournamentLogs } from '../../game/tournament-stage';
import { FIXTURE_TITLES } from '../../game/demo-world';

/** Sample replays the fixture game page links to. */
export const FIXTURE_REPLAYS: readonly { activityId: string; label: string }[] = REPLAY_SAMPLES;
/** Sample expeditions the fixture game page links to. */
export const FIXTURE_EXPEDITIONS: readonly { activityId: string; label: string }[] = EXPEDITION_SAMPLES;
/** Sample Arena activities the fixture game page opens in its Arena card, with each entrant's gladiator. */
export const FIXTURE_ARENA: readonly { activityId: string; label: string; gladiatorId: string }[] = ARENA_SAMPLES;
/**
 * Sample tournaments the fixture game page opens in its Tournaments panel (engine-generated public views), with the
 * server time each was projected at.
 */
export const FIXTURE_TOURNAMENTS: readonly { id: string; label: string; asOfMs: number }[] = TOURNAMENT_SAMPLES;
// The owner's own settled tournament activities carry its credited summary, read by the Tournaments panel (Task 19 2b).
const FIXTURE_TIMELINES = { ...REPLAY_TIMELINES, ...EXPEDITION_TIMELINES, ...ARENA_TIMELINES, ...TOURNAMENT_OWNER_TIMELINES };
/**
 * The owner plus the current slot's Arena entrants, warming up at the fixture time (minute 40), and Otho, resting at home
 * (Task 23.9: listed, not drawn in the camp).
 */
/** A fixture actor wearing the title the preview gives its name (`FIXTURE_TITLES`: the owner, the Arena gladiators and the crowd), or none. */
const titled = (actor: PublicActor): PublicActor => (FIXTURE_TITLES[actor.name] ? { ...actor, title: FIXTURE_TITLES[actor.name] } : actor);
const FIXTURE_WORLD = { ...worldFixture, actors: [...worldFixture.actors, ...ARENA_WORLD_ACTORS, RESTING_ACTOR].map(titled) };
const OWNER_ID = RESTING_OWNER.gladiatorId;
/**
 * The public profiles with their card data (Task 11c): sample builds, creation times and each standings row's record. Aster, the preview's
 * own gladiator, owns the Arena banner (Patch 1.6: her card shows its pill, and her shop says Owned).
 */
const BASE_PROFILES = profileCards({ ...ARENA_PROFILES, [RESTING_ACTOR.gladiatorId]: RESTING_PROFILE }, Object.values(ARENA_STANDINGS).flat(), ARENA_OWNER,
  worldFixture.serverNowMs, new Set([OWNER_ID]));
/**
 * Patch 1.7: each profile's actor wears its preview title; the card counts the titles earned: Aster's 8, Lucilla's 9 (the mockup's), and one
 * for anyone else who wears a title.
 */
const FIXTURE_PROFILES: typeof BASE_PROFILES = Object.fromEntries(Object.entries(BASE_PROFILES).map(([id, profile]) => {
  const actor = titled(profile.actor);
  return [id, { ...profile, actor, titlesEarned: id === OWNER_ID ? 8 : actor.name === 'Lucilla' ? 9 : actor.title ? 1 : 0 }];
}));
/** The owner's cosmetics: the Arena banner, bound to her account as a bought one is. */
const OWNER_COSMETICS: OwnerState['ownedCosmetics'] = [{ catalogId: 'banner', catalogVersion: 'v1', binding: 'bound' }];
/**
 * The seasons newest first, each with the rules version that opened it (Patch 1.6): the current sample season was opened under the
 * economy's v2 (its card lists every league's prizes), the closed one before it under v1.
 */
const FIXTURE_SEASON_VIEWS: readonly SeasonView[] = FIXTURE_SEASONS.map(season => ({ ...season,
  rulesVersion: season.closedAtMs === null ? RULES_V2.version : RULES_V1.version }));
/**
 * The one trip the preview says was followed by a Rest: the Woodland sample's gladiator (Aster) at the end of its trip. The
 * Mountain and Outpost samples are followed by another expedition, and nobody else's trips are in the preview.
 */
/**
 * The preview's patch history: patch 1.4 and the M26 seed, newest first, the sample patch notes linked to the patches they read like (the
 * Evening Arena note to 1.1, the look note to 1.2).
 */
const FIXTURE_PATCHES = [PATCH_1_4, ...linkNotes(SEED_PATCHES, { '1.1': 1, '1.2': 2 })];
const WOODLAND_REST = { gladiatorId: EXPEDITION_GLADIATORS.aster.id.toLowerCase(),
  tripEndMs: EXPEDITION_TIMELINES[EXPEDITION_FIXTURES.woodland.activityId].stages.at(-1)!.endsAtMs };

/** The last bout stage of a fixture timeline, as the live read's names query gives it. */
function lastBoutOf(timeline: RevealedTimeline): LastBout | null {
  const stage = timeline.stages.filter(s => s.kind === 'bout' && s.battleLog).at(-1);
  const log = stage?.battleLog;
  return stage && log ? { label: stage.label, tieBreakReason: log.tieBreakReason, participants: log.participants.map(p => ({ id: p.id, gladiatorId: p.gladiatorId, name: p.name })) } : null;
}
/**
 * The owner's bouts the preview lists (tests/fixtures/my-bouts.ts, out of the timelines above), newest first, built through the live read's own `boutOf` from each
 * timeline's summary: a bout starts one slot before it settles, and its last bout's names are known only while its replay is kept at
 * the fixture's server time, as the live read asks for them only then. `result` is what the live read's Won/Lost filter looks at.
 */
const FIXTURE_BOUTS = myBoutTimelines(FIXTURE_TIMELINES).map(timeline => {
  const summary = timeline.summary!, slotMs = RULES_V1.clock.slotMs, slotIndex = Math.floor((summary.settledAtMs - 1) / slotMs);
  const bout = boutOf({ activityId: timeline.activityId, gladiatorId: OWNER_ID, slotIndex, startsAtMs: summary.settledAtMs - slotMs,
    kind: summary.resolvedKind, summary, lastBout: replayKept(summary.replayExpiry, worldFixture.serverNowMs) ? lastBoutOf(timeline) : null });
  return { slotIndex, result: summary.result, bout };
});

/**
 * Pure local preview: no transport, auth session, storage, clock, or side effects. Commands are refused; the owner's
 * presence is answered (Task 23.9). `resting` (the game page's `?mode=fixture&as=resting`) previews the owner's gladiator
 * resting at home in the current slot: drawn nowhere in the camp, and with no `restingUntilSlot` until this preview has
 * answered a presence, then the next slot, as the server answers it (Task 23.8).
 */
export function createFixtureGateway(options: { resting?: boolean } = {}): GameGateway {
  const resting = options.resting === true;
  /** The resting preview: whether a presence has been answered since the gladiator began resting. */
  let signalled = false;
  const world = resting ? { ...FIXTURE_WORLD, actors: FIXTURE_WORLD.actors.map(a => (a.gladiatorId === OWNER_ID ? restingActor(a) : a)) } : FIXTURE_WORLD;
  const profiles = resting ? { ...FIXTURE_PROFILES, [OWNER_ID]: { ...FIXTURE_PROFILES[OWNER_ID], actor: restingActor(FIXTURE_PROFILES[OWNER_ID].actor) } } : FIXTURE_PROFILES;
  const unavailable = async (): Promise<never> => {
    throw Object.assign(new Error('This read is unavailable in the fixture preview.'), { code: 'unavailable' as const });
  };
  return {
    command: async () => ({ ok: false, code: 'unavailable' }),
    sendPresence: async () => { signalled = true; return { ok: true }; },
    // The owner fixture with the rating and renown of its credited Arena samples (resting, in the resting preview), and the inbox
    // the sample messages make (tests/fixtures/messages.ts). Patch 1.7: Aster's 8 titles and the mockup's progress, wearing Founder
    // (tests/fixtures/titles.ts); her history notice counts as new in the inbox, as the server counts it (Task 11).
    owner: async () => withAsterTitles({ ...(resting ? { ...structuredClone(RESTING_OWNER), restingUntilSlot: signalled ? RESTING_OWNER.processedSlotIndex + 1 : null }
      : structuredClone(ARENA_OWNER)), inbox: { ...structuredClone(FIXTURE_INBOX),
      newNotifications: FIXTURE_INBOX.newNotifications + titleNoticeCount(ASTER_TITLES, FIXTURE_INBOX.notificationsSeenMs) }, ownedCosmetics: structuredClone(OWNER_COSMETICS) }),
    // The sample messages, newest first (a copy each time), each patch note with the number of the patch that links it; no network.
    messages: async () => FIXTURE_MESSAGES.map(m => ({ ...structuredClone(m),
      patch: m.kind === 'patch-notes' ? FIXTURE_PATCHES.find(p => p.messageId === m.id)?.number ?? null : null })),
    // The preview's history, 20 at a time as the live read pages it (a copy each time); no network.
    patches: async beforeSortKey => {
      const older = FIXTURE_PATCHES.filter(p => beforeSortKey === undefined || p.sortKey < beforeSortKey);
      return { items: structuredClone(older.slice(0, 20)), more: older.length > 20 };
    },
    // The sample notifications, newest first (a copy each time); no network.
    notifications: async () => ({ items: structuredClone([...FIXTURE_NOTIFICATIONS]), newestSettledMs: FIXTURE_NOTIFICATIONS.length ? Math.max(...FIXTURE_NOTIFICATIONS.map(n => n.settledAtMs)) : null }),
    // The owner's own Arena and tournament bouts, newest first, paged and filtered as the live read does (a copy each time; no network):
    // a malformed cursor or filter is `unavailable`, the cursor is the last fetched row's slot, and a well-formed one below every bout
    // ends the list.
    bouts: async (filter, cursor) => {
      const options = parseBoutsRead(filter, cursor);
      const fetched = FIXTURE_BOUTS.filter(row => (options.before === null || row.slotIndex < options.before) && (options.result === null || row.result === options.result)).slice(0, BOUTS_PAGE);
      return structuredClone({ rows: fetched.flatMap(row => (row.bout ? [row.bout] : [])), nextCursor: nextBoutsCursor(fetched.length, fetched.at(-1)?.slotIndex) });
    },
    // The fixture world's slot is published (Task 23.2's published slot, C5).
    world: async () => ({ ...structuredClone(world), publishedSlotIndex: worldFixture.slotIndex }),
    // The preview is up to date: the newest patch is this build's, and its texts are the 1.6 economy's (rules version v2, Patch 1.6).
    revision: async () => ({ revision: worldFixture.revision, serverNowMs: worldFixture.serverNowMs, slotIndex: worldFixture.slotIndex, publishedSlotIndex: worldFixture.slotIndex,
      latestPatch: PATCH, rulesVersion: RULES_V2.version }),
    // Sample timelines with engine-generated battle logs; every other activity stays unavailable. Expedition and Arena
    // samples hold every stage of their slot (no clock here): views show only the stages revealed by their display time.
    timeline: async id => (Object.hasOwn(FIXTURE_TIMELINES, id) ? structuredClone(FIXTURE_TIMELINES[id]) : unavailable()),
    // A replay's fighters' looks, from the fixture world's own actors (no network): a gladiator the preview does not know is absent.
    looks: async ids => new Map(world.actors.filter(a => ids.includes(a.gladiatorId)).map(a => [a.gladiatorId, validAppearance(a.appearance) ? a.appearance : null] as const)),
    // The titles worn now, from the fixture world's own actors (no network): a gladiator the preview does not know is absent.
    readWornTitles: async ids => Object.fromEntries(world.actors.filter(a => ids.includes(a.gladiatorId)).map(a => [a.gladiatorId, a.title ?? null])),
    // Whether a trip's next slot was a Rest (no network): true only for the Woodland sample, and a malformed argument is `unavailable`,
    // as the live read refuses it.
    restAfter: async (gladiatorId, tripEndMs) => {
      const next = parseRestAfter(gladiatorId, tripEndMs);
      return next.gladiatorId === WOODLAND_REST.gladiatorId && tripEndMs === WOODLAND_REST.tripEndMs;
    },
    profile: async id => (Object.hasOwn(profiles, id) ? structuredClone(profiles[id]) : unavailable()),
    // The seasons newest first: the current one (open, rules v2) and the closed season before it (v1), built with seasonAt.
    seasons: async () => structuredClone([...FIXTURE_SEASON_VIEWS]),
    // Pages of at most 50 rows, with the live read's rules: the season is the cursor's (`season:rank`), else the named one, else
    // the current season; a closed season serves its archive. A malformed league, cursor or season id, or a named season the
    // fixtures lack, is `unavailable`; a well-formed cursor of another season ends the list with an empty page.
    standings: async (league, cursor, seasonId) => {
      if (!['bronze', 'silver', 'gold', 'champion'].includes(league)) throw new GatewayReadError('unavailable');
      const read = parseStandingsRead(cursor, seasonId);
      if (read.cursor === null && read.seasonId !== null && !FIXTURE_SEASONS.some(s => s.seasonId === String(read.seasonId))) throw new GatewayReadError('unavailable');
      return arenaStandingsPage(league, read.cursor ? String(read.cursor.season) : read.seasonId !== null ? String(read.seasonId) : FIXTURE_SEASONS[0].seasonId,
        read.cursor?.after ?? 0);
    },
    // One gladiator's row of the current season ('1', open: ARENA_STANDINGS), with its rank in the whole league, or null; a
    // malformed league or gladiator id is `unavailable`, as the live read refuses it.
    standingOf: async (league, gladiatorId) => {
      const id = parseStandingOf(league, gladiatorId);
      const row = ARENA_STANDINGS[league].find(r => r.gladiatorId === id);
      return row ? structuredClone(row) : null;
    },
    // Public tournament views, each projected at its own server time (no clock here): the panel shows only the results
    // its display time has reached. As the live read, a view carries each fought bout's fight summary and no battle log;
    // the log of a revealed bout loads on demand. Every other tournament id stays unavailable.
    tournament: async id => (Object.hasOwn(TOURNAMENT_VIEWS_BY_ID, id) ? withoutTournamentLogs(structuredClone(TOURNAMENT_VIEWS_BY_ID[id])) : unavailable()),
    tournamentLog: async boutId => {
      const id = typeof boutId === 'string' ? boutId.split(':').slice(0, 3).join(':') : '';
      if (!Object.hasOwn(TOURNAMENT_VIEWS_BY_ID, id)) return unavailable();
      const log = TOURNAMENT_VIEWS_BY_ID[id].bouts.find(b => b.id === boutId)?.revealedResult?.battleLog;
      if (!log) throw Object.assign(new Error('This bout has no revealed log in the fixture preview.'), { code: 'not-found' as const });
      return structuredClone(log);
    },
    // Settled results from the fixture timelines, newest first, paged as the live read is, with its cursor rules: none (absent,
    // null or empty) starts the list, a malformed cursor is refused as `unavailable`, and a well-formed one that no page issued
    // ends the list with an empty page.
    recent: async cursor => {
      const after = parseResultsCursor(cursor);
      const previous = after === null ? -1 : RESULTS_FIXTURE.findIndex(page => page.nextCursor === cursor);
      if (after !== null && previous < 0) return { rows: [], nextCursor: null };
      return structuredClone(RESULTS_FIXTURE[previous + 1]);
    },
    // Open offers, newest first, paged as the live read is, with its cursor and seller rules: a malformed cursor or seller is
    // refused as `unavailable`, a seller keeps only its own offers, and a well-formed cursor that no page issued ends the list.
    market: async (cursor, seller) => {
      const read = parseMarketRead(cursor, seller);
      const pages = read.seller === null ? FIXTURE_MARKET
        : marketPages(FIXTURE_MARKET.flatMap(page => page.rows).filter(row => row.seller.gladiatorId === read.seller));
      const previous = read.after === null ? -1 : pages.findIndex(page => page.nextCursor === cursor);
      if (read.after !== null && previous < 0) return { rows: [], nextCursor: null };
      return structuredClone(pages[previous + 1]);
    },
  };
}
