'use client';

// The game page's one source of shared state: a single sync controller (the public world, its revision and the
// server-time offset), the display clock that offset drives, the session, the signed-in owner and the viewer kind.
// The camp and the panels only consume it. Fixture previews read the fixture gateway the same way, with the demo crowd.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OwnerState, WorldSnapshot } from '@contracts/reads';
import type { GameGateway } from '../../lib/api/gateway';
import { refreshSession, signOut, useSession, type SessionState } from '../../lib/api/session';
import { createSync, type SyncController, type SyncState } from '../../lib/api/sync';
import { createPresence, type Presence, type PresenceInput } from '../../lib/api/presence';
import { createDisplayClock, type DisplayClock } from '../../game/display-clock';
import { withDemoCrowd } from '../../game/demo-world';

export type Viewer = 'loading' | 'unavailable' | 'visitor' | 'no-gladiator' | 'player';
export type GameUiState = {
  viewer: Viewer; session: SessionState; world: WorldSnapshot | null; owner: OwnerState | null;
  ownerError: 'unavailable' | null; syncError: 'unavailable' | 'unauthenticated' | null;
  revision: string | null; slotIndex: number | null; clock: DisplayClock;
  /** The revision's published slot (Task 23.2, C5): the latest slot whose boundary is published; null before the first coordination. */
  publishedSlotIndex: number | null;
  /** The owner's own gladiator rests at home in the shared world (its public actor's `resting`; Task 23.9 fix round 1). */
  ownResting: boolean;
  sceneStatus: 'loading' | 'ready' | 'unavailable';
  refreshOwner(): Promise<void>; setSceneStatus(status: GameUiState['sceneStatus']): void;
  /**
   * The gladiator the creation dialog has just created, with the owner state it read to confirm it: shown at once, with
   * no read of its own, and the world (which the creation changed) read now; that new revision reads the owner once more.
   */
  ownerCreated(owner: OwnerState): void;
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
type Seen = { revision: string | null; slotIndex: number | null };
/**
 * The last owner read of one account: its owner, or that it has none (`missing`), and whether the latest read failed. A
 * failed refresh keeps an owner already shown (with `failed`), but never a "no gladiator" answer, so a failed read never
 * offers creation.
 */
type OwnerRead = { account: string; owner: OwnerState | null; missing: boolean; failed: boolean };
const codeOf = (error: unknown) => (error && typeof error === 'object' && 'code' in error ? error.code : null);

/**
 * `gateway` is the live gateway, or in fixture mode the fixture gateway once loaded (null until then). `previewAs:
 * 'visitor'` (fixture mode only) previews the visitor view, without an owner. `clockOnly` (a /replay/ deep link, which
 * needs only the server's time and the viewer's gladiator; Task 23.4, C6): the sync polls the revision and never loads
 * the world (its `world` has no actors), and the owner is read once per account, never again on a revision, a slot or a
 * tab return.
 *
 * - One `createSync` runs per gateway, which wires `subscribeSession`; each publish with an offset syncs the display clock
 *   to `Date.now() + offsetMs` (forward only, and never while a test holds it).
 * - The owner is read when the account changes, the revision changes, the server slot advances or the tab comes back,
 *   and on `refreshOwner()`, which rejects when its read fails. Only the latest read lands. A revision or slot change is
 *   seen as the sync publishes it, so the read starts at once (Task 23.4, C6). A tab return fires both `visibilitychange`
 *   and `focus`: it reads only when no owner read is in flight and none completed within 2 s, and only after that
 *   return's revision read, which reads the owner itself when it finds a new revision, so a return to a changed world
 *   reads the owner once, not twice. A creation's own confirming read stands for the owner read (`ownerCreated`).
 * - A stored session the server rejects: while the session says signed in and the sync reports `unauthenticated` (the
 *   public reads carried the stale token), the session is first refreshed once; a renewed session reads the world and
 *   the owner again. Only a refused refresh, or a renewed session the next read still reports, is signed out locally,
 *   so the reads continue as a visitor's (final review Minor 3: a device clock running slow, or a transient rejection,
 *   no longer discards the refresh token). A sign-out that fails and keeps the session is tried again at each later
 *   publish that still reports it. A successful read lets a later rejection be refreshed once again.
 * - The owner's activity signal (Task 23.9, `createPresence`): a player sends a presence once its gladiator is shown (after
 *   sign-in or a page load), then every 6 hours while the page is visible; a visitor or an account without a gladiator
 *   never does. Failures are not shown; one that the resting gladiator waits on is retried once. An answered presence of a
 *   gladiator resting with no signal yet reads the owner again, except with `clockOnly`, which reads the owner once per account.
 */
export function useGameState(gateway: GameGateway | null, options: { fixture: boolean; previewAs?: 'visitor' | 'player'; clockOnly?: boolean }): GameUiState {
  const { fixture, previewAs, clockOnly = false } = options;
  const session = useSession();
  const [clock] = useState(createDisplayClock);
  const [sync, setSync] = useState<SyncState | null>(null);
  const [ownerRead, setOwnerRead] = useState<OwnerRead | null>(null);
  const [sceneStatus, setSceneStatus] = useState<GameUiState['sceneStatus']>('loading');
  const ticket = useRef(0);
  /** Owner reads started and in flight, and when the last one completed (`performance.now()`), for tab returns. */
  const ownerReads = useRef({ started: 0, inFlight: 0, doneAt: Number.NEGATIVE_INFINITY });
  const controllerRef = useRef<SyncController | null>(null);
  const account = fixture ? (previewAs === 'visitor' ? null : FIXTURE_ACCOUNT)
    : session.status === 'signed-in' ? session.userId : null;

  const loadOwner = useCallback(async (): Promise<void> => {
    if (!gateway || account === null) return;
    const mine = ++ticket.current;
    ownerReads.current.started += 1;
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

  // The world's revision and slot as the sync last published them: a new revision, or a later server slot, reads the
  // owner at once (not after a render), so a tab return that awaits the sync refresh knows whether it already has.
  const seen = useRef<Seen>({ revision: null, slotIndex: null });
  useEffect(() => {
    if (!gateway) return;
    seen.current = { revision: null, slotIndex: null };
    const controller = createSync(gateway, next => {
      if (next.offsetMs !== null) clock.sync(Date.now() + next.offsetMs);
      const previous = seen.current;
      const now: Seen = { revision: next.world?.revision ?? null, slotIndex: next.world?.slotIndex ?? null };
      seen.current = now;
      const changed = (previous.revision !== null && now.revision !== null && now.revision !== previous.revision)
        || (previous.slotIndex !== null && now.slotIndex !== null && now.slotIndex > previous.slotIndex);
      if (changed && !clockOnly) void latestLoadOwner.current().catch(() => undefined);
      setSync(next);
    }, { actors: !clockOnly });
    controllerRef.current = controller;
    void controller.start();
    return () => { controller.stop(); if (controllerRef.current === controller) controllerRef.current = null; };
  }, [gateway, clock, clockOnly]);

  // A new account (or none) invalidates reads in flight; a signed-out view keeps no private owner.
  useEffect(() => {
    ticket.current++;
    if (account === null) { setOwnerRead(null); return; }
    void loadOwner().catch(() => undefined);
  }, [account, loadOwner]);

  const syncWorld = sync?.world ?? null;
  const revision = syncWorld?.revision ?? null;
  const slotIndex = syncWorld?.slotIndex ?? null;
  const publishedSlotIndex = syncWorld?.publishedSlotIndex ?? null;

  useEffect(() => {
    if (!gateway || account === null || clockOnly) return;
    let returning = false;
    const refresh = () => {
      const reads = ownerReads.current;
      if (returning || document.visibilityState !== 'visible' || reads.inFlight > 0 || performance.now() - reads.doneAt < RETURN_READ_GAP_MS) return;
      returning = true;
      const before = reads.started;
      // The sync reads the revision on the same return (its own focus handler starts the refresh this one joins); a new
      // revision or slot has read the owner already by the time it resolves, so the return reads it only otherwise.
      void (controllerRef.current?.refresh() ?? Promise.resolve())
        .then(() => (ownerReads.current.started === before ? latestLoadOwner.current() : undefined))
        .catch(() => undefined)
        .finally(() => { returning = false; });
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [gateway, account, clockOnly]);

  const ownerCreated = useCallback((owner: OwnerState) => {
    if (account === null) return;
    // Reads in flight (started before the creation) would say there is no gladiator: they no longer land.
    ticket.current++;
    setOwnerRead({ account, owner, missing: false, failed: false });
    // The creation changed the world: read its revision now, after any refresh in flight; the new revision reads the
    // owner once more, and the camp shows the new gladiator without waiting for the next poll.
    void controllerRef.current?.refresh({ fresh: true });
  }, [account]);

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

  // The presence follows the gateway (the fixture one once loaded) and the viewer: created per gateway with the viewer as
  // last seen, then told each change of account or owner read (the same account's reads never send another).
  const ownId = owner?.gladiatorId ?? null;
  const ownResting = ownId !== null && (world?.actors ?? []).some(a => a.gladiatorId === ownId && a.resting);
  const presence = useRef<Presence | null>(null);
  const presenceInput = useRef<PresenceInput>({ account: null, owner: null, resting: false });
  useEffect(() => {
    if (!gateway) return;
    const current = createPresence({
      send: () => gateway.sendPresence(),
      reread: () => { if (!clockOnly) void latestLoadOwner.current().catch(() => undefined); },
    });
    presence.current = current;
    current.update(presenceInput.current);
    return () => { current.stop(); if (presence.current === current) presence.current = null; };
  }, [gateway, clockOnly]);
  useEffect(() => {
    presenceInput.current = { account, owner, resting: ownResting };
    presence.current?.update(presenceInput.current);
  }, [account, owner, ownResting]);
  let viewer: Viewer;
  if (fixture) viewer = previewAs === 'visitor' ? 'visitor' : owner ? 'player' : read?.failed ? 'unavailable' : 'loading';
  else if (session.status === 'loading') viewer = 'loading';
  else if (session.status === 'unavailable') viewer = 'unavailable';
  else if (session.status === 'signed-out') viewer = 'visitor';
  else viewer = owner ? 'player' : read?.missing ? 'no-gladiator' : read?.failed ? 'unavailable' : 'loading';

  return {
    viewer, session, world, owner, ownerError: read?.failed ? 'unavailable' : null, syncError, revision, slotIndex, publishedSlotIndex, ownResting, clock,
    sceneStatus, refreshOwner, setSceneStatus, ownerCreated,
  };
}
