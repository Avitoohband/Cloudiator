import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { sql, admin, account, anonymous, resetIdentity, creation } from '../fixtures/db.ts';
import { createDatabase } from '../../supabase/functions/_shared/backend/database.ts';
import { RULES_V1 } from '../../supabase/functions/_shared/domain/rules-v1.ts';

// Task 21.1: closing a season in the database. Each test seeds a season's private rating rows by SQL for real characters
// and calls private.close_season(season, now) directly as the database owner. Task 21.2 wires the close into phase 2 of
// the slot boundary.
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
/** A season row with the launch-epoch-0 bounds of seasonAt (Task 21.2): 504 slots of 80 minutes. */
async function openSeason(index = 0) {
  await sql`insert into public.seasons(season_index,starts_at_ms,ends_at_ms) values(${index},${index * SEASON_MS},${(index + 1) * SEASON_MS})`;
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
      // Private awards and the close itself are unreachable.
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
      where n.nspname='private' and p.proname in ('season_rules','guard_season','close_season') order by p.proname`;
    expect(functions.map(r => ({ ...r }))).toEqual(['close_season', 'guard_season', 'season_rules'].map(proname =>
      ({ proname, prosecdef: false, proconfig: ['search_path=""'], anon: false, player: false, backend: true })));
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
});
