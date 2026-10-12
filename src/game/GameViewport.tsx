'use client';

// React host for the Phaser camp. Phaser and the asset package load lazily in the browser,
// so the static build never touches WebGL. Unmounting removes the scene's bridge listeners
// synchronously and destroys the game.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { Game } from 'phaser';
import type { WorldSnapshot } from '@contracts/reads';
import type { Point } from './iso';
import type { SceneBridge, SceneEventName, SceneEvents } from './bridge';
import type { CampDebugState, CampSceneHandle, PropDebug } from './camp-scene';
import styles from './GameViewport.module.css';

type Status = { kind: 'loading' } | { kind: 'ready' } | { kind: 'unavailable'; message: string };

/** Fixture builds only (NEXT_PUBLIC_FIXTURE_ENABLED): browser tests read and drive the scene. */
export type CampTestHook = {
  state(): CampDebugState | null;
  props(): PropDebug[];
  canvases(): number;
  listeners(): number;
  emit<E extends SceneEventName>(event: E, payload: SceneEvents[E]): void;
  centerOn(x: number, y: number, zoom?: number): void;
  screenOf(id: string): Point | null;
  world(): WorldSnapshot | null;
  /** Pushes a world straight to the scene, as a new server snapshot would. */
  setWorld(world: WorldSnapshot): void;
  /** Stops the scene clock at a server time (null resumes it) for deterministic captures. */
  freezeClock(serverNowMs: number | null): void;
};
declare global {
  interface Window { __cloudiatorCamp?: CampTestHook }
}

function supportsWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    // Release the probe context at once; browsers cap live WebGL contexts per page.
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return !!gl;
  } catch {
    return false;
  }
}

const prefersReducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function GameViewport({ world, bridge, focusGladiatorId = null }: { world: WorldSnapshot | null; bridge: SceneBridge; focusGladiatorId?: string | null }) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<CampSceneHandle | null>(null);
  const latestWorld = useRef(world);
  const focus = useRef(focusGladiatorId);
  const clock = useRef({ serverNowMs: world?.serverNowMs ?? 0, at: 0 });
  const frozenAt = useRef<number | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [following, setFollowing] = useState(false);
  const statusId = useId();

  useEffect(() => { focus.current = focusGladiatorId; }, [focusGladiatorId]);

  useEffect(() => {
    latestWorld.current = world;
    if (!world) return;
    clock.current = { serverNowMs: world.serverNowMs, at: performance.now() };
    handle.current?.setWorld(world);
  }, [world]);

  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return;
    const onChange = () => handle.current?.setReducedMotion(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => bridge.on('follow-character', ({ gladiatorId }) => setFollowing(!!gladiatorId && gladiatorId === focus.current)), [bridge]);

  useEffect(() => {
    let cancelled = false;
    let failed = false;
    let game: Game | null = null;
    const fail = (reason: 'webgl' | 'assets' | 'error', message: string) => {
      if (cancelled || failed) return;
      failed = true;
      setStatus({ kind: 'unavailable', message });
      handle.current?.dispose();
      game?.destroy(true);
      game = null;
      // Deferred so panels that subscribe in their own effects (which run after ours) still hear it.
      setTimeout(() => { if (!cancelled) bridge.emit('scene-unavailable', { reason, message }); }, 0);
    };
    if (!supportsWebGL()) {
      fail('webgl', 'The animated camp needs WebGL, which this browser does not provide. Management panels still work.');
      return () => { cancelled = true; };
    }
    if (clock.current.at === 0) clock.current = { serverNowMs: latestWorld.current?.serverNowMs ?? Date.now(), at: performance.now() };
    (async () => {
      const [P, assets, campScene] = await Promise.all([import('phaser'), import('./assets'), import('./camp-scene')]);
      if (cancelled || !host.current) return;
      const created = campScene.createCampScene(P, {
        manifest: assets.loadAssetManifest(),
        atlasData: assets.ATLAS_DATA,
        assetBase: '/assets/',
        world: latestWorld.current,
        bridge,
        focusId: () => focus.current,
        reducedMotion: prefersReducedMotion(),
        now: () => frozenAt.current ?? clock.current.serverNowMs + (performance.now() - clock.current.at),
        onReady: () => { if (!cancelled) setStatus({ kind: 'ready' }); },
        onError: (reason, message) => fail(reason, reason === 'assets' ? `The camp art could not load (${message}). Management panels still work.` : `The camp view stopped: ${message}`),
      });
      handle.current = created.handle;
      game = new P.Game({
        type: P.WEBGL,
        parent: host.current,
        // Crisp pixels at every zoom step, without the uneven texels of nearest sampling at fractional scales.
        smoothPixelArt: true,
        backgroundColor: '#1c3f24',
        banner: false,
        disableContextMenu: true,
        input: { keyboard: false },
        scale: { mode: P.Scale.RESIZE, width: '100%', height: '100%' },
        scene: [created.scene],
      });
      if (process.env.NEXT_PUBLIC_FIXTURE_ENABLED === 'true') {
        window.__cloudiatorCamp = {
          state: () => handle.current?.debug() ?? null,
          props: () => handle.current?.props() ?? [],
          canvases: () => document.querySelectorAll('canvas').length,
          listeners: () => bridge.listenerCount(),
          emit: (event, payload) => bridge.emit(event, payload),
          centerOn: (x, y, zoom) => handle.current?.centerOn(x, y, zoom),
          screenOf: id => handle.current?.screenOf(id) ?? null,
          world: () => latestWorld.current,
          setWorld: next => { latestWorld.current = next; handle.current?.setWorld(next); },
          freezeClock: ms => {
            if (ms === null && frozenAt.current !== null) clock.current = { serverNowMs: frozenAt.current, at: performance.now() };
            frozenAt.current = ms;
          },
        };
      }
    })().catch(error => fail('error', error instanceof Error ? error.message : String(error)));
    return () => {
      cancelled = true;
      handle.current?.dispose();
      handle.current = null;
      game?.destroy(true);
      game = null;
      if (window.__cloudiatorCamp) delete window.__cloudiatorCamp;
    };
  }, [bridge]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return; // leave browser zoom and shortcuts alone
    const step = 64;
    const pan: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (pan[event.key]) { bridge.emit('camera-pan', { dx: pan[event.key][0], dy: pan[event.key][1] }); event.preventDefault(); }
    else if (event.key === '+' || event.key === '=') { bridge.emit('camera-zoom', { direction: 'in' }); event.preventDefault(); }
    else if (event.key === '-' || event.key === '_') { bridge.emit('camera-zoom', { direction: 'out' }); event.preventDefault(); }
    else if (event.key === '0') { bridge.emit('camera-zoom', { direction: 'reset' }); event.preventDefault(); }
  };

  const unavailable = status.kind === 'unavailable';
  return (
    <div className={styles.viewport}>
      <div
        ref={host}
        className={styles.canvas}
        tabIndex={unavailable ? -1 : 0}
        role={unavailable ? undefined : 'application'}
        aria-label={unavailable ? 'Camp view unavailable' : 'Isometric camp view. Drag or use the arrow keys to look around; use plus and minus to zoom.'}
        aria-describedby={statusId}
        onKeyDown={unavailable ? undefined : onKeyDown}
        // Phaser cancels the default pointerdown, so focus the host ourselves for the arrow keys.
        onPointerDown={() => host.current?.focus({ preventScroll: true })}
      />
      {!unavailable && (
        <div className={styles.controls} role="group" aria-label="Camera controls">
          <button type="button" onClick={() => bridge.emit('camera-zoom', { direction: 'in' })} aria-label="Zoom in">+</button>
          <button type="button" onClick={() => bridge.emit('camera-zoom', { direction: 'out' })} aria-label="Zoom out">−</button>
          <button type="button" onClick={() => bridge.emit('camera-zoom', { direction: 'reset' })} aria-label="Reset zoom">1:1</button>
          {focusGladiatorId && (
            <>
              <button type="button" onClick={() => bridge.emit('find-character', { gladiatorId: focusGladiatorId })} aria-label="Find my gladiator">Find</button>
              <button
                type="button"
                aria-pressed={following}
                onClick={() => bridge.emit('follow-character', { gladiatorId: following ? null : focusGladiatorId })}
                aria-label="Follow my gladiator"
              >Follow</button>
            </>
          )}
        </div>
      )}
      <p id={statusId} className={unavailable ? styles.fallback : styles.status} role="status">
        {status.kind === 'loading' ? 'Opening the camp…' : unavailable ? status.message : ''}
      </p>
    </div>
  );
}
