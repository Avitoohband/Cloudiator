import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicActor } from '@contracts/reads';
import { arrivalBanner, newcomers } from '../../src/features/arrivals/arrivals';
import { worldFixture } from '../fixtures/domain';

// Patch A item 2: a new player is announced. Ursa (a Guardian) and Nero (a Duelist) are in orientation, Ursa the newer; Vita arrived
// before them both; Aster is at camp.
const base = worldFixture.actors[0];
const actor = (name: string, classId: PublicActor['classId'], startsAtMs: number, location: PublicActor['location'] = 'orientation'): PublicActor =>
  ({ ...base, gladiatorId: `id-${name}`, name, classId, location, startsAtMs, endsAtMs: startsAtMs + 4_800_000, activityId: null, resting: false });
const ursa = actor('Ursa', 'guardian', 3_000);
const nero = actor('Nero', 'duelist', 2_000);
const vita = actor('Vita', 'berserker', 1_000);
const aster = actor('Aster', 'guardian', 500, 'camp');

describe('who is new', () => {
  it('lists the gladiators in orientation, newest first and ties by name, never a resting or a settled one', () => {
    expect(newcomers([vita, aster, nero, ursa]).map(a => a.name)).toEqual(['Ursa', 'Nero', 'Vita']);
    expect(newcomers([actor('Zed', 'duelist', 5), actor('Abe', 'duelist', 5)]).map(a => a.name)).toEqual(['Abe', 'Zed']);
    expect(newcomers([{ ...ursa, resting: true }, aster])).toEqual([]);
  });
});

describe('the arrival banner', () => {
  it('announces one newcomer', () => {
    const b = arrivalBanner([ursa, aster], new Set(), null)!;
    expect(b).toMatchObject({ kind: 'arrival', ids: [ursa.gladiatorId], findId: ursa.gladiatorId, findName: 'Ursa',
      text: 'Ursa, a new Guardian, has arrived in the camp. Say hello at the gate!', narrowText: 'Ursa, a new Guardian, has arrived. Say hello at the gate!' });
  });
  it('shares one banner among several, newest first', () => {
    expect(arrivalBanner([nero, ursa], new Set(), null)!.text).toBe('Ursa and Nero have arrived in the camp.');
    expect(arrivalBanner([nero, ursa, vita], new Set(), null)!.text).toBe('Ursa and 2 others have arrived in the camp.');
    // The phone says the same sentences, and Find goes to the newest; every newcomer is remembered with the banner.
    const b = arrivalBanner([nero, ursa, vita], new Set(), null)!;
    expect(b.narrowText).toBe(b.text);
    expect(b).toMatchObject({ kind: 'arrival', findId: ursa.gladiatorId, findName: 'Ursa', ids: [ursa.gladiatorId, nero.gladiatorId, vita.gladiatorId] });
  });
  it('welcomes the newcomer’s own player first, then the others', () => {
    expect(arrivalBanner([nero, ursa], new Set(), ursa.gladiatorId)).toMatchObject({ kind: 'welcome', ids: [ursa.gladiatorId], findId: ursa.gladiatorId, findName: 'Ursa',
      text: 'Welcome to the camp, Ursa! Everyone here has been told you arrived.', narrowText: 'Welcome to the camp, Ursa! Everyone here has been told you arrived.' });
    expect(arrivalBanner([nero, ursa], new Set([ursa.gladiatorId]), ursa.gladiatorId)!.text).toBe('Nero, a new Duelist, has arrived in the camp. Say hello at the gate!');
  });
  it('announces nobody seen, resting or past orientation', () => {
    expect(arrivalBanner([ursa], new Set([ursa.gladiatorId]), null)).toBeNull();
    expect(arrivalBanner([{ ...ursa, resting: true }, { ...nero, location: 'camp' }], new Set(), null)).toBeNull();
    expect(arrivalBanner([], new Set(), null)).toBeNull();
  });
  it('leaves the ones already seen out of a shared banner', () => {
    expect(arrivalBanner([nero, ursa], new Set([ursa.gladiatorId]), null)).toMatchObject({ ids: [nero.gladiatorId], findName: 'Nero' });
  });
});

describe('the device memory of announced arrivals', () => {
  // Each test imports a fresh module after vi.resetModules(): the page's own memory starts empty.
  const store = new Map<string, string>();
  const fresh = async () => { vi.resetModules(); return import('../../src/features/arrivals/arrivals'); };
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);
  const throwingStorage = () => vi.stubGlobal('localStorage', {
    getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); },
  });
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); } });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('names its key', async () => { expect((await fresh()).ARRIVALS_KEY).toBe('cloudiator.arrivals-seen.v1'); });
  it('remembers the newest 200 ids, and keeps them in memory when storage throws', async () => {
    const a = await fresh(); a.rememberArrivals(ids(201));
    expect(JSON.parse(store.get('cloudiator.arrivals-seen.v1')!)).toHaveLength(200); expect(a.readSeenArrivals().has('id-0')).toBe(false);
    expect(a.readSeenArrivals().has('id-200')).toBe(true);
    throwingStorage(); const b = await fresh(); expect(() => b.rememberArrivals(['id-x'])).not.toThrow(); expect(b.readSeenArrivals().has('id-x')).toBe(true);
  });
  it('adds to what an earlier visit stored, once, and ignores a stored value that is not a list of ids', async () => {
    store.set('cloudiator.arrivals-seen.v1', JSON.stringify(['old-1', 'old-2']));
    const a = await fresh(); expect([...a.readSeenArrivals()].sort()).toEqual(['old-1', 'old-2']);
    a.rememberArrivals(['new-1', 'old-2']);
    expect(JSON.parse(store.get('cloudiator.arrivals-seen.v1')!)).toEqual(['old-1', 'old-2', 'new-1']);
    store.set('cloudiator.arrivals-seen.v1', '{"not":"a list"}');
    const b = await fresh(); expect(b.readSeenArrivals().size).toBe(0);
    store.set('cloudiator.arrivals-seen.v1', 'nonsense');
    const c = await fresh(); expect(c.readSeenArrivals().size).toBe(0); c.rememberArrivals(['id-y']);
    expect(JSON.parse(store.get('cloudiator.arrivals-seen.v1')!)).toEqual(['id-y']);
  });
  it('reads nothing at all when storage throws on a read', async () => {
    throwingStorage(); const a = await fresh(); expect(a.readSeenArrivals().size).toBe(0);
  });
});
