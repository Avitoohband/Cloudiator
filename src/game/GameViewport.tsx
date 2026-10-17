'use client';

// React host for the Phaser camp. Phaser and the asset package load lazily in the browser,
// so the static build never touches WebGL. Unmounting removes the scene's bridge listeners
// synchronously and destroys the game. With a timeline reader, the host also reads the
// timelines of Arena entrants once their bouts are due (src/game/arena-layout.ts), so the
// camp can stage revealed fights, forgets those of activities no longer in the world, and
// lists the ring fights as keyboard buttons below the camp view (with `chrome: 'none'` the page shell lists them, from the
// bridge's `arena-fights` event, and holds the camera buttons). With a tournament reader it
// reads the tournaments of entrants in camp during their slot (src/game/tournament-camp.ts),
// so they wait, fight and spectate by the revealed bracket, and forgets a tournament once its
// entrants have left the camp. Tournament views carry no battle logs: the scene stages a revealed
// bout from its fight summary, and the host loads its log, through the reader's log cache that the
// Tournaments panel shares, only while its ring window is current or about to start.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { TournamentView, WorldSnapshot } from '@contracts/reads';
import type { BattleLog, RevealedTimeline } from '@contracts/events';
import type { GameGateway } from '../lib/api/gateway';
import type { Point } from './iso';
import type { ArenaFightSummary, SceneBridge, SceneEventName, SceneEvents } from './bridge';
import type { CampDebugState, CampSceneHandle, PropDebug } from './camp-scene';
import { arenaFightButton, arenaReadsDue, type ArenaRead } from './arena-layout';
import { TOURNAMENT_LOG_WINDOW_MS, campTournamentIds, recordTournamentRead, tournamentLogsDue, tournamentReadsDue, type TournamentRead } from './tournament-camp';
import { TOURNAMENT_RETRY_MS, withTournamentLogs } from './tournament-stage';
import { createDisplayClock, type DisplayClock } from './display-clock';
import { prefersReducedMotion, supportsWebGL } from './webgl';
import { startGame } from './phaser-game';
import styles from './GameViewport.module.css';

/** How often the host checks for due Arena timeline reads (display ms pass in real time). */
const ARENA_CHECK_MS = 1000;
/** At most this many tournament battle logs load at once (each ring asks for at most its current and next bout). */
const LOG_LOADS = 6;

/** Keeps every battle log a view already carries (a scene test's view, an older reader) so it is never asked for. */
function keepLogs(view: TournamentView, logs: Map<string, BattleLog>) {
  for (const bout of view.bouts) if (bout.revealedResult?.battleLog && !logs.has(bout.id)) logs.set(bout.id, bout.revealedResult.battleLog);
}
/** The views with their loaded logs merged in, as the scene stages them. */
function withLogs(views: ReadonlyMap<string, TournamentView>, logs: ReadonlyMap<string, BattleLog>): Map<string, TournamentView> {
  return new Map([...views].map(([id, view]) => [id, withTournamentLogs(view, logs)]));
}

type Status = { kind: 'loading' } | { kind: 'ready' } | { kind: 'unavailable'; message: string };

/** Drops what is kept for activities no longer in the world; true when something was dropped. */
function forgetLeft<V>(kept: Map<string, V>, world: WorldSnapshot | null): boolean {
  if (!world) return false;
  const live = new Set(world.actors.map(a => a.activityId));
  let dropped = false;
  for (const id of [...kept.keys()]) if (!live.has(id)) { kept.delete(id); dropped = true; }
  return dropped;
}
/**
 * Drops the tournament views, and the logs of their bouts, of tournaments with no entrant left in the world (Task 20
 * review minor 4); true when something was dropped. Logs stay in the reader's cache, so nothing is read twice.
 */
function forgetLeftTournaments(views: Map<string, TournamentView>, logs: Map<string, BattleLog>, world: WorldSnapshot | null): boolean {
  if (!world) return false;
  const live = campTournamentIds(world.actors);
  let dropped = false;
  for (const [id, view] of [...views]) {
    if (live.has(id)) continue;
    views.delete(id);
    for (const bout of view.bouts) logs.delete(bout.id);
    dropped = true;
  }
  return dropped;
}

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
  /** The tournaments whose views the camp keeps. */
  tournamentViews(): string[];
  /** Tournament battle logs asked for on demand so far, and the bouts whose logs the camp holds. */
  tournamentLogReads(): number;
  tournamentLogs(): string[];
};
declare global {
  interface Window { __cloudiatorCamp?: CampTestHook }
}

export function GameViewport({ world, bridge, focusGladiatorId = null, clock: sharedClock, timelines = null, tournaments = null, onStatus, chrome = 'framed' }: {
  world: WorldSnapshot | null;
  bridge: SceneBridge;
  focusGladiatorId?: string | null;
  /**
   * The page's display clock, shared with its panels and synced by its owner (the game state's sync controller), so the
   * viewport never syncs it from the world. Without one the viewport keeps its own, synced from each world's server time.
   */
  clock?: DisplayClock;
  /** Reads Arena entrants' timelines so revealed bouts can be staged; without it the arena only warms up. */
  timelines?: Pick<GameGateway, 'timeline'> | null;
  /**
   * Reads tournament views so camp entrants take their roles, and the logs of the bouts it stages; without it they wait
   * in staging (and without `tournamentLog` a revealed bout's pair stands in its ring unless its view carries the log).
   */
  tournaments?: (Pick<GameGateway, 'tournament'> & Partial<Pick<GameGateway, 'tournamentLog'>>) | null;
  /** Hears the scene's availability: loading, ready, or unavailable (no WebGL, art that failed to load, a stopped scene). */
  onStatus?(status: 'loading' | 'ready' | 'unavailable'): void;
  /**
   * `framed` (the default): a bordered view with its camera buttons and the ring-fight buttons below it. `none`: the view
   * fills its parent with neither, for a page shell that offers them itself (zoom on its menu rail, Find and Follow in
   * its Gladiators menu, the fights in its Arena menu).
   */
  chrome?: 'framed' | 'none';
}) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<CampSceneHandle | null>(null);
  const latestWorld = useRef(world);
  const focus = useRef(focusGladiatorId);
  const [ownClock] = useState(() => createDisplayClock());
  const clock = useRef<DisplayClock>(sharedClock ?? ownClock);
  /** Whether the viewport syncs the clock from world snapshots: only its own clock. */
  const syncsClock = useRef(!sharedClock);
  useEffect(() => { clock.current = sharedClock ?? ownClock; syncsClock.current = !sharedClock; }, [ownClock, sharedClock]);
  const arenaTimelines = useRef(new Map<string, RevealedTimeline>());
  const arenaReadCount = useRef(0);
  const tournamentViews = useRef(new Map<string, TournamentView>());
  const tournamentReadCount = useRef(0);
  /** Battle logs of staged tournament bouts of the kept views (the reader's cache holds them for the session). */
  const tournamentLogs = useRef(new Map<string, BattleLog>());
  const tournamentLogReadCount = useRef(0);
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [following, setFollowing] = useState(false);
  const [fights, setFights] = useState<ArenaFightSummary[]>([]);
  const statusId = useId();

  useEffect(() => { focus.current = focusGladiatorId; }, [focusGladiatorId]);
  const statusListener = useRef(onStatus);
  useEffect(() => { statusListener.current = onStatus; }, [onStatus]);
  useEffect(() => { statusListener.current?.(status.kind); }, [status.kind]);

  useEffect(() => {
    latestWorld.current = world;
    if (!world) return;
    if (syncsClock.current) clock.current.sync(world.serverNowMs);
    handle.current?.setWorld(world);
    if (forgetLeft(arenaTimelines.current, world)) handle.current?.setTimelines(new Map(arenaTimelines.current));
    if (forgetLeftTournaments(tournamentViews.current, tournamentLogs.current, world)) handle.current?.setTournaments(withLogs(tournamentViews.current, tournamentLogs.current));
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
      forgetLeft(known, current);
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
      if (batch.length) void Promise.all(batch).then(() => {
        if (!alive) return;
        forgetLeft(arenaTimelines.current, latestWorld.current);
        handle.current?.setTimelines(new Map(arenaTimelines.current));
      });
    };
    check();
    const timer = window.setInterval(check, ARENA_CHECK_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, [timelines]);

  // Tournament views: read once an entrant is in camp during its slot, again after each reveal mark, every 30 s while
  // a read failed, and while a due round is unpublished after 30 s, 60 s, 120 s, 240 s and then every 5 minutes (back to
  // 30 s once it is not processing); paused in hidden tabs, with one re-read of a processing tournament on coming back.
  // A tournament whose entrants have all left the camp is forgotten. The views carry no battle logs: a bout's log loads
  // only while its ring window is current or starts within TOURNAMENT_LOG_WINDOW_MS (the scene's ring schedule), at most
  // LOG_LOADS at a time, through the reader's session cache that the Tournaments panel shares, so a viewer who joins
  // late asks only for what the rings show now and next (Task 19 live-camp gate).
  useEffect(() => {
    if (!tournaments) return;
    let alive = true;
    const known = new Map<string, TournamentRead>();
    const inFlight = new Set<string>();
    const logsInFlight = new Set<string>();
    /** Display time of each bout's last failed log load: asked again only after the retry interval. */
    const logFailedAt = new Map<string, number>();
    const publish = () => handle.current?.setTournaments(withLogs(tournamentViews.current, tournamentLogs.current));
    /** Whether a tournament still has an entrant in the world, so a read or log that lands late is kept. */
    const inCamp = (id: string) => campTournamentIds(latestWorld.current?.actors ?? []).has(id);
    const check = (focused = false) => {
      const current = latestWorld.current;
      if (!current || document.visibilityState !== 'visible') return;
      const now = clock.current.now();
      const live = campTournamentIds(current.actors);
      for (const id of [...known.keys()]) if (!live.has(id)) known.delete(id);
      for (const id of tournamentReadsDue(current.actors, known, now, { focused })) {
        if (inFlight.has(id)) continue;
        inFlight.add(id);
        const previous = known.get(id);
        known.set(id, { ...previous, view: previous?.view ?? null, readAtMs: now });
        tournamentReadCount.current += 1;
        tournaments.tournament(id).then(view => {
          if (!alive || !inCamp(id)) return;
          known.set(id, recordTournamentRead(previous, view, clock.current.now()));
          keepLogs(view, tournamentLogs.current);
          tournamentViews.current.set(id, view);
          publish();
        }, () => { if (alive && inCamp(id)) known.set(id, recordTournamentRead(previous, null, clock.current.now())); }).finally(() => inFlight.delete(id));
      }
      const loadLog = tournaments.tournamentLog;
      const rings = handle.current?.ringSchedule();
      if (!loadLog || !rings) return;
      const due = [...withLogs(tournamentViews.current, tournamentLogs.current).values()]
        .flatMap(view => tournamentLogsDue(view, now, TOURNAMENT_LOG_WINDOW_MS, rings))
        .sort((p, q) => rings.get(p)!.enterAtMs - rings.get(q)!.enterAtMs);
      for (const boutId of due) {
        if (logsInFlight.size >= LOG_LOADS) break;
        if (logsInFlight.has(boutId) || tournamentLogs.current.has(boutId) || now - (logFailedAt.get(boutId) ?? -Infinity) < TOURNAMENT_RETRY_MS) continue;
        logsInFlight.add(boutId);
        tournamentLogReadCount.current += 1;
        loadLog(boutId).then(log => {
          logFailedAt.delete(boutId);
          // A log of a tournament the camp has forgotten meanwhile is not kept (the reader's cache still holds it).
          if (!alive || ![...tournamentViews.current.values()].some(view => view.bouts.some(bout => bout.id === boutId))) return;
          tournamentLogs.current.set(boutId, log);
          publish();
        }, () => { logFailedAt.set(boutId, clock.current.now()); }).finally(() => logsInFlight.delete(boutId));
      }
    };
    check();
    const timer = window.setInterval(() => check(), ARENA_CHECK_MS);
    const onFocus = () => { if (document.visibilityState === 'visible') check(true); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      alive = false; window.clearInterval(timer);
      window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus);
    };
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
    if (latestWorld.current && syncsClock.current) clock.current.sync(latestWorld.current.serverNowMs);
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
      created.handle.setTournaments(withLogs(tournamentViews.current, tournamentLogs.current));
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
          setWorld: next => {
            latestWorld.current = next;
            handle.current?.setWorld(next);
            if (forgetLeft(arenaTimelines.current, next)) handle.current?.setTimelines(new Map(arenaTimelines.current));
            if (forgetLeftTournaments(tournamentViews.current, tournamentLogs.current, next)) handle.current?.setTournaments(withLogs(tournamentViews.current, tournamentLogs.current));
          },
          freezeClock: ms => clock.current.freeze(ms),
          arenaReads: () => arenaReadCount.current,
          arenaTimelines: () => [...arenaTimelines.current.keys()],
          setArenaTimelines: next => {
            for (const [id, timeline] of Object.entries(next)) arenaTimelines.current.set(id, timeline);
            forgetLeft(arenaTimelines.current, latestWorld.current);
            handle.current?.setTimelines(new Map(arenaTimelines.current));
          },
          tournamentReads: () => tournamentReadCount.current,
          setTournaments: views => {
            for (const view of views) { keepLogs(view, tournamentLogs.current); tournamentViews.current.set(view.id, view); }
            handle.current?.setTournaments(withLogs(tournamentViews.current, tournamentLogs.current));
          },
          tournamentViews: () => [...tournamentViews.current.keys()],
          tournamentLogReads: () => tournamentLogReadCount.current,
          tournamentLogs: () => [...tournamentLogs.current.keys()],
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
  const framed = chrome === 'framed';
  return (
    <div className={framed ? styles.frame : styles.fill}>
      <div className={framed ? styles.viewport : styles.fillViewport}>
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
        {framed && !unavailable && (
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
        <p id={statusId} className={unavailable ? styles.fallback : styles.status} role="status" data-camp-fallback={unavailable ? '' : undefined}>
          {status.kind === 'loading' ? 'Opening the camp…' : unavailable ? status.message : ''}
        </p>
      </div>
      {/* Keyboard and touch equivalents of clicking a fighting pair, below the view so they never cover it. */}
      {framed && !unavailable && fights.length > 0 && (
        <div className={styles.fights} role="group" aria-label="Arena bouts in the rings">
          {fights.map(f => {
            const { label, entrant } = arenaFightButton(f);
            return (
              <button
                key={f.battleId}
                type="button"
                onClick={() => {
                  if (entrant.gladiatorId) bridge.emit('find-character', { gladiatorId: entrant.gladiatorId });
                  bridge.emit('open-arena', { activityId: entrant.activityId, gladiatorId: entrant.gladiatorId });
                }}
              >{label}</button>
            );
          })}
        </div>
      )}
    </div>
  );
}
