'use client';

// A replay or an expedition as a full-screen scene over the running camp (spec "Scenes", the approved mockup's bout
// scene; Task 13.8). It is a labelled modal dialog: the camp keeps running beneath it but takes no input, "Back to camp"
// (or Escape) closes it, and the focus goes back to whatever opened it. The scenes are the existing views: the battle
// replay, filtered by the shared display clock, and the followable expedition, re-read on the shared revision. A
// viewer who is not a player never gets an owner summary here (the live server sends a visitor none; the fixture
// preview's samples carry their owner's, so the scene drops it), so visitors never see rewards in a scene.
import { useLayoutEffect, useMemo, useRef } from 'react';
import type { GameGateway } from '../../lib/api/gateway';
import type { GameUiState } from '../character/useGameState';
import { ActivityReplay } from '../arena/BattleReplay';
import { ExpeditionView, type ExpeditionReads } from '../character/ExpeditionView';
import type { SceneView } from './scene-url';
import styles from './shell.module.css';

/** The camp view, which takes the keyboard when the scene had no opener to give it back to. */
const focusCamp = () => document.querySelector<HTMLElement>('[data-camp-view] [role="application"]')?.focus({ preventScroll: true });

export function SceneOverlay({ view, gateway, state, fixture = false, onClose, onWatch }: {
  view: SceneView;
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
  const sceneKey = `${view.kind}|${view.activityId}|${view.kind === 'replay' ? view.stageId ?? '' : ''}`;
  const shownKey = useRef(sceneKey);
  useLayoutEffect(() => {
    if (shownKey.current === sceneKey) return;
    shownKey.current = sceneKey;
    dialog.current?.scrollTo({ top: 0 });
    back.current?.focus({ preventScroll: true });
  }, [sceneKey]);

  const player = state.viewer === 'player';
  const reads = useMemo<ExpeditionReads | null>(() => {
    if (!gateway) return null;
    if (player) return gateway;
    return { timeline: async id => { const { summary: _owner, ...shown } = await gateway.timeline(id); return shown; } };
  }, [gateway, player]);

  // The display clock has a server time once the shared sync has read the world (or it never will).
  const clock = state.world || state.syncError ? state.clock : null;
  return (
    <dialog ref={dialog} className={styles.scene} aria-label={view.kind === 'replay' ? 'Replay' : 'Expedition'}
      // Escape closes a modal dialog natively (it may refuse to cancel it): follow it into the address. The close event
      // comes a task later, so one from an unmount (or React's development remount) finds the dialog open again or gone.
      onClose={() => { if (!leaving.current && !dialog.current?.open) closeRef.current(); }}>
      <button ref={back} type="button" className={styles.sceneBack} onClick={onClose}><span aria-hidden="true">←</span> Back to camp</button>
      <div className={styles.sceneBody}>
        {view.kind === 'replay'
          ? <ActivityReplay key={sceneKey} reads={reads} activityId={view.activityId} stageId={view.stageId ?? null} clock={clock} headingLevel={2}
            viewerId={player ? state.owner?.gladiatorId ?? null : null} />
          : !reads ? <p role="status">Loading the expedition…</p>
            : <ExpeditionView key={sceneKey} reads={reads} activityId={view.activityId} fixture={fixture} revision={state.revision} world={state.world}
              worldFailed={!state.world && state.syncError !== null} owner={player ? state.owner : null}
              overCamp={{ onWatch: stageId => onWatch?.({ kind: 'replay', activityId: view.activityId, stageId }) }} />}
      </div>
    </dialog>
  );
}
