'use client';

// A replay or an expedition as a full-screen scene over the camp (spec "Scenes", the approved mockup's bout scene; Task
// 13.8). It is a labelled modal dialog: the camp is paused beneath it (Task 23.4, C8) and takes no input, "Back to camp"
// (or Escape) closes it, and the focus goes back to whatever opened it. The scenes are the existing views: the battle
// replay, filtered by the shared display clock, and the followable expedition, re-read on the shared revision. A
// viewer who is not a player never gets an owner summary here (the live server sends a visitor none; the fixture
// preview's samples carry their owner's, so the scene drops it), so visitors never see rewards in a scene. An address
// with a malformed activity id names nothing: the scene says so and reads nothing (final review Minor 6). Each view is
// the account's own read: once the session is known, a sign-out, expiry or account switch (here or in another tab)
// remounts it as the new reader, so no owner's rewards outlive the session (final review Minor 1). It mounts only once
// the viewer is known, so a signed-in deep link reads once (Task 23.5).
import { useLayoutEffect, useMemo, useRef } from 'react';
import type { GameGateway } from '../../lib/api/gateway';
import type { GameUiState } from '../character/useGameState';
import { ActivityReplay, BattleReplay } from '../arena/BattleReplay';
import { ExpeditionUnavailable, ExpeditionView, type ExpeditionReads } from '../character/ExpeditionView';
import { appearancesOf } from '../../game/replay-looks';
import type { SceneAddress, SceneView } from './scene-url';
import styles from './shell.module.css';

/** The camp view, which takes the keyboard when the scene had no opener to give it back to. */
const focusCamp = () => document.querySelector<HTMLElement>('[data-camp-view] [role="application"]')?.focus({ preventScroll: true });

export function SceneOverlay({ view, gateway, state, fixture = false, onClose, onWatch }: {
  view: SceneAddress;
  /** The camp's reads: the live gateway, or the fixture preview's once it has loaded (null until then). */
  gateway: GameGateway | null;
  state: GameUiState;
  fixture?: boolean;
  /** "Back to camp" or Escape: the shell emits `return-camp`. */
  onClose(): void;
  /** An expedition's encounter replay: the shell opens the replay scene. */
  onWatch?(view: SceneView): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const leaving = useRef(false);
  const closeRef = useRef(onClose);
  useLayoutEffect(() => { closeRef.current = onClose; });

  // Shown as a modal dialog while mounted (whatever scene it shows); on unmount the focus goes back to its opener.
  useLayoutEffect(() => {
    const element = dialog.current!;
    const active = document.activeElement;
    const opener = active instanceof HTMLElement && active !== document.body ? active : null;
    leaving.current = false;
    if (!element.open) element.showModal();
    back.current?.focus({ preventScroll: true });
    return () => {
      leaving.current = true;
      if (element.open) element.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
      else focusCamp();
    };
  }, []);

  // Another scene in the same dialog (an expedition's encounter replay, or Back and Forward between scenes) starts at its
  // top with the focus on Back to camp, as the first one did: the control that opened it is gone (fix round 1, M6).
  const sceneKey = `${view.kind}|${view.activityId}|${view.activityId !== null && view.kind === 'replay' ? view.stageId ?? '' : ''}`;
  const shownKey = useRef(sceneKey);
  useLayoutEffect(() => {
    if (shownKey.current === sceneKey) return;
    shownKey.current = sceneKey;
    dialog.current?.scrollTo({ top: 0 });
    back.current?.focus({ preventScroll: true });
  }, [sceneKey]);

  const player = state.viewer === 'player';
  const reads = useMemo<(ExpeditionReads & Partial<Pick<GameGateway, 'looks'>>) | null>(() => {
    if (!gateway) return null;
    if (player) return gateway;
    // The fighters' looks are public, so a visitor's replay reads them too.
    return { timeline: async id => { const { summary: _owner, ...shown } = await gateway.timeline(id); return shown; }, looks: ids => gateway.looks(ids) };
  }, [gateway, player]);
  // The camp's own world actors already hold their looks: a replay of those fighters reads nothing (the replay takes them once,
  // when it mounts, so a world refresh never changes a replay in play).
  const known = useMemo(() => appearancesOf(state.world?.actors), [state.world]);

  // The display clock has a server time once the shared sync has read the world (or it never will).
  const clock = state.world || state.syncError ? state.clock : null;
  const activityId = view.activityId;
  const viewKey = `${sceneKey}|${state.session.userId ?? 'visitor'}`;
  // The view mounts once the viewer is known: the session, and for an account its owner read (Task 23.5, C19). Mounted
  // earlier, a signed-in player's view would read as a visitor's and remount as the player's a moment later, reading its
  // timeline twice and restarting the replay.
  const loading = !reads || state.session.status === 'loading' || state.viewer === 'loading';
  return (
    <dialog ref={dialog} className={styles.scene} aria-label={view.kind === 'replay' ? 'Replay' : 'Expedition'}
      // Escape asks the scene to close: the address goes back to the camp, and the dialog stays open (with the focus in
      // it) until the scene unmounts and gives the focus back to its opener (Task 23.5: a native close would drop the
      // focus to <body> until then). Should the browser close it anyway, follow that into the address. The close event
      // comes a task later, so one from an unmount (or React's development remount) finds the dialog open again or gone.
      onCancel={event => { event.preventDefault(); closeRef.current(); }}
      onClose={() => { if (!leaving.current && !dialog.current?.open) closeRef.current(); }}>
      <button ref={back} type="button" className={styles.sceneBack} onClick={onClose}><span aria-hidden="true">←</span> Back to camp</button>
      <div className={styles.sceneBody}>
        {activityId === null
          ? view.kind === 'replay' ? <BattleReplay view={{ kind: 'unavailable', reason: 'not-found' }} headingLevel={2} />
            : <ExpeditionUnavailable fixture={fixture} reason="not-found" overCamp />
          : view.kind === 'replay'
            ? loading ? <p role="status">Loading the replay…</p>
              : <ActivityReplay key={viewKey} reads={reads} activityId={activityId} stageId={view.stageId ?? null} clock={clock} headingLevel={2}
                viewerId={player ? state.owner?.gladiatorId ?? null : null} known={known} />
            : loading ? <p role="status">Loading the expedition…</p>
              : <ExpeditionView key={viewKey} reads={reads} activityId={activityId} fixture={fixture} revision={state.revision} world={state.world}
                worldFailed={!state.world && state.syncError !== null} owner={player ? state.owner : null}
                overCamp={{ onWatch: stageId => onWatch?.({ kind: 'replay', activityId, stageId }) }} />}
      </div>
    </dialog>
  );
}
