'use client';

// React host for the Phaser camp. Phaser and the asset package load lazily in the browser,
// so the static build never touches WebGL. Unmounting destroys the game and its listeners.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Game } from 'phaser';
import type { WorldSnapshot } from '@contracts/reads';
import type { SceneBridge } from './bridge';
import type { CampDebugState, CampSceneHandle } from './camp-scene';
import styles from './GameViewport.module.css';

type Status = { kind: 'loading' } | { kind: 'ready' } | { kind: 'unavailable'; message: string };

export type CampTestHook = { state(): CampDebugState | null; canvases(): number; listeners(): number };
declare global {
  interface Window { __cloudiatorCamp?: CampTestHook }
}

function supportsWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

export function GameViewport({ world, bridge }: { world: WorldSnapshot | null; bridge: SceneBridge }) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<CampSceneHandle | null>(null);
  const latestWorld = useRef(world);
  const clock = useRef({ serverNowMs: world?.serverNowMs ?? 0, at: 0 });
  const [status, setStatus] = useState<Status>({ kind: 'loading' });

  useEffect(() => {
    latestWorld.current = world;
    if (!world) return;
    clock.current = { serverNowMs: world.serverNowMs, at: performance.now() };
    handle.current?.setWorld(world);
  }, [world]);

  useEffect(() => {
    let cancelled = false;
    let game: Game | null = null;
    const fail = (reason: 'webgl' | 'assets' | 'error', message: string) => {
      if (cancelled) return;
      setStatus({ kind: 'unavailable', message });
      bridge.emit('scene-unavailable', { reason, message });
      game?.destroy(true);
      game = null;
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
        now: () => clock.current.serverNowMs + (performance.now() - clock.current.at),
        onReady: () => { if (!cancelled) setStatus({ kind: 'ready' }); },
        onError: (reason, message) => fail(reason, reason === 'assets' ? `The camp art could not load (${message}). Management panels still work.` : `The camp view stopped: ${message}`),
      });
      handle.current = created.handle;
      game = new P.Game({
        type: P.WEBGL,
        parent: host.current,
        pixelArt: true,
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
          canvases: () => document.querySelectorAll('canvas').length,
          listeners: () => bridge.listenerCount(),
        };
      }
    })().catch(error => fail('error', error instanceof Error ? error.message : String(error)));
    return () => {
      cancelled = true;
      handle.current = null;
      game?.destroy(true);
      game = null;
      if (window.__cloudiatorCamp) delete window.__cloudiatorCamp;
    };
  }, [bridge]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = 64;
    const pan: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (pan[event.key]) { bridge.emit('camera-pan', { dx: pan[event.key][0], dy: pan[event.key][1] }); event.preventDefault(); }
    else if (event.key === '+' || event.key === '=') { bridge.emit('camera-zoom', { direction: 'in' }); event.preventDefault(); }
    else if (event.key === '-' || event.key === '_') { bridge.emit('camera-zoom', { direction: 'out' }); event.preventDefault(); }
    else if (event.key === '0') { bridge.emit('camera-zoom', { direction: 'reset' }); event.preventDefault(); }
  };

  return (
    <div className={styles.viewport}>
      <div
        ref={host}
        className={styles.canvas}
        tabIndex={0}
        role="application"
        aria-label="Isometric camp view. Drag or use the arrow keys to look around; use plus and minus to zoom."
        aria-describedby="camp-status"
        onKeyDown={onKeyDown}
      />
      {status.kind !== 'unavailable' && (
        <div className={styles.controls} aria-label="Camera controls">
          <button type="button" onClick={() => bridge.emit('camera-zoom', { direction: 'in' })} aria-label="Zoom in">+</button>
          <button type="button" onClick={() => bridge.emit('camera-zoom', { direction: 'out' })} aria-label="Zoom out">−</button>
          <button type="button" onClick={() => bridge.emit('camera-zoom', { direction: 'reset' })} aria-label="Reset zoom">1:1</button>
        </div>
      )}
      <p id="camp-status" className={status.kind === 'unavailable' ? styles.fallback : styles.status} role="status">
        {status.kind === 'loading' ? 'Opening the camp…' : status.kind === 'unavailable' ? status.message : ''}
      </p>
    </div>
  );
}
