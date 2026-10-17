'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { CampShell, type SignInResult } from '../../features/shell/CampShell';

/**
 * Reads the preview options from the URL: `?mode=fixture` (fixture-enabled builds only) and, with it, `?as=visitor`;
 * and `?signin=cancelled|failed`, a Google sign-in that returned without completing (plan Decision 6).
 */
function GameRoute() {
  const search = useSearchParams();
  const requested = search.get('mode') === 'fixture';
  const fixture = requested && process.env.NEXT_PUBLIC_FIXTURE_ENABLED === 'true';
  // `?as=visitor` previews the visitor view, in fixture mode only.
  const previewAs = fixture && search.get('as') === 'visitor' ? 'visitor' : undefined;
  const signin = search.get('signin');
  const signInResult: SignInResult | null = signin === 'cancelled' || signin === 'failed' ? signin : null;
  return <CampShell fixture={fixture} previewAs={previewAs} fixtureRefused={requested && !fixture} signInResult={signInResult} />;
}

/** The full-screen camp. The site root renders this same page, so a shared link opens straight onto the camp. */
export default function GamePage() {
  return <Suspense fallback={<main id="main" className="loading" role="status">Opening the camp…</main>}><GameRoute /></Suspense>;
}
