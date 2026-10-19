'use client';

// Fixed expedition page for the static export: /expedition/?activity=<id>, a deep link (the camp opens the same
// expedition as a scene over itself, Task 13.8). It follows one expedition's revealed timeline and only reads; it never
// sends commands. The page mounts the shared game state: its sync controller's revision re-reads the timeline (the
// view has no poll of its own), and its world and owner name the gladiator. Fixture mode (?mode=fixture in a
// fixture-enabled build) may add &minute=<0..90> to open the sample at that minute.
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { createLiveGateway, type GameGateway } from '../../lib/api/gateway';
import { useGameState } from '../../features/character/useGameState';
import { ExpeditionView, ExpeditionUnavailable } from '../../features/character/ExpeditionView';
import { expeditionQuery } from '../../features/character/expedition-query';

function ExpeditionShell() {
  const search = useSearchParams();
  const { requested, fixture, activityId, minute } = expeditionQuery(search, process.env.NEXT_PUBLIC_FIXTURE_ENABLED === 'true');
  const [loaded, setLoaded] = useState<{ fixture: boolean; reads: GameGateway } | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      // The fixture gateway is only reachable when the build enables fixtures, so production exports drop it.
      const reads: GameGateway = process.env.NEXT_PUBLIC_FIXTURE_ENABLED === 'true' && fixture
        ? (await import('../../lib/api/fixture-gateway')).createFixtureGateway()
        : createLiveGateway();
      if (active) setLoaded({ fixture, reads });
    })().catch(() => { if (active) setLoaded({ fixture, reads: createLiveGateway() }); });
    return () => { active = false; };
  }, [fixture]);

  const reads = loaded?.fixture === fixture ? loaded.reads : null;
  // Without a well-formed activity there is nothing to show, so nothing is read or polled.
  const game = useGameState(activityId ? reads : null, { fixture });
  // The expedition is the account's own read: once the session is known, a sign-out, expiry or account switch (here or in
  // another tab) remounts it as the new reader, so no owner's rewards outlive the session (final review Minor 1).
  const reader = game.session.userId ?? 'visitor';
  return <div className="game-shell">
    <header className="topbar">
      <Link className="brand" href="/">CLOUDIATOR <span>CHRONICLES OF THE ARENA</span></Link>
      <Link className="back-link" href={fixture ? '/game/?mode=fixture' : '/game/'}>Back to camp</Link>
    </header>
    {fixture && <p className="fixture-banner" role="status">Fixture mode — sample expeditions from the local preview</p>}
    {requested && !fixture && <p className="notice" role="status">Fixture preview is unavailable in this build.</p>}
    <main id="main" className="replay-page" tabIndex={-1}>
      {!activityId ? <ExpeditionUnavailable fixture={fixture} reason="not-found" />
        : reads && game.session.status !== 'loading' ? <ExpeditionView key={`${fixture}|${activityId}|${minute}|${reader}`} reads={reads} activityId={activityId} fixture={fixture} startMinute={minute}
          revision={game.revision} world={game.world} worldFailed={!game.world && game.syncError !== null} owner={game.owner} />
          : <p role="status">Loading the expedition…</p>}
    </main>
    <footer className="game-footer">CLOUDIATOR <span>Expeditions show only revealed stages; watching never changes their result.</span></footer>
  </div>;
}

export default function ExpeditionPage() {
  return <Suspense fallback={<main id="main" className="loading" role="status" tabIndex={-1}>Loading the expedition…</main>}><ExpeditionShell /></Suspense>;
}
