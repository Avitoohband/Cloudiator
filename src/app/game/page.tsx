'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import type { OwnerState } from '@contracts/reads';
import type { Phase } from '@contracts/commands';

const panels = ['Schedule', 'Gladiator', 'Inventory', 'Marketplace', 'Standings', 'Tournaments', 'Results'] as const;
type Panel = typeof panels[number];

function GameShell() {
  const search = useSearchParams();
  const requested = search.get('mode') === 'fixture';
  const fixture = requested && process.env.NEXT_PUBLIC_FIXTURE_ENABLED === 'true';
  const [owner, setOwner] = useState<OwnerState | null>(null);
  const [panel, setPanel] = useState<Panel>('Schedule');
  const [previewError, setPreviewError] = useState(false);

  useEffect(() => {
    let active = true;
    if (fixture) {
      import('../../lib/api/fixture-gateway')
        .then(({ createFixtureGateway }) => createFixtureGateway().owner())
        .then((data) => { if (active) setOwner(data); })
        .catch(() => { if (active) setPreviewError(true); });
    }
    return () => { active = false; };
  }, [fixture]);

  const visibleOwner = fixture ? owner : null;
  return <div className="game-shell">
    <header className="topbar">
      <Link className="brand" href="/">CLOUDIATOR <span>CHRONICLES OF THE ARENA</span></Link>
      <div className="world-status"><span className="status-dot" aria-hidden="true" />{fixture ? 'LOCAL PREVIEW' : 'CAMP UNDER CONSTRUCTION'}</div>
    </header>
    {fixture && <p className="fixture-banner" role="status">Fixture mode — progress is not saved online</p>}
    {requested && !fixture && <p className="notice" role="status">Fixture preview is unavailable in this build.</p>}
    <main id="main" className="dashboard">
      <section className="camp-area" aria-labelledby="camp-heading">
        <div className="section-title"><div><p className="eyebrow">THE SHARED WORLD</p><h1 id="camp-heading">Hearthstone Camp</h1></div><span className="tag">{fixture ? 'Preview' : 'Coming soon'}</span></div>
        <div className="scene-placeholder">
          <div className="scene-label">CAMP VIEW</div>
          <h2>Your world is taking shape.</h2>
          <p>The living camp and its fighters will appear here.<br />Management stays available alongside the world.</p>
          <span className="scene-caption">Animated scene coming in a later build</span>
        </div>
        <div className="day-strip" aria-label="Shared game day">
          <div><span className="eyebrow">WORLD RHYTHM</span><strong>4 hours, 3 chapters</strong></div>
          <div><strong>Morning</strong><span>80 minutes</span></div>
          <div><strong>Afternoon</strong><span>80 minutes</span></div>
          <div><strong>Evening</strong><span>80 minutes</span></div>
        </div>
        <p className="muted world-note">{fixture ? 'Sample activity and balances. The preview clock does not advance.' : 'World time and activity will appear after sign-in is connected.'}</p>
      </section>
      <aside className="fighter-card" aria-labelledby="fighter-heading">
        <p className="eyebrow">YOUR GLADIATOR</p>
        <h2 id="fighter-heading">{visibleOwner?.name ?? 'A legend awaits'}</h2>
        <p className="fighter-class">{visibleOwner ? `${visibleOwner.currentBuild.classId} · Level ${visibleOwner.progression.level} · Bronze league` : 'One fighter. Your choices.'}</p>
        {visibleOwner ? <>
          <div className="activity-box"><span className="eyebrow">SAMPLE ACTIVITY</span><p>{visibleOwner.currentActivity?.label ?? 'At camp'}</p></div>
          <label className="stamina-label" htmlFor="stamina">Stamina <span>{visibleOwner.stamina.current} / {visibleOwner.stamina.maximum}</span></label>
          <progress id="stamina" value={visibleOwner.stamina.current} max={visibleOwner.stamina.maximum} />
          <dl className="wallets"><div><dt>Money</dt><dd>{visibleOwner.wallets.money}</dd></div><div><dt>Renown</dt><dd>{visibleOwner.wallets.renown}</dd></div></dl>
          <p className="muted">Local sample character. No account is signed in.</p>
        </> : <div className="welcome"><h3>Your story starts here</h3><p>Manage one gladiator and make a plan for each shared game day.</p><button className="primary-button" disabled>Continue with Google</button><p className="muted">Google sign-in is not connected yet.</p></div>}
        {fixture && !owner && <p role="status">{previewError ? 'The fixture preview could not be loaded.' : 'Loading local preview…'}</p>}
      </aside>
      <section className="management" aria-label="Gladiator management">
        <nav className="panel-nav" aria-label="Management panels">
          {panels.map((name) => <button key={name} aria-pressed={panel === name} aria-controls="management-panel" onClick={() => setPanel(name)}>{name}</button>)}
        </nav>
        <div id="management-panel" className="panel-content">
          {panel === 'Schedule' ? <>
            <div className="section-title"><div><p className="eyebrow">PLAN THE NEXT CHAPTER</p><h2>Repeating schedule</h2></div><span className="tag">{visibleOwner ? 'Sample plan' : 'Preview only'}</span></div>
            <p className="muted">A morning of practice. An afternoon of adventure. An evening to recover.</p>
            <div className="schedule-grid">{(['morning', 'afternoon', 'evening'] as Phase[]).map((phase, index) => {
              const choice = visibleOwner?.schedule[phase];
              const title = choice ? choice.kind === 'expedition' ? 'Expedition' : choice.kind : 'Awaiting character';
              return <article className={`schedule-slot slot-${index}`} key={phase}><span className="eyebrow">{phase}</span><h3>{title}</h3><p>{choice?.kind === 'expedition' ? 'Woodland Path' : choice?.kind === 'training' ? 'Practice yard' : choice?.kind === 'rest' ? 'Recover stamina' : 'Sign-in is not connected'}</p><span className="slot-duration">80-minute slot</span></article>;
            })}</div>
            <p className="panel-notice">This preview cannot save schedule changes.</p>
          </> : <><p className="eyebrow">MANAGEMENT</p><h2>{panel}</h2><p className="panel-notice">{panel} is not available in this build. Online play is not connected yet.</p></>}
        </div>
      </section>
    </main>
    <footer className="game-footer">CLOUDIATOR <span>A life in the arena · Early development</span></footer>
  </div>;
}

export default function GamePage() {
  return <Suspense fallback={<main id="main" className="loading" role="status">Opening the camp…</main>}><GameShell /></Suspense>;
}
