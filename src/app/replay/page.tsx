'use client';

// Fixed replay page for the static export: /replay/?activity=<id>[&stage=<stage id>].
// It reads one revealed timeline and plays its battle log locally; it never sends commands.
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { createLiveGateway } from '../../lib/api/gateway';
import { loadReplayView, type ReplayView } from '../../game/replay';
import { BattleReplay } from '../../features/arena/BattleReplay';

function ReplayShell() {
  const search = useSearchParams();
  const requested = search.get('mode') === 'fixture';
  const fixture = requested && process.env.NEXT_PUBLIC_FIXTURE_ENABLED === 'true';
  const activityId = search.get('activity');
  const stageId = search.get('stage');
  const [loaded, setLoaded] = useState<{ key: string; view: ReplayView } | null>(null);
  const key = `${fixture}|${activityId}|${stageId}`;

  useEffect(() => {
    let active = true;
    (async () => {
      if (!activityId) return { kind: 'unavailable', reason: 'not-found' } as const;
      // The fixture gateway is only reachable when the build enables fixtures, so production exports drop it.
      const gateway = process.env.NEXT_PUBLIC_FIXTURE_ENABLED === 'true' && fixture
        ? (await import('../../lib/api/fixture-gateway')).createFixtureGateway()
        : createLiveGateway();
      return loadReplayView(gateway, activityId, stageId);
    })()
      .catch((): ReplayView => ({ kind: 'unavailable', reason: 'unavailable' }))
      .then(view => { if (active) setLoaded({ key, view }); });
    return () => { active = false; };
  }, [activityId, fixture, key, stageId]);

  const view = loaded?.key === key ? loaded.view : null;
  return <div className="game-shell">
    <header className="topbar">
      <Link className="brand" href="/">CLOUDIATOR <span>CHRONICLES OF THE ARENA</span></Link>
      <Link className="back-link" href={fixture ? '/game/?mode=fixture' : '/game/'}>Back to camp</Link>
    </header>
    {fixture && <p className="fixture-banner" role="status">Fixture mode — sample replays from the local preview</p>}
    {requested && !fixture && <p className="notice" role="status">Fixture preview is unavailable in this build.</p>}
    <main id="main" className="replay-page">
      {view ? <BattleReplay key={key} view={view} /> : <p role="status">Loading the replay…</p>}
    </main>
    <footer className="game-footer">CLOUDIATOR <span>Replays show the recorded fight; they never change its result.</span></footer>
  </div>;
}

export default function ReplayPage() {
  return <Suspense fallback={<main id="main" className="loading" role="status">Loading the replay…</main>}><ReplayShell /></Suspense>;
}
