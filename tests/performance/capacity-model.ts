import { RULES_V1 } from '../../supabase/functions/_shared/domain/rules-v1.ts';
import { WORKER_LIMITS } from '../../supabase/functions/_shared/backend/jobs.ts';

// Task 23.3: the arithmetic from a measured accelerated run to monthly figures against the free-tier budgets (spec §12,
// Global Constraints). Pure functions; tests/performance/capacity-model.test.ts pins them, tests/db/capacity.test.ts feeds
// them the measured run, and docs/operations/release-evidence.md ("Lane A: capacity") shows the arithmetic.

const SLOT_MS = RULES_V1.clock.slotMs;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const SLOT_MINUTES = SLOT_MS / MINUTE_MS;
/** The scheduler's dispatch ceiling (private.scheduler.max_dispatch_per_minute, checked by the DB test). */
export const DISPATCH_PER_MINUTE = 5;

/**
 * Retention windows in slots (14-operations.sql's retention matrix): seven-day detail, ninety-day summaries, the 48-hour
 * dispatch log and the 30-day operations log. Receipts, settled slots, checkpoints and season archives are permanent.
 */
export const RETENTION = Object.freeze({
  detailSlots: RULES_V1.retention.replayMs / SLOT_MS,
  summarySlots: RULES_V1.retention.summaryMs / SLOT_MS,
  dispatchLogSlots: 172_800_000 / SLOT_MS,
  operationsEventSlots: 2_592_000_000 / SLOT_MS,
  slotsPerDay: DAY_MS / SLOT_MS,
});
/** pg_cron's run log, kept seven days by cleanup: the coordinator every minute and cleanup every hour. */
const CRON_ROWS_KEPT = 7 * (24 * 60 + 24);

/** The most v1 tournament slots (Wednesdays and Saturdays) any run of `days` consecutive days contains. */
export function tournamentsIn(days: number): number {
  let most = 0;
  for (let start = 0; start < 7; start++) {
    let count = 0;
    for (let d = 0; d < days; d++) if ((RULES_V1.tournament.utcWeekdays as readonly number[]).includes((start + d) % 7)) count++;
    most = Math.max(most, count);
  }
  return most;
}
/** A 30-day and a 31-day month: their slots, the dispatch ceiling (5 a scheduled minute) and the most tournament slots. */
export const MONTHS = Object.freeze([30, 31].map(days => Object.freeze({ days, slots: days * RETENTION.slotsPerDay,
  dispatchCeiling: days * 24 * 60 * DISPATCH_PER_MINUTE, tournaments: tournamentsIn(days) })));
/** A week of slots, two of them tournament slots: the weights of a regular and a tournament slot in an average slot. */
const WEEK_SLOTS = 7 * RETENTION.slotsPerDay;
const WEEK_TOURNAMENTS = RULES_V1.tournament.utcWeekdays.length;
const weighted = (regular: number, tournament: number) => ((WEEK_SLOTS - WEEK_TOURNAMENTS) * regular + WEEK_TOURNAMENTS * tournament) / WEEK_SLOTS;

/** Task 23.2: steady-state publication of a 50-character boundary (held and cleared windows), about 61.4 s. */
export const STEADY_PUBLICATION_MS = 61_400;
/** Spec §10.4: normal boundary processing within two minutes at 50 characters. */
export const BOUNDARY_TARGET_MS = 120_000;
/** Supabase's default statement timeout for the anon role (visitors read as anon): the hard limit of a public read. */
const ANON_STATEMENT_TIMEOUT_MS = 3_000;
/**
 * The budgets. Database: 500 MB as private.health_report counts it (524,288,000 bytes; Avi's decision, 2026-10-19, Task 23.7;
 * the report warns from 80 %, 400 MB, on the physical size). Egress: 3 GB taken as 3 × 10⁹
 * bytes, the stricter reading. Invocations: 300,000 a month. Worker: cpuMs less 25 %. The season close must fit in what the
 * boundary target leaves after a steady publication, less 25 %. A standings read must stay far inside the anon statement
 * timeout: its plan at a tenth of it, its local Data API round trip at a quarter.
 */
export const BUDGETS = Object.freeze({
  databaseBytes: 524_288_000, egressBytes: 3_000_000_000, invocations: 300_000, workerMs: WORKER_LIMITS.cpuMs * 0.75,
  seasonCloseMs: Math.floor((BOUNDARY_TARGET_MS - STEADY_PUBLICATION_MS) * 0.75),
  standingsPlanMs: ANON_STATEMENT_TIMEOUT_MS / 10, standingsReadMs: ANON_STATEMENT_TIMEOUT_MS / 4,
  /** A budget used above this share is a named risk with a mitigation; above 1 it is a blocker for Avi. */
  riskShare: 0.8,
});
export const share = (used: number, budget: number) => used / budget;
/**
 * Task 23.7: the slots a job keeps its input and result. Cleanup's trim compacts the completed jobs of slots at or below the
 * checkpoint minus 19 (15-release.sql, M21), once an hourly tick reaches them; a tick's lag is under one 80-minute slot.
 */
export const JOB_PAYLOAD_SLOTS = 19 + 1;

export type Retention = 'detail' | 'summary' | 'permanent' | 'player' | 'season' | 'operational' | 'singleton';
/**
 * Every table of the public and private schemas with its retention class (14-operations.sql's retention matrix):
 * - detail: whole slots pruned seven days (126 slots) after they end (a job's payloads compacted after JOB_PAYLOAD_SLOTS);
 * - summary: pruned after ninety days (1,620 slots; the ledger, reservations and listings by time, which is the same span);
 * - permanent: one row per slot and character, never pruned (settled slots; receipts, a settlement receipt's result
 *   compacted at 90 days);
 * - player: bounded per character (account state, inventory up to 60 items, projections, at most 5 open listings);
 * - season: per season and character, kept forever (ratings, standings, archives, awards);
 * - operational: short windows (command attempts one hour, the dispatch log 48 hours, operations events 30 days);
 * - singleton: configuration rows.
 * `compactAfterSlots` replaces a row's measured size by `compactedBytesPerRow` once that many slots have passed.
 */
export const TABLE_CLASSES: Readonly<Record<string, { retention: Retention; windowSlots?: number; compactAfterSlots?: number }>> = Object.freeze({
  'private.activity_snapshots': { retention: 'detail' }, 'private.arena_assignment_sides': { retention: 'detail' },
  'private.arena_assignments': { retention: 'detail' }, 'private.arena_results': { retention: 'detail' },
  'private.boundary_members': { retention: 'detail' }, 'private.expedition_plans': { retention: 'detail' },
  'private.job_attempts': { retention: 'detail' }, 'private.job_dependencies': { retention: 'detail' },
  'private.jobs': { retention: 'detail', compactAfterSlots: JOB_PAYLOAD_SLOTS },
  'private.tournament_bouts': { retention: 'detail' }, 'private.tournament_entries': { retention: 'detail' },
  'private.tournament_results': { retention: 'detail' }, 'private.tournaments': { retention: 'detail' }, 'public.activity_stages': { retention: 'detail' },
  'private.boundaries': { retention: 'summary' }, 'private.boundary_work': { retention: 'summary' }, 'public.activities': { retention: 'summary' },
  'public.recent_results': { retention: 'summary' }, 'public.reservations': { retention: 'summary' }, 'public.wallet_ledger': { retention: 'summary' },
  'public.tournament_bout_results': { retention: 'summary', compactAfterSlots: RETENTION.detailSlots },
  'public.tournament_placements': { retention: 'summary' }, 'public.tournament_views': { retention: 'summary' },
  'private.settled_slots': { retention: 'permanent' },
  'public.operation_receipts': { retention: 'permanent', compactAfterSlots: RETENTION.summarySlots },
  'public.gladiators': { retention: 'player' }, 'public.builds': { retention: 'player' }, 'public.schedules': { retention: 'player' },
  'public.schedule_revisions': { retention: 'player' }, 'public.wallets': { retention: 'player' }, 'private.wallet_checkpoints': { retention: 'player' },
  'public.item_instances': { retention: 'player' }, 'public.owned_cosmetics': { retention: 'player' }, 'public.pending_build_items': { retention: 'player' },
  'private.pending_build_preparations': { retention: 'player' }, 'public.public_profiles': { retention: 'player' },
  'public.world_actors': { retention: 'player' }, 'private.market_listings': { retention: 'player' }, 'public.market_offers': { retention: 'player' },
  // Task 23.8: one signal per owner and one rest row per character that has rested.
  'private.owner_signals': { retention: 'player' }, 'public.character_rests': { retention: 'player' },
  // M25: the operator's game messages (a handful of rows, posted by hand and kept) and each account's read marks (at most one per
  // account and message, so bounded by the players and the few messages: tiny, kept).
  'public.game_messages': { retention: 'singleton' }, 'public.message_reads': { retention: 'player' },
  // M25: one "notifications seen up to" time per account that has asked, never more.
  'public.notification_marks': { retention: 'player' },
  'private.arena_ratings': { retention: 'season' }, 'public.arena_standings': { retention: 'season' }, 'public.season_standings': { retention: 'season' },
  'private.season_awards': { retention: 'season' }, 'public.seasons': { retention: 'season' },
  'private.command_attempts': { retention: 'operational', windowSlots: 1 }, 'private.dispatch_log': { retention: 'operational', windowSlots: RETENTION.dispatchLogSlots },
  'private.operations_events': { retention: 'operational', windowSlots: RETENTION.operationsEventSlots },
  'private.coordinator': { retention: 'singleton' }, 'private.scheduler': { retention: 'singleton' }, 'private.retention_state': { retention: 'singleton' },
  'private.rules_versions': { retention: 'singleton' }, 'private.season_epoch': { retention: 'singleton' }, 'public.world_revision_state': { retention: 'singleton' },
});

/**
 * One table as measured: rows added by a regular slot and by a tournament slot (its boundary, reveals and settlement),
 * on-disk bytes per row (heap, TOAST and indexes, marginal over the empty table), the compacted size where it applies, and
 * the rows and bytes it held at the end of the run (used for player, season and singleton tables).
 */
export type TableMeasure = { regularRows: number; tournamentRows: number; bytesPerRow: number; compactedBytesPerRow?: number; rows: number; totalBytes: number };
export type DatabaseMeasure = {
  players: number;
  /** The database without the game, cron, pg_net and Auth rows (catalogs, extensions, empty relations). */
  baselineBytes: number;
  slotsPerSeason: number;
  tables: Record<string, TableMeasure>;
  /** Bytes a season adds for the measured players (ratings, standings, archive, awards), when measured. */
  seasonBytes?: number;
  /** Extra player-table bytes for a full 60-item inventory per character, when measured. */
  inventoryAllowanceBytes?: number;
  system: { cronBytesPerRow: number; netBytes: number; authBytesPerPlayer: number };
  /**
   * Commands write a permanent receipt each (Task 22: command receipts are never deleted or compacted) and, at most, one
   * 90-day row beside it (a listing, a ledger row, a reservation or a superseded schedule revision).
   */
  commandReceipts: { perPlayerPerDay: number; bytesPerRow: number; summaryBytesPerRow?: number };
};

/** The database after `slots` slots: every class at its retention window, permanent rows and seasons accumulated. */
export function projectDatabase(m: DatabaseMeasure) {
  const perSlot = (t: TableMeasure) => weighted(t.regularRows, t.tournamentRows);
  const sized = (t: TableMeasure, kept: number, compactAfter?: number) => {
    const rows = perSlot(t);
    if (compactAfter === undefined || t.compactedBytesPerRow === undefined) return rows * kept * t.bytesPerRow;
    return rows * (Math.min(kept, compactAfter) * t.bytesPerRow + Math.max(0, kept - compactAfter) * t.compactedBytesPerRow);
  };
  function atSlots(slots: number) {
    const byClass: Record<Retention | 'system' | 'commands', number> = { detail: 0, summary: 0, permanent: 0, player: 0, season: 0, operational: 0,
      singleton: 0, system: 0, commands: 0 };
    const byTable: Record<string, number> = {};
    for (const [name, t] of Object.entries(m.tables)) {
      const c = TABLE_CLASSES[name];
      if (!c) throw new Error(`unclassified table ${name}`);
      const bytes = c.retention === 'detail' ? sized(t, Math.min(slots, RETENTION.detailSlots), c.compactAfterSlots)
        : c.retention === 'summary' ? sized(t, Math.min(slots, RETENTION.summarySlots), c.compactAfterSlots)
          : c.retention === 'permanent' ? sized(t, slots, c.compactAfterSlots)
            : c.retention === 'operational' ? perSlot(t) * Math.min(slots, c.windowSlots ?? 1) * t.bytesPerRow
              : c.retention === 'season' ? 0 : t.totalBytes;
      byTable[name] = bytes;
      byClass[c.retention] += bytes;
    }
    const seasons = Math.ceil(slots / m.slotsPerSeason);
    byClass.season = m.seasonBytes === undefined
      ? Object.entries(m.tables).filter(([n]) => TABLE_CLASSES[n].retention === 'season').reduce((sum, [, t]) => sum + t.totalBytes, 0) * seasons
      : m.seasonBytes * seasons;
    byClass.player += m.inventoryAllowanceBytes ?? 0;
    byClass.system = m.baselineBytes + CRON_ROWS_KEPT * m.system.cronBytesPerRow + m.system.netBytes + m.players * m.system.authBytesPerPlayer;
    const commandsPerSlot = m.players * m.commandReceipts.perPlayerPerDay / RETENTION.slotsPerDay;
    byClass.commands = commandsPerSlot * (slots * m.commandReceipts.bytesPerRow
      + Math.min(slots, RETENTION.summarySlots) * (m.commandReceipts.summaryBytesPerRow ?? 0));
    const bytes = Object.values(byClass).reduce((sum, b) => sum + b, 0);
    return { slots, days: slots / RETENTION.slotsPerDay, bytes, byClass, byTable };
  }
  const atDays = (days: number) => atSlots(days * RETENTION.slotsPerDay);
  // Every window is full after 1,620 slots (90 days). From then on only permanent rows (at their compacted size), command
  // receipts and one season per 504 slots grow.
  const windowsFull = Math.max(RETENTION.detailSlots, RETENTION.summarySlots);
  const permanentPerSlot = Object.entries(m.tables).filter(([n]) => TABLE_CLASSES[n].retention === 'permanent')
    .reduce((sum, [, t]) => sum + perSlot(t) * (t.compactedBytesPerRow ?? t.bytesPerRow), 0)
    + m.players * m.commandReceipts.perPlayerPerDay / RETENTION.slotsPerDay * m.commandReceipts.bytesPerRow;
  const seasonPerSlot = (m.seasonBytes ?? Object.entries(m.tables).filter(([n]) => TABLE_CLASSES[n].retention === 'season')
    .reduce((sum, [, t]) => sum + t.totalBytes, 0)) / m.slotsPerSeason;
  const month = 30 * RETENTION.slotsPerDay;
  const permanentBytesPerMonth = Math.round(permanentPerSlot * month), seasonBytesPerMonth = Math.round(seasonPerSlot * month);
  // What an average slot writes before any pruning or compaction, by class (the run's measured rows at their measured size).
  const bytesPerSlotByClass: Partial<Record<Retention, number>> = {};
  for (const [name, t] of Object.entries(m.tables)) {
    const r = TABLE_CLASSES[name].retention;
    if (['detail', 'summary', 'permanent', 'operational'].includes(r)) bytesPerSlotByClass[r] = (bytesPerSlotByClass[r] ?? 0) + perSlot(t) * t.bytesPerRow;
  }
  const bytesPerSlot = Object.values(bytesPerSlotByClass).reduce((sum, b) => sum + b, 0);
  const at90Days = atDays(90), atOneYear = atDays(365);
  const growth = permanentBytesPerMonth + seasonBytesPerMonth;
  const monthsToBudget = growth > 0 ? 3 + Math.max(0, BUDGETS.databaseBytes - at90Days.bytes) / growth : null;
  return { windowsFull, atDays, bytesPerSlot, bytesPerSlotByClass, at90Days, atOneYear, steadyStateBytes: at90Days.bytes, permanentBytesPerMonth,
    seasonBytesPerMonth, monthsToBudget, budgetBytes: BUDGETS.databaseBytes };
}

/** Worker dispatches per slot (measured) plus player commands, each with its CORS preflight (no Access-Control-Max-Age). */
export function projectInvocations(perSlot: { regularPerSlot: number; tournamentPerSlot: number },
  a: { players: number; commandsPerPlayerPerDay: number; preflightPerCommand: number }) {
  const months = MONTHS.map(month => {
    const worker = (month.slots - month.tournaments) * perSlot.regularPerSlot + month.tournaments * perSlot.tournamentPerSlot;
    const commands = a.players * a.commandsPerPlayerPerDay * (1 + a.preflightPerCommand) * month.days;
    const total = worker + commands;
    return { days: month.days, slots: month.slots, tournaments: month.tournaments, worker, commands, total, ceiling: month.dispatchCeiling + commands,
      share: share(total, BUDGETS.invocations), ceilingShare: share(month.dispatchCeiling + commands, BUDGETS.invocations) };
  });
  return { perSlot: { ...perSlot, weighted: weighted(perSlot.regularPerSlot, perSlot.tournamentPerSlot) }, months, budget: BUDGETS.invocations };
}

export type Encoding = 'raw' | 'gzip' | 'brotli';
/** One read as the client makes it: its responses' body bytes (raw, gzip, brotli), request count and header bytes. */
export type ReadSize = Record<Encoding, number> & { requests: number; headerBytes: number };
export type RoleSizes = { visitor: ReadSize; player: ReadSize };
export type EgressMeasure = {
  reads: Record<string, RoleSizes>;
  /** Revision changes a 30-second poller sees in a regular slot, the arena entrants whose timeline the camp reads after minute
   * 60, and the share of extra re-reads when one tick's commits straddle a poll (1 + the measured tick work / 30 s). */
  regular: { changedMinutes: number; arenaEntrants: number; splitFactor: number };
  /** A tournament slot: its revision changes, the view reads of a viewer who watches it all, and every fought bout's log once. */
  tournament: { changedMinutes: number; viewReads: number; logBytes: Record<Encoding, number> };
  /**
   * Backend traffic, an estimate counted only if hosted egress includes Edge-to-API traffic (Task 24): the worker's own Data
   * API responses per slot, and per command the function's session lookup, owner-state read and RPC responses.
   */
  worker?: { regularPerSlot: Record<Encoding, number>; tournamentPerSlot: Record<Encoding, number>; perCommand: Record<Encoding, number> };
};
export type EgressAssumptions = { players: number; viewers: number; visibleMinutesPerDay: number; commandsPerPlayerPerDay: number; standingsOpenShare: number };

/**
 * Egress of one usage model a day and a month. A person with the camp visible `minutes` a day polls the revision every 30 s,
 * re-reads the world (and, a player, the owner state) at every revision change it sees, re-reads the standings shown while the
 * panel is open (`standingsOpenShare` of the time), reads every arena entrant's timeline once per slot whose minute-60 to
 * minute-80 window its session overlaps, and loads on entry the world, the seasons, a standings page, a results page, a
 * market page and a profile (a player also the owner state, its standing row and its own latest timeline). A player also
 * sends its commands and refreshes its session once a day. On a tournament day a person watches the share of the tournament
 * its session covers. Headers are counted uncompressed.
 */
export function projectEgress(m: EgressMeasure, a: EgressAssumptions) {
  const changesPerSlot = weighted(m.regular.changedMinutes, m.tournament.changedMinutes) + 1;
  const rereadsPerMinute = changesPerSlot / SLOT_MINUTES * m.regular.splitFactor;
  const size = (kind: string, role: 'visitor' | 'player', e: Encoding) => {
    const read = m.reads[kind]?.[role];
    return read ? read[e] + read.headerBytes : 0;
  };
  function perPerson(role: 'visitor' | 'player', minutes: number, e: Encoding) {
    const player = role === 'player';
    const s = (kind: string) => size(kind, role, e);
    const polls = minutes * 2 * s('revision');
    const rereads = minutes * rereadsPerMinute * (s('world') + (player ? s('owner') : 0) + a.standingsOpenShare * (s('standings') + (player ? s('standingOf') : 0)));
    const arena = (minutes + 20) / SLOT_MINUTES * m.regular.arenaEntrants * s('timelineArena');
    const entry = s('revision') + s('world') + s('seasons') + s('standings') + s('recent') + s('market') + s('profile')
      + (player ? s('owner') + s('standingOf') + s('timelineOwn') : 0);
    const commands = player ? a.commandsPerPlayerPerDay * s('command') + s('authRefresh') : 0;
    const coverage = Math.min(1, minutes / SLOT_MINUTES);
    const tournament = coverage * (m.tournament.viewReads * s('tournament') + m.tournament.logBytes[e]);
    return { day: polls + rereads + arena + entry + commands, tournament, parts: { polls, rereads, arena, entry, commands, tournament } };
  }
  const encodings: Encoding[] = ['raw', 'gzip', 'brotli'];
  function model(role: 'visitor' | 'player', people: number, minutes: number) {
    const per = Object.fromEntries(encodings.map(e => [e, perPerson(role, minutes, e)])) as Record<Encoding, ReturnType<typeof perPerson>>;
    const months = MONTHS.map(month => ({ days: month.days, ...Object.fromEntries(encodings.map(e =>
      [e, people * (month.days * per[e].day + month.tournaments * per[e].tournament)])) as Record<Encoding, number> }));
    return { people, minutesPerDay: minutes, perPersonDay: Object.fromEntries(encodings.map(e => [e, per[e].day])) as Record<Encoding, number>,
      perPersonTournament: Object.fromEntries(encodings.map(e => [e, per[e].tournament])) as Record<Encoding, number>,
      partsRaw: per.raw.parts, months };
  }
  const players = model('player', a.players, a.visibleMinutesPerDay);
  const viewers = model('visitor', a.viewers, a.visibleMinutesPerDay);
  const viewersAlwaysOn = model('visitor', a.viewers, 24 * 60);
  const worker = m.worker ? MONTHS.map(month => ({ days: month.days, ...Object.fromEntries(encodings.map(e =>
    [e, (month.slots - month.tournaments) * m.worker!.regularPerSlot[e] + month.tournaments * m.worker!.tournamentPerSlot[e]
      + a.players * a.commandsPerPlayerPerDay * month.days * m.worker!.perCommand[e]])) as Record<Encoding, number> })) : null;
  const sum = (...parts: ({ days: number } & Record<Encoding, number>)[][]) => MONTHS.map((month, i) => ({ days: month.days,
    ...Object.fromEntries(encodings.map(e => [e, parts.reduce((total, p) => total + p[i][e], 0)])) as Record<Encoding, number>,
    share: share(parts.reduce((total, p) => total + p[i].raw, 0), BUDGETS.egressBytes) }));
  // How many always-on visitors the raw budget leaves room for beside the players, in a 31-day month.
  const long = MONTHS[1];
  const alwaysOnViewerMonth = long.days * viewersAlwaysOn.perPersonDay.raw + long.tournaments * viewersAlwaysOn.perPersonTournament.raw;
  return { perRead: m.reads, inputs: { regular: m.regular, tournament: m.tournament }, changesPerSlot, rereadsPerMinute, players, viewers,
    viewersAlwaysOn, combined: { months: sum(players.months, viewers.months) },
    worker, combinedWithWorker: worker ? { months: sum(players.months, viewers.months, worker) } : null, budget: BUDGETS.egressBytes,
    alwaysOnViewersWithinBudget: alwaysOnViewerMonth > 0 ? Math.floor(Math.max(0, BUDGETS.egressBytes - players.months[1].raw) / alwaysOnViewerMonth) : null };
}
