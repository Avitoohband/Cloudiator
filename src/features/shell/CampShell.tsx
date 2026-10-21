'use client';

// The game screen (spec "Full-screen camp"): the camp fills the window, and everything else floats on it. A hidden rail
// on the left edge opens one menu at a time, beside it (a bottom sheet on touch); the corner chip sits top right. The
// shell owns the shared game state (`useGameState`), the scene bridge and the menus' contents, which are the existing
// panels, re-housed. Keyboard: the first Tab reaches the skip link and the next one the rail's first icon, which reveals
// the rail (Task 23.5: the shell no longer takes the first Tab); Escape closes the open menu and returns the focus to its
// icon. Menus render outside the camp view's element, so its keys never see their typing. The focus is never left on
// <body>: a control that leaves the page gives it to the nearest panel or control (`useFocusRescue`, Task 23.5).
//
// Task 13.6, visitors and joining: anyone watches the camp and its public menus; the chip starts Google sign-in. Signed in
// without a gladiator, the "Create your gladiator" dialog opens over the running camp (`useJoining`). When the viewer
// stops being a player (sign-out, expiry, another account), a private menu that is open closes. A cancelled or failed
// sign-in comes back as `?signin=cancelled|failed` (plan Decision 6): the shell shows a short message and removes it.
//
// Task 13.7: clicks on gladiators and merchants in the camp (`useCampClicks`) open profile cards and the shops; the
// Gladiators list and the standings open the same cards. Escape closes the card first when it has the focus or no menu
// is open. Results lists the recent results.
//
// Task 13.8: replays and expeditions open as full-screen scenes over the running camp (`SceneOverlay`), each a history
// entry on the camp's route (`?view=…`, plan Decision 4, `useSceneHistory`). The bridge carries them: `view-replay` and
// `view-expedition` open one (the Arena card's Watch replay, the Gladiators list's away rows), `return-camp` closes it
// (the scene's "Back to camp"); Results opens each result by its kind. The camp pauses beneath a scene, which covers it
// (Task 23.4, C8), and goes on from the shared clock's time when the scene closes.
//
// Task 18.3: the 💰 Marketplace reads the public offers for anyone; only a player gets the command gateway to trade.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Phase } from '@contracts/commands';
import type { PublicActivitySummary } from '@contracts/events';
import type { OwnerState } from '@contracts/reads';
import { createLiveGateway, type GameGateway } from '../../lib/api/gateway';
import { useGameState } from '../character/useGameState';
import { CharacterPanel } from '../character/CharacterPanel';
import { ownRestingText } from '../character/activity-status';
import { CreateCharacter } from '../character/CreateCharacter';
import { RosterPanel, type Roster } from '../character/RosterPanel';
import { ProfileLayer } from '../character/ProfileCard';
import { SchedulePanel } from '../schedule/SchedulePanel';
import { useMinuteNow } from '../schedule/use-minute-now';
import { InventoryPanel } from '../inventory/InventoryPanel';
import { MarketPanel } from '../market/MarketPanel';
import { ArenaMenu } from '../arena/ArenaMenu';
import type { ArenaSample } from '../arena/ArenaPanel';
import { TournamentPanel, type TournamentSample } from '../tournaments/TournamentPanel';
import { ResultsPanel } from '../results/ResultsPanel';
import { GameViewport } from '../../game/GameViewport';
import type { DisplayClock } from '../../game/display-clock';
import { createSceneBridge, type ArenaFightSummary } from '../../game/bridge';
import { isClick } from '../../game/camera';
import { CornerChip } from './CornerChip';
import { MenuRail } from './MenuRail';
import { MenuSurface } from './MenuSurface';
import { PerfOverlay, perfPhaseOf } from './PerfOverlay';
import { menusFor, type MenuId } from './menus';
import { railReducer, type RailEvent, type RailState } from './rail-reveal';
import { SceneOverlay } from './SceneOverlay';
import { sceneForResult, type SceneAddress, type SceneView } from './scene-url';
import { useCampClicks } from './useCampClicks';
import { useFocusRescue } from './useFocusRescue';
import { useJoining } from './useJoining';
import { useSceneHistory } from './useSceneHistory';
import styles from './shell.module.css';

/** How a Google sign-in that did not complete came back (`AuthCallback`, plan Decision 6). */
export type SignInResult = 'cancelled' | 'failed';
const SIGN_IN_MESSAGES: Record<SignInResult, string> = {
  cancelled: 'Google sign-in was canceled. You can keep watching the camp.',
  failed: 'Google sign-in could not be completed. Please try again.',
};

type Sample = { activityId: string; label: string };
type Samples = { replays: readonly Sample[]; expeditions: readonly Sample[]; arena: readonly ArenaSample[]; tournaments: readonly TournamentSample[] };
const NO_SAMPLES: Samples = { replays: [], expeditions: [], arena: [], tournaments: [] };

/**
 * Whether an element is rendered and not hidden (the touch row of icons hides while a sheet is open).
 * `checkVisibility` arrived in Safari 17.4, below the project's Safari 16.4 floor, so it is feature-detected.
 */
const shown = (element: HTMLElement | null): element is HTMLElement => !!element && (typeof element.checkVisibility === 'function'
  ? element.checkVisibility({ visibilityProperty: true })
  : element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');

/** Whether a modal dialog is open (`:modal`, Safari 15.6+, within the project's Safari 16.4 floor). */
const modalOpen = () => document.querySelector('dialog:modal') !== null;
/** Gives the keyboard back to the camp view (the menus hand the view to the camp). */
const focusCamp = () => document.querySelector<HTMLElement>('[data-camp-view] [role="application"]')?.focus({ preventScroll: true });
/**
 * Where the focus goes when the creation dialog that opened on its own is dismissed: the chip's "Create your gladiator",
 * which offers it again, else the camp view (Task 23.5 fix round 1: never <body>, the first screen of a new account).
 */
const focusOffer = () => {
  const offer = document.querySelector<HTMLElement>('[data-create-offer]');
  if (shown(offer)) offer.focus({ preventScroll: true });
  else focusCamp();
};

/** The fixture preview's schedule: the sample plan, read-only. */
function SchedulePreview({ owner }: { owner: OwnerState | null }) {
  return <>
    <div className="section-title"><div><p className="eyebrow">PLAN THE NEXT CHAPTER</p><h2>Repeating schedule</h2></div><span className="tag">{owner ? 'Sample plan' : 'Awaiting character'}</span></div>
    <p className="muted">A morning of practice. An afternoon of adventure. An evening to recover.</p>
    <div className="schedule-grid">{(['morning', 'afternoon', 'evening'] as Phase[]).map((phase, index) => {
      const choice = owner?.schedule[phase];
      const title = choice ? choice.kind === 'expedition' ? 'Expedition' : choice.kind : 'Awaiting character';
      return <article className={`schedule-slot slot-${index}`} key={phase}><span className="eyebrow">{phase}</span><h3>{title}</h3>
        <p>{choice?.kind === 'expedition' ? 'Woodland Path' : choice?.kind === 'training' ? 'Practice yard' : choice?.kind === 'rest' ? 'Recover stamina' : 'Create your gladiator to begin'}</p>
        <span className="slot-duration">80-minute slot</span></article>;
    })}</div>
    <p className="panel-notice">This preview cannot save schedule changes.</p>
  </>;
}

/**
 * A fixture sample as a link to its scene over the camp (spec "Scenes", Task 13.8 fix round 1): a plain click opens the
 * scene in place; a modified click (a new tab or window) follows the link, which opens the same scene over a new camp.
 */
function SampleLink({ view, label, onOpen }: { view: SceneView; label: string; onOpen(view: SceneView): void }) {
  const href = `?mode=fixture&view=${view.kind}&activity=${encodeURIComponent(view.activityId)}`;
  return <a href={href} onClick={event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onOpen(view);
  }}>{label}</a>;
}

/** Results: the recent results, and in fixture mode the sample replays and expeditions below them, opened as scenes. */
function ResultsMenu({ fixture, samples, previewFailed, reads, viewerId, clock, onWatch, onOpen }: {
  fixture: boolean; samples: Samples; previewFailed: boolean; reads: GameGateway | null; viewerId: string | null; clock: DisplayClock;
  onWatch(activityId: string, kind: PublicActivitySummary['resolvedKind']): void;
  onOpen(view: SceneView): void;
}) {
  return <>
    {reads ? <ResultsPanel reads={reads} viewerId={viewerId} clock={clock} onWatch={onWatch} />
      : <p role="status">{previewFailed ? 'The fixture preview could not be loaded.' : 'Loading local preview…'}</p>}
    {fixture && samples.replays.length > 0 && <nav className="sample-replays" aria-label="Sample replays">
      <p className="eyebrow">SAMPLE REPLAYS</p>
      <ul>{samples.replays.map(r => <li key={r.activityId}><SampleLink view={{ kind: 'replay', activityId: r.activityId }} label={r.label} onOpen={onOpen} /></li>)}</ul>
    </nav>}
    {fixture && samples.expeditions.length > 0 && <nav className="sample-replays" aria-label="Sample expeditions">
      <p className="eyebrow">SAMPLE EXPEDITIONS</p>
      <ul>{samples.expeditions.map(e => <li key={e.activityId}><SampleLink view={{ kind: 'expedition', activityId: e.activityId }} label={e.label} onOpen={onOpen} /></li>)}</ul>
    </nav>}
  </>;
}

export function CampShell({ fixture, previewAs, previewResting = false, fixtureRefused = false, signInResult = null, scene = null, perf = false }: {
  fixture: boolean;
  previewAs?: 'visitor' | 'player';
  /** `?as=resting` (fixture mode only): the player's gladiator rests at home (Task 23.9). */
  previewResting?: boolean;
  /** `?mode=fixture` was asked for in a build without the preview: say so over the live camp. */
  fixtureRefused?: boolean;
  /** `?signin=`: a Google sign-in that was cancelled or failed has returned to the camp. */
  signInResult?: SignInResult | null;
  /** `?view=replay|expedition&activity=…`: the scene over the camp (plan Decision 4). */
  scene?: SceneAddress | null;
  /** `?perf=1`: the opt-in frame-rate overlay (plan Decision 2, Task 23.4); never shown without it. */
  perf?: boolean;
}) {
  const [bridge] = useState(createSceneBridge);
  const [gateway] = useState(createLiveGateway);
  const [previewError, setPreviewError] = useState(false);
  const [samples, setSamples] = useState<Samples>(NO_SAMPLES);
  const [fixtureReads, setFixtureReads] = useState<GameGateway | null>(null);

  useEffect(() => {
    let active = true;
    // The inlined build flag (as the replay and expedition pages guard it) lets a production export drop the fixture
    // gateway's chunk and its sample data; the prop alone would keep it (final review Minor 4).
    if (process.env.NEXT_PUBLIC_FIXTURE_ENABLED === 'true' && fixture) {
      import('../../lib/api/fixture-gateway')
        .then(({ createFixtureGateway, FIXTURE_REPLAYS, FIXTURE_EXPEDITIONS, FIXTURE_ARENA, FIXTURE_TOURNAMENTS }) => {
          if (!active) return;
          setSamples({ replays: FIXTURE_REPLAYS, expeditions: FIXTURE_EXPEDITIONS, arena: FIXTURE_ARENA, tournaments: FIXTURE_TOURNAMENTS });
          setFixtureReads(createFixtureGateway({ resting: previewResting }));
        })
        .catch(() => { if (active) setPreviewError(true); });
    }
    return () => { active = false; };
  }, [fixture, previewResting]);

  const reads = fixture ? fixtureReads : gateway;
  // One sync controller, display clock and owner state for the camp and every menu (the fixture gateway once loaded).
  const game = useGameState(reads, { fixture, previewAs });
  const { owner, world, clock, viewer } = game;
  // The display time the owner's resting line shows its return against (Task 23.10): it follows the shared clock by the minute.
  const nowMs = useMinuteNow(clock);
  const menus = menusFor(viewer);

  const [rail, setRail] = useState<RailState>({ revealed: false, open: null });
  const send = useCallback((event: RailEvent) => setRail(state => railReducer(state, event)), []);
  // A menu the viewer no longer has (a player's menu after the session ends) is not shown, and is closed, so the rail
  // can slide away again (13.5 review).
  const open = rail.open !== null && menus.some(m => m.id === rail.open) ? rail.open : null;
  const openRef = useRef(open);
  useEffect(() => { openRef.current = open; });
  const lost = rail.open !== null && open === null;
  useEffect(() => { if (lost) send('escape'); }, [lost, send]);
  const show = useCallback((id: MenuId) => { if (openRef.current !== id) send({ toggle: id }); }, [send]);

  const account = game.session.userId;
  const joining = useJoining({ viewer, account, ownerCreated: game.ownerCreated, show });

  // A sign-in that did not complete: keep its message, and take the parameter out of the address.
  const [signInNotice, setSignInNotice] = useState<SignInResult | null>(signInResult);
  useEffect(() => {
    if (!signInResult) return;
    setSignInNotice(signInResult);
    const url = new URL(window.location.href);
    url.searchParams.delete('signin');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }, [signInResult]);

  // Close a menu and give the focus back to its icon (the ☰ button when the touch row is hidden).
  const [focusBack, setFocusBack] = useState<MenuId | null>(null);
  const close = useCallback((id: MenuId) => { send('escape'); setFocusBack(id); }, [send]);
  useEffect(() => {
    if (focusBack === null || rail.open !== null) return;
    const icon = document.querySelector<HTMLElement>(`[data-menu-icon="${focusBack}"]`);
    const target = shown(icon) ? icon : document.querySelector<HTMLElement>('[data-menu-burger]');
    target?.focus({ preventScroll: true });
    setFocusBack(null);
  }, [focusBack, rail.open]);

  // Find and Follow hand the view back to the camp: the menu closes and the camp view takes the keyboard.
  const handBack = useCallback(() => {
    send('camp-click');
    focusCamp();
  }, [send]);

  const { card, cardRef, openRow, closeCard, shop } = useCampClicks({ bridge, open, viewer, world, show, focusCamp });

  // The scene's public facts the menus show, kept while they are closed.
  const [fights, setFights] = useState<readonly ArenaFightSummary[]>([]);
  const [roster, setRoster] = useState<Roster | null>(null);
  const [following, setFollowing] = useState<string | null>(null);
  useEffect(() => bridge.on('arena-fights', ({ fights: next }) => setFights(next)), [bridge]);
  useEffect(() => bridge.on('roster', next => setRoster(next)), [bridge]);
  useEffect(() => bridge.on('follow-character', ({ gladiatorId }) => setFollowing(gladiatorId)), [bridge]);
  // A click on an Arena entrant (or a ring-fight button) opens its card in the Arena menu.
  useEffect(() => bridge.on('open-arena', () => setRail(state => (state.open === 'arena' ? state : railReducer(state, { toggle: 'arena' })))), [bridge]);

  // Escape closes the profile card when it has the focus or no menu is open, and otherwise the open menu (a native dialog
  // inside a panel, such as a discard confirmation, handles its own). It stands down while a modal dialog is open (the
  // creation dialog, a discard confirmation): the page behind it is inert, and the dialog owns Escape (13.6 review I1).
  // Tab is the browser's: the first one reaches the skip link (Task 23.5, C19), and focusing a rail icon reveals the rail.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (modalOpen()) return;
      if (event.key === 'Escape') {
        const current = openRef.current;
        if (event.defaultPrevented || (event.target instanceof Element && event.target.closest('dialog'))) return;
        if (cardRef.current && (!current || (event.target instanceof Element && event.target.closest('[data-profile-card]')))) {
          event.preventDefault();
          closeCard(true);
          return;
        }
        if (!current) return;
        event.preventDefault();
        close(current);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close, closeCard]);

  const shellRef = useRef<HTMLDivElement>(null);
  useFocusRescue(shellRef, focusCamp);

  // Scenes over the camp: a history entry each; the bridge opens and closes them.
  const { open: openScene, close: closeScene } = useSceneHistory();
  useEffect(() => bridge.on('view-replay', ({ activityId, stageId }) => openScene(stageId ? { kind: 'replay', activityId, stageId } : { kind: 'replay', activityId })),
    [bridge, openScene]);
  useEffect(() => bridge.on('view-expedition', ({ activityId }) => openScene({ kind: 'expedition', activityId })), [bridge, openScene]);
  useEffect(() => bridge.on('return-camp', () => closeScene()), [bridge, closeScene]);
  // A scene takes the screen: the profile card closes (the menus stay, to come back to).
  const sceneKey = scene ? `${scene.kind}|${scene.activityId}` : null;
  useEffect(() => { if (sceneKey) closeCard(false); }, [sceneKey, closeCard]);
  // Results open each kept result by its kind: an expedition its expedition, a bout its replay (13.7 review).
  const watchResult = useCallback((activityId: string, kind: PublicActivitySummary['resolvedKind']) => {
    const view = sceneForResult(activityId, kind);
    if (view) openScene(view);
  }, [openScene]);

  const press = useRef<{ x: number; y: number } | null>(null);
  const sceneUnavailable = game.sceneStatus === 'unavailable';
  // `?perf=1` measures per phase: a new one when the camp gets ready and at each scene open or close (Task 24.1b).
  const perfPhase = perfPhaseOf(game.sceneStatus, scene);
  const ownerId = owner?.gladiatorId ?? null;
  // The owner's own words while its gladiator rests at home (Task 23.9 fix round 1): when it is back on its schedule once
  // that is known (a short time, Task 23.10), else only that it rests. Its own Gladiators row and profile card say this, never the public sentence.
  const ownPlace = owner && (owner.restingUntilSlot !== null || game.ownResting) ? ownRestingText(owner.restingUntilSlot, nowMs) : null;
  const content = (id: MenuId) => {
    switch (id) {
      case 'gladiator': return <CharacterPanel viewer={viewer} session={game.session} owner={owner} ownerError={game.ownerError} slotIndex={game.slotIndex}
        clock={clock} gateway={gateway} fixture={fixture} previewAs={previewAs} previewFailed={previewError} refreshOwner={game.refreshOwner}
        onCreate={joining.offer} resting={game.ownResting} />;
      case 'schedule': return owner && !fixture ? <SchedulePanel key={owner.gladiatorId} owner={owner} gateway={gateway} refresh={game.refreshOwner} clock={clock} />
        : <SchedulePreview owner={owner} />;
      case 'inventory': return owner ? <InventoryPanel key={owner.gladiatorId} owner={owner} gateway={gateway} refresh={game.refreshOwner} preview={fixture}
        initialMerchant={shop?.merchant} merchantRequest={shop?.request} /> : null;
      // Anyone browses; the command gateway is a player's only, so a visitor's or a new account's panel cannot send one.
      case 'market': return reads ? <MarketPanel key={ownerId ?? viewer} reads={reads} gateway={viewer === 'player' ? gateway : null} owner={owner} viewer={viewer}
        clock={clock} refreshOwner={game.refreshOwner} fixture={fixture} />
        : <p role="status">{previewError ? 'The fixture preview could not be loaded.' : 'Loading local preview…'}</p>;
      case 'arena': return <ArenaMenu open={open === 'arena'} bridge={bridge} reads={reads} owner={owner} world={world} clock={clock} fixture={fixture}
        samples={samples.arena} fights={fights} sceneUnavailable={sceneUnavailable} revision={game.revision}
        onProfile={row => openRow(row.gladiatorId, { wins: row.humanWins, losses: row.humanLosses }, row.name)} />;
      case 'tournaments': return <TournamentPanel key={owner?.gladiatorId ?? 'none'} reads={reads} owner={owner} clock={clock} fixture={fixture} samples={samples.tournaments}
        refresh={fixture ? undefined : game.refreshOwner} syncError={game.syncError} viewer={viewer} publishedSlotIndex={game.publishedSlotIndex} />;
      case 'results': return <ResultsMenu fixture={fixture} samples={samples} previewFailed={previewError} reads={reads} viewerId={ownerId} clock={clock}
        onWatch={watchResult} onOpen={openScene} />;
      case 'gladiators': return <RosterPanel world={world} ownerId={ownerId} ownPlace={ownPlace} roster={roster} sceneStatus={game.sceneStatus}
        following={following} bridge={bridge} onDone={handBack}
        onProfile={gladiatorId => openRow(gladiatorId)} />;
    }
  };

  return (
    <div ref={shellRef} className={styles.shell} data-rail={rail.revealed ? 'shown' : 'hidden'} data-sheet={open ? 'open' : undefined}>
      <h1 className={styles.sr}>Cloudiator — Hearthstone Camp</h1>
      <MenuRail menus={menus} state={{ revealed: rail.revealed, open }} send={send} onToggle={id => send({ toggle: id })}
        zoom={sceneUnavailable ? null : direction => bridge.emit('camera-zoom', { direction })} />
      <CornerChip viewer={viewer} session={game.session} owner={owner} fixture={fixture} previewAs={previewAs} clock={clock}
        onOpenMenu={show} onCreate={joining.offer} />
      {fixture && <p className={styles.pill} role="status">Fixture mode — progress is not saved online</p>}
      {fixtureRefused && <p className={styles.pill} role="status">Fixture preview is unavailable in this build.</p>}
      <div className={styles.notices}>
        {/* A rejected stored session (`unauthenticated`) is signed out locally, not a lost connection (13.5 review); a
            signed-out visitor has no session to sign out, so for them a refusal is a lost connection (final review Minor 2). */}
        {!fixture && (game.syncError === 'unavailable' || (game.syncError === 'unauthenticated' && game.session.status === 'signed-out'))
          && <p className={styles.notice} role="status">Connection lost — showing the last known camp</p>}
        {signInNotice && <div className={styles.signInNotice} role="status">
          <p>{SIGN_IN_MESSAGES[signInNotice]}</p>
          <button type="button" className={styles.dismiss} aria-label="Dismiss" onClick={() => setSignInNotice(null)}>×</button>
        </div>}
      </div>
      {menus.map(menu => (menu.id === open || menu.id === 'arena') && (
        <MenuSurface key={menu.id} menu={menu} open={menu.id === open} onClose={() => close(menu.id)}>{content(menu.id)}</MenuSurface>
      ))}
      {card && <ProfileLayer key={card.n} target={card} world={world} reads={reads} ownerId={ownerId} ownPlace={ownPlace} roster={roster} sceneStatus={game.sceneStatus}
        following={following} onClose={() => closeCard(true)} onOpenMenu={id => { closeCard(false); show(id); }}
        onFollow={id => { bridge.emit('follow-character', { gladiatorId: following === id ? null : id }); closeCard(false); handBack(); }}
        onWatch={(activityId, gladiatorId) => { closeCard(false); bridge.emit('open-arena', { activityId, gladiatorId }); }} />}
      <main id="main" className={styles.camp} data-camp-view="" tabIndex={-1}
        onPointerDown={event => { press.current = { x: event.clientX, y: event.clientY }; }}
        onPointerUp={event => {
          const start = press.current;
          press.current = null;
          // A click on the camp closes the menus and the card; a gladiator's click opens its card just after (Phaser
          // hears the mouseup that follows this pointerup). The scene tells a click from a drag by the same travel.
          if (start && isClick(event.clientX - start.x, event.clientY - start.y)) { send('camp-click'); closeCard(false); }
        }}>
        <GameViewport chrome="none" world={world} bridge={bridge} focusGladiatorId={ownerId} clock={clock} timelines={reads} tournaments={reads}
          onStatus={game.setSceneStatus} paused={scene !== null} />
      </main>
      {scene && <SceneOverlay view={scene} gateway={reads} state={game} fixture={fixture} onClose={() => bridge.emit('return-camp', {})} onWatch={openScene} />}
      {joining.creating && (
        <CreateCharacter key={account ?? 'none'} gateway={gateway} onCreated={joining.created} onDismiss={joining.dismiss} onFocusLost={focusOffer} />
      )}
      {perf && <PerfOverlay phase={perfPhase.label} phaseKey={perfPhase.key} />}
    </div>
  );
}
