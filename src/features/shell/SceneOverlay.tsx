'use client';

// A replay or an expedition as a full-screen scene over the camp (spec "Scenes", the approved mockup's bout scene; Task
// 13.8). It is a labelled modal dialog: the camp is paused beneath it (Task 23.4, C8) and takes no input, its Back button
// (or Escape) closes it, and the focus goes back to whatever opened it. The button names where it goes, "← Results" or "← Arena"
// (the scene's `from`), or "← Camp" for a scene with no origin, and on a phone sits in a solid bar at the top, so nothing floats
// over the content once it scrolls (Arena replays Task 3). The scenes are the existing views: the battle
// replay, filtered by the shared display clock, and the followable expedition, re-read on the shared revision. A
// viewer who is not a player never gets an owner summary here (the live server sends a visitor none; the fixture
// preview's samples carry their owner's, so the scene drops it), so visitors never see rewards in a scene. An address
// with a malformed activity id names nothing: the scene says so and reads nothing (final review Minor 6). Each view is
// the account's own read: once the session is known, a sign-out, expiry or account switch (here or in another tab)
// remounts it as the new reader, so no owner's rewards outlive the session (final review Minor 1). It mounts only once
// the viewer is known, so a signed-in deep link reads once (Task 23.5). A player's replay scene marks its activity watched on this
// device whenever it shows one, so My bouts drops that bout's dot (Arena replays Task 4). A replay takes the focus from Back to ⏸ once
// it has loaded, and its result card offers the same way back at the end (Arena replays Task 5).
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import type { GameGateway } from '../../lib/api/gateway';
import type { GameUiState } from '../character/useGameState';
import { ActivityReplay, BattleReplay } from '../arena/BattleReplay';
import { ExpeditionUnavailable, ExpeditionView, type ExpeditionReads } from '../character/ExpeditionView';
import { appearancesOf } from '../../game/replay-looks';
import { markWatched } from '../bouts/watched';
import { useBoutList, type BoutsStore } from '../bouts/bouts-store';
import type { ReplayQueue } from '../bouts/bout-queue';
import { backLabel, boutFilterOf, namedScene, sameSceneSource, sceneFromOf, sceneKeyOf, sceneOf, type SceneAddress, type SceneView } from './scene-url';
import styles from './shell.module.css';

/** The camp view, which takes the keyboard when the scene had no opener to give it back to. */
const focusCamp = () => document.querySelector<HTMLElement>('[data-camp-view] [role="application"]')?.focus({ preventScroll: true });

export function SceneOverlay({ view, gateway, state, fixture = false, onClose, onWatch, bouts, onReplace }: {
  view: SceneAddress;
  /** The camp's reads: the live gateway, or the fixture preview's once it has loaded (null until then). */
  gateway: GameGateway | null;
  state: GameUiState;
  fixture?: boolean;
  /** The Back button or Escape: the shell emits `return-camp`. */
  onClose(): void;
  /** An expedition's encounter replay: the shell opens the replay scene. */
  onWatch?(view: SceneView): void;
  bouts: BoutsStore | null;
  onReplace(view: SceneView): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const [counterHost, setCounterHost] = useState<HTMLSpanElement | null>(null);
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
  // top with the focus on Back, as the first one did: the control that opened it is gone (fix round 1, M6). An
  // expedition's live view and its whole-trip replay (`play`) are one scene: the view switches between them itself, keeping its
  // reads and its place, and puts the focus on ▶ or back on its own button (Patch A Task 9). A scene's origin is not part of it, and
  // a bracket's bouts are chapters of one scene (`sceneKeyOf`).
  const named = namedScene(view);
  // A replay's stage is a chapter of the loaded activity too: replace its address without rereading its timeline or looks.
  const sceneKey = named?.kind === 'expedition' || named?.kind === 'replay' ? `${named.kind}|${named.activityId}` : sceneKeyOf(view);
  const shownKey = useRef(sceneKey);
  useLayoutEffect(() => {
    if (shownKey.current === sceneKey) return;
    shownKey.current = sceneKey;
    dialog.current?.scrollTo({ top: 0 });
    back.current?.focus({ preventScroll: true });
  }, [sceneKey]);

  const player = state.viewer === 'player';
  // My bouts' "not watched" dot goes once a player's replay scene shows the bout (each later bout it steps to as well).
  const watching = player && named?.kind === 'replay' ? named.activityId : null;
  const displayClock = state.clock;
  useEffect(() => { if (watching) markWatched(watching, displayClock.now()); }, [watching, displayClock]);
  const reads = useMemo<(ExpeditionReads & Partial<Pick<GameGateway, 'looks' | 'restAfter'>>) | null>(() => {
    if (!gateway) return null;
    if (player) return gateway;
    // The fighters' looks are public, so a visitor's replay reads them too, and whether a trip's next slot was a Rest (the whole-trip
    // replay's last chapter, Patch A Task 9).
    return { timeline: async id => { const { summary: _owner, ...shown } = await gateway.timeline(id); return shown; }, looks: ids => gateway.looks(ids),
      restAfter: (gladiatorId, tripEndMs) => gateway.restAfter(gladiatorId, tripEndMs) };
  }, [gateway, player]);
  // The camp's own world actors already hold their looks: a replay of those fighters reads nothing (the replay takes them once,
  // when it mounts, so a world refresh never changes a replay in play).
  const known = useMemo(() => appearancesOf(state.world?.actors), [state.world]);

  // The display clock has a server time once the shared sync has read the world (or it never will).
  const clock = state.world || state.syncError ? state.clock : null;
  const from = sceneFromOf(view);
  const label = backLabel(from);
  // A scene it opens from this one (an encounter's replay, the whole trip) goes back to the same place.
  const origin = from ? { from } : {};
  const filter = boutFilterOf(from) ?? 'all';
  const owner = player ? state.owner : null;
  const currentActivityId = owner?.currentActivity && ['arena', 'tournament'].includes(owner.currentActivity.kind) ? owner.currentActivity.id : null;
  const replayId = named?.kind === 'replay' ? named.activityId : null;
  const replayStage = named?.kind === 'replay' ? named.stageId : undefined;
  const queue = useMemo<ReplayQueue | null>(() => bouts && owner && replayId ? {
    filter, get list() { return bouts.list(filter); }, ownerName: owner.name, currentActivityId,
    open: activityId => {
      // Native history changes the address before React commits new props/refs. A page from that older source must not replace it.
      const source: SceneView = { kind: 'replay', activityId: replayId, ...(replayStage ? { stageId: replayStage } : {}), ...(from ? { from } : {}) };
      if (!sameSceneSource(sceneOf(new URL(window.location.href).searchParams), source)) return;
      onReplace({ kind: 'replay', activityId, ...(from ? { from } : {}) });
    },
    more: () => bouts.more(filter),
  } : null, [bouts, owner?.gladiatorId, owner?.name, replayId, replayStage, filter, currentActivityId, from, onReplace]);
  const viewKey = `${sceneKey}|${state.session.userId ?? 'visitor'}`;
  // The view mounts once the viewer is known: the session, and for an account its owner read (Task 23.5, C19). Mounted
  // earlier, a signed-in player's view would read as a visitor's and remount as the player's a moment later, reading its
  // timeline twice and restarting the replay.
  const loading = !reads || state.session.status === 'loading' || state.viewer === 'loading';
  return (
    <dialog ref={dialog} className={styles.scene} aria-label={view.kind === 'expedition' ? 'Expedition' : 'Replay'}
      // Escape asks the scene to close: the address goes back to the camp, and the dialog stays open (with the focus in
      // it) until the scene unmounts and gives the focus back to its opener (Task 23.5: a native close would drop the
      // focus to <body> until then). Should the browser close it anyway, follow that into the address. The close event
      // comes a task later, so one from an unmount (or React's development remount) finds the dialog open again or gone.
      onCancel={event => { event.preventDefault(); closeRef.current(); }}
      onClose={() => { if (!leaving.current && !dialog.current?.open) closeRef.current(); }}>
      <div className={styles.sceneTop} data-testid="scene-top">
        <button ref={back} type="button" className={styles.sceneBack} data-scene-back="" aria-label={`Back to ${label}`} onClick={onClose}><span aria-hidden="true">←</span> {label}</button>
        <span ref={setCounterHost} className={styles.sceneCounter} />
      </div>
      <div className={styles.sceneBody}>
        {named === null
          ? view.kind === 'expedition' ? <ExpeditionUnavailable fixture={fixture} reason="not-found" overCamp />
            : <BattleReplay view={{ kind: 'unavailable', reason: 'not-found' }} headingLevel={2} />
          // A bracket's bout opens in its own viewer (Task 9); until it does, its address says no replay was found.
          : named.kind === 'bout' ? <BattleReplay view={{ kind: 'unavailable', reason: 'not-found' }} headingLevel={2} />
          : named.kind === 'replay'
            ? loading ? <p role="status">Loading the replay…</p>
              : <QueuedReplay key={viewKey} store={bouts} queue={queue} reads={reads} activityId={named.activityId} stageId={named.stageId ?? null} clock={clock} headingLevel={2} counterHost={counterHost}
                onChapter={stageId => {
                  // The activity stays mounted; hand the outgoing chapter's focus to Back before its player remounts.
                  back.current?.focus({ preventScroll: true });
                  onReplace({ kind: 'replay', activityId: named.activityId, stageId, ...origin });
                }}
                viewerId={player ? state.owner?.gladiatorId ?? null : null} known={known} takeFocus back={{ label, go: onClose }} />
            : loading ? <p role="status">Loading the expedition…</p>
              : <ExpeditionView key={viewKey} reads={reads} activityId={named.activityId} fixture={fixture} play={named.play ?? null}
                onPlay={play => onWatch?.(play ? { kind: 'expedition', activityId: named.activityId, play, ...origin } : { kind: 'expedition', activityId: named.activityId, ...origin })}
                revision={state.revision} world={state.world}
                worldFailed={!state.world && state.syncError !== null} owner={player ? state.owner : null}
                overCamp={{ onWatch: stageId => onWatch?.({ kind: 'replay', activityId: named.activityId, stageId, ...origin }) }} />}
      </div>
    </dialog>
  );
}

/** Keep the same store snapshot live while a replay steps or reads its next page. */
function QueuedReplay({ store, queue, ...props }: ComponentProps<typeof ActivityReplay> & { store: BoutsStore | null }) {
  return store && queue ? <SubscribedReplay store={store} queue={queue} {...props} /> : <ActivityReplay {...props} />;
}
function SubscribedReplay({ store, queue, ...props }: ComponentProps<typeof ActivityReplay> & { store: BoutsStore; queue: ReplayQueue }) {
  useBoutList(store, queue.filter);
  return <ActivityReplay {...props} queue={queue} />;
}
