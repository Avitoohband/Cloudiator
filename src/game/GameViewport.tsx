'use client';

// React host for the Phaser camp. Phaser and the asset package load lazily in the browser,
// so the static build never touches WebGL. Unmounting removes the scene's bridge listeners
// synchronously and destroys the game. With a timeline reader, the host also reads the
// timelines of Arena entrants once their bouts are due (src/game/arena-layout.ts), so the
// camp can stage revealed fights, and lists those fights as keyboard buttons. With a tournament
// reader it reads the tournaments of entrants in camp during their slot (src/game/tournament-camp.ts),
// so they wait, fight and spectate by the revealed bracket.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { TournamentView, WorldSnapshot } from '@contracts/reads';
import type { RevealedTimeline } from '@contracts/events';
import type { GameGateway } from '../lib/api/gateway';
import type { Point } from './iso';
import type { ArenaFightSummary, SceneBridge, SceneEventName, SceneEvents } from './bridge';
import type { CampDebugState, CampSceneHandle, PropDebug } from './camp-scene';
import { arenaReadsDue, type ArenaRead } from './arena-layout';
import { tournamentReadsDue, type TournamentRead } from './tournament-camp';
import { createDisplayClock, type DisplayClock } from './display-clock';
import { prefersReducedMotion, supportsWebGL } from './webgl';
import { startGame } from './phaser-game';
import styles from './GameViewport.module.css';

/** How often the host checks for due Arena timeline reads (display ms pass in real time). */
const ARENA_CHECK_MS = 1000;

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
  /** Arena timeline reads so far, and the activities whose timelines the camp holds. */
  arenaReads(): number;
  arenaTimelines(): string[];
  /** Hands Arena timelines straight to the scene, as completed reads would (scene tests without a reader). */
  setArenaTimelines(timelines: Record<string, RevealedTimeline>): void;
  /** Tournament view reads so far, and handing views straight to the scene (scene tests without a reader). */
  tournamentReads(): number;
  setTournaments(views: TournamentView[]): void;
};
declare global {
  interface Window { __cloudiatorCamp?: CampTestHook }
}

export function GameViewport({ world, bridge, focusGladiatorId = null, clock: sharedClock, timelines = null, tournaments = null }: {
  world: WorldSnapshot | null;
  bridge: SceneBridge;
  focusGladiatorId?: string | null;
  /** The page's display clock, shared with its panels; the viewport keeps its own when none is given. */
  clock?: DisplayClock;
  /** Reads Arena entrants' timelines so revealed bouts can be staged; without it the arena only warms up. */
  timelines?: Pick<GameGateway, 'timeline'> | null;
  /** Reads tournament views so camp entrants take their roles; without it they wait in staging. */
  tournaments?: Pick<GameGateway, 'tournament'> | null;
}) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<CampSceneHandle | null>(null);
  const latestWorld = useRef(world);
  const focus = useRef(focusGladiatorId);
  const [ownClock] = useState(() => createDisplayClock());
  const clock = useRef<DisplayClock>(sharedClock ?? ownClock);
  useEffect(() => { clock.current = sharedClock ?? ownClock; }, [ownClock, sharedClock]);
  const arenaTimelines = useRef(new Map<string, RevealedTimeline>());
  const arenaReadCount = useRef(0);
  const tournamentViews = useRef(new Map<string, TournamentView>());
  const tournamentReadCount = useRef(0);
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [following, setFollowing] = useState(false);
  const [fights, setFights] = useState<ArenaFightSummary[]>([]);
  const statusId = useId();

  useEffect(() => { focus.current = focusGladiatorId; }, [focusGladiatorId]);

  useEffect(() => {
    latestWorld.current = world;
    if (!world) return;
    clock.current.sync(world.serverNowMs);
    handle.current?.setWorld(world);
  }, [world]);

  // Arena timelines: read once an entrant's bout is due, retried while it is missing; paused in hidden tabs.
  useEffect(() => {
    if (!timelines) return;
    let alive = true;
    const known = new Map<string, ArenaRead>();
    const inFlight = new Set<string>();
    const check = () => {
      const current = latestWorld.current;
      if (!current || document.visibilityState !== 'visible') return;
      const now = clock.current.now();
      const batch: Promise<unknown>[] = [];
      for (const activityId of arenaReadsDue(current.actors, known, now)) {
        if (inFlight.has(activityId)) continue;
        inFlight.add(activityId);
        known.set(activityId, { readAtMs: now, hasBout: false });
        arenaReadCount.current += 1;
        batch.push(timelines.timeline(activityId).then(timeline => {
          if (!alive) return;
          clock.current.sync(timeline.serverNowMs);
          const at = clock.current.now();
          known.set(activityId, { readAtMs: at, hasBout: timeline.stages.some(s => s.kind === 'bout' && s.revealedAtMs <= at) });
          arenaTimelines.current.set(activityId, timeline);
        }, () => {}).finally(() => inFlight.delete(activityId)));
      }
      // Reads due together land together, so bouts revealed at the same minute are scheduled as one wave.
      if (batch.length) void Promise.all(batch).then(() => { if (alive) handle.current?.setTimelines(new Map(arenaTimelines.current)); });
    };
    check();
    const timer = window.setInterval(check, ARENA_CHECK_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, [timelines]);

  // Tournament views: read once an entrant is in camp during its slot, again after each reveal mark, and every 30 s
  // while a read failed or a due round is unpublished; paused in hidden tabs.
  useEffect(() => {
    if (!tournaments) return;
    let alive = true;
    const known = new Map<string, TournamentRead>();
    const inFlight = new Set<string>();
    const check = () => {
      const current = latestWorld.current;
      if (!current || document.visibilityState !== 'visible') return;
      const now = clock.current.now();
      for (const id of tournamentReadsDue(current.actors, known, now)) {
        if (inFlight.has(id)) continue;
        inFlight.add(id);
        known.set(id, { readAtMs: now, view: known.get(id)?.view ?? null });
        tournamentReadCount.current += 1;
        tournaments.tournament(id).then(view => {
          if (!alive) return;
          known.set(id, { readAtMs: clock.current.now(), view });
          tournamentViews.current.set(id, view);
          handle.current?.setTournaments(new Map(tournamentViews.current));
        }, () => {}).finally(() => inFlight.delete(id));
      }
    };
    check();
    const timer = window.setInterval(check, ARENA_CHECK_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, [tournaments]);

  useEffect(() => bridge.on('arena-fights', ({ fights: next }) => setFights(next)), [bridge]);

  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return;
    const onChange = () => handle.current?.setReducedMotion(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => bridge.on('follow-character', ({ gladiatorId }) => setFollowing(!!gladiatorId && gladiatorId === focus.current)), [bridge]);
  // Find and Follow only make sense while the owner is drawn in camp (not away, not before the scene is ready).
  const [inCamp, setInCamp] = useState<readonly string[]>([]);
  useEffect(() => bridge.on('roster', roster => setInCamp(roster.inCamp)), [bridge]);
  const ownerInCamp = !!focusGladiatorId && inCamp.includes(focusGladiatorId);

  useEffect(() => {
    let cancelled = false;
    let failed = false;
    let game: ReturnType<typeof startGame> | null = null;
    const fail = (reason: 'webgl' | 'assets' | 'error', message: string) => {
      if (cancelled || failed) return;
      failed = true;
      setStatus({ kind: 'unavailable', message });
      handle.current?.dispose();
      game?.destroy();
      game = null;
      // Deferred so panels that subscribe in their own effects (which run after ours) still hear it.
      setTimeout(() => { if (!cancelled) bridge.emit('scene-unavailable', { reason, message }); }, 0);
    };
    if (!supportsWebGL()) {
      fail('webgl', 'The animated camp needs WebGL, which this browser does not provide. Management panels still work.');
      return () => { cancelled = true; };
    }
    if (latestWorld.current) clock.current.sync(latestWorld.current.serverNowMs);
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
        now: () => clock.current.now(),
        onReady: () => { if (!cancelled) setStatus({ kind: 'ready' }); },
        onError: (reason, message) => fail(reason, reason === 'assets' ? `The camp art could not load (${message}). Management panels still work.` : `The camp view stopped: ${message}`),
      });
      handle.current = created.handle;
      created.handle.setTimelines(new Map(arenaTimelines.current));
      created.handle.setTournaments(new Map(tournamentViews.current));
      game = startGame(P, {
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
          freezeClock: ms => clock.current.freeze(ms),
          arenaReads: () => arenaReadCount.current,
          arenaTimelines: () => [...arenaTimelines.current.keys()],
          setArenaTimelines: next => {
            for (const [id, timeline] of Object.entries(next)) arenaTimelines.current.set(id, timeline);
            handle.current?.setTimelines(new Map(arenaTimelines.current));
          },
          tournamentReads: () => tournamentReadCount.current,
          setTournaments: views => {
            for (const view of views) tournamentViews.current.set(view.id, view);
            handle.current?.setTournaments(new Map(tournamentViews.current));
          },
        };
      }
    })().catch(error => fail('error', error instanceof Error ? error.message : String(error)));
    return () => {
      cancelled = true;
      handle.current?.dispose();
      handle.current = null;
      game?.destroy();
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
              <button type="button" disabled={!ownerInCamp} onClick={() => bridge.emit('find-character', { gladiatorId: focusGladiatorId })} aria-label="Find my gladiator">Find</button>
              <button
                type="button"
                disabled={!ownerInCamp}
                aria-pressed={following && ownerInCamp}
                onClick={() => bridge.emit('follow-character', { gladiatorId: following ? null : focusGladiatorId })}
                aria-label="Follow my gladiator"
              >Follow</button>
            </>
          )}
        </div>
      )}
      {!unavailable && fights.length > 0 && (
        <div className={styles.fights} role="group" aria-label="Arena bouts in the rings">
          {fights.map(f => (
            <button
              key={f.battleId}
              type="button"
              onClick={() => {
                const [entrant] = f.sides;
                if (entrant.gladiatorId) bridge.emit('find-character', { gladiatorId: entrant.gladiatorId });
                bridge.emit('open-arena', { activityId: entrant.activityId, gladiatorId: entrant.gladiatorId });
              }}
            >{f.sides[0].name} vs {f.sides[1].name}{f.sides[1].npc ? ' (NPC)' : ''}</button>
          ))}
        </div>
      )}
      <p id={statusId} className={unavailable ? styles.fallback : styles.status} role="status">
        {status.kind === 'loading' ? 'Opening the camp…' : unavailable ? status.message : ''}
      </p>
    </div>
  );
}
