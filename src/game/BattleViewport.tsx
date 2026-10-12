'use client';

// React host for the close-up battle scene. Phaser, the asset package and the scene load lazily
// in the browser. The scene only draws the replay position it is given; if WebGL or the art is
// missing, the host shows a note and the replay controls, result and log keep working.
import { useEffect, useRef, useState } from 'react';
import type { BattleLog } from '@contracts/events';
import type { SceneBridge } from './bridge';
import type { BattleDebugState, BattleSceneHandle } from './battle-scene';
import { supportsWebGL } from './webgl';
import { startGame } from './phaser-game';
import styles from './BattleViewport.module.css';

type Status = { kind: 'loading' } | { kind: 'ready' } | { kind: 'unavailable'; message: string };

/** Fixture builds only (NEXT_PUBLIC_FIXTURE_ENABLED): browser tests read the drawn scene. */
export type BattleTestHook = { debug(): BattleDebugState | null; canvases(): number };
declare global {
  interface Window { __cloudiatorBattle?: BattleTestHook }
}

export function BattleViewport({ log, position, reducedMotion, bridge, label }: {
  log: BattleLog;
  /** Replay position in log milliseconds. */
  position: () => number;
  reducedMotion: boolean;
  bridge: SceneBridge;
  /** Accessible description of the fight. */
  label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<BattleSceneHandle | null>(null);
  const positionRef = useRef(position);
  const reduced = useRef(reducedMotion);
  const [status, setStatus] = useState<Status>({ kind: 'loading' });

  useEffect(() => { positionRef.current = position; }, [position]);
  useEffect(() => {
    reduced.current = reducedMotion;
    handle.current?.setReducedMotion(reducedMotion);
  }, [reducedMotion]);

  useEffect(() => {
    let cancelled = false;
    let failed = false;
    let game: ReturnType<typeof startGame> | null = null;
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
      fail('webgl', 'The animated replay needs WebGL, which this browser does not provide. The result and the combat log below still work.');
      return () => { cancelled = true; };
    }
    (async () => {
      const [P, assets, battle] = await Promise.all([import('phaser'), import('./assets'), import('./battle-scene')]);
      if (cancelled || !host.current) return;
      const created = battle.createBattleScene(P, {
        manifest: assets.loadAssetManifest(),
        atlasData: assets.ATLAS_DATA,
        assetBase: '/assets/',
        log,
        position: () => positionRef.current(),
        reducedMotion: reduced.current,
        onReady: () => { if (!cancelled) setStatus({ kind: 'ready' }); },
        onError: (reason, message) => fail(reason, reason === 'assets'
          ? `The replay art could not load (${message}). The result and the combat log below still work.`
          : `The animated replay stopped: ${message}. The result and the combat log below still work.`),
      });
      handle.current = created.handle;
      game = startGame(P, {
        type: P.WEBGL,
        parent: host.current,
        // Integer 3x scaling everywhere: nearest-neighbour textures and whole-pixel positions.
        pixelArt: true,
        backgroundColor: '#1a1423',
        banner: false,
        disableContextMenu: true,
        // The close-up is watched, not played: leave pointer and keyboard input to the page.
        input: { keyboard: false, mouse: false, touch: false, gamepad: false },
        scale: { mode: P.Scale.RESIZE, width: '100%', height: '100%' },
        scene: [created.scene],
      });
      if (process.env.NEXT_PUBLIC_FIXTURE_ENABLED === 'true') {
        window.__cloudiatorBattle = { debug: () => handle.current?.debug() ?? null, canvases: () => document.querySelectorAll('canvas').length };
      }
    })().catch(error => fail('error', error instanceof Error ? error.message : String(error)));
    return () => {
      cancelled = true;
      handle.current?.dispose();
      handle.current = null;
      game?.destroy();
      game = null;
      if (window.__cloudiatorBattle) delete window.__cloudiatorBattle;
    };
  }, [bridge, log]);

  const unavailable = status.kind === 'unavailable';
  return (
    <div className={styles.stage}>
      <div ref={host} className={styles.canvas} role="img" aria-label={unavailable ? 'Animated replay unavailable' : label} />
      <p className={unavailable ? styles.fallback : styles.status} role="status">
        {status.kind === 'loading' ? 'Setting the stage…' : unavailable ? status.message : ''}
      </p>
    </div>
  );
}
