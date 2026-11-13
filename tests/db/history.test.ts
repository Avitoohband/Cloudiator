import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql, account, admin, anonymous, resetIdentity, creation } from '../fixtures/db.ts';
import { createDatabase } from '../../supabase/functions/_shared/backend/database.ts';
import { HISTORY_PAGE, readHistory, readHistoryCounts, readTimeline } from '../../src/lib/api/reads.ts';
import type { HistoryEntry, HistoryKind } from '../../supabase/functions/_shared/contracts/reads.ts';

// Patch 1.9 (M37, supabase/sql/31-history-sellers.sql; .superpowers/design/2026-11-12-gladiator-history/notes.md "Server: what a new
// public read must expose"). Any reader (a visitor, another player, the owner) reads one gladiator's settled history by kind through
// public.gladiator_history_reads, 20 a page, newest first, and the chips' counts through public.gladiator_history_counts. An Arena bout
// or expedition is one row (its league and destination kept in public.result_details when it settles); a tournament row is one fought
// bout of a settled run. Never a reward, renown, rating change, gold, item, loot, receipt, schedule or plan; nothing of an unsettled
// activity; no opponent once the replay is no longer kept. Rows here are written as settlement leaves them (the operator's SQL); the
// real settlement paths are covered in arena.test.ts, tournaments.test.ts and expeditions.test.ts.
const SLOT = 4_800_000, MINUTE = 60_000, WEEK = 604_800_000;
const database = createDatabase(admin);
beforeEach(async () => { await resetIdentity(); await sql`update private.scheduler set enabled=false where singleton`; });
afterAll(() => sql.end());

const dbNow = async () => Number((await sql`select floor(extract(epoch from clock_timestamp())*1000)::bigint as ms`)[0].ms);
const short = () => randomUUID().slice(0, 6);
async function player(prefix: string) {
  const owner = await account();
  const name = `${prefix} ${short()}`;
  const created = await database.createGladiator({ userId: owner.id }, creation(name));
  if (!created.ok) throw Error('creation failed');
  return { ...owner, gid: created.value.gladiatorId, name };
}
type Player = Awaited<ReturnType<typeof player>>;
/** What only the owner may ever see: these values and keys must never appear in a history row. */
const REWARDS = { money: 424_242, renown: 77, xp: 999, attributePoints: 1, items: [{ catalogId: 'iron-helmet:5:uncommon', catalogVersion: 'v1', tier: 5, rarity: 'uncommon', quantity: 1 }],
  overflowMoney: 0 };
const SECRET = /rewards|renown|ratingDelta|receipt|iron-helmet|424242|overflow|placement|"money"|"xp"|seed|snapshot|schedule|stamina/i;
type Replay = 'kept' | 'expired' | 'lapsed';
/** The summary settlement stores (the owner's), with the replay's state: kept (a week after the slot), expired (flipped), or lapsed (past, not yet flipped). */
function summary(id: string, kind: string, ends: number, settledAt: number, result: 'victory' | 'defeat', replay: Replay, extra: Record<string, unknown> = {}) {
  const replayExpiry = replay === 'expired' ? { state: 'expired' } : { state: 'available', expiresAtMs: replay === 'kept' ? ends + WEEK : settledAt - 1 };
  return { activityId: id, resolvedKind: kind, result, success: result === 'victory', rewards: REWARDS, receiptId: randomUUID(), settledAtMs: settledAt,
    replayExpiry, ...extra };
}
const participant = (gladiatorId: string | null, name: string, botTeam?: string) =>
  ({ id: gladiatorId ?? `npc:${name}`, gladiatorId, name, classId: gladiatorId ? 'guardian' : null, ...(botTeam ? { botTeam } : {}) });
type Opponent = { gladiatorId: string | null; name: string; botTeam?: string };

/**
 * An Arena bout as the real paths leave it: an active activity, its private assignment (league), its due bout stage with both fighters,
 * then settlement completes it with its summary (`complete: false` leaves it active). `settledAt` defaults to the slot's end.
 */
async function arena(me: Player, slot: number, o: { result?: 'victory' | 'defeat'; league?: string | null; opponent?: Opponent; unranked?: boolean;
  replay?: Replay; settledAt?: number; foughtAt?: number; complete?: boolean } = {}) {
  const id = randomUUID(), starts = slot * SLOT, ends = starts + SLOT, result = o.result ?? 'victory';
  await sql`insert into public.activities(id,gladiator_id,slot_index,starts_at_ms,ends_at_ms,requested,resolved_kind,status,published_at_ms)
    values(${id},${me.gid},${slot},${starts},${ends},'{"kind":"arena"}','arena','active',${starts})`;
  if (o.league !== null) {
    const [{ job }] = await sql`insert into private.jobs(kind,dedupe_key,slot_index,input,rules_version,due_at_ms,status)
      values('pair',${'history-pair:' + randomUUID()},${slot},'{}','v1',0,'completed') returning id as job`;
    await sql`insert into private.arena_assignments(battle_id,pairing_job_id,slot_index,league,season_index,kind,seed,assignment,created_at_ms)
      values(${'history:' + id},${job},${slot},${o.league ?? 'silver'},0,'human','seed','{}',0)`;
    await sql`insert into private.arena_assignment_sides(activity_id,battle_id,side) values(${id},${'history:' + id},0)`;
  }
  const opponent = o.opponent ?? { gladiatorId: randomUUID(), name: 'Varro' }, fought = o.foughtAt ?? starts + 60 * MINUTE;
  const stage = { id: `${id}:1`, kind: 'bout', revealedAtMs: fought, startedAtMs: fought, endsAtMs: fought + 30_000, label: `Bout: ${result}`,
    battleLog: { participants: [participant(me.gid, me.name), participant(opponent.gladiatorId, opponent.name, opponent.botTeam)] } };
  await sql`insert into public.activity_stages(activity_id,ordinal,reveal_at_ms,stage) values(${id},1,${fought},${sql.json(stage as never)})`;
  if (o.complete === false) return id;
  const settledAt = o.settledAt ?? ends;
  const stored = summary(id, 'arena', ends, settledAt, result, o.replay ?? 'kept', { ratingDelta: result === 'victory' ? 17 : -17,
    ...(o.unranked ? { arenaMode: 'unranked' } : {}) });
  await sql`update public.activities set status='completed',summary=${sql.json(stored as never)},settled_at_ms=${settledAt},receipt_id=${stored.receiptId} where id=${id}`;
  return id;
}
/** An expedition as settlement leaves it, written completed at once (`complete: false`: still under way, no summary). */
async function expedition(me: Player, slot: number, o: { success?: boolean; expeditionId?: string; replay?: Replay; settledAt?: number; complete?: boolean } = {}) {
  const id = randomUUID(), starts = slot * SLOT, ends = starts + SLOT, settledAt = o.settledAt ?? ends;
  const requested = { kind: 'expedition', expeditionId: o.expeditionId ?? 'woodland' };
  const stored = o.complete === false ? null : summary(id, 'expedition', ends, settledAt, o.success === false ? 'defeat' : 'victory', o.replay ?? 'kept');
  await sql`insert into public.activities(id,gladiator_id,slot_index,starts_at_ms,ends_at_ms,requested,resolved_kind,status,published_at_ms,summary,settled_at_ms)
    values(${id},${me.gid},${slot},${starts},${ends},${sql.json(requested)},'expedition',${stored ? 'completed' : 'active'},${starts},
      ${stored ? sql.json(stored as never) : null},${stored ? settledAt : null})`;
  return id;
}
type Bout = { round: number; position: number; fighters: [Opponent, Opponent] | [Opponent]; winner: 0 | 1; revealAt: number };
/** A published tournament (its pairing job a completed private job) with its due public bout results, as phase 8 and the reveals write them. */
async function tournament(slot: number, league: string, rounds: number, bouts: Bout[]) {
  const id = `tournament:${slot}:${league}`, size = 2 ** rounds, starts = slot * SLOT;
  const [{ job }] = await sql`insert into private.jobs(kind,dedupe_key,slot_index,input,rules_version,due_at_ms,status)
    values('pair',${'history-pair:' + randomUUID()},${slot},'{}','v1',0,'completed') returning id as job`;
  await sql`insert into public.tournament_views(id,pairing_job_id,slot_index,league,starts_at_ms,ends_at_ms,status,entrants,bracket,bouts,reveal_at_ms,published_at_ms)
    values(${id},${job},${slot},${league},${starts},${starts + SLOT},'active','[]',${sql.json({ size, rounds, slots: [] })},'[]','[]',${starts})`;
  for (const b of bouts) {
    const bye = b.fighters.length === 1;
    const result = { participants: b.fighters.map(f => ({ gladiatorId: f.gladiatorId, name: f.name, classId: 'guardian' })),
      winnerId: b.fighters[b.winner]!.gladiatorId, bye, ...(bye ? {} : { battleLog: { participants: b.fighters.map(f => participant(f.gladiatorId, f.name)) } }) };
    await sql`insert into public.tournament_bout_results(bout_id,tournament_id,ordinal,round,position,reveal_at_ms,result)
      values(${`${id}:${b.round}:${b.position}`},${id},${size - (size >> (b.round - 1)) + b.position},${b.round},${b.position},${b.revealAt},${sql.json(result as never)})`;
  }
  return id;
}
/** One entrant's run: its activity (settled with its summary unless `complete: false`) and, once settled, its public place. */
async function run(me: Player, tid: string, place: number, o: { replay?: Replay; settledAt?: number; complete?: boolean; placement?: boolean } = {}) {
  const slot = Number(tid.split(':')[1]), id = randomUUID(), starts = slot * SLOT, ends = starts + SLOT, settledAt = o.settledAt ?? ends;
  const stored = o.complete === false ? null : summary(id, 'tournament', ends, settledAt, place === 1 ? 'victory' : 'defeat', o.replay ?? 'kept', { ratingDelta: 17 });
  await sql`insert into public.activities(id,gladiator_id,slot_index,starts_at_ms,ends_at_ms,requested,resolved_kind,status,published_at_ms,summary,settled_at_ms)
    values(${id},${me.gid},${slot},${starts},${ends},'{"kind":"tournament"}','tournament',${stored ? 'completed' : 'active'},${starts},
      ${stored ? sql.json(stored as never) : null},${stored ? settledAt : null})`;
  if (o.placement ?? stored !== null) {
    await sql`insert into public.tournament_placements(tournament_id,gladiator_id,activity_id,place) values(${tid},${me.gid},${id},${place})`;
  }
  return id;
}
const entry = (over: Partial<HistoryEntry> & Pick<HistoryEntry, 'entryId' | 'kind' | 'activityId' | 'foughtAtMs' | 'settledAtMs' | 'result'>): HistoryEntry =>
  ({ success: over.result === 'victory', replayExpiry: { state: 'expired' }, league: null, tournamentId: null, round: null, place: null, expeditionId: null, opponent: null, ...over });
const kept = (slot: number) => ({ state: 'available' as const, expiresAtMs: (slot + 1) * SLOT + WEEK });
/** Every page of one kind through the real Data API, following each page's cursor. */
async function allPages(client: typeof anonymous, gid: string, kind: HistoryKind) {
  const pages: HistoryEntry[][] = [];
  for (let cursor: string | undefined, n = 0; n < 10; n++) {
    const page = await readHistory(client, gid, kind, cursor);
    pages.push(page.rows);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return pages;
}
const VIEW_COLUMNS = ['activity_id', 'arena_mode', 'entry_id', 'expedition_id', 'fought_at_ms', 'gladiator_id', 'kind', 'league', 'opponent', 'place',
  'replay_expires_at_ms', 'result', 'round', 'settled_at_ms', 'success', 'tournament_id'];

describe('gladiator history (M37)', () => {
  it('shows a visitor, another player, an opponent and the owner the same public rows of each kind, and no reward of any kind', async () => {
    const hero = await player('Hero'), rival = await player('Rival'), other = await player('Other'), spectator = await account();
    const base = Math.floor(await dbNow() / SLOT);
    // Arena: a win over a player and a loss to an NPC fallback in Silver, and an unranked win over a Ludus Nimbus bot.
    const won = await arena(hero, base - 3, { league: 'silver', opponent: { gladiatorId: rival.gid, name: rival.name } });
    const lost = await arena(hero, base - 5, { result: 'defeat', league: 'silver', opponent: { gladiatorId: null, name: 'Iron Warden' } });
    const bot = await arena(hero, base - 7, { league: 'gold', unranked: true, opponent: { gladiatorId: randomUUID(), name: 'Nimbus Kael', botTeam: 'ludus-nimbus' } });
    // Expeditions: a success and a failure.
    const trip = await expedition(hero, base - 4, { expeditionId: 'woodland' });
    const failed = await expedition(hero, base - 6, { success: false, expeditionId: 'outpost' });
    // A Gold tournament of 8 seats: the hero has a bye in round 1, wins the semifinal over the rival and loses the final to the other (2nd).
    const T = base - 8, starts = T * SLOT, x = { gladiatorId: randomUUID(), name: 'Livius' };
    const tid = await tournament(T, 'gold', 3, [
      { round: 1, position: 0, fighters: [{ gladiatorId: hero.gid, name: hero.name }], winner: 0, revealAt: starts },
      { round: 1, position: 1, fighters: [{ gladiatorId: rival.gid, name: rival.name }, x], winner: 0, revealAt: starts + 20 * MINUTE },
      { round: 2, position: 0, fighters: [{ gladiatorId: hero.gid, name: hero.name }, { gladiatorId: rival.gid, name: rival.name }], winner: 0, revealAt: starts + 40 * MINUTE },
      { round: 2, position: 1, fighters: [{ gladiatorId: other.gid, name: other.name }, x], winner: 0, revealAt: starts + 40 * MINUTE },
      { round: 3, position: 0, fighters: [{ gladiatorId: other.gid, name: other.name }, { gladiatorId: hero.gid, name: hero.name }], winner: 0, revealAt: starts + 60 * MINUTE },
    ]);
    const heroRun = await run(hero, tid, 2), rivalRun = await run(rival, tid, 3);
    const expected: Record<HistoryKind, HistoryEntry[]> = {
      arena: [
        entry({ entryId: won, kind: 'arena', activityId: won, foughtAtMs: (base - 3) * SLOT + 60 * MINUTE, settledAtMs: (base - 2) * SLOT, result: 'victory',
          replayExpiry: kept(base - 3), league: 'silver', opponent: { name: rival.name, npc: false } }),
        entry({ entryId: lost, kind: 'arena', activityId: lost, foughtAtMs: (base - 5) * SLOT + 60 * MINUTE, settledAtMs: (base - 4) * SLOT, result: 'defeat',
          replayExpiry: kept(base - 5), league: 'silver', opponent: { name: 'Iron Warden', npc: true } }),
        entry({ entryId: bot, kind: 'arena', activityId: bot, foughtAtMs: (base - 7) * SLOT + 60 * MINUTE, settledAtMs: (base - 6) * SLOT, result: 'victory',
          replayExpiry: kept(base - 7), arenaMode: 'unranked', league: 'gold', opponent: { name: 'Nimbus Kael', npc: false, botTeam: 'ludus-nimbus' } }),
      ],
      tournament: [
        entry({ entryId: `${tid}:3:0`, kind: 'tournament', activityId: heroRun, foughtAtMs: starts + 60 * MINUTE, settledAtMs: (T + 1) * SLOT, result: 'defeat',
          replayExpiry: kept(T), league: 'gold', tournamentId: tid, round: 'Final', place: 2, opponent: { name: other.name, npc: false } }),
        entry({ entryId: `${tid}:2:0`, kind: 'tournament', activityId: heroRun, foughtAtMs: starts + 40 * MINUTE, settledAtMs: (T + 1) * SLOT, result: 'victory',
          replayExpiry: kept(T), league: 'gold', tournamentId: tid, round: 'Semifinal', place: 2, opponent: { name: rival.name, npc: false } }),
      ],
      expedition: [
        entry({ entryId: trip, kind: 'expedition', activityId: trip, foughtAtMs: (base - 4) * SLOT, settledAtMs: (base - 3) * SLOT, result: 'victory',
          replayExpiry: kept(base - 4), expeditionId: 'woodland' }),
        entry({ entryId: failed, kind: 'expedition', activityId: failed, foughtAtMs: (base - 6) * SLOT, settledAtMs: (base - 5) * SLOT, result: 'defeat',
          replayExpiry: kept(base - 6), expeditionId: 'outpost' }),
      ],
    };
    for (const [who, client] of [['visitor', anonymous], ['spectator', spectator.client], ['rival', rival.client], ['owner', hero.client], ['backend', admin]] as const) {
      for (const kind of ['arena', 'tournament', 'expedition'] as const) {
        expect(await readHistory(client, hero.gid, kind), `${who} ${kind}`).toEqual({ rows: expected[kind], nextCursor: null });
      }
      expect(await readHistoryCounts(client, hero.gid), who).toEqual({ arena: { total: 3, won: 2 }, tournament: { total: 2, won: 1 }, expedition: { total: 2, won: 1 } });
    }
    // The rival's own history names the semifinal it lost to the hero (and its round-1 win), never the hero's bye.
    expect((await readHistory(anonymous, rival.gid, 'tournament')).rows.map(r => [r.entryId, r.round, r.result, r.place, r.opponent?.name, r.activityId]))
      .toEqual([[`${tid}:2:0`, 'Semifinal', 'defeat', 3, hero.name, rivalRun], [`${tid}:1:1`, 'Quarterfinal', 'victory', 3, 'Livius', rivalRun]]);
    // The other entrant has not settled (no run): its fought bouts are not its history yet.
    expect(await readHistory(anonymous, other.gid, 'tournament')).toEqual({ rows: [], nextCursor: null });
    // The raw view row as a visitor reads it: exactly its sixteen public columns, and nothing of the owner's summary anywhere.
    const raw = await anonymous.from('gladiator_history_reads').select('*').eq('gladiator_id', hero.gid);
    expect(raw.error).toBeNull();
    expect(raw.data).toHaveLength(7);
    for (const row of raw.data!) expect(Object.keys(row).sort()).toEqual(VIEW_COLUMNS);
    expect(JSON.stringify(raw.data)).not.toMatch(SECRET);
    const counts = await anonymous.from('gladiator_history_counts').select('*').eq('gladiator_id', hero.gid);
    expect(counts.data).toEqual([{ gladiator_id: hero.gid, arena: 3, arena_won: 2, tournament: 2, tournament_won: 1, expedition: 2, expedition_won: 1 }]);
    const details = await anonymous.from('result_details').select('*').eq('gladiator_id', hero.gid).order('fought_at_ms', { ascending: false });
    expect(details.data).toEqual([[won, 'arena', 'silver', null], [trip, 'expedition', null, 'woodland'], [lost, 'arena', 'silver', null],
      [failed, 'expedition', null, 'outpost'], [bot, 'arena', 'gold', null]].map(([id, kind, league, destination], n) => ({ activity_id: id, gladiator_id: hero.gid,
      kind, league, expedition_id: destination, fought_at_ms: [(base - 3) * SLOT + 60 * MINUTE, (base - 4) * SLOT, (base - 5) * SLOT + 60 * MINUTE, (base - 6) * SLOT,
        (base - 7) * SLOT + 60 * MINUTE][n], reveal_at_ms: [(base - 2) * SLOT, (base - 3) * SLOT, (base - 4) * SLOT, (base - 5) * SLOT, (base - 6) * SLOT][n] })));
    expect(JSON.stringify(details.data)).not.toMatch(SECRET);
    // A gladiator without history has no counts row: every count is 0.
    expect(await readHistoryCounts(anonymous, spectator.id)).toEqual({ arena: { total: 0, won: 0 }, tournament: { total: 0, won: 0 }, expedition: { total: 0, won: 0 } });
    // Malformed options are refused before any request.
    for (const [gid, kind, cursor] of [['not-a-gladiator', 'arena', undefined], [hero.gid, 'dungeon', undefined], [hero.gid, 'arena', 'x:y'],
      [hero.gid, 'arena', `1:${hero.gid},id.neq.x`], [hero.gid, 'arena', '99999999999999999:' + won]] as const) {
      await expect(readHistory(anonymous, gid, kind as HistoryKind, cursor), `${gid} ${kind} ${cursor}`).rejects.toMatchObject({ code: 'unavailable' });
    }
  });

  it('pages 20 rows at a time, newest first, with a stable cursor through equal times and tournament bout ids', async () => {
    const hero = await player('Pager');
    const base = Math.floor(await dbNow() / SLOT);
    const ids: string[] = [];
    // 45 Arena bouts, one a slot; the 20th and 21st newest share one fought time (the cursor's tie-break is the entry id).
    for (let n = 1; n <= 45; n++) ids.push(await arena(hero, base - n, { foughtAt: n === 21 ? (base - 20) * SLOT + 60 * MINUTE : undefined, result: n % 3 ? 'victory' : 'defeat' }));
    await expedition(hero, base - 46);
    const order = ids.map((id, n) => ({ id, at: (base - (n === 20 ? 20 : n + 1)) * SLOT + 60 * MINUTE }))
      .sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1)).map(r => r.id);
    for (const client of [anonymous, hero.client]) {
      const pages = await allPages(client, hero.gid, 'arena');
      expect(pages.map(p => p.length)).toEqual([HISTORY_PAGE, HISTORY_PAGE, 5]);
      expect(pages.flat().map(r => r.entryId)).toEqual(order);
      expect(pages.flat().every(r => r.kind === 'arena')).toBe(true);
    }
    const first = await readHistory(anonymous, hero.gid, 'arena');
    expect(first.nextCursor).toBe(`${first.rows[19].foughtAtMs}:${first.rows[19].entryId}`);
    expect(await readHistoryCounts(anonymous, hero.gid)).toEqual({ arena: { total: 45, won: 30 }, tournament: { total: 0, won: 0 }, expedition: { total: 1, won: 1 } });
    // A tournament cursor holds colons: the read quotes it, and the next page starts strictly after that bout.
    const T = base - 50, starts = T * SLOT, foe = (n: number) => ({ gladiatorId: randomUUID(), name: `Foe ${n}` });
    const tid = await tournament(T, 'bronze', 3, [1, 2, 3].map(round => ({ round, position: 0, fighters: [{ gladiatorId: hero.gid, name: hero.name }, foe(round)] as [Opponent, Opponent],
      winner: 0 as const, revealAt: starts + round * 20 * MINUTE })));
    await run(hero, tid, 1);
    const bouts = await readHistory(anonymous, hero.gid, 'tournament');
    expect(bouts.rows.map(r => [r.entryId, r.round])).toEqual([[`${tid}:3:0`, 'Final'], [`${tid}:2:0`, 'Semifinal'], [`${tid}:1:0`, 'Quarterfinal']]);
    const after = await readHistory(anonymous, hero.gid, 'tournament', `${bouts.rows[0].foughtAtMs}:${bouts.rows[0].entryId}`);
    expect(after.rows.map(r => r.entryId)).toEqual([`${tid}:2:0`, `${tid}:1:0`]);
  });

  it('lists nothing of an activity before it has settled, and lists it once it has', async () => {
    const hero = await player('Waiting'), rival = await player('Pending');
    const now = await dbNow(), base = Math.floor(now / SLOT);
    // An Arena bout revealed (its stage is public) but not settled; one settled with a future settlement time; an expedition under way.
    const open = await arena(hero, base - 2, { complete: false, opponent: { gladiatorId: rival.gid, name: rival.name } });
    await arena(hero, base - 3, { settledAt: now + 3_600_000 });
    await expedition(hero, base - 4, { complete: false });
    // A tournament whose bouts are all revealed while the run has not settled (no summary, no place yet), and one settled in the future.
    const T = base - 5, starts = T * SLOT;
    const tid = await tournament(T, 'silver', 1, [{ round: 1, position: 0, fighters: [{ gladiatorId: hero.gid, name: hero.name }, { gladiatorId: rival.gid, name: rival.name }],
      winner: 0, revealAt: starts + 20 * MINUTE }]);
    await run(hero, tid, 1, { complete: false });
    await run(rival, tid, 2, { settledAt: now + 3_600_000 });
    for (const client of [anonymous, hero.client, rival.client, admin]) {
      for (const gid of [hero.gid, rival.gid]) {
        for (const kind of ['arena', 'tournament', 'expedition'] as const) expect(await readHistory(client, gid, kind), kind).toEqual({ rows: [], nextCursor: null });
        expect(await readHistoryCounts(client, gid)).toEqual({ arena: { total: 0, won: 0 }, tournament: { total: 0, won: 0 }, expedition: { total: 0, won: 0 } });
      }
    }
    // The future-settled bout's details exist but are due later, like its public result: no client reads them yet.
    expect((await anonymous.from('result_details').select('activity_id').eq('gladiator_id', hero.gid)).data).toEqual([]);
    expect(await sql`select count(*)::int as n from public.result_details where gladiator_id=${hero.gid}`).toEqual([{ n: 1 }]);
    // Settlement completes the open bout: it is listed at once, for everyone.
    const settled = (base - 1) * SLOT;
    const stored = summary(open, 'arena', settled, settled, 'victory', 'kept');
    await sql`update public.activities set status='completed',summary=${sql.json(stored as never)},settled_at_ms=${settled},receipt_id=${stored.receiptId} where id=${open}`;
    for (const client of [anonymous, rival.client]) {
      expect((await readHistory(client, hero.gid, 'arena')).rows).toEqual([entry({ entryId: open, kind: 'arena', activityId: open, foughtAtMs: (base - 2) * SLOT + 60 * MINUTE,
        settledAtMs: settled, result: 'victory', replayExpiry: kept(base - 2), league: 'silver', opponent: { name: rival.name, npc: false } })]);
    }
  });

  it('names no opponent once the replay is no longer kept, by the database time, and keeps the rest of the row', async () => {
    const hero = await player('Veteran'), rival = await player('Foe');
    const base = Math.floor(await dbNow() / SLOT);
    // Flipped to expired by the cleanup, and past its expiry but not flipped yet: the stage (and its names) are still in the table.
    const expired = await arena(hero, base - 2, { replay: 'expired', opponent: { gladiatorId: rival.gid, name: rival.name } });
    const lapsed = await arena(hero, base - 3, { replay: 'lapsed', result: 'defeat', opponent: { gladiatorId: null, name: 'Bronze Sentinel' } });
    const trip = await expedition(hero, base - 4, { replay: 'lapsed' });
    const T = base - 6, starts = T * SLOT;
    const tid = await tournament(T, 'champion', 2, [{ round: 1, position: 0, fighters: [{ gladiatorId: hero.gid, name: hero.name }, { gladiatorId: rival.gid, name: rival.name }],
      winner: 1, revealAt: starts + 20 * MINUTE }]);
    const heroRun = await run(hero, tid, 3, { replay: 'expired' });
    for (const client of [anonymous, rival.client, hero.client]) {
      expect((await readHistory(client, hero.gid, 'arena')).rows).toEqual([
        entry({ entryId: expired, kind: 'arena', activityId: expired, foughtAtMs: (base - 2) * SLOT + 60 * MINUTE, settledAtMs: (base - 1) * SLOT, result: 'victory', league: 'silver' }),
        entry({ entryId: lapsed, kind: 'arena', activityId: lapsed, foughtAtMs: (base - 3) * SLOT + 60 * MINUTE, settledAtMs: (base - 2) * SLOT, result: 'defeat', league: 'silver' })]);
      expect((await readHistory(client, hero.gid, 'expedition')).rows).toEqual([
        entry({ entryId: trip, kind: 'expedition', activityId: trip, foughtAtMs: (base - 4) * SLOT, settledAtMs: (base - 3) * SLOT, result: 'victory', expeditionId: 'woodland' })]);
      expect((await readHistory(client, hero.gid, 'tournament')).rows).toEqual([
        entry({ entryId: `${tid}:1:0`, kind: 'tournament', activityId: heroRun, foughtAtMs: starts + 20 * MINUTE, settledAtMs: (T + 1) * SLOT, result: 'defeat',
          league: 'champion', tournamentId: tid, round: 'Semifinal', place: 3 })]);
    }
    const raw = (await anonymous.from('gladiator_history_reads').select('opponent,replay_expires_at_ms').eq('gladiator_id', hero.gid)).data!;
    expect(raw).toEqual(Array(4).fill({ opponent: null, replay_expires_at_ms: null }));
    expect(JSON.stringify(raw)).not.toContain(rival.name);
  });

  it('records a bout\'s league and fought time once, at settlement, keeps them immutable, and backfills settled rows exactly as the trigger writes them', async () => {
    const hero = await player('Keeper');
    const base = Math.floor(await dbNow() / SLOT);
    const bout = await arena(hero, base - 2, { league: 'gold' });
    const old = await arena(hero, base - 3, { league: null });
    const trip = await expedition(hero, base - 4, { expeditionId: 'mountain' });
    await arena(hero, base - 5, { complete: false });
    const details = async () => (await sql`select activity_id::text, gladiator_id::text, kind, fought_at_ms::float8, reveal_at_ms::float8, league, expedition_id
      from public.result_details where gladiator_id=${hero.gid} order by activity_id`).map(row => ({ ...row }));
    const written = await details();
    // One row per settled Arena bout or expedition; the bout without an assignment (older than seven days) has no league.
    expect(written).toEqual([
      { activity_id: bout, gladiator_id: hero.gid, kind: 'arena', fought_at_ms: (base - 2) * SLOT + 60 * MINUTE, reveal_at_ms: (base - 1) * SLOT, league: 'gold', expedition_id: null },
      { activity_id: old, gladiator_id: hero.gid, kind: 'arena', fought_at_ms: (base - 3) * SLOT + 60 * MINUTE, reveal_at_ms: (base - 2) * SLOT, league: null, expedition_id: null },
      { activity_id: trip, gladiator_id: hero.gid, kind: 'expedition', fought_at_ms: (base - 4) * SLOT, reveal_at_ms: (base - 3) * SLOT, league: null, expedition_id: 'mountain' },
    ].sort((a, b) => (a.activity_id < b.activity_id ? -1 : 1)));
    // Training, Rest and tournaments get none (a tournament reads its public tables); a summary-less (bot) completion gets none.
    const quiet = randomUUID();
    await sql`insert into public.activities(id,gladiator_id,slot_index,starts_at_ms,ends_at_ms,requested,resolved_kind,status,published_at_ms,settled_at_ms)
      values(${quiet},${hero.gid},${base - 9},${(base - 9) * SLOT},${(base - 8) * SLOT},'{"kind":"arena"}','arena','completed',0,${(base - 8) * SLOT})`;
    expect(await details()).toEqual(written);
    // Immutable: no update, even by the operator; no client writes; the backend only inserts (the trigger, as service_role).
    await expect(sql`update public.result_details set league='bronze' where activity_id=${bout}`).rejects.toThrow('immutable result_details');
    for (const client of [anonymous, hero.client]) {
      expect((await client.from('result_details').insert({ activity_id: randomUUID(), gladiator_id: hero.gid, kind: 'arena', fought_at_ms: 0, reveal_at_ms: 0 })).error).not.toBeNull();
      await client.from('result_details').delete().eq('activity_id', bout);
    }
    expect(await details()).toEqual(written);
    // A second completion of the same activity (a replayed settlement) changes nothing.
    await sql`update public.activities set status='completed' where id=${bout}`;
    expect(await details()).toEqual(written);
    // The backfill (SQL31 re-applied in a transaction that rolls back): with the rows gone and the old bout's stage cleaned up, it
    // writes the same rows (the old bout's fought time from its slot's minute 60), and nothing for the activity still under way.
    const source = readFileSync(new URL('../../supabase/sql/31-history-sellers.sql', import.meta.url), 'utf8');
    const open = source.indexOf('\nbegin;\n'), close = source.lastIndexOf('\ncommit;\n');
    expect(open > 0 && close > open).toBe(true);
    const ROLLBACK = new Error('rollback-only');
    let replayed: unknown;
    try {
      await sql.begin(async tx => {
        await tx`delete from public.result_details where gladiator_id=${hero.gid}`;
        await tx`delete from public.activity_stages where activity_id=${old}`;
        await tx.unsafe(source.slice(open + '\nbegin;\n'.length, close + 1));
        replayed = (await tx`select activity_id::text, gladiator_id::text, kind, fought_at_ms::float8, reveal_at_ms::float8, league, expedition_id
          from public.result_details where gladiator_id=${hero.gid} order by activity_id`).map(row => ({ ...row }));
        throw ROLLBACK;
      });
    } catch (error) { if (error !== ROLLBACK) throw error; }
    expect(replayed).toEqual(written);
    expect(await details()).toEqual(written);
    // The details go with their activity (the 90-day pass deletes completed activities).
    await sql`delete from public.activity_stages where activity_id=${bout}`;
    await sql`delete from private.arena_assignment_sides where activity_id=${bout}`;
    await sql`delete from public.activities where id=${bout}`;
    expect((await details()).map(r => r.activity_id)).not.toContain(bout);
  });

  it('lets anyone watch any kept replay by its activity: the fights and the result, never the rewards', async () => {
    const hero = await player('Watched'), rival = await player('Watcher'), spectator = await account();
    const base = Math.floor(await dbNow() / SLOT);
    const bout = await arena(hero, base - 2, { opponent: { gladiatorId: rival.gid, name: rival.name } });
    const trip = await expedition(hero, base - 3);
    await sql`insert into public.activity_stages(activity_id,ordinal,reveal_at_ms,stage) values(${trip},0,${(base - 3) * SLOT},${sql.json({ id: `${trip}:0`, kind: 'depart',
      revealedAtMs: (base - 3) * SLOT, startedAtMs: (base - 3) * SLOT, endsAtMs: (base - 3) * SLOT + 20 * MINUTE, label: 'Depart for Pinewood Run' })})`;
    for (const [activity, kind] of [[bout, 'arena'], [trip, 'expedition']] as const) {
      for (const [who, client, ownerSummary] of [['visitor', anonymous, false], ['spectator', spectator.client, true], ['rival', rival.client, true]] as const) {
        const watched = await readTimeline(client, activity, { ownerSummary });
        expect(watched.stages.length, `${who} ${kind}`).toBeGreaterThan(0);
        expect(watched.completion, `${who} ${kind}`).toMatchObject({ activityId: activity, resolvedKind: kind, replayExpiry: { state: 'available' } });
        expect(watched.summary, `${who} ${kind}`).toBeUndefined();
        expect(JSON.stringify(watched), `${who} ${kind}`).not.toMatch(SECRET);
      }
      // The owner alone reads its own rewards with its timeline.
      expect((await readTimeline(hero.client, activity, { ownerSummary: true })).summary).toMatchObject({ rewards: REWARDS });
    }
  });
});
