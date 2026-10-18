import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { sql, admin, account, anonymous, resetIdentity, creation } from '../fixtures/db.ts';
import { createDatabase, createWorkerDatabase } from '../../supabase/functions/_shared/backend/database.ts';
import { DEFAULT_EXECUTORS, prepareActivityV1 } from '../../supabase/functions/_shared/backend/jobs.ts';
import { slotAt } from '../../supabase/functions/_shared/domain/clock.ts';
import { RULES_V1 } from '../../supabase/functions/_shared/domain/rules-v1.ts';
import { seasonAt } from '../../supabase/functions/_shared/domain/season.ts';
import { readProfile, readSeasons, readStandings } from '../../src/lib/api/reads.ts';
import { isTournamentSlot, tournamentOutcomes } from '../../supabase/functions/_shared/domain/tournament.ts';
import type { TournamentGraph } from '../../supabase/functions/_shared/domain/tournament.ts';
import type { JobLease, PreparationInput } from '../../supabase/functions/_shared/domain/types.ts';

// Task 21.1: closing a season in the database. Each test of the first block seeds a season's private rating rows by SQL for
// real characters and calls private.close_season(season, now) directly as the database owner. Task 21.2 (the second block)
// closes seasons through real slot boundaries: phase 2, private.boundary_close_season.
const commands = createDatabase(admin);
const MAX = Number.MAX_SAFE_INTEGER;
const SEASON_MS = RULES_V1.seasons.durationMs;
const PLACES = RULES_V1.seasons.placements;
const LEAGUES = ['bronze', 'silver', 'gold', 'champion'] as const;
type League = typeof LEAGUES[number];

beforeEach(() => resetIdentity());
afterAll(() => sql.end());

/** Real creation through the command database. The trusted local operator then seeds rating rows by SQL. */
async function fighter() {
  const owner = await account(), name = 'Season ' + randomUUID().slice(0, 8);
  const created = await commands.createGladiator({ userId: owner.id }, creation(name));
  if (!created.ok) throw Error('creation failed');
  return { ...owner, name, gid: created.value.gladiatorId };
}
type Fighter = Awaited<ReturnType<typeof fighter>>;
/** `count` characters in gladiator id order, so tie-breaks on the identifier are known in advance. */
const fighters = async (count: number) =>
  (await Promise.all(Array.from({ length: count }, () => fighter()))).sort((p, q) => (p.gid < q.gid ? -1 : 1));

type Counters = { rating?: number; wins?: number; losses?: number };
async function rate(f: Fighter, league: League, counters: Counters = {}, season = 0) {
  await sql`insert into private.arena_ratings(gladiator_id,league,season_index,rating,human_wins,human_losses)
    values(${f.gid},${league},${season},${counters.rating ?? 1000},${counters.wins ?? 0},${counters.losses ?? 0})`;
}
/** A season row with seasonAt's launch-epoch-0 bounds (504 slots of 80 minutes), as boundary phase 2 writes it. */
async function openSeason(index = 0) {
  const season = seasonAt(index * RULES_V1.seasons.durationSlots, 0);
  await sql`insert into public.seasons(season_index,starts_at_ms,ends_at_ms) values(${season.index},${season.startsAtMs},${season.endsAtMs})`;
}
async function close(season = 0, now = Date.now()): Promise<number> {
  return (await sql`select private.close_season(${season},${now}) as awards`)[0].awards;
}

type ArchiveRow = { league: League; rank: number; gid: string; name: string; rating: number; wins: number; losses: number;
  promoted: boolean; inactive: boolean; eligible: boolean; place: number | null };
async function archive(season = 0): Promise<ArchiveRow[]> {
  return (await sql`select league, rank::int as rank, gladiator_id::text as gid, name, rating::int as rating, human_wins::int as wins,
    human_losses::int as losses, promoted, inactive, reward_eligible as eligible, award_place as place
    from public.season_standings where season_index=${season}
    order by array_position(array['bronze','silver','gold','champion'],league), rank`).map(r => ({ ...r }) as ArchiveRow);
}
/** One expected archive row; flags default to false and the place to none. */
function entry(league: League, rank: number, f: Fighter, counters: Required<Counters>,
  flags: { promoted?: boolean; inactive?: boolean; eligible?: boolean; place?: number } = {}): ArchiveRow {
  return { league, rank, gid: f.gid, name: f.name, rating: counters.rating, wins: counters.wins, losses: counters.losses,
    promoted: flags.promoted ?? false, inactive: flags.inactive ?? false, eligible: flags.eligible ?? false, place: flags.place ?? null };
}
/** Award places by league, from the archive. */
async function places(season = 0) {
  return (await archive(season)).filter(r => r.place !== null).map(r => [r.league, r.place, r.gid]);
}
async function awards(season = 0) {
  return (await sql`select gladiator_id::text as gid, league, place, money::int as money, renown::int as renown, title, badge,
    receipt_id::text as receipt, awarded_at_ms::float8 as at from private.season_awards where season_index=${season}
    order by array_position(array['bronze','silver','gold','champion'],league), place`).map(r => ({ ...r }));
}
/** Read as text: a float8 read can round the wallet maximum 9,007,199,254,740,991. */
async function walletOf(f: Fighter) {
  const [w] = await sql`select money::text as money, renown::text as renown from public.wallets where gladiator_id=${f.gid}`;
  return { money: Number(w.money), renown: Number(w.renown) };
}
const receiptsOf = async (f: Fighter) => (await sql`select owner_id::text as owner, gladiator_id::text as gid, request,
  encode(request_digest,'hex') as digest, result, receipt_id::text as receipt from public.operation_receipts
  where gladiator_id=${f.gid} and request->>'kind'='season-award'`).map(r => ({ ...r }));
const ledgerOf = async (f: Fighter) => (await sql`select money_delta::int as money, renown_delta::int as renown, reason,
  receipt_id::text as receipt from public.wallet_ledger where gladiator_id=${f.gid} and reason='season'`).map(r => ({ ...r }));
const prestigeOf = async (f: Fighter) => (await sql`select prestige from public.public_profiles where gladiator_id=${f.gid}`)[0].prestige;
const digest = (season: number, f: Fighter) => createHash('sha256').update(`season:${season}:${f.gid}`).digest('hex');
/** Five human bouts: the qualifying minimum. */
const QUALIFIED = { wins: 3, losses: 2 };

describe('closing a season', () => {
  it('season_rules matches RULES_V1.seasons', async () => {
    const [{ rules, volatility }] = await sql`select private.season_rules() as rules, p.provolatile as volatility
      from pg_proc p where p.oid='private.season_rules()'::regprocedure`;
    expect(rules).toEqual({ minimumHumanBouts: RULES_V1.seasons.minimumHumanBouts, placements: RULES_V1.seasons.placements });
    expect(volatility).toBe('i');
  });

  it('archives every league ranked by rating, human wins, fewer losses, then gladiator id', async () => {
    const f = await fighters(10);
    // Bronze ties: five rows at 1050, four of them with two wins, two of those with one loss (decided by gladiator id).
    const bronze: [Fighter, Required<Counters>][] = [[f[3], { rating: 1100, wins: 3, losses: 0 }], [f[5], { rating: 1050, wins: 4, losses: 3 }],
      [f[4], { rating: 1050, wins: 2, losses: 0 }], [f[0], { rating: 1050, wins: 2, losses: 1 }], [f[2], { rating: 1050, wins: 2, losses: 1 }],
      [f[1], { rating: 1050, wins: 2, losses: 2 }], [f[6], { rating: 900, wins: 9, losses: 0 }]];
    // Inserted out of order, so the archive order comes from the ranking alone.
    for (const [x, counters] of [...bronze].reverse()) await rate(x, 'bronze', counters);
    await rate(f[7], 'silver', { rating: 1000, wins: 0, losses: 0 });
    await rate(f[8], 'gold', { rating: 1000, wins: 1, losses: 0 });
    await rate(f[9], 'champion', { rating: 1000, wins: 0, losses: 1 });
    // A later season's row is not part of season 0.
    await rate(f[3], 'bronze', { rating: 1300, wins: 5, losses: 0 }, 1);
    await openSeason(0);
    await openSeason(1);
    const now = Date.now();
    expect(await close(0, now)).toBe(2);
    expect(await archive(0)).toEqual([
      entry('bronze', 1, f[3], bronze[0][1]),
      entry('bronze', 2, f[5], bronze[1][1], { eligible: true, place: 1 }),
      entry('bronze', 3, f[4], bronze[2][1]),
      entry('bronze', 4, f[0], bronze[3][1]),
      entry('bronze', 5, f[2], bronze[4][1]),
      entry('bronze', 6, f[1], bronze[5][1]),
      entry('bronze', 7, f[6], bronze[6][1], { eligible: true, place: 2 }),
      entry('silver', 1, f[7], { rating: 1000, wins: 0, losses: 0 }, { inactive: true }),
      entry('gold', 1, f[8], { rating: 1000, wins: 1, losses: 0 }),
      entry('champion', 1, f[9], { rating: 1000, wins: 0, losses: 1 })]);
    // Only season 0 closed, at the given time; season 1 has no archive yet.
    expect(await archive(1)).toEqual([]);
    expect((await sql`select season_index::int as season, closed_at_ms::float8 as closed from public.seasons order by season_index`)
      .map(r => ({ ...r }))).toEqual([{ season: 0, closed: now }, { season: 1, closed: null }]);
  });

  it('pays 500/100 + champion + gold, 300/60 + silver, 200/40 + bronze once, with receipts and season ledger rows', async () => {
    const [a, b, c, d] = await fighters(4);
    const ranked = [[b, 1300], [d, 1200], [a, 1100], [c, 1000]] as const;
    for (const [x, rating] of ranked) await rate(x, 'bronze', { rating, ...QUALIFIED });
    await openSeason();
    const before = await Promise.all(ranked.map(([x]) => walletOf(x)));
    const now = Date.now();
    expect(PLACES.map(p => [p.money, p.renown, p.title, p.badge])).toEqual([[500, 100, 'champion', 'gold'], [300, 60, null, 'silver'], [200, 40, null, 'bronze']]);
    expect(await close(0, now)).toBe(3);
    const expectedAwards: Record<string, unknown>[] = [];
    for (const [i, [x]] of ranked.slice(0, 3).entries()) {
      const p = PLACES[i], place = i + 1;
      expect(await walletOf(x)).toEqual({ money: before[i].money + p.money, renown: before[i].renown + p.renown });
      const receipts = await receiptsOf(x);
      expect(receipts).toEqual([{ owner: x.id, gid: x.gid, request: { kind: 'season-award', seasonIndex: 0, league: 'bronze', place },
        digest: digest(0, x), result: { seasonIndex: 0, league: 'bronze', place, money: p.money, renown: p.renown, title: p.title, badge: p.badge },
        receipt: expect.any(String) }]);
      expect(await ledgerOf(x)).toEqual([{ money: p.money, renown: p.renown, reason: 'season', receipt: receipts[0].receipt }]);
      expectedAwards.push({ gid: x.gid, league: 'bronze', place, money: p.money, renown: p.renown, title: p.title, badge: p.badge,
        receipt: receipts[0].receipt, at: now });
    }
    expect(await awards()).toEqual(expectedAwards);
    // The fourth qualifier gets nothing.
    expect(await walletOf(c)).toEqual(before[3]);
    expect(await receiptsOf(c)).toEqual([]);
    expect(await ledgerOf(c)).toEqual([]);
    expect(await places()).toEqual([['bronze', 1, b.gid], ['bronze', 2, d.gid], ['bronze', 3, a.gid]]);
    // Once: closing again pays nothing.
    expect(await close(0, now + 1)).toBe(0);
    expect(await Promise.all(ranked.map(([x]) => walletOf(x)))).toEqual(
      ranked.map((_, i) => i < 3 ? { money: before[i].money + PLACES[i].money, renown: before[i].renown + PLACES[i].renown } : before[i]));
  });

  it('needs five human bouts: four never qualify, five do', async () => {
    const [four, fiveLosses, five, fourLosses] = await fighters(4);
    await rate(four, 'bronze', { rating: 2000, wins: 4, losses: 0 });
    await rate(fiveLosses, 'bronze', { rating: 1500, wins: 0, losses: 5 });
    await rate(five, 'bronze', { rating: 1100, wins: 5, losses: 0 });
    await rate(fourLosses, 'bronze', { rating: 1000, wins: 1, losses: 3 });
    await openSeason();
    expect(await close()).toBe(2);
    expect(await archive()).toEqual([
      entry('bronze', 1, four, { rating: 2000, wins: 4, losses: 0 }),
      entry('bronze', 2, fiveLosses, { rating: 1500, wins: 0, losses: 5 }, { eligible: true, place: 1 }),
      entry('bronze', 3, five, { rating: 1100, wins: 5, losses: 0 }, { eligible: true, place: 2 }),
      entry('bronze', 4, fourLosses, { rating: 1000, wins: 1, losses: 3 })]);
    expect(await receiptsOf(four)).toEqual([]);
  });

  it('rewards a promoted gladiator only in the highest qualifying league and moves the lower league medals down', async () => {
    const [p, q, b1, b2, b3, s1] = await fighters(6);
    // p qualifies in Bronze and in Silver; q was promoted too but has only four Silver bouts, so Bronze is its highest.
    await rate(p, 'bronze', { rating: 1500, ...QUALIFIED });
    await rate(p, 'silver', { rating: 1200, ...QUALIFIED });
    await rate(q, 'bronze', { rating: 1250, wins: 5, losses: 0 });
    await rate(q, 'silver', { rating: 1000, wins: 2, losses: 2 });
    for (const [x, rating] of [[b1, 1400], [b2, 1300], [b3, 1200]] as const) await rate(x, 'bronze', { rating, ...QUALIFIED });
    await rate(s1, 'silver', { rating: 1100, ...QUALIFIED });
    await openSeason();
    expect(await close()).toBe(5);
    expect(await archive()).toEqual([
      entry('bronze', 1, p, { rating: 1500, ...QUALIFIED }, { promoted: true }),
      entry('bronze', 2, b1, { rating: 1400, ...QUALIFIED }, { eligible: true, place: 1 }),
      entry('bronze', 3, b2, { rating: 1300, ...QUALIFIED }, { eligible: true, place: 2 }),
      entry('bronze', 4, q, { rating: 1250, wins: 5, losses: 0 }, { promoted: true, eligible: true, place: 3 }),
      entry('bronze', 5, b3, { rating: 1200, ...QUALIFIED }, { eligible: true }),
      entry('silver', 1, p, { rating: 1200, ...QUALIFIED }, { eligible: true, place: 1 }),
      entry('silver', 2, s1, { rating: 1100, ...QUALIFIED }, { eligible: true, place: 2 }),
      entry('silver', 3, q, { rating: 1000, wins: 2, losses: 2 })]);
    // One award per character and season, in its highest qualifying league.
    expect((await awards()).map(a => [a.league, a.place, a.gid])).toEqual([['bronze', 1, b1.gid], ['bronze', 2, b2.gid], ['bronze', 3, q.gid],
      ['silver', 1, p.gid], ['silver', 2, s1.gid]]);
    expect((await receiptsOf(p)).map(r => r.result)).toEqual([{ seasonIndex: 0, league: 'silver', place: 1, money: 500, renown: 100,
      title: 'champion', badge: 'gold' }]);
    expect(await receiptsOf(b3)).toEqual([]);
  });

  it('gives nothing to a promoted gladiator placing fourth in the higher league', async () => {
    const [p, s1, s2, s3, b1, b2, b3] = await fighters(7);
    await rate(p, 'bronze', { rating: 1600, ...QUALIFIED });
    await rate(p, 'silver', { rating: 1200, ...QUALIFIED });
    for (const [x, rating] of [[s1, 1500], [s2, 1400], [s3, 1300]] as const) await rate(x, 'silver', { rating, ...QUALIFIED });
    for (const [x, rating] of [[b1, 1100], [b2, 1000], [b3, 900]] as const) await rate(x, 'bronze', { rating, ...QUALIFIED });
    await openSeason();
    const wallet = await walletOf(p);
    expect(await close()).toBe(6);
    expect(await places()).toEqual([['bronze', 1, b1.gid], ['bronze', 2, b2.gid], ['bronze', 3, b3.gid],
      ['silver', 1, s1.gid], ['silver', 2, s2.gid], ['silver', 3, s3.gid]]);
    expect((await archive()).filter(r => r.gid === p.gid)).toEqual([
      entry('bronze', 1, p, { rating: 1600, ...QUALIFIED }, { promoted: true }),
      entry('silver', 4, p, { rating: 1200, ...QUALIFIED }, { eligible: true })]);
    expect(await walletOf(p)).toEqual(wallet);
    expect(await receiptsOf(p)).toEqual([]);
    expect(await ledgerOf(p)).toEqual([]);
    expect((await awards()).filter(a => a.gid === p.gid)).toEqual([]);
    expect(await prestigeOf(p)).toEqual([]);
  });

  it('awards only the existing places when fewer than three qualify', async () => {
    const [a, b, c, d, e, f] = await fighters(6);
    await rate(a, 'bronze', { rating: 1100, ...QUALIFIED });
    await rate(b, 'bronze', { rating: 1050, ...QUALIFIED });
    await rate(c, 'bronze', { rating: 1200, wins: 4, losses: 0 });
    await rate(d, 'bronze');
    await rate(e, 'gold', { rating: 1000, wins: 2, losses: 1 });
    await rate(f, 'champion', { rating: 900, wins: 1, losses: 5 });
    await openSeason();
    expect(await close()).toBe(3);
    expect(await places()).toEqual([['bronze', 1, a.gid], ['bronze', 2, b.gid], ['champion', 1, f.gid]]);
    expect((await awards()).map(x => [x.league, x.place, x.badge, x.title])).toEqual([['bronze', 1, 'gold', 'champion'], ['bronze', 2, 'silver', null],
      ['champion', 1, 'gold', 'champion']]);
  });

  it('marks promoted and inactive rows in the archive', async () => {
    const [p, q, r] = await fighters(3);
    // p climbed twice this season: Bronze, then Silver (without a human bout), then Gold.
    await rate(p, 'bronze', { rating: 1040, wins: 2, losses: 0 });
    await rate(p, 'silver', { rating: 1000, wins: 0, losses: 0 });
    await rate(p, 'gold', { rating: 1100, wins: 3, losses: 2 });
    await rate(q, 'bronze', { rating: 1000, wins: 0, losses: 0 });
    await rate(r, 'silver', { rating: 1050, wins: 1, losses: 0 });
    await openSeason();
    expect(await close()).toBe(1);
    expect(await archive()).toEqual([
      entry('bronze', 1, p, { rating: 1040, wins: 2, losses: 0 }, { promoted: true }),
      entry('bronze', 2, q, { rating: 1000, wins: 0, losses: 0 }, { inactive: true }),
      entry('silver', 1, r, { rating: 1050, wins: 1, losses: 0 }),
      entry('silver', 2, p, { rating: 1000, wins: 0, losses: 0 }, { promoted: true, inactive: true }),
      entry('gold', 1, p, { rating: 1100, wins: 3, losses: 2 }, { eligible: true, place: 1 })]);
  });

  it('returns 0 on a second close with no new rows, receipts or credits', async () => {
    const all = await fighters(6);
    for (const [i, x] of all.slice(0, 4).entries()) await rate(x, 'bronze', { rating: 1000 + i * 10, ...QUALIFIED });
    await rate(all[4], 'silver', { rating: 1000, ...QUALIFIED });
    await openSeason();
    const snapshot = async () => ({
      archive: await archive(),
      awards: await awards(),
      receipts: (await sql`select receipt_id::text, owner_id::text, request, result from public.operation_receipts order by receipt_id`).map(r => ({ ...r })),
      ledger: (await sql`select receipt_id::text, money_delta::text, renown_delta::text, reason from public.wallet_ledger order by receipt_id`).map(r => ({ ...r })),
      wallets: (await sql`select gladiator_id::text, money::text, renown::text from public.wallets order by gladiator_id`).map(r => ({ ...r })),
      seasons: (await sql`select season_index::int, closed_at_ms::float8 from public.seasons`).map(r => ({ ...r })),
      prestige: (await sql`select gladiator_id::text, prestige from public.public_profiles order by gladiator_id`).map(r => ({ ...r })),
    });
    const now = Date.now();
    expect(await close(0, now)).toBe(4);
    const first = await snapshot();
    expect(first.awards).toHaveLength(4);
    // A rating row written into the closed season afterwards is not archived or paid by a later close either.
    await rate(all[5], 'bronze', { rating: 5000, wins: 9, losses: 0 });
    expect(await close(0, now + 60_000)).toBe(0);
    expect(await snapshot()).toEqual(first);
    expect(first.seasons).toEqual([{ season_index: 0, closed_at_ms: now }]);
  });

  it('credits only up to the wallet cap and records the credited amount', async () => {
    const [a, b, c] = await fighters(3);
    await rate(a, 'bronze', { rating: 1200, ...QUALIFIED });
    await rate(b, 'bronze', { rating: 1100, ...QUALIFIED });
    await rate(c, 'bronze', { rating: 1000, ...QUALIFIED });
    await sql`update public.wallets set money=${String(MAX - 200)},renown=${String(MAX - 30)} where gladiator_id=${a.gid}`;
    await sql`update public.wallets set money=${String(MAX)},renown=0 where gladiator_id=${b.gid}`;
    await sql`update public.wallets set money=0,renown=0 where gladiator_id=${c.gid}`;
    await openSeason();
    expect(await close()).toBe(3);
    const credited = [[a, 200, 30], [b, 0, 60], [c, 200, 40]] as const;
    expect(await Promise.all(credited.map(([x]) => walletOf(x)))).toEqual([{ money: MAX, renown: MAX }, { money: MAX, renown: 60 }, { money: 200, renown: 40 }]);
    for (const [i, [x, money, renown]] of credited.entries()) {
      expect(await ledgerOf(x), x.name).toEqual([{ money, renown, reason: 'season', receipt: expect.any(String) }]);
      expect((await receiptsOf(x))[0].result, x.name).toMatchObject({ place: i + 1, money, renown });
    }
    expect((await awards()).map(x => [x.gid, x.money, x.renown])).toEqual(credited.map(([x, money, renown]) => [x.gid, money, renown]));
  });

  it('keeps XP, items, money and renown other than the award unchanged', async () => {
    const [winner, bystander] = await fighters(2);
    await sql`update public.gladiators set xp=4321 where id=${winner.gid}`;
    await sql`update public.wallets set money=777,renown=33 where gladiator_id=${winner.gid}`;
    await rate(winner, 'bronze', { rating: 1100, ...QUALIFIED });
    await rate(bystander, 'bronze', { rating: 1000, wins: 1, losses: 0 });
    await openSeason();
    const state = async (x: Fighter) => ({
      gladiator: (await sql`select to_jsonb(g) as row from public.gladiators g where id=${x.gid}`)[0].row,
      build: (await sql`select to_jsonb(b) as row from public.builds b where gladiator_id=${x.gid}`)[0].row,
      items: (await sql`select item from public.item_instances where gladiator_id=${x.gid} order by id`).map(r => r.item),
      ratings: (await sql`select to_jsonb(r) as row from private.arena_ratings r where gladiator_id=${x.gid} order by league`).map(r => r.row),
      wallet: await walletOf(x),
    });
    const before = { winner: await state(winner), bystander: await state(bystander) };
    expect(before.winner.items.length).toBeGreaterThan(0);
    expect(await close()).toBe(1);
    expect(await state(winner)).toEqual({ ...before.winner, wallet: { money: 777 + 500, renown: 33 + 100 } });
    expect(await state(bystander)).toEqual(before.bystander);
  });

  it('projects prestige into public_profiles and keeps earlier seasons when a later one adds a badge', async () => {
    const [a, b, c] = await fighters(3);
    await rate(b, 'bronze', { rating: 1200, ...QUALIFIED });
    await rate(a, 'bronze', { rating: 1100, ...QUALIFIED });
    await rate(c, 'bronze', { rating: 1000, wins: 1, losses: 0 });
    await openSeason(0);
    expect(await close(0)).toBe(2);
    const seasonZero = { seasonIndex: 0, league: 'bronze', place: 2, badge: 'silver', title: null };
    expect(await prestigeOf(a)).toEqual([seasonZero]);
    expect(await prestigeOf(b)).toEqual([{ seasonIndex: 0, league: 'bronze', place: 1, badge: 'gold', title: 'champion' }]);
    expect(await prestigeOf(c)).toEqual([]);
    // Season 1: a wins Silver. Its season 0 badge stays, in season order.
    await rate(a, 'silver', { rating: 1000, ...QUALIFIED }, 1);
    await openSeason(1);
    expect(await close(1)).toBe(1);
    const both = [seasonZero, { seasonIndex: 1, league: 'silver', place: 1, badge: 'gold', title: 'champion' }];
    expect(await prestigeOf(a)).toEqual(both);
    expect(await prestigeOf(b)).toEqual([{ seasonIndex: 0, league: 'bronze', place: 1, badge: 'gold', title: 'champion' }]);
    // Visitors see it on the public profile.
    const { data, error } = await anonymous.from('public_profile_reads').select('profile').eq('gladiator_id', a.gid);
    expect(error).toBeNull();
    expect(data![0].profile.prestige).toEqual(both);
  });

  it('refuses updates of a closed season rating row and of the archive and awards', async () => {
    const [a] = await fighters(1);
    await rate(a, 'bronze', { rating: 1100, ...QUALIFIED });
    await rate(a, 'silver', { rating: 1000 }, 1);
    await openSeason(0);
    await openSeason(1);
    // Open seasons still credit their rows.
    await sql`update private.arena_ratings set rating=1110 where gladiator_id=${a.gid} and season_index=0`;
    expect(await close(0)).toBe(1);
    await expect(sql`update private.arena_ratings set rating=2000 where gladiator_id=${a.gid} and season_index=0`).rejects.toThrow('immutable arena rating');
    await expect(sql`update private.arena_ratings set human_wins=human_wins+1 where gladiator_id=${a.gid} and season_index=0`)
      .rejects.toThrow('immutable arena rating');
    await sql`update private.arena_ratings set rating=1010,human_wins=1 where gladiator_id=${a.gid} and season_index=1`;
    await expect(sql`update public.season_standings set rating=1 where gladiator_id=${a.gid}`).rejects.toThrow('immutable season_standings');
    await expect(sql`delete from public.season_standings where gladiator_id=${a.gid}`).rejects.toThrow('immutable season_standings');
    await expect(sql`update private.season_awards set money=0 where gladiator_id=${a.gid}`).rejects.toThrow('immutable season_awards');
    await expect(sql`delete from private.season_awards where gladiator_id=${a.gid}`).rejects.toThrow('immutable season_awards');
    // A season row: bounds fixed, never deleted, closed at most once and never reopened.
    await expect(sql`update public.seasons set closed_at_ms=closed_at_ms+1 where season_index=0`).rejects.toThrow('immutable season');
    await expect(sql`update public.seasons set closed_at_ms=null where season_index=0`).rejects.toThrow('immutable season');
    await expect(sql`update public.seasons set starts_at_ms=1,ends_at_ms=${SEASON_MS + 1} where season_index=1`).rejects.toThrow('immutable season');
    // The bounds clause alone: a valid first close (null → value) that also moves the bounds is still refused.
    await expect(sql`update public.seasons set closed_at_ms=1,starts_at_ms=1,ends_at_ms=${SEASON_MS + 1} where season_index=1`)
      .rejects.toThrow('immutable season');
    await expect(sql`delete from public.seasons where season_index=1`).rejects.toThrow('immutable season');
    await sql`update public.seasons set closed_at_ms=1 where season_index=1`;
    await expect(sql`update public.seasons set closed_at_ms=2 where season_index=1`).rejects.toThrow('immutable season');
    await expect(sql`insert into public.seasons(season_index,starts_at_ms,ends_at_ms) values(2,0,1)`).rejects.toThrow(/check constraint/);
    expect((await archive(0)).map(r => r.rating)).toEqual([1110]);
  });

  it('marks reward_eligible in the live view with the highest-league rule', async () => {
    const [a, b, c, d, e, f] = await fighters(6);
    await rate(a, 'bronze', QUALIFIED);                       // qualifies, nothing higher
    await rate(b, 'bronze', { wins: 4, losses: 0 });          // four bouts
    await rate(c, 'bronze', QUALIFIED);                       // qualifies, but also in Silver
    await rate(c, 'silver', QUALIFIED);
    await rate(d, 'bronze', QUALIFIED);                       // qualifies; Silver has only four bouts
    await rate(d, 'silver', { wins: 2, losses: 2 });
    await rate(e, 'bronze');                                  // inactive
    await rate(f, 'bronze', QUALIFIED);                       // a higher league in another season does not count
    await rate(f, 'silver', QUALIFIED, 1);
    type Row = { gid: string; league: string; eligible: boolean };
    const sorted = (rows: Row[]) => [...rows].sort((p, q) => (p.gid + p.league < q.gid + q.league ? -1 : 1));
    const expected = sorted(([[a, 'bronze', true], [b, 'bronze', false], [c, 'bronze', false], [c, 'silver', true], [d, 'bronze', true],
      [d, 'silver', false], [e, 'bronze', false], [f, 'bronze', true]] as const).map(([x, league, eligible]) => ({ gid: x.gid, league, eligible })));
    const rows = await sql`select gladiator_id::text as gid, league, reward_eligible as eligible from public.arena_standing_reads where season_index=0`;
    expect(sorted(rows.map(r => ({ ...r }) as Row))).toEqual(expected);
    expect((await sql`select column_name from information_schema.columns where table_schema='public' and table_name='arena_standing_reads'
      order by ordinal_position desc limit 1`)[0].column_name).toBe('reward_eligible');
    // Visitors read the same column.
    const { data, error } = await anonymous.from('arena_standing_reads').select('gladiator_id,league,reward_eligible').eq('season_index', 0);
    expect(error).toBeNull();
    expect(sorted(data!.map(r => ({ gid: r.gladiator_id, league: r.league, eligible: r.reward_eligible })))).toEqual(expected);
  });

  it('serves seasons and season_standings to visitors read-only and hides season_awards and close_season', async () => {
    const [a] = await fighters(1);
    const player = await account();
    await rate(a, 'bronze', { rating: 1100, ...QUALIFIED });
    await openSeason(0);
    await openSeason(1);
    const now = Date.now();
    expect(await close(0, now)).toBe(1);
    for (const client of [anonymous, player.client]) {
      const seasons = await client.from('seasons').select('season_index,starts_at_ms,ends_at_ms,closed_at_ms').order('season_index');
      expect(seasons.error).toBeNull();
      expect(seasons.data).toEqual([{ season_index: 0, starts_at_ms: 0, ends_at_ms: SEASON_MS, closed_at_ms: now },
        { season_index: 1, starts_at_ms: SEASON_MS, ends_at_ms: 2 * SEASON_MS, closed_at_ms: null }]);
      const standings = await client.from('season_standings').select('league,rank,gladiator_id,name,award_place').eq('season_index', 0);
      expect(standings.error).toBeNull();
      expect(standings.data).toEqual([{ league: 'bronze', rank: 1, gladiator_id: a.gid, name: a.name, award_place: 1 }]);
      // Read-only.
      expect((await client.from('seasons').insert({ season_index: 7, starts_at_ms: 0, ends_at_ms: SEASON_MS })).error).not.toBeNull();
      expect((await client.from('seasons').update({ closed_at_ms: null }).eq('season_index', 0)).error).not.toBeNull();
      expect((await client.from('seasons').delete().eq('season_index', 1)).error).not.toBeNull();
      expect((await client.from('season_standings').update({ award_place: 3 }).eq('gladiator_id', a.gid)).error).not.toBeNull();
      expect((await client.from('season_standings').delete().eq('gladiator_id', a.gid)).error).not.toBeNull();
      expect((await client.from('season_standings').insert({ season_index: 1, league: 'gold', rank: 1, gladiator_id: a.gid, name: 'Forged',
        rating: 1, human_wins: 0, human_losses: 0, promoted: false, inactive: true, reward_eligible: false })).error).not.toBeNull();
      // Exposure checks only, not privilege proof: the Data API serves only the public schema (supabase/config.toml), and no
      // public close_season exists. The catalog checks below carry the privilege proof.
      expect((await client.schema('private').from('season_awards').select('*')).error).not.toBeNull();
      expect((await client.rpc('close_season', { season: 1, now_ms: now })).error).not.toBeNull();
      expect((await client.schema('private').rpc('close_season', { season: 1, now_ms: now })).error).not.toBeNull();
    }
    expect((await sql`select closed_at_ms from public.seasons where season_index=1`)[0].closed_at_ms).toBeNull();
    expect((await sql`select count(*)::int as n from public.season_standings`)[0].n).toBe(1);
    // Privileges: clients read seasons and the archive only, and nothing of the awards or the functions. The backend (the
    // boundary worker) holds exactly the DML the close needs; the guards refuse any update or delete of the archive and awards.
    const tables = await sql`select c.oid::regclass::text as name, c.relrowsecurity as rls,
      has_table_privilege('anon',c.oid,'SELECT') as anon, has_table_privilege('authenticated',c.oid,'SELECT') as player,
      has_table_privilege('anon',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE') or has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE') as write,
      array(select x.p from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) with ordinality x(p,i)
        where has_table_privilege('service_role',c.oid,x.p) order by x.i) as backend
      from pg_class c where c.oid in ('public.seasons'::regclass,'public.season_standings'::regclass,'private.season_awards'::regclass)
      order by c.oid::regclass::text collate "C"`;
    expect(tables.map(r => ({ ...r }))).toEqual([
      { name: 'private.season_awards', rls: true, anon: false, player: false, write: false, backend: ['SELECT', 'INSERT'] },
      { name: 'season_standings', rls: true, anon: true, player: true, write: false, backend: ['SELECT', 'INSERT'] },
      { name: 'seasons', rls: true, anon: true, player: true, write: false, backend: ['SELECT', 'INSERT', 'UPDATE'] }]);
    const functions = await sql`select p.proname, p.prosecdef, p.proconfig,
      has_function_privilege('anon',p.oid,'EXECUTE') as anon, has_function_privilege('authenticated',p.oid,'EXECUTE') as player,
      has_function_privilege('service_role',p.oid,'EXECUTE') as backend
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='private' and p.proname in ('season_rules','guard_season','close_season','boundary_close_season') order by p.proname`;
    expect(functions.map(r => ({ ...r }))).toEqual(['boundary_close_season', 'close_season', 'guard_season', 'season_rules'].map(proname =>
      ({ proname, prosecdef: false, proconfig: ['search_path=""'], anon: false, player: false, backend: true })));
    // Task 21.2: phase 2 writes, so it is a volatile PL/pgSQL function (Task 7's stub was stable SQL).
    expect((await sql`select l.lanname as language, p.provolatile as volatility from pg_proc p join pg_language l on l.oid=p.prolang
      where p.oid='private.boundary_close_season(bigint)'::regprocedure`).map(r => ({ ...r }))).toEqual([{ language: 'plpgsql', volatility: 'v' }]);
    // The worker coordinates boundaries as service_role, so a close must succeed in that role: archive, award, receipt,
    // ledger, wallet, the season row and (made immediate here) the deferred prestige projection. Rolled back afterwards.
    await rate(a, 'silver', { rating: 1000, ...QUALIFIED }, 1);
    const rollback = new Error('rollback');
    await expect(sql.begin(async tx => {
      await tx`set local role service_role`;
      expect((await tx`select private.close_season(1,${now + 1}) as awards`)[0].awards).toBe(1);
      await tx`set constraints all immediate`;
      expect((await tx`select count(*)::int as n from private.season_awards where season_index=1`)[0].n).toBe(1);
      expect((await tx`select closed_at_ms::float8 as closed from public.seasons where season_index=1`)[0].closed).toBe(now + 1);
      expect((await tx`select prestige from public.public_profiles where gladiator_id=${a.gid}`)[0].prestige.map((p: { seasonIndex: number }) => p.seasonIndex))
        .toEqual([0, 1]);
      throw rollback;
    })).rejects.toBe(rollback);
    expect((await sql`select closed_at_ms from public.seasons where season_index=1`)[0].closed_at_ms).toBeNull();
    expect((await sql`select count(*)::int as n from private.season_awards where season_index=1`)[0].n).toBe(0);
  });

  // Task 21.3: the client read layer against the real database, as a visitor (the anonymous client) and as a signed-in player.
  it('reads seasons, an archived season and prestige through readSeasons, readStandings and readProfile after a real close', async () => {
    const [p, b1, b2, b3, b4, idle] = await fighters(6);
    // p qualifies in Bronze (first) and Silver, so it is rewarded in Silver and Bronze's places go to b1 to b3; b4 qualifies without a place.
    await rate(p, 'bronze', { rating: 1500, ...QUALIFIED });
    await rate(p, 'silver', { rating: 1200, ...QUALIFIED });
    for (const [x, rating] of [[b1, 1400], [b2, 1300], [b3, 1200], [b4, 1100]] as const) await rate(x, 'bronze', { rating, ...QUALIFIED });
    await rate(idle, 'bronze', { rating: 1000 });
    await openSeason(0);
    await openSeason(1);
    const now = Date.now();
    expect(await close(0, now)).toBe(4);
    const player = await account();
    const [season0, season1] = [seasonAt(0, 0), seasonAt(RULES_V1.seasons.durationSlots, 0)];
    const seasons = [{ seasonId: '1', startsAtMs: season1.startsAtMs, endsAtMs: season1.endsAtMs, closedAtMs: null },
      { seasonId: '0', startsAtMs: season0.startsAtMs, endsAtMs: season0.endsAtMs, closedAtMs: now }];
    // The archive as the database holds it, in the read's row shape (50 rows or fewer per league here).
    const frozen = async (league: League) => (await archive(0)).filter(r => r.league === league).map(r => ({ rank: r.rank, gladiatorId: r.gid,
      name: r.name, rating: r.rating, humanWins: r.wins, humanLosses: r.losses, promoted: r.promoted, inactive: r.inactive,
      rewardEligible: r.eligible, awardPlace: r.place }));
    for (const client of [anonymous, player.client]) {
      expect(await readSeasons(client)).toEqual(seasons);
      // No season named: the latest, season 1, is open and has no rating rows yet.
      expect(await readStandings(client, 'bronze')).toEqual({ league: 'bronze', seasonId: '1', archived: false, rows: [], nextCursor: null });
      // The finished season: frozen ranks, flags and award places, by league.
      const bronze = await readStandings(client, 'bronze', undefined, '0');
      expect(bronze).toEqual({ league: 'bronze', seasonId: '0', archived: true, nextCursor: null, rows: await frozen('bronze') });
      expect(bronze.rows.map(r => [r.gladiatorId, r.rank, r.promoted, r.inactive, r.rewardEligible, r.awardPlace])).toEqual([
        [p.gid, 1, true, false, false, null], [b1.gid, 2, false, false, true, 1], [b2.gid, 3, false, false, true, 2], [b3.gid, 4, false, false, true, 3],
        [b4.gid, 5, false, false, true, null], [idle.gid, 6, false, true, false, null]]);
      expect(await readStandings(client, 'silver', undefined, '0')).toEqual({ league: 'silver', seasonId: '0', archived: true, nextCursor: null, rows: await frozen('silver') });
      expect((await readStandings(client, 'silver', undefined, '0')).rows).toMatchObject([{ gladiatorId: p.gid, rank: 1, rewardEligible: true, awardPlace: 1 }]);
      expect((await readStandings(client, 'gold', undefined, '0')).rows).toEqual([]);
      // A cursor stays in its season and starts after its rank; it wins over another season id.
      expect(await readStandings(client, 'bronze', '0:2', '1')).toEqual({ league: 'bronze', seasonId: '0', archived: true, nextCursor: null, rows: (await frozen('bronze')).slice(2) });
      // An unknown season is unavailable; a closed season is read-only data, so the same read repeats exactly.
      await expect(readStandings(client, 'bronze', undefined, '5')).rejects.toMatchObject({ code: 'unavailable' });
      expect(await readStandings(client, 'bronze', undefined, '0')).toEqual(bronze);
      // The award's prestige on its public profile; a gladiator with no award has none.
      expect((await readProfile(client, p.gid)).prestige).toEqual([{ seasonId: '0', league: 'silver', place: 1, badge: 'gold', title: 'champion' }]);
      expect((await readProfile(client, b3.gid)).prestige).toEqual([{ seasonId: '0', league: 'bronze', place: 3, badge: 'bronze', title: null }]);
      expect((await readProfile(client, b4.gid)).prestige).toEqual([]);
    }
  });
});

// ===== Task 21.2: the close at slot-boundary phase 2, through real boundaries (helpers in the style of arena.test.ts) =====
const SLOT = RULES_V1.clock.slotMs;
const worker = createWorkerDatabase(admin);
type Outcome = { ok: boolean; code?: string; [key: string]: unknown };
async function rpc<T = Outcome>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await admin.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data as T;
}
type Choices = { morning: unknown; afternoon: unknown; evening: unknown };
const ARENA: Choices = { morning: { kind: 'arena' }, afternoon: { kind: 'arena' }, evening: { kind: 'arena' } };
const TRAINING: Choices = { morning: { kind: 'training' }, afternoon: { kind: 'training' }, evening: { kind: 'training' } };

// Operator-only world controls for the isolated local test database (as arena.test.ts): the coordinator has published
// `published`, no boundary row exists, rules v1 is active and the scheduler is off. resetIdentity ran before.
async function resetBoundaries(published: number) {
  await sql`truncate private.boundaries, private.boundary_work, private.dispatch_log`;
  await sql`update private.coordinator set published_slot=${published}, lease_token=null, lease_until_ms=0, last_error=null,
    last_failed_slot=null where singleton`;
  await sql`update private.rules_versions set active=false where version<>'v1'`;
  await sql`delete from private.rules_versions where version<>'v1'`;
  await sql`update private.rules_versions set active=true where version='v1'`;
  await sql`update private.scheduler set enabled=false where singleton`;
}
/**
 * Real creation, then the operator places the character at a historical first slot (as arena.test.ts does): its checkpoint
 * just before `firstSlot`, its schedule, its automatic tournament entry and its earned points (the starter build allocates
 * 10; 105 places it in Silver at its next boundary).
 */
async function player(options: { firstSlot: number; schedule?: Choices; earned?: number; optIn?: boolean }): Promise<Fighter> {
  const owner = await account(), name = 'Season ' + randomUUID().slice(0, 8);
  const created = await commands.createGladiator({ userId: owner.id }, creation(name));
  if (!created.ok) throw Error('creation failed');
  const gid = created.value.gladiatorId, schedule = options.schedule ?? ARENA, earned = options.earned ?? 10;
  const createdAt = (options.firstSlot - 1) * SLOT + 1;
  await sql`update public.gladiators set created_at_ms=${createdAt},orientation_end_ms=${options.firstSlot * SLOT},
    processed_slot_index=${options.firstSlot - 1},earned_points=${earned},unspent_points=${earned - 10},
    tournament_opt_in=${options.optIn ?? false} where id=${gid}`;
  await sql`update public.schedules set schedule=${sql.json(schedule as never)} where gladiator_id=${gid}`;
  for (const phase of ['morning', 'afternoon', 'evening'] as const) {
    await sql`update public.schedule_revisions set received_at_ms=${createdAt},effective_slot_index=${options.firstSlot},
      choice=${sql.json(schedule[phase] as never)} where gladiator_id=${gid} and phase=${phase}`;
  }
  return { ...owner, name, gid };
}
/** `count` placed characters in gladiator id order. */
const players = async (count: number, options: Parameters<typeof player>[0]) =>
  (await Promise.all(Array.from({ length: count }, () => player(options)))).sort((p, q) => (p.gid < q.gid ? -1 : 1));

async function coordinatorLease() {
  const token = randomUUID();
  await sql`update private.coordinator set lease_token=${token},lease_until_ms=9007199254740991 where singleton`;
  return token;
}
const advance = (target: number, token: string) => rpc('advance_boundary', { target_slot: target, coordinator_token: token });
const claim = (kind: string, limit = 20) => rpc<JobLease[]>('claim_jobs', { worker_id: randomUUID(), kind, batch_limit: limit });
const complete = (job: JobLease, result: unknown) => rpc('complete_job', { job_id: job.id, lease_token: job.token, result });
async function completePreparations() {
  for (let jobs = await claim('prepare'); jobs.length; jobs = await claim('prepare')) {
    for (const job of jobs) expect(await complete(job, prepareActivityV1(job.snapshot as PreparationInput))).toMatchObject({ ok: true });
  }
}
/** Runs boundary `target` to its end with canonical preparation and pairing; returns the last report. */
async function runBoundary(target: number, token: string) {
  let report = await advance(target, token);
  if (report.wait === 'preparation') {
    await completePreparations();
    report = await advance(target, token);
  }
  if (report.wait === 'pairing') {
    for (const job of await claim('pair')) expect(await complete(job, DEFAULT_EXECUTORS.v1.pair!(job))).toMatchObject({ ok: true });
    report = await advance(target, token);
  }
  return report;
}
/** Every due simulation (Arena battles, and tournament bouts through their fenced read) and every reveal. */
async function simulateAndReveal() {
  for (let jobs = await claim('simulation', 5); jobs.length; jobs = await claim('simulation', 5)) {
    for (const job of jobs) expect(await complete(job, await DEFAULT_EXECUTORS.v1.simulation!(job, { database: worker }))).toMatchObject({ ok: true });
  }
  for (let jobs = await claim('reveal'); jobs.length; jobs = await claim('reveal')) {
    for (const job of jobs) expect(await complete(job, {})).toMatchObject({ ok: true });
  }
}
type Settled = { ok: boolean; code?: string; newGrants?: number };
const settle = async (job: JobLease) => await worker.settle(job.activityId!, job.token) as Settled;
/** Claims every due settlement and settles each activity through the real worker RPC adapter, one at a time. */
async function settleAll() {
  const settled: Settled[] = [];
  for (let jobs = await claim('settlement'); jobs.length; jobs = await claim('settlement')) {
    for (const job of jobs) settled.push(await settle(job));
  }
  return settled;
}

type SeasonRow = { index: number; starts: number; ends: number; closed: number | null };
const seasonRows = async () => (await sql`select season_index::int as index, starts_at_ms::float8 as starts, ends_at_ms::float8 as ends,
  closed_at_ms::float8 as closed from public.seasons order by season_index`).map(r => ({ ...r }) as SeasonRow);
/** The public.seasons row that seasonAt(slot, 0) describes. */
function seasonOf(slot: number, closed: number | null = null): SeasonRow {
  const season = seasonAt(slot, 0);
  return { index: season.index, starts: season.startsAtMs, ends: season.endsAtMs, closed };
}
type RatingRow = { league: League; season: number; rating: number; wins: number; losses: number };
const ratingsOf = async (f: Fighter) => (await sql`select league, season_index::int as season, rating::int as rating,
  human_wins::int as wins, human_losses::int as losses from private.arena_ratings where gladiator_id=${f.gid}
  order by season_index, array_position(array['bronze','silver','gold','champion'],league)`).map(r => ({ ...r }) as RatingRow);
const cacheOf = async (f: Fighter) => ({ ...(await sql`select league, rating::int as rating from public.gladiators where id=${f.gid}`)[0] });
const boundaryOf = async (slot: number) => (await sql`select opened_at_ms::float8 as opened, completed_at_ms::float8 as completed
  from private.boundaries where slot_index=${slot}`)[0];
const definitionOf = async (signature: string): Promise<string> =>
  (await sql`select pg_get_functiondef(${signature}::regprocedure) as definition`)[0].definition;
/** Every row a close writes: season rows, the archive, awards, season-award receipts and ledger rows, and prestige. */
async function closeState() {
  return {
    seasons: await seasonRows(),
    archive: (await sql`select season_index::int, league, rank::int, gladiator_id::text, name, rating::text, human_wins::text,
      human_losses::text, promoted, inactive, reward_eligible, award_place from public.season_standings
      order by season_index, league, rank`).map(r => ({ ...r })),
    awards: (await sql`select season_index::int, gladiator_id::text, league, place, money::text, renown::text, title, badge,
      receipt_id::text, awarded_at_ms::text from private.season_awards order by season_index, gladiator_id`).map(r => ({ ...r })),
    receipts: (await sql`select receipt_id::text, owner_id::text, request, result from public.operation_receipts
      where request->>'kind'='season-award' order by receipt_id`).map(r => ({ ...r })),
    ledger: (await sql`select receipt_id::text, money_delta::text, renown_delta::text from public.wallet_ledger
      where reason='season' order by receipt_id`).map(r => ({ ...r })),
    prestige: (await sql`select gladiator_id::text, prestige from public.public_profiles order by gladiator_id`).map(r => ({ ...r })),
  };
}

describe('closing each season at its slot boundary (phase 2)', () => {
  it('creates each season row at its first boundary with seasonAt bounds', async () => {
    await resetBoundaries(502);
    // Rollback-only operator transaction: phase 2 under a nonzero epoch creates no season before the epoch, then
    // seasonAt(700, 10)'s row.
    const rollback = new Error('rollback');
    await expect(sql.begin(async tx => {
      await tx`alter table private.season_epoch disable trigger guard_frozen`;
      await tx`update private.season_epoch set epoch_slot=10`;
      expect((await tx`select private.boundary_close_season(9) as wait`)[0].wait).toBeNull();
      expect((await tx`select count(*)::int as n from public.seasons`)[0].n).toBe(0);
      expect((await tx`select private.boundary_close_season(700) as wait`)[0].wait).toBeNull();
      const season = seasonAt(700, 10);
      expect((await tx`select season_index::int as index, starts_at_ms::float8 as starts, ends_at_ms::float8 as ends,
        closed_at_ms as closed from public.seasons`).map(r => ({ ...r })))
        .toEqual([{ index: season.index, starts: season.startsAtMs, ends: season.endsAtMs, closed: null }]);
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await seasonRows()).toEqual([]);
    // Real boundaries at epoch 0: boundary 503 opens season 0 before phase 4 creates its rating row.
    const [trainee] = await players(1, { firstSlot: 503, schedule: TRAINING });
    const token = await coordinatorLease();
    expect(await runBoundary(503, token)).toMatchObject({ status: 'complete' });
    expect(await seasonRows()).toEqual([seasonOf(503)]);
    expect(await ratingsOf(trainee)).toEqual([{ league: 'bronze', season: 0, rating: 1000, wins: 0, losses: 0 }]);
    expect(await settleAll()).toEqual([expect.objectContaining({ ok: true, newGrants: 1 })]);
    // Boundary 504 closes season 0 at database time inside its own run and opens season 1.
    expect(await advance(504, token)).toMatchObject({ phase: 4, status: 'waiting', wait: 'preparation' });
    const rows = await seasonRows();
    expect(rows).toEqual([seasonOf(503, rows[0].closed), seasonOf(504)]);
    expect(rows[0].closed).toBeGreaterThanOrEqual((await boundaryOf(504)).opened);
    expect(await runBoundary(504, token)).toMatchObject({ status: 'complete' });
    expect(rows[0].closed).toBeLessThanOrEqual((await boundaryOf(504)).completed);
    expect(await seasonRows()).toEqual(rows);
    // A later boundary of season 1 adds no row and changes none.
    expect(await settleAll()).toEqual([expect.objectContaining({ ok: true, newGrants: 1 })]);
    expect(await runBoundary(505, token)).toMatchObject({ status: 'complete' });
    expect(await seasonRows()).toEqual(rows);
  }, 60_000);

  it('counts a human bout started in slot 503 in season 0 and waits to close until it settles at 504', async () => {
    await resetBoundaries(502);
    const [a, b] = await players(2, { firstSlot: 503 });
    const token = await coordinatorLease();
    expect(await runBoundary(503, token)).toMatchObject({ status: 'complete' });
    await simulateAndReveal();
    // The bout started in slot 503, the last slot of season 0, so it belongs to season 0.
    expect((await sql`select kind, season_index::int as season, slot_index::int as slot from private.arena_assignments`).map(r => ({ ...r })))
      .toEqual([{ kind: 'human', season: 0, slot: 503 }]);
    // Boundary 504 holds at phase 1 until both sides' minute-80 settlement: season 0 stays open and unarchived.
    expect(await advance(504, token)).toMatchObject({ phase: 1, status: 'waiting', wait: 'settlement' });
    const [first] = await claim('settlement', 1);
    expect(await settle(first)).toMatchObject({ ok: true, newGrants: 1 });
    expect(await advance(504, token)).toMatchObject({ phase: 1, status: 'waiting', wait: 'settlement' });
    expect(await seasonRows()).toEqual([seasonOf(503)]);
    expect(await archive(0)).toEqual([]);
    expect(await settleAll()).toEqual([expect.objectContaining({ ok: true, newGrants: 1 })]);
    const [winner, loser] = (await ratingsOf(a))[0].wins === 1 ? [a, b] : [b, a];
    expect(await ratingsOf(winner)).toEqual([{ league: 'bronze', season: 0, rating: 1012, wins: 1, losses: 0 }]);
    expect(await ratingsOf(loser)).toEqual([{ league: 'bronze', season: 0, rating: 988, wins: 0, losses: 1 }]);
    // Settled: boundary 504 closes season 0 with the bout counted. One human bout is below the minimum, so nobody is paid.
    expect(await advance(504, token)).toMatchObject({ phase: 4, status: 'waiting', wait: 'preparation' });
    expect((await seasonRows()).map(r => [r.index, r.closed === null])).toEqual([[0, false], [1, true]]);
    expect(await archive(0)).toEqual([entry('bronze', 1, winner, { rating: 1012, wins: 1, losses: 0 }),
      entry('bronze', 2, loser, { rating: 988, wins: 0, losses: 1 })]);
    expect(await awards(0)).toEqual([]);
  }, 60_000);

  it('closes season 0 at boundary 504 before phase 4 starts season 1 ratings at 1000', async () => {
    await resetBoundaries(502);
    const [a, b] = await players(2, { firstSlot: 503 });
    const token = await coordinatorLease();
    expect(await runBoundary(503, token)).toMatchObject({ status: 'complete' });
    await simulateAndReveal();
    await settleAll();
    const seasonZero = await Promise.all([a, b].map(ratingsOf));
    expect(seasonZero.map(rows => rows.map(r => r.season))).toEqual([[0], [0]]);
    expect(seasonZero.map(([r]) => r.rating).sort((x, y) => x - y)).toEqual([988, 1012]);
    // Phases 1-3 ran: season 0 is closed and archived from its settled rows, and no season 1 rating row exists yet. The
    // character cache still holds the season 0 rating.
    expect(await advance(504, token)).toMatchObject({ phase: 4, status: 'waiting', wait: 'preparation' });
    expect((await seasonRows()).map(r => [r.index, r.closed === null])).toEqual([[0, false], [1, true]]);
    const archived = await archive(0);
    expect(archived.map(r => [r.gid, r.rating, r.wins, r.losses]).sort())
      .toEqual(seasonZero.map(([r], i) => [[a, b][i].gid, r.rating, r.wins, r.losses]).sort());
    expect(await sql`select count(*)::int as n from private.arena_ratings where season_index=1`).toEqual([{ n: 0 }]);
    expect(await Promise.all([a, b].map(cacheOf))).toEqual(seasonZero.map(([r]) => ({ league: 'bronze', rating: r.rating })));
    // Phase 4 then starts season 1 at 1000; slot 504's Arena entries start from it and are paired in season 1.
    expect(await runBoundary(504, token)).toMatchObject({ status: 'complete' });
    for (const [i, f] of [a, b].entries()) {
      expect(await ratingsOf(f)).toEqual([...seasonZero[i], { league: 'bronze', season: 1, rating: 1000, wins: 0, losses: 0 }]);
      expect(await cacheOf(f)).toEqual({ league: 'bronze', rating: 1000 });
      expect((await sql`select s.snapshot->'starting'->'rating' as rating from private.activity_snapshots s
        join public.activities x on x.id=s.activity_id where x.gladiator_id=${f.gid} and x.slot_index=504`)[0].rating).toBe(1000);
    }
    expect((await sql`select distinct season_index::int as season from private.arena_assignments where slot_index=504`).map(r => r.season)).toEqual([1]);
    // Season 0 stays frozen with its archive.
    await expect(sql`update private.arena_ratings set rating=rating+1 where gladiator_id=${a.gid} and season_index=0`)
      .rejects.toThrow('immutable arena rating');
    expect(await archive(0)).toEqual(archived);
  }, 60_000);

  it('places a gladiator promoted at boundary 504 in the new league only in season 1', async () => {
    await resetBoundaries(502);
    const [a, b] = await players(2, { firstSlot: 503 });
    const token = await coordinatorLease();
    expect(await runBoundary(503, token)).toMatchObject({ status: 'complete' });
    // As if after four earlier human bouts this season, so the slot-503 bout is each one's fifth. The operator banks a's
    // points only after boundary 503's phase 4, so a is promoted to Silver at boundary 504, after its last season 0 bout.
    await sql`update private.arena_ratings set human_wins=2,human_losses=2 where season_index=0`;
    await sql`update public.gladiators set earned_points=105,unspent_points=95 where id=${a.gid}`;
    await simulateAndReveal();
    await settleAll();
    const [winner, loser] = (await ratingsOf(a))[0].wins === 3 ? [a, b] : [b, a];
    expect(await advance(504, token)).toMatchObject({ phase: 4, status: 'waiting', wait: 'preparation' });
    // Season 0 holds only Bronze rows: a is not promoted there and is rewarded in Bronze, its highest qualifying league.
    const archived = [entry('bronze', 1, winner, { rating: 1012, wins: 3, losses: 2 }, { eligible: true, place: 1 }),
      entry('bronze', 2, loser, { rating: 988, wins: 2, losses: 3 }, { eligible: true, place: 2 })];
    expect(await archive(0)).toEqual(archived);
    expect((await awards(0)).map(x => [x.gid, x.league, x.place])).toEqual([[winner.gid, 'bronze', 1], [loser.gid, 'bronze', 2]]);
    expect(await runBoundary(504, token)).toMatchObject({ status: 'complete' });
    // Season 1: a starts in Silver at 1000 and has no Bronze row; b stays in Bronze.
    expect((await ratingsOf(a)).filter(r => r.season === 1)).toEqual([{ league: 'silver', season: 1, rating: 1000, wins: 0, losses: 0 }]);
    expect((await ratingsOf(b)).filter(r => r.season === 1)).toEqual([{ league: 'bronze', season: 1, rating: 1000, wins: 0, losses: 0 }]);
    expect(await cacheOf(a)).toEqual({ league: 'silver', rating: 1000 });
    // The season 0 archive and a's one award stay in Bronze; the rest of boundary 504 paid nothing more.
    expect(await archive(0)).toEqual(archived);
    const place = a === winner ? 1 : 2, prize = PLACES[place - 1];
    expect((await receiptsOf(a)).map(r => r.result)).toEqual([{ seasonIndex: 0, league: 'bronze', place, money: prize.money,
      renown: prize.renown, title: prize.title, badge: prize.badge }]);
    expect(await prestigeOf(a)).toEqual([{ seasonIndex: 0, league: 'bronze', place, badge: prize.badge, title: prize.title }]);
  }, 60_000);

  it('closes a season whose final slot held a tournament only after every entrant settled', async () => {
    const T = 301; // Saturday 1970-01-17 at 17:20 UTC, a v1 tournament slot
    expect(isTournamentSlot(slotAt(T * SLOT))).toBe(true);
    const definition = await definitionOf('private.season_index(bigint)');
    // Test-only stand-in, restored byte for byte below: season 0 ends with slot 301, so boundary 302 starts season 1.
    await sql.unsafe(`create or replace function private.season_index(slot bigint) returns bigint language sql stable security invoker
      set search_path='' as $stand$ select (slot-e.epoch_slot+202)/504 from private.season_epoch e where e.singleton and slot>=e.epoch_slot $stand$`);
    try {
      expect(await sql`select private.season_index(${T})::int as last, private.season_index(${T + 1})::int as next`).toEqual([{ last: 0, next: 1 }]);
      await resetBoundaries(T - 1);
      const entrants = await players(4, { firstSlot: T, optIn: true });
      const token = await coordinatorLease();
      expect(await runBoundary(T, token)).toMatchObject({ status: 'complete' });
      const tournaments = (await sql`select id, season_index::int as season from private.tournaments`).map(r => ({ ...r }));
      expect(tournaments).toEqual([{ id: expect.any(String), season: 0 }]);
      await simulateAndReveal();
      // Boundary 302 holds at phase 1 until every entrant's minute-80 settlement: season 0 stays open and unarchived.
      expect(await advance(T + 1, token)).toMatchObject({ phase: 1, status: 'waiting', wait: 'settlement' });
      const [first] = await claim('settlement', 1);
      expect(await settle(first)).toMatchObject({ ok: true, newGrants: 1 });
      expect(await advance(T + 1, token)).toMatchObject({ phase: 1, status: 'waiting', wait: 'settlement' });
      expect((await seasonRows()).map(r => [r.index, r.closed])).toEqual([[0, null]]);
      expect(await archive(0)).toEqual([]);
      expect(await settleAll()).toEqual(Array.from({ length: 3 }, () => expect.objectContaining({ ok: true, newGrants: 1 })));
      // Each settlement credited season 0, the season of the tournament's start.
      const graph: TournamentGraph = (await sql`select private.tournament_graph(${tournaments[0].id}) as graph`)[0].graph;
      const outcomes = tournamentOutcomes(graph);
      expect(outcomes.map(o => o.gladiatorId).sort()).toEqual(entrants.map(f => f.gid));
      expect(outcomes.reduce((sum, o) => sum + o.wins, 0)).toBe(3);
      for (const o of outcomes) {
        expect(await ratingsOf(entrants.find(f => f.gid === o.gladiatorId)!))
          .toEqual([{ league: 'bronze', season: 0, rating: o.ratingAfter, wins: o.wins, losses: o.losses }]);
      }
      // Then boundary 302 closes season 0 after the last settlement, archiving the tournament's results.
      expect(await advance(T + 1, token)).toMatchObject({ phase: 4, status: 'waiting', wait: 'preparation' });
      const [seasonZero] = await seasonRows();
      const [{ settled }] = await sql`select max(settled_at_ms)::float8 as settled from public.activities where slot_index=${T}`;
      expect(seasonZero.closed).toBeGreaterThanOrEqual(settled);
      const archived = new Map((await archive(0)).map(r => [r.gid, r]));
      expect(archived.size).toBe(4);
      for (const o of outcomes) {
        expect(archived.get(o.gladiatorId)).toMatchObject({ league: 'bronze', rating: o.ratingAfter, wins: o.wins, losses: o.losses });
      }
    } finally {
      await sql.unsafe(definition);
    }
    expect(await definitionOf('private.season_index(bigint)')).toBe(definition);
  }, 120_000);

  it('closes the season at the next boundary run when coordinate_work skips boundary 504', async () => {
    // Operator-placed world: season 0 is open with rating rows, the coordinator has published slot 503, and no character is
    // due at boundary 504: both checkpoints are at slot 509, so coordinate_work skips to boundary 510.
    await resetBoundaries(503);
    const [a, b] = await players(2, { firstSlot: 510, schedule: TRAINING });
    await openSeason(0);
    await rate(a, 'bronze', { rating: 1100, ...QUALIFIED });
    await rate(b, 'bronze', { rating: 1000, wins: 1, losses: 0 });
    // The worker's call, as service_role.
    expect(await rpc('coordinate_work')).toMatchObject({ ok: true, publishedSlot: 509,
      boundaries: [{ ok: true, slotIndex: 510, phase: 4, status: 'waiting', wait: 'preparation' }] });
    expect((await sql`select slot_index::int as slot from private.boundaries`).map(r => r.slot)).toEqual([510]);
    const rows = await seasonRows();
    expect(rows[0].closed).not.toBeNull();
    expect(rows).toEqual([seasonOf(503, rows[0].closed), seasonOf(510)]);
    expect(await archive(0)).toEqual([entry('bronze', 1, a, { rating: 1100, ...QUALIFIED }, { eligible: true, place: 1 }),
      entry('bronze', 2, b, { rating: 1000, wins: 1, losses: 0 })]);
    expect((await awards(0)).map(x => [x.gid, x.place])).toEqual([[a.gid, 1]]);
  }, 60_000);

  it('rolls back a failed close entirely and pays once on the retry', async () => {
    await resetBoundaries(503);
    const trio = await players(3, { firstSlot: 504, schedule: TRAINING });
    await openSeason(0);
    for (const [i, f] of trio.entries()) await rate(f, 'bronze', { rating: 1200 - i * 100, ...QUALIFIED });
    const before = { state: await closeState(), wallets: await Promise.all(trio.map(walletOf)) };
    // Test-only failure, always dropped below: the close's second award row raises after the first award was fully paid.
    await sql.unsafe(`create function private.test_fail_second_award() returns trigger language plpgsql set search_path='' as $fail$
      begin
        if (select count(*) from private.season_awards x where x.season_index=new.season_index)>=2 then raise exception 'injected close failure'; end if;
        return new;
      end $fail$`);
    try {
      await sql.unsafe(`create trigger test_fail_second_award after insert on private.season_awards for each row
        execute function private.test_fail_second_award()`);
      expect(await rpc('coordinate_work')).toMatchObject({ ok: true, publishedSlot: 503,
        boundaries: [{ ok: false, code: 'boundary-failed', slotIndex: 504, sqlstate: 'P0001' }] });
      // Nothing of the boundary or the close remains: season 0 open, no season 1, archive, award, receipt, ledger row or credit.
      expect(await closeState()).toEqual(before.state);
      expect(await Promise.all(trio.map(walletOf))).toEqual(before.wallets);
      expect(await sql`select count(*)::int as n from private.boundaries`).toEqual([{ n: 0 }]);
      expect(await sql`select last_error, last_failed_slot::int as slot from private.coordinator`).toEqual([{ last_error: 'P0001', slot: 504 }]);
    } finally {
      await sql`drop trigger if exists test_fail_second_award on private.season_awards`;
      await sql`drop function if exists private.test_fail_second_award()`;
    }
    // The next coordination retries the boundary: the close pays each award once.
    expect(await rpc('coordinate_work')).toMatchObject({ ok: true, publishedSlot: 503,
      boundaries: [{ ok: true, slotIndex: 504, phase: 4, status: 'waiting', wait: 'preparation' }] });
    expect(await places()).toEqual(trio.map((f, i) => ['bronze', i + 1, f.gid]));
    for (const [i, f] of trio.entries()) {
      expect(await walletOf(f)).toEqual({ money: before.wallets[i].money + PLACES[i].money, renown: before.wallets[i].renown + PLACES[i].renown });
      expect(await receiptsOf(f)).toHaveLength(1);
      expect(await ledgerOf(f)).toHaveLength(1);
    }
    const paid = { state: await closeState(), wallets: await Promise.all(trio.map(walletOf)) };
    expect(paid.state.seasons.map(r => [r.index, r.closed === null])).toEqual([[0, false], [1, true]]);
    // Finishing boundary 504 (and reaching 505, which waits for slot 504's settlements) pays nothing more.
    await completePreparations();
    const finished = await rpc<{ boundaries: Outcome[] }>('coordinate_work');
    expect(finished.boundaries[0]).toMatchObject({ ok: true, slotIndex: 504, status: 'complete' });
    expect({ state: await closeState(), wallets: await Promise.all(trio.map(walletOf)) }).toEqual(paid);
  }, 60_000);

  it('replays a completed boundary with no new awards', async () => {
    await resetBoundaries(503);
    const trio = await players(3, { firstSlot: 504, schedule: TRAINING });
    await openSeason(0);
    for (const [i, f] of trio.entries()) await rate(f, 'bronze', { rating: 1200 - i * 100, ...QUALIFIED });
    const token = await coordinatorLease();
    expect(await runBoundary(504, token)).toMatchObject({ status: 'complete' });
    const closed = await closeState();
    expect(closed.awards).toHaveLength(3);
    expect(closed.seasons.map(r => [r.index, r.closed === null])).toEqual([[0, false], [1, true]]);
    // Replaying the completed boundary returns its completion and runs no phase.
    expect(await advance(504, token)).toMatchObject({ ok: true, slotIndex: 504, phase: 9, status: 'complete', replayed: true });
    expect(await closeState()).toEqual(closed);
    // Phase 2 run again as the worker's role: season 0 is already closed, and season 1's row exists.
    await sql.begin(async tx => {
      await tx`set local role service_role`;
      expect((await tx`select private.boundary_close_season(504) as wait`)[0].wait).toBeNull();
    });
    expect(await closeState()).toEqual(closed);
    // The next boundary of season 1 runs phase 2 with nothing to close.
    await settleAll();
    expect(await runBoundary(505, token)).toMatchObject({ status: 'complete' });
    expect(await closeState()).toEqual(closed);
  }, 60_000);
});
