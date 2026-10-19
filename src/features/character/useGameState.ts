'use client';

// The game page's one source of shared state: a single sync controller (the public world, its revision and the
// server-time offset), the display clock that offset drives, the session, the signed-in owner and the viewer kind.
// The camp and the panels only consume it. Fixture previews read the fixture gateway the same way, with the demo crowd.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OwnerState, WorldSnapshot } from '@contracts/reads';
import type { GameGateway } from '../../lib/api/gateway';
import { refreshSession, signOut, useSession, type SessionState } from '../../lib/api/session';
import { createSync, type SyncController, type SyncState } from '../../lib/api/sync';
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

/**
 * Fixture-enabled builds only (as the other test hooks): browser tests read and hold the shared display clock, and can
 * give `refreshOwner` a new identity (as a parent re-rendering with a new function would), so panels prove they keep
 * their timers (Task 19 R2).
 */
export type ShellTestHook = { clock: DisplayClock; renewRefreshOwner(): void };
declare global {
  interface Window { __cloudiatorShell?: ShellTestHook }
}

/** The fixture preview's owner is not an account; it stands in for one while previewing as a player. */
const FIXTURE_ACCOUNT = 'fixture-preview';
/** A tab return reads the owner only when no read is in flight and none completed this recently (final review Minor 5). */
const RETURN_READ_GAP_MS = 2_000;
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
 * - The owner is read when the account changes, the revision changes, the server slot advances or the tab comes back,
 *   and on `refreshOwner()`, which rejects when its read fails. Only the latest read lands. A tab return fires both
 *   `visibilitychange` and `focus`: it reads only when no owner read is in flight and none completed within 2 s.
 * - A stored session the server rejects: while the session says signed in and the sync reports `unauthenticated` (the
 *   public reads carried the stale token), the session is first refreshed once; a renewed session reads the world and
 *   the owner again. Only a refused refresh, or a renewed session the next read still reports, is signed out locally,
 *   so the reads continue as a visitor's (final review Minor 3: a device clock running slow, or a transient rejection,
 *   no longer discards the refresh token). A sign-out that fails and keeps the session is tried again at each later
 *   publish that still reports it. A successful read lets a later rejection be refreshed once again.
 */
export function useGameState(gateway: GameGateway | null, options: { fixture: boolean; previewAs?: 'visitor' | 'player' }): GameUiState {
  const { fixture, previewAs } = options;
  const session = useSession();
  const [clock] = useState(createDisplayClock);
  const [sync, setSync] = useState<SyncState | null>(null);
  const [ownerRead, setOwnerRead] = useState<OwnerRead | null>(null);
  const [sceneStatus, setSceneStatus] = useState<GameUiState['sceneStatus']>('loading');
  const ticket = useRef(0);
  /** Owner reads in flight, and when the last one completed (`performance.now()`), for tab returns. */
  const ownerReads = useRef({ inFlight: 0, doneAt: Number.NEGATIVE_INFINITY });
  const controllerRef = useRef<SyncController | null>(null);
  const account = fixture ? (previewAs === 'visitor' ? null : FIXTURE_ACCOUNT)
    : session.status === 'signed-in' ? session.userId : null;

  useEffect(() => {
    if (!gateway) return;
    const controller = createSync(gateway, next => {
      if (next.offsetMs !== null) clock.sync(Date.now() + next.offsetMs);
      setSync(next);
    });
    controllerRef.current = controller;
    void controller.start();
    return () => { controller.stop(); if (controllerRef.current === controller) controllerRef.current = null; };
  }, [gateway, clock]);

  const loadOwner = useCallback(async (): Promise<void> => {
    if (!gateway || account === null) return;
    const mine = ++ticket.current;
    ownerReads.current.inFlight += 1;
    try {
      const owner = await gateway.owner();
      if (mine === ticket.current) setOwnerRead({ account, owner, missing: false, failed: false });
    } catch (error) {
      if (mine !== ticket.current) return;
      if (codeOf(error) === 'not-found') { setOwnerRead({ account, owner: null, missing: true, failed: false }); return; }
      setOwnerRead(previous => previous?.account === account && previous.owner ? { ...previous, failed: true } : { account, owner: null, missing: false, failed: true });
      throw error;
    } finally {
      ownerReads.current.inFlight -= 1;
      ownerReads.current.doneAt = performance.now();
    }
  }, [gateway, account]);
  /**
   * The latest `loadOwner`, for work that resumes after an await (the session refresh below): the account may have
   * changed meanwhile, and the read must be the current account's, never the one captured before the await (Task 23.5,
   * C19, the stale-closure race after a refresh).
   */
  const latestLoadOwner = useRef(loadOwner);
  useEffect(() => { latestLoadOwner.current = loadOwner; });

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
    const refresh = () => {
      const reads = ownerReads.current;
      if (document.visibilityState !== 'visible' || reads.inFlight > 0 || performance.now() - reads.doneAt < RETURN_READ_GAP_MS) return;
      void loadOwner().catch(() => undefined);
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [gateway, account, loadOwner]);

  const syncError = sync?.error ?? null;
  // A rejected stored session: one refresh first; then one local sign-out attempt per completed sync publish that still
  // reports it, so a sign-out that failed and kept the session is tried again at the next poll (never two at once, never
  // on a refresh in progress). A read that succeeds allows the next rejection its own refresh.
  const signingOut = useRef(false);
  const refreshTried = useRef(false);
  const handled = useRef<SyncState | null>(null);
  useEffect(() => {
    if (sync && !sync.refreshing && sync.error === null) refreshTried.current = false;
    if (fixture || session.status !== 'signed-in' || sync?.error !== 'unauthenticated' || sync.refreshing || signingOut.current) return;
    if (handled.current === sync) return;
    handled.current = sync;
    signingOut.current = true;
    const firstRejection = !refreshTried.current;
    refreshTried.current = true;
    void (async () => {
      if (firstRejection && await refreshSession()) {
        signingOut.current = false;
        // The renewed token reads again: the world (whose next publish says whether it is still refused) and the owner,
        // through the latest reader (the account may have changed during the refresh).
        void controllerRef.current?.refresh();
        void latestLoadOwner.current().catch(() => undefined);
        return;
      }
      try { await signOut({ scope: 'local' }); } catch { /* kept: tried again at the next publish that reports it */ }
      signingOut.current = false;
    })();
  }, [fixture, session.status, sync]);

  // `refreshOwner` is `loadOwner` itself unless a fixture-enabled test renews its identity (never in production).
  const [renewals, setRenewals] = useState(0);
  const refreshOwner = useMemo(() => (renewals === 0 ? loadOwner : () => loadOwner()), [loadOwner, renewals]);

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_FIXTURE_ENABLED !== 'true') return;
    window.__cloudiatorShell = { clock, renewRefreshOwner: () => setRenewals(n => n + 1) };
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
    sceneStatus, refreshOwner, setSceneStatus,
  };
}
