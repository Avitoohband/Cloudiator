import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RULES_V1 } from '@domain/rules-v1';
import { RULES_V2 } from '@domain/rules-v2';
import type { GameGateway } from '../../src/lib/api/gateway';
import type { RevisionRead } from '../../src/lib/api/reads';
import { createSync, type SyncState } from '../../src/lib/api/sync';
import { displayRules } from '../../src/lib/rules-version';

// Patch 1.6 (spec "Client", "The active version"; plan Task 8): the client words its texts with the active rules version that every
// revision read names (`world_revision.rules_version`, M27). Only 'v2' is v2: anything else (missing, malformed, an unknown later
// version) reads as v1, and never throws.
describe('displayRules', () => {
  it('is RULES_V2 for v2 and RULES_V1 for anything else', () => {
    expect(displayRules('v2')).toBe(RULES_V2);
    for (const version of ['v1', undefined, null, 'v3', 2, '', 'V2', ' v2', {}, ['v2']]) expect(displayRules(version), String(version)).toBe(RULES_V1);
  });
});

// The rules the shell shows are `displayRules` of the latest sync state's `rulesVersion` (useGameState). Only the newest read lands: a
// revision read started before a session change and answered after the newer one never replaces its version (AGENTS.md, React
// async state).
describe('the displayed rules follow the newest revision read', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
  afterEach(() => { vi.useRealTimers(); });

  it('keeps the newest read\'s version', async () => {
    const read = (revision: string, rulesVersion: string): RevisionRead => ({ revision, serverNowMs: Date.now(), slotIndex: 18, publishedSlotIndex: 18, latestPatch: null, rulesVersion });
    let releaseOlder!: (value: RevisionRead) => void;
    const older = new Promise<RevisionRead>(resolve => { releaseOlder = resolve; });
    let session = () => {};
    const gateway = {
      revision: vi.fn().mockImplementationOnce(() => older).mockResolvedValueOnce(read('2', 'v2')),
      world: vi.fn(async () => ({ revision: '2', serverNowMs: Date.now(), slotIndex: 18, publishedSlotIndex: 18, actors: [] })),
      subscribeSession: (listener: () => void) => { session = listener; return () => {}; },
    } as unknown as GameGateway;
    const states: SyncState[] = [];
    const sync = createSync(gateway, state => states.push(state));
    const first = sync.start();
    // A session change starts a newer read while the first is still held; the newer one answers first, with v2.
    session();
    await vi.advanceTimersByTimeAsync(0);
    expect(gateway.revision).toHaveBeenCalledTimes(2);
    expect(displayRules(states.at(-1)!.rulesVersion)).toBe(RULES_V2);
    const published = states.length;
    // The older read then answers v1: it never lands.
    releaseOlder(read('1', 'v1'));
    await first;
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toHaveLength(published);
    expect(displayRules(states.at(-1)!.rulesVersion)).toBe(RULES_V2);
    sync.stop();
  });
});
