import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { readMarket, readProfile, readRecent, readSeasons, readStandingOf, readStandings, readTimeline, readTournament, readTournamentLog, readWorld } from '../src/lib/api/reads';
import { tournamentLookupId } from '../src/lib/tournament-id';

function transport(rows: Record<string, unknown>, calls: string[]) {
  return createClient('http://127.0.0.1:54321', 'test-key', { auth: { persistSession: false }, global: { fetch: async (input) => {
    const url = new URL(String(input)); calls.push(url.pathname + url.search);
    const body = rows[url.pathname.split('/').at(-1)!];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } } });
}
describe('protected Data API adapters', () => {
  it('loads safe world pages with a stable revision and no eager owner/log/profile query', async () => {
    const calls: string[] = [], revision = { revision: '7:20', server_now_ms: 99_000_000, slot_index: 20 };
    const client = transport({ world_revision: revision, world_actor_reads: [{ gladiator_id: 'g', actor: { gladiatorId: 'g' } }] }, calls);
    expect(await readWorld(client)).toMatchObject({ revision: '7:20', serverNowMs: 99_000_000, actors: [{ gladiatorId: 'g' }] });
    expect(calls.filter(c => c.includes('world_actor_reads'))).toHaveLength(1);
    expect(calls.every(c => /world_revision|world_actor_reads/.test(c))).toBe(true);
    expect(calls.find(c => c.includes('world_actor_reads'))).toContain('limit=50');
  });
  it('keeps spectator completion separate from an absent RLS owner summary', async () => {
    const calls: string[] = [], summary = { activityId: 'a', resolvedKind: 'rest', result: 'completed', success: true, settledAtMs: 10, replayExpiry: { state: 'expired' } };
    const client = transport({ world_revision: { revision: '1', server_now_ms: 20, slot_index: 0 }, visible_events: [], recent_results: { summary }, activities: null }, calls);
    expect(await readTimeline(client, 'a', { ownerSummary: true })).toEqual({ activityId: 'a', serverNowMs: 20, visibleThroughMs: 20, stages: [], completion: summary });
    expect(calls.find(c => c.includes('visible_events'))).toContain('limit=50');
    expect(calls.some(c => c.includes('/activities'))).toBe(true);
  });
  it('never asks the owner-only activities table for a timeline read without the owner summary', async () => {
    const calls: string[] = [], summary = { activityId: 'a', resolvedKind: 'rest', result: 'completed', success: true, settledAtMs: 10, replayExpiry: { state: 'expired' } };
    const client = transport({ world_revision: { revision: '1', server_now_ms: 20, slot_index: 0 }, visible_events: [], recent_results: { summary } }, calls);
    expect(await readTimeline(client, 'a', { ownerSummary: false })).toEqual({ activityId: 'a', serverNowMs: 20, visibleThroughMs: 20, stages: [], completion: summary });
    expect(calls.some(c => c.includes('/activities'))).toBe(false);
  });
  it('rejects malformed cursors before issuing a query and bounds recent pages', async () => {
    const calls: string[] = [], client = transport({ recent_results: [] }, calls);
    await expect(readRecent(client, 'bad,filter')).rejects.toMatchObject({ code: 'unavailable' }); expect(calls).toHaveLength(0);
    expect(await readRecent(client)).toEqual({ rows: [], nextCursor: null }); expect(calls[0]).toContain('limit=50');
    // An empty cursor is no cursor: the first page, with no cursor filter.
    expect(await readRecent(client, '')).toEqual({ rows: [], nextCursor: null }); expect(calls[1]).not.toContain('reveal_at_ms.lt');
  });
  it('pages open offers newest first, 50 at a time, and filters by seller', async () => {
    const SELLER = '0d5f8471-d919-428f-9ab7-058c95821757', WEEK = 604_800_000;
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const stats = { damage: 6, armor: 0, weight: 4, intervalMs: 1000, attributes: { strength: 0, agility: 0, vitality: 0, endurance: 0, precision: 0 } };
    // The projection's row; an unexpected item field never crosses into the listing.
    const row = (n: number) => ({ id: id(n), seller_gladiator_id: SELLER, seller_name: 'Aster', price: 10 + n, listed_at_ms: 1_000_000 - n, expires_at_ms: 1_000_000 - n + WEEK,
      item: { catalogId: 'sword:1:common', catalogVersion: 'v1', tier: 1, rarity: 'common', stats, quantity: 1, origin: 'shop' } });
    const calls: string[] = [];
    const offers = (rows: unknown[]) => createClient('http://127.0.0.1:54321', 'test-key', { auth: { persistSession: false }, global: { fetch: async (input) => {
      const url = new URL(String(input)); calls.push(decodeURIComponent(url.pathname + url.search));
      return new Response(JSON.stringify(rows), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } } });
    // A full page of 50 names its last row as the cursor `listedAtMs:listingId`; a server answering more is still cut to 50.
    const first = await readMarket(offers(Array.from({ length: 51 }, (_, n) => row(n))));
    expect(first.rows).toHaveLength(50);
    expect(first.nextCursor).toBe(`${1_000_000 - 49}:${id(49)}`);
    expect(first.rows[0]).toEqual({ listingId: id(0), seller: { gladiatorId: SELLER, name: 'Aster' }, price: 10, listedAtMs: 1_000_000, expiresAtMs: 1_000_000 + WEEK,
      item: { catalogId: 'sword:1:common', catalogVersion: 'v1', tier: 1, rarity: 'common', stats, quantity: 1 } });
    // Newest first, then by id; only the sanitized projection's columns; at most 50 rows; no seller filter by default.
    const query = new URL(`http://local${calls[0]}`);
    expect(query.pathname).toBe('/rest/v1/market_offers');
    expect(query.searchParams.get('select')).toBe('id,seller_gladiator_id,seller_name,item,price,listed_at_ms,expires_at_ms');
    expect(query.searchParams.get('order')).toBe('listed_at_ms.desc,id.asc');
    expect(query.searchParams.get('limit')).toBe('50');
    expect([query.searchParams.has('or'), query.searchParams.has('seller_gladiator_id')]).toEqual([false, false]);
    // The next page starts strictly after the cursor's row; a short page ends the list.
    expect(await readMarket(offers([row(50)]), first.nextCursor!)).toEqual({ rows: [expect.objectContaining({ listingId: id(50) })], nextCursor: null });
    expect(calls[1]).toContain(`or=(listed_at_ms.lt.${1_000_000 - 49},and(listed_at_ms.eq.${1_000_000 - 49},id.gt.${id(49)}))`);
    // One seller's open listings only (a gladiator id in any letter case), and its own pages.
    expect(await readMarket(offers([row(1)]), undefined, SELLER.toUpperCase())).toMatchObject({ rows: [{ listingId: id(1) }], nextCursor: null });
    expect(calls[2]).toContain(`seller_gladiator_id=eq.${SELLER}`);
    await readMarket(offers([]), first.nextCursor!, SELLER);
    expect(calls[3]).toContain(`seller_gladiator_id=eq.${SELLER}`);
    expect(calls[3]).toContain(`id.gt.${id(49)}`);
    // An empty cursor is no cursor.
    expect(await readMarket(offers([]), '')).toEqual({ rows: [], nextCursor: null });
    expect(calls[4]).not.toContain('or=');
    // A malformed cursor or seller is refused before any query.
    calls.length = 0;
    for (const cursor of ['bad,filter', `1:${id(1)},id.neq.x`, '1:not-a-uuid', `99999999999999999:${id(1)}`, `x:${id(1)}`]) {
      await expect(readMarket(offers([]), cursor), cursor).rejects.toMatchObject({ code: 'unavailable' });
    }
    for (const seller of ['', 'g1', `${SELLER},id.neq.x`, `${SELLER})`]) {
      await expect(readMarket(offers([]), undefined, seller), seller).rejects.toMatchObject({ code: 'unavailable' });
    }
    expect(calls).toEqual([]);
  });
  /**
   * A Data API over fixed bodies by table (the seasons rows, the open `arena_standing_reads` view, the archived
   * `season_standings`, the legacy `arena_standings` probe and the profile view); `calls` records each decoded request.
   */
  function seasonApi(bodies: Record<string, unknown>, calls: string[]) {
    return createClient('http://127.0.0.1:54321', 'test-key', { auth: { persistSession: false }, global: { fetch: async (input) => {
      const url = new URL(String(input)); calls.push(decodeURIComponent(url.pathname + url.search));
      return new Response(JSON.stringify(bodies[url.pathname.split('/').at(-1)!] ?? []), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } } });
  }
  const SEASON_MS = 2_419_200_000;
  const season = (index: number, closed: number | null = null) => ({ season_index: index, starts_at_ms: index * SEASON_MS, ends_at_ms: (index + 1) * SEASON_MS, closed_at_ms: closed });
  const openRow = (i: number) => ({ gladiator_id: `g${i}`, name: `N${i}`, rating: 1100 - i, human_wins: i % 6, human_losses: i % 2 ? 1 : 0, rank: i + 1,
    promoted: i === 3, reward_eligible: i % 6 + (i % 2 ? 1 : 0) >= 5 && i !== 11 });
  const archivedRow = (i: number) => ({ gladiator_id: `g${i}`, name: `N${i}`, rating: 1100 - i, human_wins: i % 6, human_losses: i % 2 ? 1 : 0, rank: i + 1,
    promoted: i === 0, inactive: i === 7, reward_eligible: i !== 0 && i !== 7, award_place: i >= 1 && i <= 3 ? i : null });
  it('reads seasons newest first, without a session', async () => {
    const calls: string[] = [];
    // A server that answered more than 50 rows is still cut to 50, newest first as ordered.
    const rows = Array.from({ length: 51 }, (_, i) => season(50 - i, i === 0 ? null : (51 - i) * SEASON_MS + 5_000));
    const seasons = await readSeasons(seasonApi({ seasons: rows }, calls));
    expect(seasons).toHaveLength(50);
    expect(seasons[0]).toEqual({ seasonId: '50', startsAtMs: 50 * SEASON_MS, endsAtMs: 51 * SEASON_MS, closedAtMs: null });
    expect(seasons[1]).toEqual({ seasonId: '49', startsAtMs: 49 * SEASON_MS, endsAtMs: 50 * SEASON_MS, closedAtMs: 50 * SEASON_MS + 5_000 });
    expect(seasons.map(s => s.seasonId)).toEqual(Array.from({ length: 50 }, (_, i) => String(50 - i)));
    // One request to the public seasons table: its four columns, newest first, at most 50 rows.
    expect(calls).toHaveLength(1);
    const query = new URL(`http://local${calls[0]}`);
    expect(query.pathname).toBe('/rest/v1/seasons');
    expect(query.searchParams.get('select')).toBe('season_index,starts_at_ms,ends_at_ms,closed_at_ms');
    expect(query.searchParams.get('order')).toBe('season_index.desc');
    expect(query.searchParams.get('limit')).toBe('50');
    // No season yet: an empty list, not an error.
    expect(await readSeasons(seasonApi({ seasons: [] }, []))).toEqual([]);
  });
  it('reads the latest season when no season is named, and the archive with awardPlace for a closed one', async () => {
    const calls: string[] = [], rows = Array.from({ length: 51 }, (_, i) => openRow(i));
    // The latest season is open: its ranked view, with the reward eligibility the view computes (not the bout count).
    const open = await readStandings(seasonApi({ seasons: [season(4)], arena_standing_reads: rows }, calls), 'silver');
    expect(open).toMatchObject({ league: 'silver', seasonId: '4', archived: false, nextCursor: '4:50' });
    expect(open.rows).toHaveLength(50);
    expect(open.rows[0]).toEqual({ rank: 1, gladiatorId: 'g0', name: 'N0', rating: 1100, humanWins: 0, humanLosses: 0, promoted: false, inactive: true,
      rewardEligible: false, awardPlace: null });
    expect(open.rows[3]).toMatchObject({ promoted: true, inactive: false, rewardEligible: false, awardPlace: null });
    // g5 has five human bouts and the view says eligible; g11 also has five but the view says it is not (a higher league row).
    expect(open.rows[5]).toMatchObject({ humanWins: 5, humanLosses: 1, rewardEligible: true });
    expect(open.rows[11]).toMatchObject({ humanWins: 5, humanLosses: 1, rewardEligible: false });
    expect(open.rows.every(row => row.awardPlace === null)).toBe(true);
    expect(calls).toHaveLength(2);
    // The latest season is the newest public.seasons row; the open page reads the ranked view for it.
    const latest = new URL(`http://local${calls[0]}`);
    expect([latest.pathname, latest.searchParams.get('select'), latest.searchParams.get('order'), latest.searchParams.get('limit')])
      .toEqual(['/rest/v1/seasons', 'season_index,closed_at_ms', 'season_index.desc', '1']);
    expect(calls[1]).toContain('/arena_standing_reads?');
    expect(new URL(`http://local${calls[1]}`).searchParams.get('select')).toBe('gladiator_id,name,rating,human_wins,human_losses,rank,promoted,reward_eligible');
    expect(calls[1]).toMatch(/league=eq\.silver/);
    expect(calls[1]).toMatch(/season_index=eq\.4/);
    expect(calls[1]).toMatch(/rank=gt\.0/);
    // The Data API caps responses at 50 rows, so a full page of 50 is what yields the next cursor.
    expect(calls[1]).toContain('limit=50');
    // A closed latest season reads the frozen archive: archived, with award places, the frozen flags and no live view.
    calls.length = 0;
    const archived = await readStandings(seasonApi({ seasons: [season(3, 3 * SEASON_MS + 9_000)], season_standings: Array.from({ length: 8 }, (_, i) => archivedRow(i)),
      arena_standing_reads: [{ gladiator_id: 'live' }] }, calls), 'silver');
    expect(archived).toMatchObject({ league: 'silver', seasonId: '3', archived: true, nextCursor: null });
    expect(archived.rows.map(r => r.awardPlace)).toEqual([null, 1, 2, 3, null, null, null, null]);
    expect(archived.rows[0]).toEqual({ rank: 1, gladiatorId: 'g0', name: 'N0', rating: 1100, humanWins: 0, humanLosses: 0, promoted: true, inactive: false,
      rewardEligible: false, awardPlace: null });
    expect(archived.rows[1]).toMatchObject({ rewardEligible: true, awardPlace: 1, promoted: false, inactive: false });
    // The frozen inactive flag is read as stored.
    expect(archived.rows[7]).toMatchObject({ inactive: true, rewardEligible: false, awardPlace: null });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('/season_standings?');
    expect(new URL(`http://local${calls[1]}`).searchParams.get('select'))
      .toBe('gladiator_id,name,rating,human_wins,human_losses,rank,promoted,inactive,reward_eligible,award_place');
    expect(calls[1]).toMatch(/league=eq\.silver/);
    expect(calls[1]).toMatch(/season_index=eq\.3/);
    expect(calls[1]).toMatch(/rank=gt\.0/);
    expect(calls[1]).toContain('limit=50');
    expect(calls.some(c => c.includes('arena_standing_reads'))).toBe(false);
    // A full archived page names its last rank in the same season:rank cursor.
    const full = await readStandings(seasonApi({ seasons: [season(3, 1)], season_standings: Array.from({ length: 50 }, (_, i) => archivedRow(i)) }, []), 'bronze');
    expect(full).toMatchObject({ seasonId: '3', archived: true, nextCursor: '3:50' });
    // With no public.seasons row yet, the latest season is the maximum of the projection table, which is open.
    calls.length = 0;
    const legacy = await readStandings(seasonApi({ seasons: [], arena_standings: [{ season_index: 6 }], arena_standing_reads: [openRow(0)] }, calls), 'bronze');
    expect(legacy).toMatchObject({ seasonId: '6', archived: false, rows: [{ rank: 1, gladiatorId: 'g0', awardPlace: null }] });
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain('/seasons?select=season_index,closed_at_ms&order=season_index.desc&limit=1');
    expect(calls[1]).toContain('/arena_standings?select=season_index&order=season_index.desc&limit=1');
    expect(calls[2]).toContain('/arena_standing_reads?');
    expect(calls[2]).toMatch(/season_index=eq\.6/);
  });
  it('keeps a cursor inside its season and rejects an unknown or malformed season id', async () => {
    const rows = Array.from({ length: 51 }, (_, i) => openRow(i)).slice(50);
    // A later page stays in the cursor's season and starts after its rank; the cursor wins over a named season and over the latest.
    const calls: string[] = [];
    const later = await readStandings(seasonApi({ seasons: [season(4), season(9)], arena_standing_reads: rows }, calls), 'silver', '4:50', '9');
    expect(later).toMatchObject({ seasonId: '4', archived: false, nextCursor: null, rows: [{ rank: 51, gladiatorId: 'g50', awardPlace: null }] });
    expect(calls).toHaveLength(2);
    const lookup = new URL(`http://local${calls[0]}`);
    expect([lookup.pathname, lookup.searchParams.get('select'), lookup.searchParams.get('season_index'), lookup.searchParams.get('limit')])
      .toEqual(['/rest/v1/seasons', 'season_index,closed_at_ms', 'eq.4', '1']);
    expect(lookup.searchParams.has('order')).toBe(false);
    expect(calls[1]).toMatch(/season_index=eq\.4/);
    expect(calls[1]).toMatch(/rank=gt\.50/);
    // A cursor into a closed season keeps reading the archive.
    calls.length = 0;
    const archived = await readStandings(seasonApi({ seasons: [season(3, 1)], season_standings: [archivedRow(50)] }, calls), 'bronze', '3:50');
    expect(archived).toMatchObject({ seasonId: '3', archived: true, nextCursor: null, rows: [{ rank: 51, awardPlace: null }] });
    expect(calls[1]).toContain('/season_standings?');
    expect(calls[1]).toMatch(/season_index=eq\.3/);
    expect(calls[1]).toMatch(/rank=gt\.50/);
    // A cursor was issued by this read for a season it served: with no season row at all (a world before the seasons table
    // was filled) it still reads that season, open, as the first page did.
    calls.length = 0;
    expect(await readStandings(seasonApi({ seasons: [], arena_standing_reads: [] }, calls), 'bronze', '1:50'))
      .toEqual({ league: 'bronze', seasonId: '1', archived: false, rows: [], nextCursor: null });
    expect(calls.map(c => c.split('?')[0].split('/').at(-1))).toEqual(['seasons', 'arena_standing_reads']);
    // A named season, closed or open, with no cursor: its own lookup and its own source.
    calls.length = 0;
    const named = await readStandings(seasonApi({ seasons: [season(2, 1)], season_standings: [archivedRow(0)] }, calls), 'gold', undefined, '2');
    expect(named).toMatchObject({ seasonId: '2', archived: true });
    expect(new URL(`http://local${calls[0]}`).searchParams.get('season_index')).toBe('eq.2');
    calls.length = 0;
    expect(await readStandings(seasonApi({ seasons: [season(0)], arena_standing_reads: [openRow(0)] }, calls), 'gold', undefined, '0'))
      .toMatchObject({ seasonId: '0', archived: false });
    expect(new URL(`http://local${calls[0]}`).searchParams.get('season_index')).toBe('eq.0');
    // A season id that names no public.seasons row is unavailable, after exactly one lookup and no standings query.
    calls.length = 0;
    await expect(readStandings(seasonApi({ seasons: [] }, calls), 'bronze', undefined, '7')).rejects.toMatchObject({ code: 'unavailable' });
    expect(calls).toHaveLength(1);
    // A malformed season id, whatever else is given, is refused before any query. Only a canonical non-negative integer counts.
    calls.length = 0;
    const client = seasonApi({ seasons: [season(4)] }, calls);
    for (const bad of ['', '-1', '01', '1.5', '1e3', 'x', ' 1', '1 ', '99999999999999999', '4,rating.lt.0', 'fixture-season-1', '4)', 4 as never, null as never]) {
      await expect(readStandings(client, 'bronze', undefined, bad), String(bad)).rejects.toMatchObject({ code: 'unavailable' });
      await expect(readStandings(client, 'bronze', '4:50', bad), String(bad)).rejects.toMatchObject({ code: 'unavailable' });
    }
    expect(calls).toHaveLength(0);
  });
  it('rejects malformed standings cursors and leagues before any query and reports a world with no season yet', async () => {
    const calls: string[] = [], client = seasonApi({ seasons: [], arena_standings: [] }, calls);
    for (const cursor of ['4:50,rating.lt.0', '4', 'x:1', '99999999999999999:1', '']) {
      await expect(readStandings(client, 'bronze', cursor)).rejects.toMatchObject({ code: 'unavailable' });
    }
    await expect(readStandings(client, 'platinum' as never)).rejects.toMatchObject({ code: 'unavailable' });
    expect(calls).toHaveLength(0);
    // No public.seasons row and no projection row: no season yet.
    expect(await readStandings(client, 'gold')).toEqual({ league: 'gold', seasonId: '', archived: false, rows: [], nextCursor: null });
    expect(calls).toHaveLength(2);
  });
  // Task 21.4: one gladiator's own row of the current season (the owner's "Your standing" when it is outside the loaded page).
  it('reads one gladiator’s row of the current season from the ranked view, keeping its rank in the whole league', async () => {
    const G = '0d5f8471-d919-428f-9ab7-058c95821757';
    const row = { ...openRow(56), gladiator_id: G };
    const calls: string[] = [];
    expect(await readStandingOf(seasonApi({ seasons: [season(4)], arena_standing_reads: [row] }, calls), 'silver', G)).toEqual({
      rank: 57, gladiatorId: G, name: 'N56', rating: 1044, humanWins: 2, humanLosses: 0, promoted: false, inactive: false, rewardEligible: false, awardPlace: null });
    // The latest season, chosen as the standings read chooses it, then one row of its ranked view (the rank is the view's).
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('/seasons?select=season_index,closed_at_ms&order=season_index.desc&limit=1');
    const query = new URL(`http://local${calls[1]}`);
    expect([query.pathname, query.searchParams.get('select'), query.searchParams.get('league'), query.searchParams.get('season_index'),
      query.searchParams.get('gladiator_id'), query.searchParams.get('limit')]).toEqual(['/rest/v1/arena_standing_reads',
      'gladiator_id,name,rating,human_wins,human_losses,rank,promoted,reward_eligible', 'eq.silver', 'eq.4', `eq.${G}`, '1']);
    expect(query.searchParams.has('rank')).toBe(false);
    // No rating row in the current season: not ranked.
    expect(await readStandingOf(seasonApi({ seasons: [season(4)], arena_standing_reads: [] }, []), 'silver', G)).toBeNull();
    // The latest season is closed (no current season): nothing, without reading the view.
    calls.length = 0;
    expect(await readStandingOf(seasonApi({ seasons: [season(3, 1)], arena_standing_reads: [row] }, calls), 'silver', G)).toBeNull();
    expect(calls).toHaveLength(1);
    // With no public.seasons row yet, the latest season of the projection table, as the standings read does; with none, nothing.
    calls.length = 0;
    expect(await readStandingOf(seasonApi({ seasons: [], arena_standings: [{ season_index: 6 }], arena_standing_reads: [row] }, calls), 'bronze', G))
      .toMatchObject({ rank: 57, gladiatorId: G });
    expect(calls.map(c => c.split('?')[0].split('/').at(-1))).toEqual(['seasons', 'arena_standings', 'arena_standing_reads']);
    expect(calls[2]).toMatch(/season_index=eq\.6/);
    expect(await readStandingOf(seasonApi({ seasons: [], arena_standings: [] }, []), 'bronze', G)).toBeNull();
    // An upper-case id reads as its canonical lower-case form; a malformed league or gladiator id is refused before any query.
    calls.length = 0;
    await readStandingOf(seasonApi({ seasons: [season(4)], arena_standing_reads: [] }, calls), 'bronze', G.toUpperCase());
    expect(new URL(`http://local${calls[1]}`).searchParams.get('gladiator_id')).toBe(`eq.${G}`);
    calls.length = 0;
    const client = seasonApi({ seasons: [season(4)], arena_standing_reads: [row] }, calls);
    for (const bad of ['', 'g1', `${G},rating.lt.0`, `${G})`, ` ${G}`, 'x'.repeat(36), 4 as never, null as never]) {
      await expect(readStandingOf(client, 'bronze', bad), String(bad)).rejects.toMatchObject({ code: 'unavailable' });
    }
    await expect(readStandingOf(client, 'platinum' as never, G)).rejects.toMatchObject({ code: 'unavailable' });
    expect(calls).toHaveLength(0);
  });
  it('maps prestige into PrestigeAward with a string seasonId', async () => {
    const actor = { gladiatorId: 'g1', name: 'Aster' };
    const calls: string[] = [];
    const prestige = [{ seasonIndex: 0, league: 'bronze', place: 3, badge: 'bronze', title: null },
      { seasonIndex: 12, league: 'silver', place: 1, badge: 'gold', title: 'champion' }];
    const profile = await readProfile(seasonApi({ public_profile_reads: { profile: { actor, combatStrength: 410, rating: 1012, prestige } } }, calls), 'g1');
    expect(profile).toEqual({ actor, combatStrength: 410, rating: 1012, prestige: [
      { seasonId: '0', league: 'bronze', place: 3, badge: 'bronze', title: null },
      { seasonId: '12', league: 'silver', place: 1, badge: 'gold', title: 'champion' }] });
    expect(calls[0]).toContain('/public_profile_reads?select=profile&gladiator_id=eq.g1');
    // No award is an empty list.
    expect((await readProfile(seasonApi({ public_profile_reads: { profile: { actor, combatStrength: null, rating: 1000, prestige: [] } } }, []), 'g1')).prestige).toEqual([]);
    // Anything that is not the projection's award list (the earlier string badges, a missing or malformed entry) is unavailable.
    const bad: unknown[] = [['gold'], null, undefined, 'gold', [{ seasonIndex: '0', league: 'bronze', place: 3, badge: 'bronze', title: null }],
      [{ seasonIndex: -1, league: 'bronze', place: 3, badge: 'bronze', title: null }], [{ seasonIndex: 0, league: 'platinum', place: 3, badge: 'bronze', title: null }],
      [{ seasonIndex: 0, league: 'bronze', place: 4, badge: 'bronze', title: null }], [{ seasonIndex: 0, league: 'bronze', place: 3, badge: 'copper', title: null }],
      [{ seasonIndex: 0, league: 'bronze', place: 3, badge: 'bronze', title: 'king' }], [{ seasonIndex: 0, league: 'bronze', place: 3, badge: 'bronze' }], [null]];
    for (const value of bad) {
      await expect(readProfile(seasonApi({ public_profile_reads: { profile: { actor, combatStrength: 1, rating: 1, prestige: value } } }, []), 'g1'), JSON.stringify(value))
        .rejects.toMatchObject({ code: 'unavailable' });
    }
  });
  /** The public tournament rows of one view: the frame row, due results, placements and their public completions. */
  function tournament(tables: Record<string, unknown>, calls: string[], now: number) {
    return createClient('http://127.0.0.1:54321', 'test-key', { auth: { persistSession: false }, global: { fetch: async (input) => {
      const url = new URL(String(input)); calls.push(decodeURIComponent(url.pathname + url.search));
      const table = url.pathname.split('/').at(-1)!;
      const body = table === 'world_revision' ? { revision: '3', server_now_ms: now, slot_index: 301 } : tables[table];
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } } });
  }
  const S = 301 * 4_800_000;
  const entrant = (id: string, name: string) => ({ gladiatorId: id, name, classId: 'guardian' });
  const view = { id: 'tournament:301:bronze', slot_index: 301, league: 'bronze', starts_at_ms: S, ends_at_ms: S + 4_800_000, status: 'active',
    entrants: [entrant('g2', 'Varro'), entrant('g1', 'Aster')], bracket: { size: 2, rounds: 1, slots: ['g1', 'g2'] },
    bouts: [{ id: 'tournament:301:bronze:1:0', round: 1, position: 0, parentBoutIds: [] }], reveal_at_ms: [S + 2_400_000] };
  const result = { participants: [entrant('g1', 'Aster'), entrant('g2', 'Varro')], winnerId: 'g1', bye: false };
  const completion = (activity: string, outcome: string) => ({ activityId: activity, resolvedKind: 'tournament', result: outcome,
    success: outcome === 'victory', settledAtMs: S + 4_800_000, replayExpiry: { state: 'expired' } });
  // Polled rows carry only the result fields the view needs (JSON-path selection), never the battle log.
  const due = [{ bout_id: view.bouts[0].id, ordinal: 0, participants: result.participants, winnerId: 'g1', bye: false,
    durationMs: null, victoryReason: null, tieBreakReason: null }];
  it('reads a tournament from its public rows: the seeded first round, due results only, and placements once every entrant settled', async () => {
    const calls: string[] = [];
    // Before round one is due: the bracket and no result; active.
    const early = await readTournament(tournament({ tournament_views: view, tournament_bout_results: [], tournament_placements: [] }, calls, S + 1_000), view.id);
    expect(early).toEqual({ id: view.id, league: 'bronze', slotIndex: 301, startsAtMs: S, endsAtMs: S + 4_800_000, status: 'active',
      bracket: view.bracket, entrants: [entrant('g1', 'Aster'), entrant('g2', 'Varro')],
      bouts: [{ id: 'tournament:301:bronze:1:0', round: 1, position: 0, parentBoutIds: [], revealedResult: null }], placements: [] });
    // Results come only from due rows, filtered by the sampled server time as well as by RLS, in pages of at most 50.
    const results = calls.find(c => c.includes('tournament_bout_results'))!;
    expect(results).toContain(`reveal_at_ms=lte.${S + 1_000}`);
    expect(results).toContain('limit=50');
    // Only the fields the view needs cross: participants, winner, bye and the fight summary, never the battle log itself.
    expect(new URL(`http://local${results}`).searchParams.get('select')!.split(',')).toEqual(['bout_id', 'ordinal',
      'participants:result->participants', 'winnerId:result->>winnerId', 'bye:result->bye', 'fight:result->fight', 'durationMs:result->battleLog->durationMs',
      'victoryReason:result->battleLog->>victoryReason', 'tieBreakReason:result->battleLog->>tieBreakReason']);
    // A due round without its result is processing, never invented.
    const late = await readTournament(tournament({ tournament_views: view, tournament_bout_results: [], tournament_placements: [] }, [], S + 2_400_000), view.id);
    expect(late.status).toBe('processing');
    const shown = await readTournament(tournament({ tournament_views: view, tournament_bout_results: due, tournament_placements: [] }, [], S + 2_400_000), view.id);
    expect([shown.status, shown.bouts[0].revealedResult]).toEqual(['active', result]);
    // A fought result carries its fight summary (duration, victory and tie-break reasons) in place of the log.
    const fought = [{ ...due[0], durationMs: 9_000, victoryReason: 'tie-break', tieBreakReason: 'simultaneous-defeat' }];
    const summarized = await readTournament(tournament({ tournament_views: view, tournament_bout_results: fought, tournament_placements: [] }, [], S + 2_400_000), view.id);
    expect(summarized.bouts[0].revealedResult).toEqual({ ...result, fight: { durationMs: 9_000, victoryReason: 'tie-break', tieBreakReason: 'simultaneous-defeat' } });
    expect(JSON.stringify(summarized)).not.toContain('battleLog');
    // Task 22.5: seven days after the tournament, cleanup compacts the log to `result.fight`; the read keeps showing it
    // (only its three fields cross), and prefers it to anything read through a log.
    const compacted = [{ ...due[0], fight: { durationMs: 12_000, victoryReason: 'defeat', tieBreakReason: null, extra: 'never shown' } }];
    const aged = await readTournament(tournament({ tournament_views: view, tournament_bout_results: compacted, tournament_placements: [] }, [], S + 4_800_000 + 8 * 86_400_000), view.id);
    expect(aged.bouts[0].revealedResult).toEqual({ ...result, fight: { durationMs: 12_000, victoryReason: 'defeat', tieBreakReason: null } });
    const both = [{ ...fought[0], fight: { durationMs: 12_000, victoryReason: 'defeat', tieBreakReason: null } }];
    expect((await readTournament(tournament({ tournament_views: view, tournament_bout_results: both, tournament_placements: [] }, [], S + 2_400_000), view.id))
      .bouts[0].revealedResult!.fight).toEqual({ durationMs: 12_000, victoryReason: 'defeat', tieBreakReason: null });
    // One entrant settled: no placement yet, and processing after minute 80.
    const one = await readTournament(tournament({ tournament_views: view, tournament_bout_results: due,
      tournament_placements: [{ gladiator_id: 'g1', activity_id: 'a1', place: 1 }], recent_results: [{ activity_id: 'a1', summary: completion('a1', 'victory') }] },
      [], S + 4_800_000), view.id);
    expect([one.status, one.placements]).toEqual(['processing', []]);
    // Every entrant settled: public place and completion only, by place.
    const done = await readTournament(tournament({ tournament_views: view, tournament_bout_results: due,
      tournament_placements: [{ gladiator_id: 'g2', activity_id: 'a2', place: 2 }, { gladiator_id: 'g1', activity_id: 'a1', place: 1 }],
      recent_results: [{ activity_id: 'a1', summary: completion('a1', 'victory') }, { activity_id: 'a2', summary: completion('a2', 'defeat') }] }, [], S + 4_800_000), view.id);
    expect([done.status, done.placements]).toEqual(['completed', [{ gladiatorId: 'g1', place: 1, completion: completion('a1', 'victory') },
      { gladiatorId: 'g2', place: 2, completion: completion('a2', 'defeat') }]]);
    // A league below the minimum.
    const insufficient = await readTournament(tournament({ tournament_views: { ...view, status: 'insufficient-entrants', bracket: null, bouts: [], reveal_at_ms: [],
      entrants: [entrant('g9', 'Valeria')] }, tournament_bout_results: [], tournament_placements: [] }, [], S + 4_900_000), view.id);
    expect(insufficient).toMatchObject({ status: 'insufficient-entrants', bracket: null, bouts: [], placements: [], entrants: [entrant('g9', 'Valeria')] });
  });
  it('builds the lookup id of a league tournament and rejects malformed ids before any query', async () => {
    expect(tournamentLookupId(301, 'gold')).toBe('tournament:301:gold');
    expect(() => tournamentLookupId(-1, 'gold')).toThrow();
    expect(() => tournamentLookupId(301, 'platinum' as never)).toThrow();
    const calls: string[] = [], client = tournament({}, calls, 0);
    for (const id of ['tournament:301:platinum', 'tournament:x:bronze', 'tournament:301:bronze:1:0', 'tournament:301:bronze,id.neq.x', '']) {
      await expect(readTournament(client, id), id).rejects.toMatchObject({ code: 'not-found' });
    }
    expect(calls).toHaveLength(0);
    await expect(readTournament(tournament({ tournament_views: null }, calls, 0), 'tournament:301:bronze')).rejects.toMatchObject({ code: 'not-found' });
  });
  it('loads one revealed bout’s log on demand, filtered by the sampled server time as well as by RLS', async () => {
    const id = 'tournament:301:bronze:1:0', log = { battleId: id, durationMs: 9_000, winnerId: 'g1', participants: [], events: [] };
    const calls: string[] = [];
    expect(await readTournamentLog(tournament({ tournament_bout_results: { battleLog: log } }, calls, S + 2_400_000), id)).toEqual(log);
    const query = calls.find(c => c.includes('tournament_bout_results'))!;
    expect(new URL(`http://local${query}`).searchParams.get('select')).toBe('battleLog:result->battleLog');
    expect(query).toContain(`bout_id=eq.${id}`);
    expect(query).toContain(`reveal_at_ms=lte.${S + 2_400_000}`);
    // Not due (no row under RLS) or a bye (no log): not found.
    for (const row of [null, { battleLog: null }]) {
      await expect(readTournamentLog(tournament({ tournament_bout_results: row }, [], S), id)).rejects.toMatchObject({ code: 'not-found' });
    }
    // Task 22.5: from seven days after the tournament's end (its slot's end) the log is no longer kept, by the sampled server
    // time: not-found without asking for it, whether or not cleanup has compacted it yet.
    const end = S + 4_800_000, week = 604_800_000;
    expect(await readTournamentLog(tournament({ tournament_bout_results: { battleLog: log } }, [], end + week - 1), id)).toEqual(log);
    const expired: string[] = [];
    await expect(readTournamentLog(tournament({ tournament_bout_results: { battleLog: log } }, expired, end + week), id)).rejects.toMatchObject({ code: 'not-found' });
    expect(expired.map(c => c.split('?')[0].split('/').at(-1))).toEqual(['world_revision']);
    // Malformed bout ids never reach a query.
    const none: string[] = [], client = tournament({}, none, 0);
    for (const bad of ['tournament:301:bronze', 'tournament:301:bronze:1:0,bout_id.neq.x', 'tournament:301:platinum:1:0', 'x', '']) {
      await expect(readTournamentLog(client, bad), bad).rejects.toMatchObject({ code: 'not-found' });
    }
    expect(none).toHaveLength(0);
  });
});
