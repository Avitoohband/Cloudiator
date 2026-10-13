'use client';

// React host for the expedition scene. Phaser, the asset package and the scene load lazily in the
// browser. The scene draws the stage state it reads every frame; it keeps no clock of its own. If WebGL
// or the art is missing, the host shows a note, and the progress strip, log and result keep working
// because they are React. Unmounting removes the scene's bridge listeners and destroys the game.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { SceneBridge } from './bridge';
import type { ExpeditionSceneState } from './expedition-stage';
import type { ExpeditionDebugState, ExpeditionEnvironment, ExpeditionPropDebug, ExpeditionSceneHandle, GladiatorLook } from './expedition-scene';
import { supportsWebGL } from './webgl';
import { startGame } from './phaser-game';
import styles from './ExpeditionViewport.module.css';

type Status = { kind: 'loading' } | { kind: 'ready' } | { kind: 'unavailable'; message: string };

/** Fixture builds only (NEXT_PUBLIC_FIXTURE_ENABLED): browser tests read the drawn scene. */
export type ExpeditionSceneTestHook = { debug(): ExpeditionDebugState | null; props(): ExpeditionPropDebug[]; canvases(): number };
declare global {
  interface Window { __cloudiatorExpeditionScene?: ExpeditionSceneTestHook }
}

export function ExpeditionViewport({ environment, state, look, bridge, reducedMotion, label }: {
  environment: ExpeditionEnvironment;
  /** The stage state at the display clock; the scene reads it every frame. */
  state: () => ExpeditionSceneState | null;
  look: GladiatorLook;
  bridge: SceneBridge;
  reducedMotion: boolean;
  /** Accessible description of the scene. */
  label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<ExpeditionSceneHandle | null>(null);
  const stateRef = useRef(state);
  const lookRef = useRef(look);
  const reduced = useRef(reducedMotion);
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [following, setFollowing] = useState(true);
  const statusId = useId();

  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { lookRef.current = look; handle.current?.setLook(look); }, [look]);
  useEffect(() => { reduced.current = reducedMotion; handle.current?.setReducedMotion(reducedMotion); }, [reducedMotion]);
  useEffect(() => bridge.on('follow-character', ({ gladiatorId }) => setFollowing(gladiatorId !== null)), [bridge]);

  useEffect(() => {
    let cancelled = false;
    let failed = false;
    let game: ReturnType<typeof startGame> | null = null;
    setFollowing(true);
    const fail = (reason: 'webgl' | 'assets' | 'error', message: string) => {
      if (cancelled || failed) return;
      failed = true;
      setStatus({ kind: 'unavailable', message });
      handle.current?.dispose();
      handle.current = null;
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
        onReady: () => { if (!cancelled) setStatus({ kind: 'ready' }); },
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
      if (process.env.NEXT_PUBLIC_FIXTURE_ENABLED === 'true') {
        window.__cloudiatorExpeditionScene = {
          debug: () => handle.current?.debug() ?? null,
          props: () => handle.current?.props() ?? [],
          canvases: () => document.querySelectorAll('canvas').length,
        };
      }
    })().catch(error => fail('error', error instanceof Error ? error.message : String(error)));
    return () => {
      cancelled = true;
      handle.current?.dispose();
      handle.current = null;
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
