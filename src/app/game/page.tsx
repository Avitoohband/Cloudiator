'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import type { Phase } from '@contracts/commands';
import { createLiveGateway, type GameGateway } from '../../lib/api/gateway';
import { signOut } from '../../lib/api/session';
import { SignIn } from '../../features/auth/SignIn';
import { CreateCharacter } from '../../features/character/CreateCharacter';
import { useGameState } from '../../features/character/useGameState';
import { SchedulePanel } from '../../features/schedule/SchedulePanel';
import { BuildPanel } from '../../features/build/BuildPanel';
import { InventoryPanel } from '../../features/inventory/InventoryPanel';
import { ArenaPanel, type ArenaSample } from '../../features/arena/ArenaPanel';
import { StandingsPanel } from '../../features/arena/StandingsPanel';
import { TournamentPanel, type TournamentSample } from '../../features/tournaments/TournamentPanel';
import { GameViewport } from '../../game/GameViewport';
import { createSceneBridge } from '../../game/bridge';

const panels = ['Schedule', 'Gladiator', 'Inventory', 'Marketplace', 'Standings', 'Tournaments', 'Results'] as const;
type Panel = typeof panels[number];

function GameShell() {
  const search = useSearchParams();
  const requested = search.get('mode') === 'fixture';
  const fixture = requested && process.env.NEXT_PUBLIC_FIXTURE_ENABLED === 'true';
  // `?as=visitor` previews the visitor view, in fixture mode only.
  const previewAs = fixture && search.get('as') === 'visitor' ? 'visitor' : undefined;
  const [bridge] = useState(createSceneBridge);
  const [panel, setPanel] = useState<Panel>('Schedule');
  const [previewError, setPreviewError] = useState(false);
  const [sampleReplays, setSampleReplays] = useState<readonly { activityId: string; label: string }[]>([]);
  const [sampleExpeditions, setSampleExpeditions] = useState<readonly { activityId: string; label: string }[]>([]);
  const [sampleArena, setSampleArena] = useState<readonly ArenaSample[]>([]);
  const [sampleTournaments, setSampleTournaments] = useState<readonly TournamentSample[]>([]);
  const [fixtureReads, setFixtureReads] = useState<GameGateway | null>(null);
  const [gateway] = useState(createLiveGateway);
  const [signOutError, setSignOutError] = useState(false);

  useEffect(() => {
    let active = true;
    if (fixture) {
      import('../../lib/api/fixture-gateway')
        .then(({ createFixtureGateway, FIXTURE_REPLAYS, FIXTURE_EXPEDITIONS, FIXTURE_ARENA, FIXTURE_TOURNAMENTS }) => { if (active) { setSampleReplays(FIXTURE_REPLAYS); setSampleExpeditions(FIXTURE_EXPEDITIONS); setSampleArena(FIXTURE_ARENA); setSampleTournaments(FIXTURE_TOURNAMENTS); setFixtureReads(createFixtureGateway()); } })
        .catch(() => { if (active) setPreviewError(true); });
    }
    return () => { active = false; };
  }, [fixture]);

  const reads = fixture ? fixtureReads : gateway;
  // One sync controller, display clock and owner state for the camp and every panel (the fixture gateway once loaded).
  const game = useGameState(reads, { fixture, previewAs });
  const { session, world, clock } = game;
  const visibleOwner = game.owner;
  const noCharacter = game.viewer === 'no-gladiator';
  const refreshPlanning = game.refreshOwner;
  return <div className="game-shell">
    <header className="topbar">
      <Link className="brand" href="/">CLOUDIATOR <span>CHRONICLES OF THE ARENA</span></Link>
      <div className="world-status"><span className="status-dot" aria-hidden="true" />{fixture ? 'LOCAL PREVIEW' : 'LIVE CAMP'}
        {!fixture && session.status === 'signed-in' && <button className="signout-button" onClick={() => { setSignOutError(false); void signOut().catch(() => setSignOutError(true)); }}>Sign out</button>}
      </div>
    </header>
    {fixture && <p className="fixture-banner" role="status">Fixture mode — progress is not saved online</p>}
    {requested && !fixture && <p className="notice" role="status">Fixture preview is unavailable in this build.</p>}
    <main id="main" className="dashboard">
      <section className="camp-area" aria-labelledby="camp-heading">
        <div className="section-title"><div><p className="eyebrow">THE SHARED WORLD</p><h1 id="camp-heading">Hearthstone Camp</h1></div><span className="tag">{fixture ? 'Preview' : 'Live'}</span></div>
        <GameViewport world={world} bridge={bridge} focusGladiatorId={visibleOwner?.gladiatorId ?? null} clock={clock} timelines={reads} tournaments={reads} onStatus={game.setSceneStatus} />
        <div className="day-strip" aria-label="Shared game day">
          <div><span className="eyebrow">WORLD RHYTHM</span><strong>4 hours, 3 chapters</strong></div>
          <div><strong>Morning</strong><span>80 minutes</span></div>
          <div><strong>Afternoon</strong><span>80 minutes</span></div>
          <div><strong>Evening</strong><span>80 minutes</span></div>
        </div>
        <p className="muted world-note">{fixture ? 'Sample activity and balances. The camp animates, but the sample schedule and balances never change.' : visibleOwner ? 'The shared camp, live. Your character is saved online.' : 'The shared camp, live. Sign in with Google to create a gladiator.'}</p>
      </section>
      <aside className="fighter-card" aria-labelledby="fighter-heading">
        <p className="eyebrow">YOUR GLADIATOR</p>
        <h2 id="fighter-heading">{visibleOwner?.name ?? 'A legend awaits'}</h2>
        <p className="fighter-class">{visibleOwner ? `${visibleOwner.currentBuild.classId} · Level ${visibleOwner.progression.level} · ${visibleOwner.progression.league} league` : 'One fighter. Your choices.'}</p>
        {visibleOwner ? <>
          <div className="activity-box"><span className="eyebrow">{fixture ? 'SAMPLE ACTIVITY' : 'CURRENT ACTIVITY'}</span><p>{visibleOwner.currentActivity?.label ?? 'At camp'}</p></div>
          <label className="stamina-label" htmlFor="stamina">Stamina <span>{visibleOwner.stamina.current} / {visibleOwner.stamina.maximum}</span></label>
          <progress id="stamina" value={visibleOwner.stamina.current} max={visibleOwner.stamina.maximum} />
          <dl className="wallets"><div><dt>Money</dt><dd>{visibleOwner.wallets.money}</dd></div><div><dt>Renown</dt><dd>{visibleOwner.wallets.renown}</dd></div></dl>
          <p className="muted">{fixture ? 'Local sample character. No account is signed in.' : 'Your first full activity begins at the next shared slot boundary.'}</p>
        </> : !fixture && <>
          {session.status === 'loading' ? <p role="status">Checking your session…</p> : session.status !== 'signed-in' ? <SignIn available={session.status === 'signed-out'} />
            : game.ownerError ? <><p role="alert">Your character could not be loaded. Please retry before creating a gladiator.</p><button onClick={() => { void game.refreshOwner().catch(() => undefined); }}>Retry owner load</button></>
              : !noCharacter ? <p role="status">Loading your gladiator…</p> : null}
          {(noCharacter || session.status === 'signed-out' || session.status === 'unavailable') && <CreateCharacter key={session.userId ?? 'signed-out'} gateway={gateway} onCreated={() => { void game.refreshOwner().catch(() => undefined); }} />}
        </>}
        {signOutError && <p role="alert">Sign-out could not be completed. Please try again.</p>}
        {fixture && previewAs !== 'visitor' && !visibleOwner && <p role="status">{previewError || game.viewer === 'unavailable' ? 'The fixture preview could not be loaded.' : 'Loading local preview…'}</p>}
        {fixture && sampleReplays.length > 0 && <nav className="sample-replays" aria-label="Sample replays">
          <p className="eyebrow">SAMPLE REPLAYS</p>
          <ul>{sampleReplays.map(r => <li key={r.activityId}><Link href={`/replay/?mode=fixture&activity=${r.activityId}`}>{r.label}</Link></li>)}</ul>
        </nav>}
        {fixture && sampleExpeditions.length > 0 && <nav className="sample-replays" aria-label="Sample expeditions">
          <p className="eyebrow">SAMPLE EXPEDITIONS</p>
          <ul>{sampleExpeditions.map(e => <li key={e.activityId}><Link href={`/expedition/?mode=fixture&activity=${e.activityId}`}>{e.label}</Link></li>)}</ul>
        </nav>}
        {/* Live mode reads Arena timelines and opponent profiles through the live gateway (Tasks 10/16); without an owner
            it is a spectator's: cards opened from the camp, with public stages and results only. */}
        <ArenaPanel bridge={bridge} reads={reads} owner={visibleOwner} world={world} clock={clock} fixture={fixture} samples={sampleArena} />
      </aside>
      <section className="management" aria-label="Gladiator management">
        <nav className="panel-nav" aria-label="Management panels">
          {panels.map((name) => <button key={name} aria-pressed={panel === name} aria-controls="management-panel" onClick={() => setPanel(name)}>{name}</button>)}
        </nav>
        <div id="management-panel" className="panel-content">
          {!fixture && visibleOwner && panel === 'Schedule' ? <SchedulePanel key={visibleOwner.gladiatorId} owner={visibleOwner} gateway={gateway} refresh={refreshPlanning} clock={clock} />
            : !fixture && visibleOwner && panel === 'Gladiator' ? <BuildPanel key={visibleOwner.gladiatorId} owner={visibleOwner} gateway={gateway} refresh={refreshPlanning} />
              : visibleOwner && panel === 'Inventory' ? <InventoryPanel key={visibleOwner.gladiatorId} owner={visibleOwner} gateway={gateway} refresh={refreshPlanning} preview={fixture} />
              // Live mode reads the paginated league standings through the live gateway (Task 16).
              : panel === 'Standings' ? <StandingsPanel key={visibleOwner?.gladiatorId ?? 'none'} reads={reads} owner={visibleOwner} clock={clock} revision={game.revision} />
              : panel === 'Tournaments' ? <TournamentPanel key={visibleOwner?.gladiatorId ?? 'none'} reads={reads} owner={visibleOwner} clock={clock} fixture={fixture} samples={sampleTournaments}
                refresh={fixture ? undefined : refreshPlanning} syncError={game.syncError} />
              : panel === 'Schedule' ? <>
            <div className="section-title"><div><p className="eyebrow">PLAN THE NEXT CHAPTER</p><h2>Repeating schedule</h2></div><span className="tag">{visibleOwner ? fixture ? 'Sample plan' : 'Your plan' : 'Awaiting character'}</span></div>
            <p className="muted">A morning of practice. An afternoon of adventure. An evening to recover.</p>
            <div className="schedule-grid">{(['morning', 'afternoon', 'evening'] as Phase[]).map((phase, index) => {
              const choice = visibleOwner?.schedule[phase];
              const title = choice ? choice.kind === 'expedition' ? 'Expedition' : choice.kind : 'Awaiting character';
              return <article className={`schedule-slot slot-${index}`} key={phase}><span className="eyebrow">{phase}</span><h3>{title}</h3><p>{choice?.kind === 'expedition' ? 'Woodland Path' : choice?.kind === 'training' ? 'Practice yard' : choice?.kind === 'rest' ? 'Recover stamina' : 'Create your gladiator to begin'}</p><span className="slot-duration">80-minute slot</span></article>;
            })}</div>
            <p className="panel-notice">{fixture ? 'This preview cannot save schedule changes.' : 'Schedule editing is not available in this build.'}</p>
          </> : <><p className="eyebrow">MANAGEMENT</p><h2>{panel}</h2><p className="panel-notice">{panel} is not available in this build.</p></>}
        </div>
      </section>
    </main>
    <footer className="game-footer">CLOUDIATOR <span>A life in the arena · Early development</span></footer>
  </div>;
}

export default function GamePage() {
  return <Suspense fallback={<main id="main" className="loading" role="status">Opening the camp…</main>}><GameShell /></Suspense>;
}
