import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSync, type SyncState } from '../src/lib/api/sync';
import type { GameGateway } from '../src/lib/api/gateway';

let visible = true;
let doc: EventTarget;
let win: EventTarget;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  doc = new EventTarget(); win = new EventTarget(); visible = true;
  Object.defineProperty(doc, 'visibilityState', { get: () => visible ? 'visible' : 'hidden' });
  vi.stubGlobal('document', doc); vi.stubGlobal('window', win);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function fixture() {
  let revision = '1', down = false;
  let sessionListener = () => {};
  const state = () => ({ revision, serverNowMs: Date.now() + 86_400_000, slotIndex: 18 });
  const gateway = {
    revision: vi.fn(async () => { if (down) throw Error('network'); return state(); }),
    world: vi.fn(async () => ({ ...state(), actors: [] })),
    subscribeSession: (listener: () => void) => { sessionListener = listener; return () => { sessionListener = () => {}; }; },
  } as unknown as GameGateway;
  const states: SyncState[] = [];
  const sync = createSync(gateway, state => states.push(state));
  return { sync, gateway, states, change: () => { revision = '2'; }, outage: () => { down = true; }, recover: () => { down = false; }, accountChange: () => sessionListener() };
}
describe('revision synchronization', () => {
  it('loads once, polls the small revision every 30s, and fetches a changed world once', async () => {
    const f = fixture(); await f.sync.start();
    expect(f.states.at(-1)).toMatchObject({ world: { revision: '1' }, offsetMs: 86_400_000, error: null });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(f.gateway.revision).toHaveBeenCalledTimes(3); expect(f.gateway.world).toHaveBeenCalledTimes(1);
    f.change(); await vi.advanceTimersByTimeAsync(30_000);
    expect(f.gateway.world).toHaveBeenCalledTimes(2); expect(f.states.at(-1)?.world?.revision).toBe('2'); f.sync.stop();
  });
  it('pauses hidden tabs, recovers on focus, and preserves last synchronized state during outage', async () => {
    const f = fixture(); await f.sync.start(); const last = f.states.at(-1)!;
    visible = false; doc.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(90_000);
    expect(f.gateway.revision).not.toHaveBeenCalled();
    f.outage(); visible = true; win.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(0);
    expect(f.states.at(-1)).toMatchObject({ world: last.world, lastSyncMs: last.lastSyncMs, offsetMs: last.offsetMs, error: 'unavailable' });
    f.recover(); f.change(); win.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(0);
    expect(f.states.at(-1)).toMatchObject({ world: { revision: '2' }, error: null }); f.sync.stop();
  });
  it('coalesces overlapping refreshes and discards results after stop/account changes', async () => {
    const f = fixture(); let resolve!: (v: Awaited<ReturnType<GameGateway['world']>>) => void;
    vi.mocked(f.gateway.world).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const started = f.sync.start(); const overlap = f.sync.refresh();
    expect(f.gateway.world).toHaveBeenCalledTimes(1);
    f.accountChange(); f.sync.stop(); resolve({ revision: 'old', serverNowMs: 10, slotIndex: 0, actors: [] });
    await Promise.all([started, overlap]);
    expect(f.states.at(-1)?.world).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000); expect(f.gateway.world).toHaveBeenCalledTimes(1);
  });
  it('reports delayed authoritative work without manufacturing completion or rewards', async () => {
    const f = fixture();
    vi.mocked(f.gateway.world).mockResolvedValue({revision:'1',serverNowMs:Date.now(),slotIndex:1,actors:[{
      gladiatorId:'g',name:'Delayed',classId:'guardian',equipmentSilhouettes:[],league:'bronze',level:1,phase:'morning',location:'rest',
      activityId:'a',activityStatus:'processing',startsAtMs:0,endsAtMs:1,visibleStage:null,
    }]});
    await f.sync.start(); expect(f.states.at(-1)?.processing).toBe(true);
    expect(f.states.at(-1)?.world?.actors[0].activityStatus).toBe('processing');
    expect(JSON.stringify(f.states.at(-1))).not.toContain('rewards');f.sync.stop();
  });
});
