'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { WorldSnapshot } from '@contracts/reads';
import type { Dungeon } from '@domain/types';
import { createSceneBridge } from '../../game/bridge';
import type { DungeonSceneDebug, DungeonSceneHandle } from '../../game/dungeon-scene';
import type { DungeonSceneState } from '../../game/dungeon-stage';
import { startGame } from '../../game/phaser-game';
import type { TripCampDebug, TripCampHandle } from '../../game/trip-camp-scene';
import type { TripVignette } from '../../game/trip-replay';
import { supportsWebGL } from '../../game/webgl';
import { useReducedMotion } from '../character/LookPreview';
import styles from './DungeonViewport.module.css';

type Props = {
  dungeon: Dungeon;
  state: DungeonSceneState;
  departure: string | null;
  world: WorldSnapshot | null;
  vignette: TripVignette | null;
  replay: boolean;
  paused: boolean;
};
type Status = { kind: 'loading' | 'ready' } | { kind: 'unavailable'; message: string };

export type DungeonSceneTestHook = {
  debug(): DungeonSceneDebug | null;
  camp(): TripCampDebug | null;
  map(): Dungeon['map'] | 'camp';
  canvases(): number;
};
declare global { interface Window { __cloudiatorDungeonScene?: DungeonSceneTestHook } }

/** The dungeon map and the camp replay chapters share one game and its atlases. */
export function DungeonViewport({ dungeon, state, departure, world, vignette, replay, paused }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [bridge] = useState(createSceneBridge);
  const reduced = useReducedMotion();
  const current = useRef({ state, departure, world, vignette, replay, paused, reduced });
  const [following, setFollowing] = useState(true);
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const statusId = useId();
  useEffect(() => { current.current = { state, departure, world, vignette, replay, paused, reduced }; },
    [state, departure, world, vignette, replay, paused, reduced]);
  useEffect(() => bridge.on('follow-character', ({ gladiatorId }) => setFollowing(gladiatorId !== null)), [bridge]);

  useEffect(() => {
    let stopped = false, failed = false, askedCamp = false;
    let game: ReturnType<typeof startGame> | null = null;
    let sceneHandle: DungeonSceneHandle | null = null, campHandle: TripCampHandle | null = null;
    let debug: DungeonSceneTestHook | undefined;
    setStatus({ kind: 'loading' });
    setFollowing(true);
    const dispose = () => {
      sceneHandle?.dispose();
      campHandle?.dispose();
      game?.destroy();
      sceneHandle = null;
      campHandle = null;
      game = null;
      if (debug && window.__cloudiatorDungeonScene === debug) delete window.__cloudiatorDungeonScene;
    };
    const fail = (message: string) => {
      if (stopped || failed) return;
      failed = true;
      setStatus({ kind: 'unavailable', message });
      dispose();
    };
    if (!supportsWebGL()) {
      fail('The animated dungeon map needs WebGL. The activity log and result are available below.');
      return () => { stopped = true; };
    }
    (async () => {
      const [P, assets, module] = await Promise.all([import('phaser'), import('../../game/assets'), import('../../game/dungeon-scene')]);
      if (stopped || !host.current) return;
      const manifest = assets.loadAssetManifest();
      const created = module.createDungeonScene(P, { dungeon, bridge, manifest, atlasData: assets.ATLAS_DATA, assetBase: '/assets/',
        input: () => current.current,
        onReady: () => { if (!stopped && !failed) setStatus({ kind: 'ready' }); },
        onError: (reason, message) => fail(reason === 'assets' ? `The dungeon art could not load (${message}).` : `The animated dungeon map stopped (${message}).`),
      });
      sceneHandle = created.handle;
      game = startGame(P, {
        type: P.WEBGL, parent: host.current, smoothPixelArt: true, backgroundColor: '#1f3326', banner: false,
        disableContextMenu: true, input: { keyboard: false }, scale: { mode: P.Scale.RESIZE, width: '100%', height: '100%' },
        scene: [created.scene],
      });
      const phaser = game.game;
      let campScene: typeof created.scene | null = null;
      let campInput: typeof current.current | null = null;
      const campLook = () => module.dungeonLeaderLook(dungeon, current.current.departure, current.current.world, current.current.state.fight);
      const addCamp = () => {
        askedCamp = true;
        import('../../game/trip-camp-scene').then(camp => {
          if (stopped || failed) return;
          const trip = camp.createTripCampScene(P, { manifest, atlasData: assets.ATLAS_DATA, assetBase: '/assets/',
            vignette: () => current.current.vignette, look: campLook(), reducedMotion: current.current.reduced,
            bridge, following: sceneHandle?.debug()?.following ?? true,
          });
          campHandle = trip.handle;
          campScene = trip.scene;
          campInput = current.current;
          phaser.scene.add(camp.TRIP_CAMP_SCENE, campScene, true);
        }).catch(() => undefined); // The dungeon map is the fallback if camp art is unavailable.
      };
      phaser.events.on(P.Core.Events.PRE_STEP, () => {
        if (stopped || failed) return;
        const next = current.current;
        if (next.replay && !askedCamp && sceneHandle?.ready()) addCamp();
        if (campHandle && campInput && next !== campInput) {
          if (next.reduced !== campInput.reduced) campHandle.setReducedMotion(next.reduced);
          if (next.departure !== campInput.departure || next.world !== campInput.world || next.state.fight?.log !== campInput.state.fight?.log) campHandle.setLook(campLook());
          campInput = next;
        }
        if (!campScene || !campHandle?.ready()) return;
        const [active, idle] = next.vignette ? [campScene, created.scene] : [created.scene, campScene];
        if (idle.sys.isActive()) phaser.scene.sleep(idle);
        if (active.sys.isSleeping()) phaser.scene.wake(active);
      });
      if (process.env.NEXT_PUBLIC_FIXTURE_ENABLED === 'true') {
        debug = { debug: () => sceneHandle?.debug() ?? null, camp: () => campHandle?.debug() ?? null,
          map: () => campScene?.sys.isActive() && campHandle?.ready() ? 'camp' : dungeon.map,
          canvases: () => host.current?.querySelectorAll('canvas').length ?? 0 };
        window.__cloudiatorDungeonScene = debug;
      }
    })().catch(error => fail(`The animated dungeon map could not open (${error instanceof Error ? error.message : String(error)}).`));
    return () => { stopped = true; dispose(); };
  }, [bridge, dungeon]);

  const follow = () => bridge.emit('follow-character', { gladiatorId: following ? null : 'dungeon-party' });
  const zoom = (direction: 'in' | 'out' | 'reset') => bridge.emit('camera-zoom', { direction });
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    switch (event.key) {
      case 'ArrowLeft': bridge.emit('camera-pan', { dx: 64, dy: 0 }); break;
      case 'ArrowRight': bridge.emit('camera-pan', { dx: -64, dy: 0 }); break;
      case 'ArrowUp': bridge.emit('camera-pan', { dx: 0, dy: 64 }); break;
      case 'ArrowDown': bridge.emit('camera-pan', { dx: 0, dy: -64 }); break;
      case '+': case '=': zoom('in'); break;
      case '-': case '_': zoom('out'); break;
      case '0': zoom('reset'); break;
      case 'f': case 'F': follow(); break;
      default: return;
    }
    event.preventDefault();
  };

  const ready = status.kind === 'ready';
  return <div className={styles.viewport}>
    <div ref={host} className={styles.canvas} role={ready ? 'application' : undefined} tabIndex={ready ? 0 : -1}
      aria-label={ready ? `${dungeon.name} dungeon map` : undefined} aria-describedby={statusId}
      onKeyDown={ready ? keyDown : undefined} onPointerDown={ready ? () => host.current?.focus({ preventScroll: true }) : undefined} />
    {ready && <div className={styles.controls} role="group" aria-label="Camera controls">
      <button type="button" onClick={() => zoom('in')} aria-label="Zoom in">+</button>
      <button type="button" onClick={() => zoom('out')} aria-label="Zoom out">−</button>
      <button type="button" onClick={() => zoom('reset')} aria-label="Reset zoom">1:1</button>
      <button type="button" aria-pressed={following} onClick={follow} aria-label="Follow the party">Follow</button>
    </div>}
    <p id={statusId} role="status" className={status.kind === 'unavailable' ? styles.fallback : styles.status}>
      {status.kind === 'loading' ? 'Opening the dungeon map…' : status.kind === 'unavailable' ? status.message : ''}
    </p>
  </div>;
}
