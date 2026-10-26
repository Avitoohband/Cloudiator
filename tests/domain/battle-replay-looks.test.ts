import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BattleLog } from '@contracts/events';
import type { Appearance } from '@domain/appearance';
import { loadAssetManifest } from '@/game/assets';
import { planStage } from '@/game/battle-stage';
import { LOOKS_TIMEOUT_MS, appearancesOf, loadLooks, lookIdsFor, type LookMap, type LookReader } from '@/game/replay-looks';
import { FIXTURE_BATTLE_LOGS } from '../fixtures/battles';

const manifest = loadAssetManifest();
const pvp: BattleLog = FIXTURE_BATTLE_LOGS.pvp;
const npc: BattleLog = FIXTURE_BATTLE_LOGS.npc;
// Nobody in the tie bout wears head gear, so every chosen hair style is drawn (it is hidden under a helmet or hood).
const tie: BattleLog = FIXTURE_BATTLE_LOGS.tie;
const CASSIA = tie.participants[1].gladiatorId!;
const [ASTER, VARRO] = [pvp.participants[0].gladiatorId!, pvp.participants[1].gladiatorId!];
const FEMALE: Appearance = { body: 'female', hair: 'ponytail', skin: 1, hairColor: 2, cloth: 4 };
const BALD: Appearance = { body: 'male', hair: 'bald', skin: 3, hairColor: 0, cloth: 7 };
const layerIds = (log: BattleLog, looks?: LookMap) => planStage(log, manifest, looks).looks.map(look => look.layers.map(l => l.id));

/** A read the test settles by hand. */
function pendingRead() {
  const calls: (readonly string[])[] = [];
  let resolve!: (looks: LookMap) => void;
  let reject!: (error: unknown) => void;
  const read: LookReader = ids => { calls.push(ids); return new Promise((res, rej) => { resolve = res; reject = rej; }); };
  return { read, calls, resolve: (looks: LookMap) => resolve(looks), reject: (error: unknown) => reject(error) };
}

describe('replay looks: which fighters need one', () => {
  it('names the gladiator participants only, once each', () => {
    expect(lookIdsFor(pvp)).toEqual([ASTER, VARRO]);
    // An NPC fallback and a creature have no gladiator id and keep their own art.
    expect(lookIdsFor(npc)).toEqual([ASTER]);
    expect(lookIdsFor(FIXTURE_BATTLE_LOGS['expedition-2'])).toEqual([ASTER]);
    const twice = { ...pvp, participants: [pvp.participants[0], pvp.participants[0]] } as BattleLog;
    expect(lookIdsFor(twice)).toEqual([ASTER]);
  });

  it('names the gladiators of every battle of a replay once (an expedition has several encounters)', () => {
    expect(lookIdsFor(FIXTURE_BATTLE_LOGS['expedition-1'], FIXTURE_BATTLE_LOGS['expedition-2'], FIXTURE_BATTLE_LOGS['expedition-3'])).toEqual([ASTER]);
    expect(lookIdsFor(pvp, tie)).toEqual([ASTER, VARRO, CASSIA]);
    expect(lookIdsFor()).toEqual([]);
  });

  it('takes the known looks from the world actors a caller already holds (a missing key is the legacy look)', () => {
    const known = appearancesOf([
      { gladiatorId: ASTER, appearance: FEMALE },
      { gladiatorId: VARRO, appearance: null },
      { gladiatorId: 'older-cached-actor' } as { gladiatorId: string; appearance?: Appearance | null },
      { gladiatorId: 'junk', appearance: { body: 'robot' } as unknown as Appearance },
    ]);
    expect(known.get(ASTER)).toEqual(FEMALE);
    expect(known.get(VARRO)).toBeNull();
    expect(known.get('older-cached-actor')).toBeNull();
    expect(known.get('junk')).toBeNull();
    expect(appearancesOf(null).size).toBe(0);
    expect(appearancesOf(undefined).size).toBe(0);
  });
});

describe('replay looks: waiting for the read', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('waits at most 1.5 seconds', () => {
    expect(LOOKS_TIMEOUT_MS).toBe(1500);
  });

  it('settles with the looks that arrive, and draws them', async () => {
    const read = pendingRead();
    const settled = vi.fn();
    loadLooks({ ids: lookIdsFor(tie), read: read.read, onSettled: settled });
    await vi.advanceTimersByTimeAsync(300);
    expect(settled, 'the scene must not mount before the looks arrive').not.toHaveBeenCalled();
    expect(read.calls).toEqual([[ASTER, CASSIA]]);
    read.resolve(new Map<string, Appearance | null>([[ASTER, FEMALE], [CASSIA, BALD]]));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledTimes(1);
    const looks: LookMap = settled.mock.calls[0][0];
    expect(looks.get(ASTER)).toEqual(FEMALE);
    expect(looks.get(CASSIA)).toEqual(BALD);
    const [left, right] = layerIds(tie, looks);
    expect(left).toContain('body-female');
    expect(left).toContain('hair-ponytail');
    expect(left).not.toContain('body');
    expect(right).toContain('body');
    expect(right.some(id => id.startsWith('hair')), 'bald draws no hair').toBe(false);
    // ... where the legacy look has short hair.
    expect(layerIds(tie)[1]).toContain('hair');
    // The timeout is cleared once the looks are in.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('mounts with the legacy look when the read times out', async () => {
    const read = pendingRead();
    const settled = vi.fn();
    loadLooks({ ids: [ASTER, VARRO], read: read.read, onSettled: settled });
    await vi.advanceTimersByTimeAsync(LOOKS_TIMEOUT_MS - 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledTimes(1);
    const looks: LookMap = settled.mock.calls[0][0];
    expect(looks.size).toBe(0);
    expect(layerIds(pvp, looks)).toEqual(layerIds(pvp));
    expect(layerIds(pvp, looks)[0]).toContain('body');
    // A late answer never reaches the scene: it would swap the look mid-play.
    read.resolve(new Map<string, Appearance | null>([[ASTER, FEMALE]]));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('keeps the looks it already knew when the read times out', async () => {
    const read = pendingRead();
    const settled = vi.fn();
    loadLooks({ ids: [ASTER, VARRO], known: new Map([[ASTER, FEMALE]]), read: read.read, onSettled: settled });
    expect(read.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(read.calls).toEqual([[VARRO]]);
    await vi.advanceTimersByTimeAsync(LOOKS_TIMEOUT_MS);
    const looks: LookMap = settled.mock.calls[0][0];
    expect([...looks]).toEqual([[ASTER, FEMALE]]);
    expect(layerIds(pvp, looks)[0]).toContain('body-female');
    expect(layerIds(pvp, looks)[1]).toContain('body');
  });

  it('mounts with the legacy look at once when the read fails (rejects or throws)', async () => {
    const rejected = pendingRead();
    const first = vi.fn();
    loadLooks({ ids: [ASTER, VARRO], read: rejected.read, onSettled: first });
    await vi.advanceTimersByTimeAsync(0);
    rejected.reject(new Error('unavailable'));
    await vi.advanceTimersByTimeAsync(0);
    expect(first).toHaveBeenCalledTimes(1);
    expect(first.mock.calls[0][0].size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    const second = vi.fn();
    loadLooks({ ids: [ASTER], read: () => { throw new Error('boom'); }, onSettled: second });
    await vi.advanceTimersByTimeAsync(0);
    expect(second).toHaveBeenCalledTimes(1);
    expect(second.mock.calls[0][0].size).toBe(0);
  });

  it('does not read ids the caller already knows, and reads nothing when it knows them all', async () => {
    const some = pendingRead();
    const load = loadLooks({ ids: [ASTER, VARRO], known: new Map([[ASTER, FEMALE]]), read: some.read, onSettled: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(some.calls).toEqual([[VARRO]]);
    load.cancel();

    const none = vi.fn<LookReader>();
    const settled = vi.fn();
    loadLooks({ ids: [ASTER, VARRO], known: new Map<string, Appearance | null>([[ASTER, FEMALE], [VARRO, null]]), read: none, onSettled: settled });
    await vi.advanceTimersByTimeAsync(0);
    expect(none).not.toHaveBeenCalled();
    expect(settled).toHaveBeenCalledTimes(1);
    const looks: LookMap = settled.mock.calls[0][0];
    expect(looks.get(ASTER)).toEqual(FEMALE);
    expect(looks.get(VARRO)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles with the legacy look at once when there is no reader', async () => {
    const settled = vi.fn();
    loadLooks({ ids: [ASTER, VARRO], onSettled: settled });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled.mock.calls[0][0].size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('merges the answer with what was known, asks for each id once and ignores ids it did not ask for', async () => {
    const read = pendingRead();
    const settled = vi.fn();
    loadLooks({ ids: [ASTER, VARRO, ASTER, VARRO], known: new Map([[ASTER, FEMALE]]), read: read.read, onSettled: settled });
    await vi.advanceTimersByTimeAsync(0);
    expect(read.calls).toEqual([[VARRO]]);
    read.resolve(new Map<string, Appearance | null>([[VARRO, BALD], [ASTER, BALD], ['stranger', FEMALE]]));
    await vi.advanceTimersByTimeAsync(0);
    const looks: LookMap = settled.mock.calls[0][0];
    expect([...looks].sort()).toEqual([[ASTER, FEMALE], [VARRO, BALD]].sort());
  });

  it('treats an invalid answer as the legacy look', async () => {
    const read = pendingRead();
    const settled = vi.fn();
    loadLooks({ ids: [VARRO], read: read.read, onSettled: settled });
    await vi.advanceTimersByTimeAsync(0);
    read.resolve(new Map<string, Appearance | null>([[VARRO, { body: 'robot', hair: 'short', skin: 0, hairColor: 0, cloth: 0 } as unknown as Appearance]]));
    await vi.advanceTimersByTimeAsync(0);
    const looks: LookMap = settled.mock.calls[0][0];
    expect(looks.get(VARRO)).toBeNull();
  });

  it('sends no read for a load cancelled before it started (a development remount of the effect)', async () => {
    const read = vi.fn<LookReader>(async () => new Map());
    const settled = vi.fn();
    loadLooks({ ids: [ASTER], read, onSettled: settled }).cancel();
    const again = loadLooks({ ids: [ASTER], read, onSettled: settled });
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledTimes(1);
    again.cancel();
  });

  it('ignores the late result of a viewport unmounted during the read', async () => {
    const read = pendingRead();
    const settled = vi.fn();
    const load = loadLooks({ ids: [ASTER, VARRO], read: read.read, onSettled: settled });
    await vi.advanceTimersByTimeAsync(200);
    load.cancel();
    // The timeout is cleared with it: nothing is left running for an unmounted viewport.
    expect(vi.getTimerCount()).toBe(0);
    read.resolve(new Map<string, Appearance | null>([[ASTER, FEMALE]]));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).not.toHaveBeenCalled();

    const gone = vi.fn();
    const immediate = loadLooks({ ids: [ASTER], known: new Map([[ASTER, null]]), onSettled: gone });
    immediate.cancel();
    await vi.advanceTimersByTimeAsync(0);
    expect(gone).not.toHaveBeenCalled();
  });

  it('plans the stage once from the settled looks, so a look never changes mid-play', async () => {
    const read = pendingRead();
    const settled = vi.fn();
    loadLooks({ ids: [ASTER, VARRO], read: read.read, onSettled: settled });
    await vi.advanceTimersByTimeAsync(LOOKS_TIMEOUT_MS);
    const legacy: LookMap = settled.mock.calls[0][0];
    const plan = planStage(pvp, manifest, legacy);
    const before = JSON.stringify(plan.looks);
    // The answer that arrives after the timeout is dropped; the plan the scene holds is unchanged.
    read.resolve(new Map<string, Appearance | null>([[ASTER, FEMALE]]));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(JSON.stringify(plan.looks)).toBe(before);
    expect(settled).toHaveBeenCalledTimes(1);
  });
});
