'use client';

// The game screen (spec "Full-screen camp"): the camp fills the window, and everything else floats on it. A hidden rail
// on the left edge opens one menu at a time, beside it (a bottom sheet on touch); the corner chip sits top right. The
// shell owns the shared game state (`useGameState`), the scene bridge and the menus' contents, which are the existing
// panels, re-housed. Keyboard: the first Tab reveals the rail and focuses its first icon; Escape closes the open menu
// and returns the focus to its icon. Menus render outside the camp view's element, so its keys never see their typing.
//
// Task 13.6, visitors and joining: anyone watches the camp and its public menus; the chip starts Google sign-in. Signed in
// without a gladiator, the "Create your gladiator" dialog opens over the running camp (once per account and page load;
// the chip and My gladiator offer it again). When the viewer stops being a player (sign-out, expiry, another account),
// a private menu that is open closes. A cancelled or failed sign-in comes back as `?signin=cancelled|failed` (plan
// Decision 6): the shell shows a short message and removes the parameter.
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { Phase } from '@contracts/commands';
import type { OwnerState } from '@contracts/reads';
import { createLiveGateway, type GameGateway } from '../../lib/api/gateway';
import { useGameState } from '../character/useGameState';
import { CharacterPanel } from '../character/CharacterPanel';
import { CreateCharacter } from '../character/CreateCharacter';
import { RosterPanel, type Roster } from '../character/RosterPanel';
import { SchedulePanel } from '../schedule/SchedulePanel';
import { InventoryPanel } from '../inventory/InventoryPanel';
import { ArenaMenu } from '../arena/ArenaMenu';
import type { ArenaSample } from '../arena/ArenaPanel';
import { TournamentPanel, type TournamentSample } from '../tournaments/TournamentPanel';
import { GameViewport } from '../../game/GameViewport';
import { createSceneBridge, type ArenaFightSummary } from '../../game/bridge';
import { CornerChip } from './CornerChip';
import { MenuRail } from './MenuRail';
import { MenuSurface } from './MenuSurface';
import { menusFor, type MenuId } from './menus';
import { railReducer, type RailEvent, type RailState } from './rail-reveal';
import styles from './shell.module.css';

/** How a Google sign-in that did not complete came back (`AuthCallback`, plan Decision 6). */
export type SignInResult = 'cancelled' | 'failed';
const SIGN_IN_MESSAGES: Record<SignInResult, string> = {
  cancelled: 'Google sign-in was canceled. You can keep watching the camp.',
  failed: 'Google sign-in could not be completed. Please try again.',
};

type SampleLink = { activityId: string; label: string };
type Samples = { replays: readonly SampleLink[]; expeditions: readonly SampleLink[]; arena: readonly ArenaSample[]; tournaments: readonly TournamentSample[] };
const NO_SAMPLES: Samples = { replays: [], expeditions: [], arena: [], tournaments: [] };
/** A click on the camp moves the pointer less than this; more is a drag, which leaves the menus open. */
const CLICK_PX = 6;

/**
 * Whether an element is rendered and not hidden (the touch row of icons hides while a sheet is open).
 * `checkVisibility` arrived in Safari 17.4, below the project's Safari 16.4 floor, so it is feature-detected.
 */
const shown = (element: HTMLElement | null): element is HTMLElement => !!element && (typeof element.checkVisibility === 'function'
  ? element.checkVisibility({ visibilityProperty: true })
  : element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');

/** Whether a modal dialog is open (`:modal`, Safari 15.6+, within the project's Safari 16.4 floor). */
const modalOpen = () => document.querySelector('dialog:modal') !== null;

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

/** Results: in fixture mode the sample replays and expeditions (Task 13.7 adds the list of recent results). */
function ResultsMenu({ fixture, samples, previewFailed }: { fixture: boolean; samples: Samples; previewFailed: boolean }) {
  if (!fixture) return <p className="panel-notice">Recent results are not available in this build yet.</p>;
  if (!samples.replays.length && !samples.expeditions.length) return <p role="status">{previewFailed ? 'The fixture preview could not be loaded.' : 'Loading local preview…'}</p>;
  return <>
    {samples.replays.length > 0 && <nav className="sample-replays" aria-label="Sample replays">
      <p className="eyebrow">SAMPLE REPLAYS</p>
      <ul>{samples.replays.map(r => <li key={r.activityId}><Link href={`/replay/?mode=fixture&activity=${r.activityId}`}>{r.label}</Link></li>)}</ul>
    </nav>}
    {samples.expeditions.length > 0 && <nav className="sample-replays" aria-label="Sample expeditions">
      <p className="eyebrow">SAMPLE EXPEDITIONS</p>
      <ul>{samples.expeditions.map(e => <li key={e.activityId}><Link href={`/expedition/?mode=fixture&activity=${e.activityId}`}>{e.label}</Link></li>)}</ul>
    </nav>}
  </>;
}

export function CampShell({ fixture, previewAs, fixtureRefused = false, signInResult = null }: {
  fixture: boolean;
  previewAs?: 'visitor' | 'player';
  /** `?mode=fixture` was asked for in a build without the preview: say so over the live camp. */
  fixtureRefused?: boolean;
  /** `?signin=`: a Google sign-in that was cancelled or failed has returned to the camp. */
  signInResult?: SignInResult | null;
}) {
  const [bridge] = useState(createSceneBridge);
  const [gateway] = useState(createLiveGateway);
  const [previewError, setPreviewError] = useState(false);
  const [samples, setSamples] = useState<Samples>(NO_SAMPLES);
  const [fixtureReads, setFixtureReads] = useState<GameGateway | null>(null);

  useEffect(() => {
    let active = true;
    if (fixture) {
      import('../../lib/api/fixture-gateway')
        .then(({ createFixtureGateway, FIXTURE_REPLAYS, FIXTURE_EXPEDITIONS, FIXTURE_ARENA, FIXTURE_TOURNAMENTS }) => {
          if (!active) return;
          setSamples({ replays: FIXTURE_REPLAYS, expeditions: FIXTURE_EXPEDITIONS, arena: FIXTURE_ARENA, tournaments: FIXTURE_TOURNAMENTS });
          setFixtureReads(createFixtureGateway());
        })
        .catch(() => { if (active) setPreviewError(true); });
    }
    return () => { active = false; };
  }, [fixture]);

  const reads = fixture ? fixtureReads : gateway;
  // One sync controller, display clock and owner state for the camp and every menu (the fixture gateway once loaded).
  const game = useGameState(reads, { fixture, previewAs });
  const { owner, world, clock } = game;
  const menus = menusFor(game.viewer);

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

  // Joining: signed in without a gladiator, the creation dialog opens over the camp once per account (and page load).
  const [creating, setCreating] = useState(false);
  const offered = useRef<string | null>(null);
  const { viewer, refreshOwner } = game;
  const account = game.session.userId;
  useEffect(() => {
    if (viewer === 'visitor') offered.current = null;
    if (viewer !== 'no-gladiator') { setCreating(false); return; }
    if (account !== null && offered.current !== account) { offered.current = account; setCreating(true); }
  }, [viewer, account]);
  // Created: the dialog closes, and My gladiator shows the new gladiator once its owner state is read.
  const created = useCallback(() => {
    setCreating(false);
    void refreshOwner().catch(() => undefined).finally(() => show('gladiator'));
  }, [refreshOwner, show]);

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
    document.querySelector<HTMLElement>('[data-camp-view] [role="application"]')?.focus({ preventScroll: true });
  }, [send]);

  // The scene's public facts the menus show, kept while they are closed.
  const [fights, setFights] = useState<readonly ArenaFightSummary[]>([]);
  const [roster, setRoster] = useState<Roster | null>(null);
  const [following, setFollowing] = useState<string | null>(null);
  useEffect(() => bridge.on('arena-fights', ({ fights: next }) => setFights(next)), [bridge]);
  useEffect(() => bridge.on('roster', next => setRoster(next)), [bridge]);
  useEffect(() => bridge.on('follow-character', ({ gladiatorId }) => setFollowing(gladiatorId)), [bridge]);
  // A click on an Arena entrant (or a ring-fight button) opens its card in the Arena menu.
  useEffect(() => bridge.on('open-arena', () => setRail(state => (state.open === 'arena' ? state : railReducer(state, { toggle: 'arena' })))), [bridge]);

  // Escape closes the open menu (a native dialog inside a panel, such as a discard confirmation, handles its own);
  // the first Tab from the page reveals the rail at its first icon. Both stand down while a modal dialog is open (the
  // creation dialog, a discard confirmation): the page behind it is inert, and the dialog owns Tab and Escape even when
  // the focus has fallen to <body> (13.6 review I1).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (modalOpen()) return;
      if (event.key === 'Escape') {
        const current = openRef.current;
        if (!current || event.defaultPrevented || (event.target instanceof Element && event.target.closest('dialog'))) return;
        event.preventDefault();
        close(current);
      } else if (event.key === 'Tab' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
        && (!document.activeElement || document.activeElement === document.body)) {
        const first = document.querySelector<HTMLElement>('[data-menu-icon]');
        if (!shown(first)) return;
        event.preventDefault();
        send('focus-in');
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close, send]);

  const press = useRef<{ x: number; y: number } | null>(null);
  const sceneUnavailable = game.sceneStatus === 'unavailable';
  const content = (id: MenuId) => {
    switch (id) {
      case 'gladiator': return <CharacterPanel viewer={game.viewer} session={game.session} owner={owner} ownerError={game.ownerError} slotIndex={game.slotIndex}
        clock={clock} gateway={gateway} fixture={fixture} previewAs={previewAs} previewFailed={previewError} refreshOwner={game.refreshOwner}
        onCreate={() => setCreating(true)} />;
      case 'schedule': return owner && !fixture ? <SchedulePanel key={owner.gladiatorId} owner={owner} gateway={gateway} refresh={game.refreshOwner} clock={clock} />
        : <SchedulePreview owner={owner} />;
      case 'inventory': return owner ? <InventoryPanel key={owner.gladiatorId} owner={owner} gateway={gateway} refresh={game.refreshOwner} preview={fixture} /> : null;
      case 'arena': return <ArenaMenu open={open === 'arena'} bridge={bridge} reads={reads} owner={owner} world={world} clock={clock} fixture={fixture}
        samples={samples.arena} fights={fights} sceneUnavailable={sceneUnavailable} revision={game.revision} />;
      case 'tournaments': return <TournamentPanel key={owner?.gladiatorId ?? 'none'} reads={reads} owner={owner} clock={clock} fixture={fixture} samples={samples.tournaments}
        refresh={fixture ? undefined : game.refreshOwner} syncError={game.syncError} viewer={game.viewer} />;
      case 'results': return <ResultsMenu fixture={fixture} samples={samples} previewFailed={previewError} />;
      case 'gladiators': return <RosterPanel world={world} ownerId={owner?.gladiatorId ?? null} roster={roster} sceneStatus={game.sceneStatus}
        following={following} bridge={bridge} onDone={handBack} />;
    }
  };

  return (
    <div className={styles.shell} data-rail={rail.revealed ? 'shown' : 'hidden'} data-sheet={open ? 'open' : undefined}>
      <h1 className={styles.sr}>Cloudiator — Hearthstone Camp</h1>
      <MenuRail menus={menus} state={{ revealed: rail.revealed, open }} send={send} onToggle={id => send({ toggle: id })}
        zoom={sceneUnavailable ? null : direction => bridge.emit('camera-zoom', { direction })} />
      <CornerChip viewer={game.viewer} session={game.session} owner={owner} fixture={fixture} previewAs={previewAs} clock={clock}
        onOpenMenu={show} onCreate={() => setCreating(true)} />
      {fixture && <p className={styles.pill} role="status">Fixture mode — progress is not saved online</p>}
      {fixtureRefused && <p className={styles.pill} role="status">Fixture preview is unavailable in this build.</p>}
      <div className={styles.notices}>
        {/* A rejected stored session (`unauthenticated`) is signed out locally, not a lost connection (13.5 review). */}
        {!fixture && game.syncError === 'unavailable' && <p className={styles.notice} role="status">Connection lost — showing the last known camp</p>}
        {signInNotice && <div className={styles.signInNotice} role="status">
          <p>{SIGN_IN_MESSAGES[signInNotice]}</p>
          <button type="button" className={styles.dismiss} aria-label="Dismiss" onClick={() => setSignInNotice(null)}>×</button>
        </div>}
      </div>
      {menus.map(menu => (menu.id === open || menu.id === 'arena') && (
        <MenuSurface key={menu.id} menu={menu} open={menu.id === open} onClose={() => close(menu.id)}>{content(menu.id)}</MenuSurface>
      ))}
      <main id="main" className={styles.camp} data-camp-view=""
        onPointerDown={event => { press.current = { x: event.clientX, y: event.clientY }; }}
        onPointerUp={event => {
          const start = press.current;
          press.current = null;
          if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) < CLICK_PX) send('camp-click');
        }}>
        <GameViewport chrome="none" world={world} bridge={bridge} focusGladiatorId={owner?.gladiatorId ?? null} clock={clock} timelines={reads} tournaments={reads}
          onStatus={game.setSceneStatus} />
      </main>
      {creating && viewer === 'no-gladiator' && (
        <CreateCharacter key={account ?? 'none'} gateway={gateway} onCreated={created} onDismiss={() => setCreating(false)} />
      )}
    </div>
  );
}
