import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql, account, admin, anonymous, resetIdentity, creation, request, directEdge, tokenFor, recordingClient } from '../fixtures/db.ts';
import { makeVerifier } from '../../supabase/functions/_shared/backend/auth.ts';
import { createDatabase } from '../../supabase/functions/_shared/backend/database.ts';
import { handleCommand } from '../../supabase/functions/_shared/backend/commands.ts';
import { readNotifications, readOwner } from '../../src/lib/api/reads.ts';

// Notifications (2026-10-28, M25; spec "Added 2026-10-28: notifications"). What a player's own settled activities earned is read from
// the activities the owner already reads (nothing new is stored per result). Only one thing is new: each account's "seen up to" time
// (public.notification_marks, owner-only, written by public.see_notifications with no receipt). The owner read's `inbox` says how many
// completed, revealed, non-rest results settled after the mark (or after the gladiator's creation without one) and the mark itself.
const database = createDatabase(admin);
const deps = { database, verifyActor: makeVerifier(anonymous), allowedOrigins: ['http://127.0.0.1:3000'] };
const handle = async (token: string, body: unknown) => { const response = await handleCommand(request(token, body), deps); return { status: response.status, body: await response.json() }; };
beforeEach(resetIdentity);
afterAll(() => sql.end());

/** The database's own clock (the container's may differ from this host's). */
const dbNow = async () => Number((await sql`select floor(extract(epoch from clock_timestamp())*1000)::bigint as ms`)[0].ms);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const revision = async () => (await sql`select revision::int as revision from public.world_revision_state where singleton`)[0].revision as number;
/** A signed-in account with a gladiator, and the time the gladiator was created. */
async function player(name: string) {
  const owner = await account();
  const created = await database.createGladiator({ userId: owner.id }, creation(name));
  if (!created.ok) throw Error('creation failed');
  const [{ at }] = await sql`select created_at_ms::bigint as at from public.gladiators where id=${created.value.gladiatorId}`;
  await sleep(10);
  return { ...owner, gid: created.value.gladiatorId, createdAt: Number(at) };
}
type Kind = 'training' | 'expedition' | 'arena' | 'tournament' | 'rest';
type Earned = Partial<{ money: number; renown: number; xp: number; attributePoints: number; overflowMoney: number }>;
let nextSlot = 1000;
/** One activity row, as settlement leaves it (a completed one carries its summary and settlement time). */
async function activity(gid: string, kind: Kind, over: { settledAt?: number | null; status?: 'completed' | 'active'; earned?: Earned; expeditionId?: string; ratingDelta?: number } = {}) {
  const { settledAt = await dbNow(), status = 'completed', earned = {}, expeditionId = 'woodland', ratingDelta } = over;
  const slot = nextSlot++, id = randomUUID();
  const requested = kind === 'expedition' ? { kind, expeditionId } : { kind };
  const summary = status === 'completed' ? { activityId: id, resolvedKind: kind, result: kind === 'training' || kind === 'rest' ? 'completed' : 'victory', success: true,
    rewards: { money: 0, renown: 0, xp: 0, attributePoints: 0, items: [], overflowMoney: 0, ...earned }, receiptId: randomUUID(), settledAtMs: settledAt,
    replayExpiry: { state: 'expired' }, ...(ratingDelta === undefined ? {} : { ratingDelta }) } : null;
  await sql`insert into public.activities(id,gladiator_id,slot_index,starts_at_ms,ends_at_ms,requested,resolved_kind,status,published_at_ms,summary,settled_at_ms)
    values(${id},${gid},${slot},${slot * 4_800_000},${(slot + 1) * 4_800_000},${sql.json(requested)},${kind},${status},0,${summary ? sql.json(summary) : null},${status === 'completed' ? settledAt : null})`;
  return id;
}
/** `public.see_notifications` as the backend calls it (service_role). */
const see = async (actor: string | null, upTo: number | null) => {
  const { data, error } = await admin.rpc('see_notifications', { actor_id: actor, up_to_ms: upTo });
  expect(error).toBeNull();
  return data;
};
const markOf = async (ownerId: string) => (await sql`select seen_ms::bigint as seen from public.notification_marks where owner_id=${ownerId}`).map(r => Number(r.seen));
const inboxOf = async (ownerId: string) => (await sql`select state->'inbox' as inbox from public.owner_state where owner_id=${ownerId}`)[0]?.inbox;
const receipts = async (ownerId: string) => (await sql`select count(*)::int as n from public.operation_receipts where owner_id=${ownerId}`)[0].n as number;

describe('notifications', () => {
  it('counts a settled training after the gladiator was created as one new notification; the mark starts at the creation time', async () => {
    const owner = await player('Note Owner');
    expect((await readOwner(owner.client)).inbox).toEqual({ unread: 0, readIds: [], sinceMs: owner.createdAt, newNotifications: 0, notificationsSeenMs: owner.createdAt });
    await activity(owner.gid, 'training', { earned: { attributePoints: 1 } });
    const expected = { unread: 0, readIds: [], sinceMs: owner.createdAt, newNotifications: 1, notificationsSeenMs: owner.createdAt };
    expect((await readOwner(owner.client)).inbox).toEqual(expected);
    // A second session of the same account reads the same; so do the backend (past row security) and the database owner.
    expect((await readOwner(recordingClient(tokenFor(owner.id)).client)).inbox).toEqual(expected);
    expect(((await admin.from('owner_state').select('state').eq('owner_id', owner.id).single()).data!.state as { inbox: unknown }).inbox).toEqual(expected);
    expect(await inboxOf(owner.id)).toEqual(expected);
    // A result that settled at the creation time itself is not after it (strictly after counts): still one.
    await activity(owner.gid, 'training', { settledAt: owner.createdAt });
    expect((await readOwner(owner.client)).inbox.newNotifications).toBe(1);
    // Every kind that earns something counts, once each.
    await activity(owner.gid, 'expedition', { earned: { money: 20, xp: 100 } });
    await activity(owner.gid, 'arena', { earned: { renown: 5 }, ratingDelta: 3 });
    await activity(owner.gid, 'tournament', { earned: { money: 50, renown: 5 } });
    expect((await readOwner(owner.client)).inbox.newNotifications).toBe(4);
  });

  it('sees notifications: sets the mark, never moves it back, cuts a future time to now, and leaves another account\'s mark alone', async () => {
    const a = await player('Seen A'), b = await player('Seen B');
    const t1 = await dbNow(); await sleep(8);
    const t2 = await dbNow(); await sleep(8);
    const t3 = await dbNow();
    for (const t of [t1, t2, t3]) { await activity(a.gid, 'training', { settledAt: t }); await activity(b.gid, 'training', { settledAt: t }); }
    expect((await readOwner(a.client)).inbox).toMatchObject({ newNotifications: 3, notificationsSeenMs: a.createdAt });
    const [before, receiptsBefore] = [await revision(), [await receipts(a.id), await receipts(b.id)]];
    // The mark is the time asked: what settled at or before it is seen, the later one is still new.
    expect(await see(a.id, t2)).toEqual({ ok: true, value: { seenMs: t2 } });
    expect(await markOf(a.id)).toEqual([t2]);
    expect((await readOwner(a.client)).inbox).toMatchObject({ newNotifications: 1, notificationsSeenMs: t2 });
    // A lower time never moves it back, and the answer says where the mark stands.
    expect(await see(a.id, t1)).toEqual({ ok: true, value: { seenMs: t2 } });
    expect(await see(a.id, 0)).toEqual({ ok: true, value: { seenMs: t2 } });
    expect(await markOf(a.id)).toEqual([t2]);
    // A later time moves it on.
    expect(await see(a.id, t3)).toEqual({ ok: true, value: { seenMs: t3 } });
    expect((await readOwner(a.client)).inbox).toMatchObject({ newNotifications: 0, notificationsSeenMs: t3 });
    // A future time is cut to the database's now: nothing settling later is ever pre-seen.
    const from = await dbNow();
    const cut = await see(a.id, from + 3_600_000);
    const to = await dbNow();
    expect(cut.ok).toBe(true);
    expect(cut.value.seenMs).toBeGreaterThanOrEqual(from);
    expect(cut.value.seenMs).toBeLessThanOrEqual(to);
    expect(await markOf(a.id)).toEqual([cut.value.seenMs]);
    expect(await see(a.id, Number.MAX_SAFE_INTEGER)).toMatchObject({ ok: true });
    expect((await markOf(a.id))[0]).toBeLessThanOrEqual(await dbNow());
    // A mark writes no receipt and changes nothing public (no world revision bump).
    expect(await revision()).toBe(before);
    // So a result that settles afterwards is new again.
    await sleep(8);
    await activity(a.gid, 'training');
    expect((await readOwner(a.client)).inbox.newNotifications).toBe(1);
    // The other account was never touched: no mark, its own count, until it asks.
    expect(await markOf(b.id)).toEqual([]);
    expect((await readOwner(b.client)).inbox).toMatchObject({ newNotifications: 3, notificationsSeenMs: b.createdAt });
    const markA = await markOf(a.id);
    expect(await see(b.id, t1)).toEqual({ ok: true, value: { seenMs: t1 } });
    expect(await markOf(a.id)).toEqual(markA);
    expect((await readOwner(b.client)).inbox).toMatchObject({ newNotifications: 2, notificationsSeenMs: t1 });
    expect([await receipts(a.id), await receipts(b.id)]).toEqual(receiptsBefore);
  });

  it('never reports a mark below the gladiator\'s creation: a time before it counts the same as no mark', async () => {
    const owner = await player('Early Mark');
    await activity(owner.gid, 'training');
    expect(await see(owner.id, 1)).toEqual({ ok: true, value: { seenMs: 1 } });
    expect((await readOwner(owner.client)).inbox).toMatchObject({ newNotifications: 1, notificationsSeenMs: owner.createdAt });
  });

  it('does not count an unrevealed Arena result, a rest, an unfinished activity or another account\'s result', async () => {
    const owner = await player('Counting'), other = await player('Counted Out');
    const future = (await dbNow()) + 600_000;
    const unrevealed = await activity(owner.gid, 'arena', { settledAt: future, earned: { renown: 9 }, ratingDelta: 4 });
    await activity(owner.gid, 'rest');
    await activity(owner.gid, 'training', { status: 'active' });
    await activity(other.gid, 'training');
    const inbox = async () => (await readOwner(owner.client)).inbox;
    expect(await inbox()).toMatchObject({ newNotifications: 0 });
    expect(await inboxOf(owner.id)).toMatchObject({ newNotifications: 0 });
    expect((await readOwner(other.client)).inbox).toMatchObject({ newNotifications: 1 });
    // Once the reveal time has passed, the same result counts, and the list shows it.
    await sql`update public.activities set settled_at_ms=${(await dbNow()) - 1} where id=${unrevealed}`;
    expect(await inbox()).toMatchObject({ newNotifications: 1 });
    expect((await readNotifications(owner.client)).items.map(n => n.activityId)).toEqual([unrevealed]);
    // A completed result with no summary (never written by settlement) is not counted or listed either.
    await sql`update public.activities set summary=null where id=${unrevealed}`;
    expect(await inbox()).toMatchObject({ newNotifications: 0 });
    expect(await readNotifications(owner.client)).toEqual({ items: [], newestSettledMs: null });
  });

  it('lists the owner\'s results: newest 20 first, revealed and non-rest only, the destination named, and never another account\'s', async () => {
    const owner = await player('Lister'), other = await player('Not Listed');
    const base = (await dbNow()) - 1000;
    const ids: string[] = [];
    for (let i = 0; i < 22; i++) ids.push(await activity(owner.gid, i % 2 ? 'training' : 'expedition', { settledAt: base + i, earned: i % 2 ? { attributePoints: 1 } : { money: 20 }, expeditionId: i % 4 ? 'outpost' : 'woodland' }));
    await activity(owner.gid, 'rest', { settledAt: base + 100 });
    await activity(owner.gid, 'arena', { settledAt: base + 3_600_000 });
    await activity(other.gid, 'training', { settledAt: base + 200, earned: { attributePoints: 1 } });
    const { items: list } = await readNotifications(owner.client);
    // Newest first, 20 of the 22, with no rest, no unrevealed Arena, nothing of the other gladiator.
    expect(list.map(n => n.activityId)).toEqual(ids.slice(2).reverse());
    expect(list.map(n => n.settledAtMs)).toEqual(Array.from({ length: 20 }, (_, i) => base + 21 - i));
    expect(list[0]).toMatchObject({ kind: 'training', destination: null, summary: { resolvedKind: 'training', rewards: { attributePoints: 1 } } });
    expect(list[1]).toMatchObject({ kind: 'expedition', destination: 'Woodland Path' });
    expect(list.find(n => n.activityId === ids[6])).toMatchObject({ kind: 'expedition', destination: 'Ruined Outpost' });
    expect((await readNotifications(other.client)).items.map(n => n.summary.rewards.attributePoints)).toEqual([1]);
    // A visitor has no access to activities at all.
    await expect(readNotifications(anonymous)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('knows the level a result reached from its stored XP and the gladiator\'s level now, and claims none it cannot prove', async () => {
    const owner = await player('Leveller');
    const base = (await dbNow()) - 1000;
    // 100 (level 2), 350 (level 3, 50 XP), 400, 600 (level 4, 0 XP): the XP of four expeditions, with a training and an Arena bout between.
    const first = await activity(owner.gid, 'expedition', { settledAt: base, earned: { xp: 100 } });
    const second = await activity(owner.gid, 'expedition', { settledAt: base + 1, earned: { xp: 250 } });
    const training = await activity(owner.gid, 'training', { settledAt: base + 2, earned: { attributePoints: 1 } });
    const third = await activity(owner.gid, 'expedition', { settledAt: base + 3, earned: { xp: 50 } });
    const arena = await activity(owner.gid, 'arena', { settledAt: base + 4, earned: { renown: 5 } });
    const fourth = await activity(owner.gid, 'expedition', { settledAt: base + 5, earned: { xp: 200 } });
    await sql`update public.gladiators set level=4, xp=0 where id=${owner.gid}`;
    const levels = async () => Object.fromEntries((await readNotifications(owner.client)).items.map(n => [n.activityId, n.levelAfter]));
    expect(await levels()).toEqual({ [first]: 2, [second]: 3, [training]: null, [third]: null, [arena]: null, [fourth]: 4 });
    // Settlement adds the next XP and the gladiator's level moves with it: every earlier result keeps its level.
    const fifth = await activity(owner.gid, 'expedition', { settledAt: base + 6, earned: { xp: 100 } });
    await sql`update public.gladiators set level=4, xp=100 where id=${owner.gid}`;
    expect(await levels()).toEqual({ [first]: 2, [second]: 3, [training]: null, [third]: null, [arena]: null, [fourth]: 4, [fifth]: null });
    // A result that has settled but is not due yet is not listed, yet its XP is already in the gladiator's level (a settlement that commits
    // between the clock read and the list read is the same case): the list cannot account for the level, so no level is claimed, until the
    // result is due and listed.
    const late = await activity(owner.gid, 'expedition', { settledAt: (await dbNow()) + 600_000, earned: { xp: 50 } });
    await sql`update public.gladiators set level=4, xp=150 where id=${owner.gid}`;
    expect(Object.values(await levels()).every(level => level === null)).toBe(true);
    expect(Object.keys(await levels())).not.toContain(late);
    await sql`update public.activities set settled_at_ms=${(await dbNow()) - 1} where id=${late}`;
    expect(await levels()).toEqual({ [first]: 2, [second]: 3, [training]: null, [third]: null, [arena]: null, [fourth]: 4, [fifth]: null, [late]: null });
    // A gladiator whose numbers do not add up is never told a level.
    await sql`update public.gladiators set level=1, xp=0 where id=${owner.gid}`;
    expect(Object.values(await levels()).every(level => level === null)).toBe(true);
  });

  it('refuses a missing account or a bad time, stores nothing, and cannot be called by any client role', async () => {
    const owner = await player('Refused');
    expect(await see(null, 5)).toEqual({ ok: false, code: 'unauthenticated' });
    for (const bad of [null, -1, -9007199254740991]) expect(await see(owner.id, bad), String(bad)).toEqual({ ok: false, code: 'invalid' });
    expect(await markOf(owner.id)).toEqual([]);
    // An account with no gladiator may hold a mark (it only changes that account's own reads).
    const stranger = await account();
    expect(await see(stranger.id, 5)).toEqual({ ok: true, value: { seenMs: 5 } });
    expect(await markOf(stranger.id)).toEqual([5]);
    // Backend only: no client role may call it, so no client can name another account.
    for (const [who, client] of [['player', owner.client], ['visitor', anonymous]] as const) {
      expect((await client.rpc('see_notifications', { actor_id: stranger.id, up_to_ms: 9 })).error?.code, who).toBe('42501');
    }
    expect(await markOf(stranger.id)).toEqual([5]);
    expect(await sql`select p.proacl::text as acl, p.prosecdef as definer, p.proconfig as config, has_function_privilege('anon',p.oid,'EXECUTE') as anon,
      has_function_privilege('authenticated',p.oid,'EXECUTE') as player, has_function_privilege('service_role',p.oid,'EXECUTE') as backend
      from pg_proc p where p.oid='public.see_notifications(uuid,bigint)'::regprocedure`)
      .toEqual([{ acl: '{postgres=X/postgres,service_role=X/postgres}', definer: false, config: ['search_path=""'], anon: false, player: false, backend: true }]);
  });

  it('keeps the marks the owner\'s: a player reads only its own, a visitor none, nobody writes them, and they go with the account', async () => {
    const a = await player('Marks A'), b = await player('Marks B');
    expect(await see(a.id, 7)).toMatchObject({ ok: true });
    expect(await see(b.id, 8)).toMatchObject({ ok: true });
    expect((await a.client.from('notification_marks').select('owner_id,seen_ms')).data).toEqual([{ owner_id: a.id, seen_ms: 7 }]);
    expect((await b.client.from('notification_marks').select('owner_id,seen_ms')).data).toEqual([{ owner_id: b.id, seen_ms: 8 }]);
    expect((await anonymous.from('notification_marks').select('*')).error?.code).toBe('42501');
    for (const [who, client] of [['visitor', anonymous], ['player', a.client]] as const) {
      expect((await client.from('notification_marks').insert({ owner_id: a.id, seen_ms: 1 })).error?.code, `${who} insert`).toBe('42501');
      expect((await client.from('notification_marks').update({ seen_ms: 99 }).eq('owner_id', a.id)).error?.code, `${who} update`).toBe('42501');
      expect((await client.from('notification_marks').delete().eq('owner_id', a.id)).error?.code, `${who} delete`).toBe('42501');
    }
    // Even the backend only reads, inserts and updates its marks (a mark is never deleted by a client or the backend; the account's removal cascades).
    expect((await admin.from('notification_marks').delete().eq('owner_id', a.id)).error?.code).toBe('42501');
    expect(await markOf(a.id)).toEqual([7]);
    const stranger = await account();
    expect(await see(stranger.id, 3)).toMatchObject({ ok: true });
    expect((await admin.auth.admin.deleteUser(stranger.id)).error).toBeNull();
    expect(await markOf(stranger.id)).toEqual([]);
    expect(await markOf(b.id)).toEqual([8]);
  });

  it('keeps every other key of the owner read as it was, and adds exactly the two notification keys to the inbox', async () => {
    const owner = await player('Keys');
    const { data } = await owner.client.from('owner_state').select('state').single();
    const state = data!.state as Record<string, unknown>;
    expect(Object.keys(state).sort()).toEqual(['appearance', 'buildVersion', 'currentActivity', 'currentBuild', 'gladiatorId', 'inbox', 'inventory', 'inventoryCapacity', 'name',
      'ownedCosmetics', 'pendingBuild', 'processedSlotIndex', 'progression', 'reservedFees', 'restingUntilSlot', 'schedule', 'scheduleVersion', 'stamina', 'tournamentOptIn',
      'wallets']);
    expect(Object.keys(state.inbox as object).sort()).toEqual(['newNotifications', 'notificationsSeenMs', 'readIds', 'sinceMs', 'unread']);
    // And the view is still an invoker view: the owner sees only its own row.
    expect((await owner.client.from('owner_state').select('owner_id')).data).toEqual([{ owner_id: owner.id }]);
    expect((await sql`select (c.reloptions)::text as options from pg_class c where c.oid='public.owner_state'::regclass`)[0].options).toBe('{security_invoker=true}');
  });

  it('marks results seen through the command: no receipt, an own-account mark, invalid for a bad body', async () => {
    const owner = await player('Command Seer'), other = await player('Command Other');
    await activity(owner.gid, 'training', { earned: { attributePoints: 1 } });
    const [receiptsBefore, otherReceipts] = [await receipts(owner.id), await receipts(other.id)];
    const upTo = await dbNow();
    const command = { kind: 'see-notifications', operationId: randomUUID(), upToMs: upTo };
    const answer = await handle(owner.token, command);
    expect(answer).toEqual({ status: 200, body: { ok: true, value: { seenMs: upTo } } });
    expect(await markOf(owner.id)).toEqual([upTo]);
    // The same command again, and another operation id for the same time, are the same no-op; neither stores a receipt, and a lower
    // time answers with the mark where it stands.
    expect(await handle(owner.token, command)).toEqual(answer);
    expect(await handle(owner.token, { ...command, operationId: randomUUID() })).toEqual(answer);
    expect(await handle(owner.token, { ...command, operationId: randomUUID(), upToMs: 5 })).toEqual(answer);
    expect(await receipts(owner.id)).toBe(receiptsBefore);
    expect(await markOf(other.id)).toEqual([]);
    // The command names no account: any such key is refused at the boundary, and a bad time never reaches the database.
    for (const bad of [{ ...command, ownerId: other.id }, { ...command, actorId: other.id }, { ...command, upToMs: -1 }, { ...command, upToMs: 1.5 },
      { ...command, upToMs: String(upTo) }, { ...command, extra: 1 }, { kind: 'see-notifications', operationId: command.operationId }]) {
      expect(await handle(owner.token, bad), JSON.stringify(bad)).toEqual({ status: 400, body: { ok: false, code: 'invalid' } });
    }
    expect(await markOf(other.id)).toEqual([]);
    expect([await receipts(owner.id), await receipts(other.id)]).toEqual([receiptsBefore, otherReceipts]);
    // It moves the owner read at once.
    expect((await readOwner(owner.client)).inbox).toMatchObject({ newNotifications: 0, notificationsSeenMs: upTo });
  });

  it('marks results seen through the real local Edge runtime, which refuses a bad time and a missing session', async () => {
    const owner = await player('Edge Seer');
    const upTo = await dbNow(), command = { kind: 'see-notifications', operationId: randomUUID(), upToMs: upTo };
    const seen = directEdge(owner.token, command);
    expect([seen.status, seen.body]).toEqual([200, { ok: true, value: { seenMs: upTo } }]);
    expect(await markOf(owner.id)).toEqual([upTo]);
    expect(directEdge(owner.token, { ...command, upToMs: -1 })).toMatchObject({ status: 400, body: { ok: false, code: 'invalid' } });
    expect(directEdge(owner.token, { ...command, ownerId: owner.id })).toMatchObject({ status: 400, body: { ok: false, code: 'invalid' } });
    expect(directEdge('not-a-token', command)).toMatchObject({ status: 401, body: { ok: false, code: 'unauthenticated' } });
    expect(await receipts(owner.id)).toBe(1);
  });

  it('orders its source: the marks table before the see function and before the view that reads it, the view restated after both (M24 lesson)', () => {
    const source = readFileSync(new URL('../../supabase/sql/18-messages.sql', import.meta.url), 'utf8');
    const at = (needle: string, from = 0) => { const i = source.indexOf(needle, from); expect(i, needle).toBeGreaterThan(-1); return i; };
    const marks = at('create table if not exists public.notification_marks'), fn = at('create or replace function public.see_notifications');
    const firstView = at('create or replace view public.owner_state'), lastView = source.lastIndexOf('create or replace view public.owner_state');
    expect(firstView).toBeLessThan(marks);
    expect(marks).toBeLessThan(fn);
    expect(lastView).toBeGreaterThan(fn);
    // The final view (the one that stands once the file is applied) is the one that reads the marks and carries the new keys.
    const tail = source.slice(lastView);
    expect(tail).toContain('public.notification_marks');
    expect(tail).toContain("'newNotifications'");
    expect(tail).toContain("'notificationsSeenMs'");
    expect(source.slice(firstView, marks)).not.toContain('public.notification_marks');
  });
});
