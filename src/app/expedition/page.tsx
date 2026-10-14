'use client';

// Fixed expedition page for the static export: /expedition/?activity=<id>. It follows one expedition's
// revealed timeline and only reads (timeline, world, owner); it never sends commands. Fixture mode
// (?mode=fixture in a fixture-enabled build) may add &minute=<0..90> to open the sample at that minute.
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { createLiveGateway } from '../../lib/api/gateway';
import { ExpeditionView, ExpeditionUnavailable, type ExpeditionReads } from '../../features/character/ExpeditionView';
import { expeditionQuery } from '../../features/character/expedition-query';

function ExpeditionShell() {
  const search = useSearchParams();
  const { requested, fixture, activityId, minute } = expeditionQuery(search, process.env.NEXT_PUBLIC_FIXTURE_ENABLED === 'true');
  const [loaded, setLoaded] = useState<{ fixture: boolean; reads: ExpeditionReads } | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      // The fixture gateway is only reachable when the build enables fixtures, so production exports drop it.
      const reads: ExpeditionReads = process.env.NEXT_PUBLIC_FIXTURE_ENABLED === 'true' && fixture
        ? (await import('../../lib/api/fixture-gateway')).createFixtureGateway()
        : createLiveGateway();
      if (active) setLoaded({ fixture, reads });
    })().catch(() => { if (active) setLoaded({ fixture, reads: createLiveGateway() }); });
    return () => { active = false; };
  }, [fixture]);

  const reads = loaded?.fixture === fixture ? loaded.reads : null;
  return <div className="game-shell">
    <header className="topbar">
      <Link className="brand" href="/">CLOUDIATOR <span>CHRONICLES OF THE ARENA</span></Link>
      <Link className="back-link" href={fixture ? '/game/?mode=fixture' : '/game/'}>Back to camp</Link>
    </header>
    {fixture && <p className="fixture-banner" role="status">Fixture mode — sample expeditions from the local preview</p>}
    {requested && !fixture && <p className="notice" role="status">Fixture preview is unavailable in this build.</p>}
    <main id="main" className="replay-page">
      {!activityId ? <ExpeditionUnavailable fixture={fixture} reason="not-found" />
        : reads ? <ExpeditionView key={`${fixture}|${activityId}|${minute}`} reads={reads} activityId={activityId} fixture={fixture} startMinute={minute} />
          : <p role="status">Loading the expedition…</p>}
    </main>
    <footer className="game-footer">CLOUDIATOR <span>Expeditions show only revealed stages; watching never changes their result.</span></footer>
  </div>;
}

export default function ExpeditionPage() {
  return <Suspense fallback={<main id="main" className="loading" role="status">Loading the expedition…</main>}><ExpeditionShell /></Suspense>;
}
