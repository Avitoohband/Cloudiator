'use client';

import { useCallback, useEffect, useState } from 'react';
import type { SessionState } from '../../lib/api/session';
import { promoSourceForPath, rememberPromoSource, type PromoSource } from './source';

const DISMISSED_KEY = 'cloudiator.promo.dismissed.v1';

export function showPromoWelcome({ source, confirmedVisitor, dismissed, blocked }: {
  source: PromoSource | null;
  confirmedVisitor: boolean;
  dismissed: boolean;
  blocked: boolean;
}) {
  return source !== null && confirmedVisitor && !dismissed && !blocked;
}

export function usePromoWelcome(routeSource: PromoSource | null, session: SessionState, blocked: boolean, openedSurface: boolean) {
  const [entry, setEntry] = useState<PromoSource | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [hasSignedIn, setHasSignedIn] = useState(false);
  const confirmedVisitor = session.status === 'signed-out' && session.confirmedSignedOut !== false && !hasSignedIn;
  const source = entry === routeSource ? entry : null;

  useEffect(() => {
    if (session.status === 'signed-in') setHasSignedIn(true);
  }, [session.status]);

  useEffect(() => {
    if (!routeSource || !confirmedVisitor || promoSourceForPath(window.location.pathname) !== routeSource) return;
    rememberPromoSource(routeSource);
    try {
      if (window.sessionStorage.getItem(DISMISSED_KEY) === '1') setDismissed(true);
    } catch { /* Dismissal still works for the current document. */ }
    setEntry(routeSource);
  }, [routeSource, confirmedVisitor]);

  const dismiss = useCallback(() => {
    if (!routeSource || promoSourceForPath(window.location.pathname) !== routeSource) return;
    setDismissed(true);
    try { window.sessionStorage.setItem(DISMISSED_KEY, '1'); }
    catch { /* Keep the document's dismissal even when storage is blocked. */ }
  }, [routeSource]);

  useEffect(() => {
    if (source && confirmedVisitor && openedSurface) dismiss();
  }, [source, confirmedVisitor, openedSurface, dismiss]);

  return { visible: showPromoWelcome({ source, confirmedVisitor, dismissed, blocked }), dismiss };
}
