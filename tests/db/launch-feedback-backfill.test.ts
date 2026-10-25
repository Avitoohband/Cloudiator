import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { sql, account, resetIdentity, admin, anonymous, creation, request } from '../fixtures/db.ts';
import { makeVerifier } from '../../supabase/functions/_shared/backend/auth.ts';
import { createDatabase } from '../../supabase/functions/_shared/backend/database.ts';
import { handleCommand } from '../../supabase/functions/_shared/backend/commands.ts';
import type { GameCommand, Schedule } from '../../supabase/functions/_shared/contracts/commands.ts';

// Launch feedback (2026-10-25, M23): Arena only in the evening. The deploy-time backfill turns every morning or afternoon
// Arena that a boundary could still pick into Rest (spec, "The change surface" and "Settled after the builder check"):
//   - current (the revision the next boundary, processed slot + 1, picks): a Rest revision at processed slot + 1, in one new
//     schedule version per character;
//   - still to come (a later effective slot that no later version at the same slot overrides): a Rest revision at that same
//     effective slot, each in a further version, so the boundary's pick (effective desc, version desc) is Rest.
// Ruling R3: the block sits between marker comments in supabase/sql/16-launch-feedback.sql; this test executes exactly that
// span as postgres and checks that M23 ships the identical span.
const START = '-- launch-feedback backfill: start', END = '-- launch-feedback backfill: end';
/** The marked span of `text`, from the start marker to the end of the end marker's line, with LF line endings. */
function backfillSpan(text: string): string {
  const lf = text.replace(/\r\n/g, '\n');
  const from = lf.indexOf(START), to = lf.indexOf(END);
  if (from < 0 || to < from || lf.indexOf(START, from + 1) >= 0 || lf.indexOf(END, to + 1) >= 0) throw new Error('One marked backfill span expected');
  return lf.slice(from, to + END.length);
}
const source = () => backfillSpan(readFileSync(new URL('../../supabase/sql/16-launch-feedback.sql', import.meta.url), 'utf8'));

const SLOT = 4_800_000;
const REST = { kind: 'rest' }, ARENA = { kind: 'arena' }, TRAINING = { kind: 'training' };
const deps = { database: createDatabase(admin), verifyActor: makeVerifier(anonymous), allowedOrigins: ['http://127.0.0.1:3000'] };
const send = async (token: string, body: GameCommand) => (await handleCommand(request(token, body), deps)).json();
/** A real character through the command handler: version 1 of its schedule, with creation's three revisions at processed slot + 1. */
async function fighter() {
  const owner = await account();
  const created = await send(owner.token, creation('Fill ' + randomUUID().slice(0, 8)));
  expect(created.ok, JSON.stringify(created)).toBe(true);
  return { ...owner, gid: created.value.gladiatorId as string };
}
type Fighter = Awaited<ReturnType<typeof fighter>>;
type Revision = { phase: string; version: number; choice: unknown; effective: number; received: number };
/** A character's schedule row and every schedule revision it has. */
type Plan = { version: number; schedule: Schedule; revisions: Revision[] };
class RolledBack extends Error {}
/** Runs `body` in a transaction on a connection of its own that always rolls back, and returns what it returned. */
async function rolledBack<T>(body: (tx: postgres.TransactionSql) => Promise<T>) {
  const probe = postgres(process.env.LOCAL_DB_URL!, { max: 1, onnotice: () => {} });
  let seen: T | undefined;
  try {
    await probe.begin(async tx => { seen = await body(tx); throw new RolledBack(); })
      .catch(error => { if (!(error instanceof RolledBack)) throw error; });
  } finally { await probe.end(); }
  return seen as T;
}

describe('launch feedback: the evening-only Arena backfill (M23)', () => {
  beforeAll(async () => {
    await resetIdentity();
    await sql`update private.scheduler set enabled=false where singleton`;
  });
  afterAll(() => sql.end());

  it('turns every current and future morning or afternoon Arena into Rest at the boundary pick, and leaves the evening alone', async () => {
    const span = source();
    const [current, future, both, kept, none] = [await fighter(), await fighter(), await fighter(), await fighter(), await fighter()];
    const outcome = await rolledBack(async tx => {
      const [{ p }] = await tx`select processed_slot_index::float8 as p from public.gladiators where id=${current.gid}`;
      await tx`update public.gladiators set processed_slot_index=${p} where id in ${tx([current.gid, future.gid, both.gid, kept.gid, none.gid])}`;
      // The first slot of each part at or after processed slot + 1 (slot 0 is a morning).
      const first = (part: number) => { let t = p + 1; while (t % 3 !== part) t++; return t; };
      const M = first(0), A = first(1), E = first(2);
      const revise = async (f: Fighter, version: number, phase: string, choice: object, effective: number) =>
        tx`insert into public.schedule_revisions(gladiator_id,version,phase,choice,received_at_ms,effective_slot_index)
          values(${f.gid},${version},${phase},${tx.json(choice as never)},${p * SLOT},${effective})`;
      const plan = async (f: Fighter, version: number, day: Partial<Schedule>) =>
        tx`update public.schedules set version=${version},schedule=schedule||${tx.json(day as never)} where gladiator_id=${f.gid}`;
      // A current morning Arena (it wins processed slot + 1 over creation's version 1).
      await revise(current, 2, 'morning', ARENA, p + 1);
      await plan(current, 2, { morning: ARENA } as Partial<Schedule>);
      // A future afternoon Arena, effective from the second afternoon.
      await revise(future, 2, 'afternoon', ARENA, A + 3);
      await plan(future, 2, { afternoon: ARENA } as Partial<Schedule>);
      // One part holding both: a current Arena and a later one.
      await revise(both, 2, 'morning', ARENA, p + 1);
      await revise(both, 3, 'morning', ARENA, M + 6);
      await plan(both, 3, { morning: ARENA } as Partial<Schedule>);
      // Controls: a past afternoon Arena already superseded, a future morning Arena overridden at its own slot, and Arena
      // in the evening, current and future.
      await revise(kept, 2, 'afternoon', ARENA, p - 2);
      await revise(kept, 3, 'afternoon', TRAINING, p + 1);
      await revise(kept, 4, 'morning', ARENA, M + 3);
      await revise(kept, 5, 'morning', TRAINING, M + 3);
      await revise(kept, 6, 'evening', ARENA, p + 1);
      await revise(kept, 7, 'evening', ARENA, E + 3);
      await plan(kept, 7, { morning: TRAINING, afternoon: TRAINING, evening: ARENA } as Partial<Schedule>);

      const state = async (): Promise<Record<string, Plan>> => Object.fromEntries(await Promise.all([current, future, both, kept, none].map(async f => {
        const [s] = await tx`select version::int as version, schedule from public.schedules where gladiator_id=${f.gid}`;
        const revisions = (await tx`select phase, version::int as version, choice, effective_slot_index::float8 as effective, received_at_ms::float8 as received
          from public.schedule_revisions where gladiator_id=${f.gid} order by version, phase`).map(r => ({ ...r }) as Revision);
        return [f.gid, { version: s.version as number, schedule: s.schedule as Schedule, revisions }];
      })));
      /** The boundary's pick (private.boundary_snapshot): the latest revision of the slot's part effective by the slot. */
      const pick = async (f: Fighter, slot: number) => (await tx`select r.choice from public.schedule_revisions r where r.gladiator_id=${f.gid}
        and r.phase=private.slot_phase(${slot}) and r.effective_slot_index<=${slot} order by r.effective_slot_index desc, r.version desc limit 1`)[0].choice;
      const picks = async () => ({
        current: [await pick(current, M), await pick(current, M + 3)],
        future: [await pick(future, A), await pick(future, A + 3), await pick(future, A + 6)],
        both: [await pick(both, M), await pick(both, M + 3), await pick(both, M + 6), await pick(both, M + 9)],
        kept: [await pick(kept, A), await pick(kept, M), await pick(kept, M + 3), await pick(kept, E), await pick(kept, E + 3)],
      });

      const before = { state: await state(), picks: await picks() };
      await tx.unsafe(span);
      const after = { state: await state(), picks: await picks() };
      const [{ now }] = await tx`select private.planning_now_ms()::float8 as now`;
      // Applying the source again (it is reapplicable) changes nothing more.
      await tx.unsafe(span);
      const again = await state();
      return { p, M, A, E, now, before, after, again };
    });
    const { p, A, M, now, before, after, again } = outcome;

    // Before: Arena outside the evening would be picked.
    expect(before.picks).toEqual({ current: [ARENA, ARENA], future: [{ kind: 'expedition', expeditionId: 'woodland' }, ARENA, ARENA],
      both: [ARENA, ARENA, ARENA, ARENA], kept: [TRAINING, TRAINING, TRAINING, ARENA, ARENA] });
    // After: every affected slot picks Rest; the controls keep their picks.
    expect(after.picks).toEqual({ current: [REST, REST], future: [{ kind: 'expedition', expeditionId: 'woodland' }, REST, REST],
      both: [REST, REST, REST, REST], kept: [TRAINING, TRAINING, TRAINING, ARENA, ARENA] });

    const added = (gid: string) => after.state[gid].revisions.filter(r => !before.state[gid].revisions.some(b => b.version === r.version && b.phase === r.phase))
      .map(({ received, ...r }) => { expect(Math.abs(received - now)).toBeLessThan(60_000); return r; });
    // One version for the current Rest revisions at processed slot + 1; a further version for each future Arena's Rest.
    expect(added(current.gid)).toEqual([{ phase: 'morning', version: 3, choice: REST, effective: p + 1 }]);
    expect(added(future.gid)).toEqual([{ phase: 'afternoon', version: 3, choice: REST, effective: A + 3 }]);
    expect(added(both.gid)).toEqual([{ phase: 'morning', version: 4, choice: REST, effective: p + 1 }, { phase: 'morning', version: 5, choice: REST, effective: M + 6 }]);
    expect(added(kept.gid)).toEqual([]);
    expect(added(none.gid)).toEqual([]);
    // The latest plan shows Rest where it showed Arena outside the evening, at the last new version.
    expect(after.state[current.gid]).toMatchObject({ version: 3, schedule: { morning: REST, afternoon: { kind: 'expedition' }, evening: REST } });
    expect(after.state[future.gid]).toMatchObject({ version: 3, schedule: { morning: TRAINING, afternoon: REST, evening: REST } });
    expect(after.state[both.gid]).toMatchObject({ version: 5, schedule: { morning: REST } });
    expect(after.state[kept.gid]).toEqual(before.state[kept.gid]);
    expect(after.state[none.gid]).toEqual(before.state[none.gid]);
    // A second application is a no-op.
    expect(again).toEqual(after.state);
  });

  it('a save after the backfill takes the next version without colliding with the backfill revisions', async () => {
    const span = source();
    const f = await fighter();
    const result = await rolledBack(async tx => {
      const [{ p }] = await tx`select processed_slot_index::float8 as p from public.gladiators where id=${f.gid}`;
      await tx`insert into public.schedule_revisions(gladiator_id,version,phase,choice,received_at_ms,effective_slot_index)
        values(${f.gid},2,'afternoon',${tx.json(ARENA as never)},${p * SLOT},${p + 1}),(${f.gid},3,'afternoon',${tx.json(ARENA as never)},${p * SLOT},${p + 4})`;
      await tx`update public.schedules set version=3,schedule=jsonb_set(schedule,'{afternoon}',${tx.json(ARENA as never)}) where gladiator_id=${f.gid}`;
      await tx.unsafe(span);
      const command = { kind: 'edit-day-schedule', operationId: randomUUID(), expectedVersion: 5,
        day: { morning: TRAINING, afternoon: TRAINING, evening: ARENA } };
      const [{ saved }] = await tx`select public.edit_day_schedule(${f.id},${command.operationId},${tx.json({ command, prepared: null } as never)}) as saved`;
      return saved;
    });
    expect(result).toMatchObject({ ok: true, value: { version: 6, parts: { morning: null, afternoon: { effectiveSlotIndex: expect.any(Number) } } } });
  });

  it('ships the identical backfill span in M23', () => {
    const dir = new URL('../../supabase/migrations/', import.meta.url);
    const files = readdirSync(dir).filter(name => name.endsWith('_launch_feedback.sql'));
    expect(files).toHaveLength(1);
    const m23 = readFileSync(new URL(files[0], dir), 'utf8').replace(/\r\n/g, '\n');
    expect(backfillSpan(m23)).toBe(source());
    // As in the source, the block follows M23's function statements.
    expect(m23.indexOf(START)).toBeGreaterThan(m23.search(/create or replace function "?private"?\."?planning_command"?/i));
  });
});
