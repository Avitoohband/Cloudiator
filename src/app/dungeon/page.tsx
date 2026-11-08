'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { createLiveGateway, type GameGateway } from '../../lib/api/gateway';
import { useGameState } from '../../features/character/useGameState';
import { expeditionQuery } from '../../features/character/expedition-query';
import { DungeonUnavailable, DungeonView } from '../../features/dungeon/DungeonView';

function DungeonShell() {
  const search = useSearchParams();
  const { requested, fixture, activityId, minute, play } = expeditionQuery(search, process.env.NEXT_PUBLIC_FIXTURE_ENABLED === 'true');
  const visitor = fixture && search.get('as') === 'visitor';
  const valid = activityId !== null;
  const [loaded, setLoaded] = useState<{ fixture: boolean; visitor: boolean; reads: GameGateway } | null>(null);

  useEffect(() => {
    if (!valid) return;
    let active = true;
    (async () => {
      const reads = process.env.NEXT_PUBLIC_FIXTURE_ENABLED === 'true' && fixture
        ? (await import('../../lib/api/fixture-gateway')).createFixtureGateway()
        : createLiveGateway();
      if (active) setLoaded({ fixture, visitor, reads });
    })().catch(() => { if (active) setLoaded({ fixture, visitor, reads: createLiveGateway() }); });
    return () => { active = false; };
  }, [fixture, visitor, valid]);

  const reads = valid && loaded?.fixture === fixture && loaded.visitor === visitor ? loaded.reads : null;
  const game = useGameState(reads, { fixture, previewAs: visitor ? 'visitor' : undefined });
  const recordPlay = useCallback((next: 'trip' | null) => {
    const url = new URL(window.location.href);
    if (next) url.searchParams.set('play', next); else url.searchParams.delete('play');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, []);
  return <div className="game-shell">
    <header className="topbar">
      <Link className="brand" href="/">CLOUDIATOR <span>CHRONICLES OF THE ARENA</span></Link>
      <Link className="back-link" href={fixture ? '/game/?mode=fixture' : '/game/'}>Back to camp</Link>
    </header>
    {fixture && <p className="fixture-banner" role="status">Fixture mode — sample dungeons from the local preview</p>}
    {requested && !fixture && <p className="notice" role="status">Fixture preview is unavailable in this build.</p>}
    <main id="main" className="replay-page" tabIndex={-1}>
      {!activityId ? <DungeonUnavailable />
        : reads && game.viewer !== 'loading' && game.session.status !== 'loading'
          ? <DungeonView key={`${fixture}|${activityId}|${minute}|${game.session.userId ?? 'visitor'}`} reads={reads} activityId={activityId}
              fixture={fixture} startMinute={minute} play={play} onPlay={recordPlay} revision={game.revision} world={game.world}
              owner={game.viewer === 'player' ? game.owner : null} />
          : <p role="status">Loading the dungeon…</p>}
    </main>
    <footer className="game-footer">CLOUDIATOR <span>Dungeon replays show recorded fights.</span></footer>
  </div>;
}

export default function DungeonPage() {
  return <Suspense fallback={<main id="main" className="loading" role="status" tabIndex={-1}>Loading the dungeon…</main>}><DungeonShell /></Suspense>;
}
