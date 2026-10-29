'use client';

// React host for the expedition scene. Phaser, the asset package and the scene load lazily in the
// browser. The scene draws the stage state it reads every frame; it keeps no clock of its own. If WebGL
// or the art is missing, the host shows a note, and the progress strip, log and result keep working
// because they are React. Once the scene's gladiator has left for camp, a banner over the scene says
// so; a `banner` the view gives (the whole-trip replay's camp chapters, Patch A Task 9) takes its place.
// The whole-trip replay's camp chapters (Patch A Task 10) are drawn on the camp's own map, by a second scene in the same Phaser
// game (src/game/trip-camp-scene.ts, never a second WebGL context): the view's `vignette` (given in the replay only) says which
// one plays; the camp scene and its art load when the replay starts, and each frame runs the camp scene while a camp chapter
// plays and the expedition scene otherwise (the other one asleep). A camp scene that cannot load leaves the expedition scene
// drawing the trail's start or end. Unmounting removes the scenes' bridge listeners and destroys the game.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { SceneBridge } from './bridge';
import type { ExpeditionSceneState } from './expedition-stage';
import type { ExpeditionDebugState, ExpeditionEnvironment, ExpeditionPropDebug, ExpeditionSceneHandle, GladiatorLook } from './expedition-scene';
import type { TripCampDebug, TripCampHandle } from './trip-camp-scene';
import type { TripVignette } from './trip-replay';
import { supportsWebGL } from './webgl';
import { startGame } from './phaser-game';
import styles from './ExpeditionViewport.module.css';

type Status = { kind: 'loading' } | { kind: 'ready' } | { kind: 'unavailable'; message: string };

/** Fixture builds only (NEXT_PUBLIC_FIXTURE_ENABLED): browser tests read the drawn scene. */
export type ExpeditionSceneTestHook = {
  debug(): ExpeditionDebugState | null;
  props(): ExpeditionPropDebug[];
  canvases(): number;
  /** The map drawn now: the expedition's, or the camp's while a camp chapter of the whole-trip replay plays. */
  map(): ExpeditionEnvironment | 'camp';
  /** The camp scene of the whole-trip replay, once the replay has added it (null before, and outside the replay). */
  camp(): TripCampDebug | null;
};
declare global {
  interface Window { __cloudiatorExpeditionScene?: ExpeditionSceneTestHook }
}

export function ExpeditionViewport({ environment, state, look, bridge, reducedMotion, label, banner = null, wander = true, vignette }: {
  environment: ExpeditionEnvironment;
  /** The stage state at the display clock; the scene reads it every frame. */
  state: () => ExpeditionSceneState | null;
  look: GladiatorLook;
  bridge: SceneBridge;
  reducedMotion: boolean;
  /** Accessible description of the scene. */
  label: string;
  /** Shown over the scene where "Returned to camp" shows, in its place ("Leaving camp", "Resting until 3:00 AM"). */
  banner?: string | null;
  /**
   * Whether a search walks its steps around the spot (Task 24 search pose). The whole-trip replay runs a search at about x150, so
   * the steps would strobe: it holds the search on the spot (turns only).
   */
  wander?: boolean;
  /**
   * The whole-trip replay only (Patch A Task 10): the camp chapter at the replay clock, read every frame (null outside the camp
   * chapters). Given, it adds the camp's scene to the game; while it names a chapter, the camp's map is drawn instead.
   */
  vignette?: () => TripVignette | null;
}) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<ExpeditionSceneHandle | null>(null);
  const campHandle = useRef<TripCampHandle | null>(null);
  const stateRef = useRef(state);
  const lookRef = useRef(look);
  const reduced = useRef(reducedMotion);
  const wanderRef = useRef(wander);
  const vignetteRef = useRef(vignette ?? null);
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(following);
  const [returned, setReturned] = useState(false);
  const statusId = useId();

  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { lookRef.current = look; handle.current?.setLook(look); campHandle.current?.setLook(look); }, [look]);
  useEffect(() => {
    reduced.current = reducedMotion;
    handle.current?.setReducedMotion(reducedMotion);
    campHandle.current?.setReducedMotion(reducedMotion);
  }, [reducedMotion]);
  useEffect(() => { wanderRef.current = wander; }, [wander]);
  useEffect(() => { vignetteRef.current = vignette ?? null; }, [vignette]);
  useEffect(() => { followingRef.current = following; }, [following]);
  useEffect(() => bridge.on('follow-character', ({ gladiatorId }) => setFollowing(gladiatorId !== null)), [bridge]);

  useEffect(() => {
    let cancelled = false;
    let failed = false;
    let game: ReturnType<typeof startGame> | null = null;
    /** The whole-trip replay has asked for the camp's scene (asked once: a module that fails to load leaves the camp undrawn). */
    let campAsked = false;
    /** The camp's map is the one drawn this frame. */
    let showingCamp = false;
    setFollowing(true);
    setReturned(false);
    const disposeCamp = () => {
      campHandle.current?.dispose();
      campHandle.current = null;
    };
    const fail = (reason: 'webgl' | 'assets' | 'error', message: string) => {
      if (cancelled || failed) return;
      failed = true;
      setStatus({ kind: 'unavailable', message });
      handle.current?.dispose();
      handle.current = null;
      disposeCamp();
      game?.destroy();
      game = null;
      // Deferred so listeners that subscribe in later effects still hear it.
      setTimeout(() => { if (!cancelled) bridge.emit('scene-unavailable', { reason, message }); }, 0);
    };
    if (!supportsWebGL()) {
      fail('webgl', 'The animated expedition needs WebGL, which this browser does not provide. The progress, the activity log and the result below still work.');
      return () => { cancelled = true; };
    }
    (async () => {
      const [P, assets, expedition] = await Promise.all([import('phaser'), import('./assets'), import('./expedition-scene')]);
      if (cancelled || !host.current) return;
      const created = expedition.createExpeditionScene(P, {
        manifest: assets.loadAssetManifest(),
        atlasData: assets.ATLAS_DATA,
        assetBase: '/assets/',
        environment,
        state: () => stateRef.current(),
        look: lookRef.current,
        bridge,
        reducedMotion: reduced.current,
        wander: () => wanderRef.current,
        onReady: () => { if (!cancelled) setStatus({ kind: 'ready' }); },
        onReturned: next => { if (!cancelled) setReturned(next); },
        onError: (reason, message) => fail(reason, reason === 'assets'
          ? `The expedition art could not load (${message}). The progress, the activity log and the result below still work.`
          : `The animated expedition stopped: ${message}. The progress, the activity log and the result below still work.`),
      });
      handle.current = created.handle;
      game = startGame(P, {
        type: P.WEBGL,
        parent: host.current,
        // Crisp pixels at every zoom step, as in the camp.
        smoothPixelArt: true,
        backgroundColor: '#1f3326',
        banner: false,
        disableContextMenu: true,
        input: { keyboard: false },
        scale: { mode: P.Scale.RESIZE, width: '100%', height: '100%' },
        scene: [created.scene],
      });
      const phaser = game.game;
      let tripScene: typeof created.scene | null = null;
      /** The replay has started: the camp's scene joins the game, and its art starts loading. */
      const addCamp = () => {
        campAsked = true;
        import('./trip-camp-scene').then(module => {
          if (cancelled || failed) return;
          const trip = module.createTripCampScene(P, {
            manifest: assets.loadAssetManifest(),
            atlasData: assets.ATLAS_DATA,
            assetBase: '/assets/',
            vignette: () => vignetteRef.current?.() ?? null,
            look: lookRef.current,
            reducedMotion: reduced.current,
            // The light of the chapter's time of day: the display time the view draws (the departure, or the end of the slot).
            now: () => stateRef.current()?.displayNowMs ?? 0,
            bridge,
            following: followingRef.current,
          });
          campHandle.current = trip.handle;
          tripScene = trip.scene;
          phaser.scene.add(module.TRIP_CAMP_SCENE, trip.scene, true);
        }).catch(() => undefined);
      };
      // Before each frame: the camp's scene runs while a camp chapter plays (once its art is in), the expedition's otherwise.
      const choose = () => {
        const read = vignetteRef.current;
        if (read && !campAsked) addCamp();
        const wanted = !!read && !!tripScene && read() !== null && !!campHandle.current?.debug().ready;
        const [run, rest] = wanted ? [tripScene, created.scene] : [created.scene, tripScene];
        if (rest?.sys.isActive()) phaser.scene.sleep(rest);
        if (run?.sys.isSleeping()) phaser.scene.wake(run);
        showingCamp = wanted;
      };
      phaser.events.on(P.Core.Events.PRE_STEP, choose);
      if (process.env.NEXT_PUBLIC_FIXTURE_ENABLED === 'true') {
        window.__cloudiatorExpeditionScene = {
          debug: () => handle.current?.debug() ?? null,
          props: () => handle.current?.props() ?? [],
          canvases: () => document.querySelectorAll('canvas').length,
          map: () => (showingCamp ? 'camp' : environment),
          camp: () => campHandle.current?.debug() ?? null,
        };
      }
    })().catch(error => fail('error', error instanceof Error ? error.message : String(error)));
    return () => {
      cancelled = true;
      handle.current?.dispose();
      handle.current = null;
      disposeCamp();
      game?.destroy();
      game = null;
      if (window.__cloudiatorExpeditionScene) delete window.__cloudiatorExpeditionScene;
    };
  }, [bridge, environment]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return; // leave browser zoom and shortcuts alone
    const step = 64;
    const pan: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (pan[event.key]) bridge.emit('camera-pan', { dx: pan[event.key][0], dy: pan[event.key][1] });
    else if (event.key === '+' || event.key === '=') bridge.emit('camera-zoom', { direction: 'in' });
    else if (event.key === '-' || event.key === '_') bridge.emit('camera-zoom', { direction: 'out' });
    else if (event.key === '0') bridge.emit('camera-zoom', { direction: 'reset' });
    else if (event.key.toLowerCase() === 'f') bridge.emit('follow-character', { gladiatorId: following ? null : look.key });
    else return;
    event.preventDefault();
  };

  const unavailable = status.kind === 'unavailable';
  return (
    <div className={styles.viewport}>
      <div
        ref={host}
        className={styles.canvas}
        tabIndex={unavailable ? -1 : 0}
        role={unavailable ? undefined : 'application'}
        aria-label={unavailable ? 'Expedition view unavailable' : label}
        aria-describedby={statusId}
        onKeyDown={unavailable ? undefined : onKeyDown}
        // Phaser cancels the default pointerdown, so focus the host ourselves for the arrow keys.
        onPointerDown={() => host.current?.focus({ preventScroll: true })}
      />
      {status.kind === 'ready' && (banner ?? (returned ? 'Returned to camp' : null)) !== null
        && <p key={banner ?? 'returned'} className={styles.returned} data-testid="scene-banner">{banner ?? 'Returned to camp'}</p>}
      {!unavailable && (
        <div className={styles.controls} role="group" aria-label="Camera controls">
          <button type="button" onClick={() => bridge.emit('camera-zoom', { direction: 'in' })} aria-label="Zoom in">+</button>
          <button type="button" onClick={() => bridge.emit('camera-zoom', { direction: 'out' })} aria-label="Zoom out">−</button>
          <button type="button" onClick={() => bridge.emit('camera-zoom', { direction: 'reset' })} aria-label="Reset zoom">1:1</button>
          <button type="button" aria-pressed={following} onClick={() => bridge.emit('follow-character', { gladiatorId: following ? null : look.key })}
            aria-label="Follow the gladiator">Follow</button>
        </div>
      )}
      <p id={statusId} className={unavailable ? styles.fallback : styles.status} role="status">
        {status.kind === 'loading' ? 'Opening the expedition…' : unavailable ? status.message : ''}
      </p>
    </div>
  );
}
