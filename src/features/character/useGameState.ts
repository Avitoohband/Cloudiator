'use client';

// The game page's one source of shared state: a single sync controller (the public world, its revision and the
// server-time offset), the display clock that offset drives, the session, the signed-in owner and the viewer kind.
// The camp and the panels only consume it. Fixture previews read the fixture gateway the same way, with the demo crowd.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OwnerState, WorldSnapshot } from '@contracts/reads';
import type { GameGateway } from '../../lib/api/gateway';
import { signOut, useSession, type SessionState } from '../../lib/api/session';
import { createSync, type SyncState } from '../../lib/api/sync';
import { createDisplayClock, type DisplayClock } from '../../game/display-clock';
import { withDemoCrowd } from '../../game/demo-world';

export type Viewer = 'loading' | 'unavailable' | 'visitor' | 'no-gladiator' | 'player';
export type GameUiState = {
  viewer: Viewer; session: SessionState; world: WorldSnapshot | null; owner: OwnerState | null;
  ownerError: 'unavailable' | null; syncError: 'unavailable' | 'unauthenticated' | null;
  revision: string | null; slotIndex: number | null; clock: DisplayClock;
  sceneStatus: 'loading' | 'ready' | 'unavailable';
  refreshOwner(): Promise<void>; setSceneStatus(status: GameUiState['sceneStatus']): void;
};

/** Fixture-enabled builds only (as the other test hooks): browser tests read and hold the shared display clock. */
export type ShellTestHook = { clock: DisplayClock };
declare global {
  interface Window { __cloudiatorShell?: ShellTestHook }
}

/** The fixture preview's owner is not an account; it stands in for one while previewing as a player. */
const FIXTURE_ACCOUNT = 'fixture-preview';
/**
 * The last owner read of one account: its owner, or that it has none (`missing`), and whether the latest read failed. A
 * failed refresh keeps an owner already shown (with `failed`), but never a "no gladiator" answer, so a failed read never
 * offers creation.
 */
type OwnerRead = { account: string; owner: OwnerState | null; missing: boolean; failed: boolean };
const codeOf = (error: unknown) => (error && typeof error === 'object' && 'code' in error ? error.code : null);

/**
 * `gateway` is the live gateway, or in fixture mode the fixture gateway once loaded (null until then). `previewAs:
 * 'visitor'` (fixture mode only) previews the visitor view, without an owner.
 *
 * - One `createSync` runs per gateway, which wires `subscribeSession`; each publish with an offset syncs the display clock
 *   to `Date.now() + offsetMs` (forward only, and never while a test holds it).
 * - The owner is read when the account changes, the revision changes, the server slot advances or the tab regains focus,
 *   and on `refreshOwner()`, which rejects when its read fails. Only the latest read lands.
 * - A stored session the server rejects: while the session says signed in and the sync reports `unauthenticated` (the
 *   public reads carried the stale token), the session is signed out locally, so the reads continue as a visitor's.
 */
export function useGameState(gateway: GameGateway | null, options: { fixture: boolean; previewAs?: 'visitor' | 'player' }): GameUiState {
  const { fixture, previewAs } = options;
  const session = useSession();
  const [clock] = useState(createDisplayClock);
  const [sync, setSync] = useState<SyncState | null>(null);
  const [ownerRead, setOwnerRead] = useState<OwnerRead | null>(null);
  const [sceneStatus, setSceneStatus] = useState<GameUiState['sceneStatus']>('loading');
  const ticket = useRef(0);
  const account = fixture ? (previewAs === 'visitor' ? null : FIXTURE_ACCOUNT)
    : session.status === 'signed-in' ? session.userId : null;

  useEffect(() => {
    if (!gateway) return;
    const controller = createSync(gateway, next => {
      if (next.offsetMs !== null) clock.sync(Date.now() + next.offsetMs);
      setSync(next);
    });
    void controller.start();
    return () => controller.stop();
  }, [gateway, clock]);

  const loadOwner = useCallback(async (): Promise<void> => {
    if (!gateway || account === null) return;
    const mine = ++ticket.current;
    try {
      const owner = await gateway.owner();
      if (mine === ticket.current) setOwnerRead({ account, owner, missing: false, failed: false });
    } catch (error) {
      if (mine !== ticket.current) return;
      if (codeOf(error) === 'not-found') { setOwnerRead({ account, owner: null, missing: true, failed: false }); return; }
      setOwnerRead(previous => previous?.account === account && previous.owner ? { ...previous, failed: true } : { account, owner: null, missing: false, failed: true });
      throw error;
    }
  }, [gateway, account]);

  // A new account (or none) invalidates reads in flight; a signed-out view keeps no private owner.
  useEffect(() => {
    ticket.current++;
    if (account === null) { setOwnerRead(null); return; }
    void loadOwner().catch(() => undefined);
  }, [account, loadOwner]);

  const syncWorld = sync?.world ?? null;
  const revision = syncWorld?.revision ?? null;
  const slotIndex = syncWorld?.slotIndex ?? null;
  const seen = useRef<{ revision: string | null; slotIndex: number | null }>({ revision: null, slotIndex: null });
  useEffect(() => {
    const previous = seen.current;
    seen.current = { revision, slotIndex };
    const changed = (previous.revision !== null && revision !== null && revision !== previous.revision)
      || (previous.slotIndex !== null && slotIndex !== null && slotIndex > previous.slotIndex);
    if (changed) void loadOwner().catch(() => undefined);
  }, [revision, slotIndex, loadOwner]);

  useEffect(() => {
    if (!gateway || account === null) return;
    const refresh = () => { if (document.visibilityState === 'visible') void loadOwner().catch(() => undefined); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [gateway, account, loadOwner]);

  const syncError = sync?.error ?? null;
  useEffect(() => {
    if (fixture || session.status !== 'signed-in' || syncError !== 'unauthenticated') return;
    void signOut({ scope: 'local' }).catch(() => undefined);
  }, [fixture, session.status, syncError]);

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_FIXTURE_ENABLED !== 'true') return;
    window.__cloudiatorShell = { clock };
    return () => { if (window.__cloudiatorShell?.clock === clock) delete window.__cloudiatorShell; };
  }, [clock]);

  // A revision poll refreshes the snapshot's time but not its actors: keep the world (and the demo crowd) the same
  // object, so the camp is not handed an unchanged world every 30 s. Keyed on the actors and revision on purpose.
  const actors = syncWorld?.actors;
  const world = useMemo(() => (syncWorld ? (fixture ? withDemoCrowd(syncWorld) : syncWorld) : null), [actors, revision, fixture]);

  const read = account !== null && ownerRead?.account === account ? ownerRead : null;
  const owner = read?.owner ?? null;
  let viewer: Viewer;
  if (fixture) viewer = previewAs === 'visitor' ? 'visitor' : owner ? 'player' : read?.failed ? 'unavailable' : 'loading';
  else if (session.status === 'loading') viewer = 'loading';
  else if (session.status === 'unavailable') viewer = 'unavailable';
  else if (session.status === 'signed-out') viewer = 'visitor';
  else viewer = owner ? 'player' : read?.missing ? 'no-gladiator' : read?.failed ? 'unavailable' : 'loading';

  return {
    viewer, session, world, owner, ownerError: read?.failed ? 'unavailable' : null, syncError, revision, slotIndex, clock,
    sceneStatus, refreshOwner: loadOwner, setSceneStatus,
  };
}
