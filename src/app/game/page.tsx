'use client';

import { Suspense, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { CampShell, type SignInResult } from '../../features/shell/CampShell';
import { sceneOf } from '../../features/shell/scene-url';

/**
 * Reads the preview options from the URL: `?mode=fixture` (fixture-enabled builds only) and, with it, `?as=visitor`;
 * `?signin=cancelled|failed`, a Google sign-in that returned without completing (plan Decision 6); and
 * `?view=replay|expedition&activity=…`, a scene over the camp (plan Decision 4), which the shell opens and closes with
 * `history.pushState` and Back (the App Router keeps `useSearchParams` in step with them); and `?perf=1`, the opt-in
 * frame-rate overlay (plan Decision 2, Task 23.4).
 */
function GameRoute() {
  const search = useSearchParams();
  const requested = search.get('mode') === 'fixture';
  const fixture = requested && process.env.NEXT_PUBLIC_FIXTURE_ENABLED === 'true';
  // `?as=visitor` previews the visitor view, in fixture mode only.
  const previewAs = fixture && search.get('as') === 'visitor' ? 'visitor' : undefined;
  const signin = search.get('signin');
  const signInResult: SignInResult | null = signin === 'cancelled' || signin === 'failed' ? signin : null;
  const scene = useMemo(() => sceneOf(search), [search]);
  // `?perf=1` shows the frame-rate overlay (plan Decision 2), in every build; nothing samples frames without it.
  const perf = search.get('perf') === '1';
  return <CampShell fixture={fixture} previewAs={previewAs} fixtureRefused={requested && !fixture} signInResult={signInResult} scene={scene} perf={perf} />;
}

/** The full-screen camp. The site root renders this same page, so a shared link opens straight onto the camp. */
export default function GamePage() {
  return <Suspense fallback={<main id="main" className="loading" role="status" tabIndex={-1}>Opening the camp…</main>}><GameRoute /></Suspense>;
}
