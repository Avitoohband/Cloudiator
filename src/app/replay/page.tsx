'use client';

// Fixed replay page for the static export: /replay/?activity=<id>[&stage=<stage id>], a deep link (the camp opens the
// same replay as a scene over itself, Task 13.8). It reads one revealed timeline and plays its battle log locally; it
// never sends commands. The page mounts the shared game state for its display clock (Task 15 review Minor 2): only the
// battles that ended by the server's time are offered, so a fight in progress never shows its outcome. It polls only the
// revision and reads the owner once (Task 23.4, C6): no world, which it never shows.
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { createLiveGateway, type GameGateway } from '../../lib/api/gateway';
import { useGameState } from '../../features/character/useGameState';
import { ActivityReplay, BattleReplay } from '../../features/arena/BattleReplay';
import { isActivityId } from '../../features/character/expedition-query';

function ReplayShell() {
  const search = useSearchParams();
  const requested = search.get('mode') === 'fixture';
  const fixture = requested && process.env.NEXT_PUBLIC_FIXTURE_ENABLED === 'true';
  // A malformed activity id names no fight, as on the expedition page: it is not found, with nothing read (final review Minor 6).
  const requestedId = search.get('activity');
  const activityId = requestedId !== null && isActivityId(requestedId) ? requestedId : null;
  const stageId = search.get('stage');
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
  // Without a well-formed activity there is nothing to show, so nothing is read or polled. The page needs only the
  // server's time and the viewer's gladiator: the revision is polled, never the world, and the owner is read once (C6).
  const game = useGameState(activityId ? reads : null, { fixture, clockOnly: true });
  // The display clock has a server time once the shared sync has read the world (or it never will: the device's clock).
  const clock = game.world || game.syncError ? game.clock : null;
  // The replay is the account's own read: once the session is known, a sign-out, expiry or account switch (here or in
  // another tab) remounts it as the new reader, so no owner's rewards outlive the session (final review Minor 1).
  const reader = game.session.userId ?? 'visitor';
  return <div className="game-shell">
    <header className="topbar">
      <Link className="brand" href="/">CLOUDIATOR <span>CHRONICLES OF THE ARENA</span></Link>
      <Link className="back-link" href={fixture ? '/game/?mode=fixture' : '/game/'}>Back to camp</Link>
    </header>
    {fixture && <p className="fixture-banner" role="status">Fixture mode — sample replays from the local preview</p>}
    {requested && !fixture && <p className="notice" role="status">Fixture preview is unavailable in this build.</p>}
    <main id="main" className="replay-page" tabIndex={-1}>
      {!activityId ? <BattleReplay view={{ kind: 'unavailable', reason: 'not-found' }} />
        : game.session.status === 'loading' ? <p role="status">Loading the replay…</p>
          : <ActivityReplay key={`${fixture}|${activityId}|${stageId}|${reader}`} reads={reads} activityId={activityId} stageId={stageId} clock={clock}
            viewerId={game.owner?.gladiatorId ?? null} />}
    </main>
    <footer className="game-footer">CLOUDIATOR <span>Replays show the recorded fight; they never change its result.</span></footer>
  </div>;
}

export default function ReplayPage() {
  return <Suspense fallback={<main id="main" className="loading" role="status" tabIndex={-1}>Loading the replay…</main>}><ReplayShell /></Suspense>;
}
