import { afterAll, describe, expect, it } from 'vitest';
import { sql, resetIdentity } from '../fixtures/db.ts';
import { CAPACITY, measureSeasonClose, measureStandings, measureWorld, writeSection } from '../fixtures/capacity.ts';
import { BUDGETS, TABLE_CLASSES, projectDatabase, projectEgress, projectInvocations, share } from '../performance/capacity-model.ts';

// Task 23.3 (Review Focus 3): the target load against the free-tier budgets, measured on the local stack.
// 1. A measurement world of CAPACITY.players characters runs CAPACITY.slots accelerated boundaries (after one warm-up slot)
//    through pg_cron's tick function and the real private Edge worker reached through pg_net, ticked once a minute of
//    database time, a tournament slot among them. It records dispatches, revision changes, rows and bytes per slot, and
//    then the real Data API response sizes of every read kind as a visitor and as a player. The projections are in
//    tests/performance/capacity-model.ts; scripts/resource-report.mjs prints them as JSON.
// 2. The synchronous season close of boundary phase 2 (C14) at four 50-player leagues, and at 500 rows a league.
// 3. The standings page and the one-row standing read (C13) at 1,000 rows of one league and season, with their plans.
// Every case resets the world first; the file resets it again at the end, so no measurement row outlives the file.
//
// CAPACITY_GATE=1 enforces the budgets of case 1 (database, invocations, raw egress and boundary publication), each checked
// softly so one run names every one that fails. Without it (the default, as in a plain `npm run test:db`) case 1 still
// measures and records every number and checks the run itself, but not the budgets: they are open blockers for Avi
// (docs/operations/release-evidence.md, "Lane A: capacity"), and Task 23.6's release gate runs this file with the flag.
const GATE = process.env.CAPACITY_GATE === '1';

afterAll(async () => { await resetIdentity(); await sql.end(); });

describe('Task 23.3: capacity against the free-tier budgets', () => {
  it('measures database growth, invocations and egress over accelerated boundaries with the real worker', async () => {
    const world = await measureWorld(CAPACITY);
    // Everything is projected and written first, so a failed check below still leaves the whole measurement.
    const database = projectDatabase(world.database);
    const invocations = projectInvocations(world.invocations, { players: CAPACITY.players, commandsPerPlayerPerDay: CAPACITY.commandsPerPlayerPerDay,
      preflightPerCommand: 1 });
    const egress = projectEgress(world.egress, { players: CAPACITY.players, viewers: CAPACITY.viewers, visibleMinutesPerDay: 30,
      commandsPerPlayerPerDay: CAPACITY.commandsPerPlayerPerDay, standingsOpenShare: 1 });
    // Scenario 2 (the new-character schedule) and the command-rate sensitivity of the permanent receipts.
    const databaseDefault = projectDatabase(world.plainDatabase);
    const invocationsDefault = projectInvocations(world.plainInvocations, { players: CAPACITY.players,
      commandsPerPlayerPerDay: CAPACITY.commandsPerPlayerPerDay, preflightPerCommand: 1 });
    const withCommands = (m: typeof world.database, n: number) => ({ ...m, commandReceipts: { ...m.commandReceipts, perPlayerPerDay: n } });
    const sensitivity = [0, 5, 10, 20].map(n => ({ commandsPerPlayerPerDay: n,
      database90Days: projectDatabase(withCommands(world.database, n)).at90Days.bytes, databaseOneYear: projectDatabase(withCommands(world.database, n)).atOneYear.bytes,
      defaultDatabase90Days: projectDatabase(withCommands(world.plainDatabase, n)).at90Days.bytes,
      defaultDatabaseOneYear: projectDatabase(withCommands(world.plainDatabase, n)).atOneYear.bytes,
      invocations31Days: projectInvocations(world.invocations, { players: CAPACITY.players, commandsPerPlayerPerDay: n, preflightPerCommand: 1 }).months[1].total }));
    const section = { measured: world.summary, tables: world.database.tables, database, databaseDefault, invocations, invocationsDefault, egress,
      sensitivity, budgets: BUDGETS };
    console.info(`Task 23.3 capacity: ${JSON.stringify(section)}`);
    writeSection('capacity', section);
    // Every table of the two game schemas has a retention class, so no new table escapes the projection.
    expect(world.tables.filter(name => !Object.hasOwn(TABLE_CLASSES, name))).toEqual([]);
    expect(world.windows.map(w => w.slot)).toEqual(Array.from({ length: CAPACITY.slots }, (_, i) => world.firstSlot + i));
    expect(world.windows.filter(w => w.tournament).map(w => w.tournamentEntrants)).toEqual([CAPACITY.players]);
    // Every dispatched invocation was the real worker and answered without a failure, conflict or unrecorded failure.
    expect(world.flagged).toEqual([]);
    for (const w of [...world.windows, ...world.plainWindows]) {
      expect(w.statuses.every(status => status === 200)).toBe(true);
      expect(w.dispatched).toBeGreaterThan(0);
    }
    // The budgets (CAPACITY_GATE=1 only, see the header). Any over 100 % is a blocker for Avi; over 80 % is a named risk.
    if (!GATE) return;
    // Spec §10.4 at representative load: every boundary of both scenarios publishes within 120 s of its cutoff.
    const late = [...world.windows, ...world.plainWindows].filter(w => w.publishedMs === null || w.publishedMs >= 120_000).map(w => [w.slot, w.publishedMs]);
    expect.soft(late, 'boundaries published at or after 120 s').toEqual([]);
    for (const [name, d] of [['mixed schedules', database], ['new-character schedule', databaseDefault]] as const) {
      expect.soft(share(d.at90Days.bytes, BUDGETS.databaseBytes), `database at 90 days, ${name}`).toBeLessThan(1);
      expect.soft(share(d.atOneYear.bytes, BUDGETS.databaseBytes), `database after one year, ${name}`).toBeLessThan(1);
    }
    for (const month of invocations.months) expect.soft(share(month.total, BUDGETS.invocations), `invocations, ${month.days} days`).toBeLessThan(1);
    for (const month of egress.combined.months) expect.soft(share(month.raw, BUDGETS.egressBytes), `raw egress, ${month.days} days`).toBeLessThan(1);
  }, 1_800_000);

  it('closes a season of four 50-player leagues within one boundary budget', async () => {
    const close = await measureSeasonClose();
    expect(close.ms50.rows).toBe(200);
    expect(close.ms50.awards).toBe(12);
    expect(close.ms500.rows).toBe(2_000);
    expect(close.ms500.awards).toBe(12);
    // The close runs inside boundary phase 2: it must fit in what the 120 s boundary target leaves after a steady-state
    // publication at 50 characters (Task 23.2: about 61.4 s), with a 25 % margin.
    expect(close.ms50.ms).toBeLessThan(BUDGETS.seasonCloseMs);
    expect(close.ms500.ms).toBeLessThan(BUDGETS.seasonCloseMs);
    console.info(`Task 23.3 season close: ${JSON.stringify(close)}`);
    writeSection('seasonClose', close);
  }, 600_000);

  it('reads a standings page and one standing row within their budgets at 1,000 rows', async () => {
    const standings = await measureStandings(1_000);
    expect(standings.rows).toBe(1_000);
    expect(standings.page.rows).toBe(50);
    expect(standings.oneRow.rank).toBe(1_000);
    expect(standings.pageMs).toBeLessThan(BUDGETS.standingsReadMs);
    expect(standings.oneRowMs).toBeLessThan(BUDGETS.standingsReadMs);
    expect(standings.plans.page.executionMs).toBeLessThan(BUDGETS.standingsPlanMs);
    expect(standings.plans.oneRow.executionMs).toBeLessThan(BUDGETS.standingsPlanMs);
    console.info(`Task 23.3 standings: ${JSON.stringify(standings)}`);
    writeSection('standings', standings);
  }, 600_000);
});
