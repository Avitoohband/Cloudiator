'use client';

// The corner chip, top right. A player sees their name, stamina, money, renown and the time to the next slot boundary
// (on touch only the name and the countdown), and the chip opens a small menu with "Sign out". A visitor's chip starts
// Google sign-in: the "G" mark and "Sign in with Google to join" ("Sign in to join" on touch). Signed in without a
// gladiator, it offers "Create your gladiator" beside the account button (Task 13.6). Names render as React text.
import { useEffect, useId, useRef, useState } from 'react';
import type { OwnerState } from '@contracts/reads';
import { RULES_V1 } from '@domain/rules-v1';
import { signOut, type SessionState } from '../../lib/api/session';
import { GoogleMark, SIGN_IN_NOT_STARTED, useGoogleSignIn } from '../auth/SignIn';
import type { DisplayClock } from '../../game/display-clock';
import type { Viewer } from '../character/useGameState';
import type { MenuId } from './menus';
import styles from './shell.module.css';

const SLOT_MS = RULES_V1.clock.slotMs;
const TICK_MS = 1000;

/** Whole seconds to the next slot boundary of the display clock, ticking while the tab is visible. */
function useSlotCountdown(clock: DisplayClock) {
  const read = () => Math.ceil((SLOT_MS - (((clock.now() % SLOT_MS) + SLOT_MS) % SLOT_MS)) / 1000);
  const [seconds, setSeconds] = useState(read);
  useEffect(() => {
    const update = () => setSeconds(read());
    update();
    const off = clock.subscribe(update);
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') update(); }, TICK_MS);
    return () => { off(); window.clearInterval(timer); };
  }, [clock]);
  return seconds;
}

function Countdown({ clock }: { clock: DisplayClock }) {
  const seconds = useSlotCountdown(clock);
  const text = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return <span title="Next slot starts in">
    <span aria-hidden="true">⏱ </span><span data-testid="chip-countdown" aria-hidden="true">{text}</span>
    <span className={styles.sr}>Next slot in {Math.ceil(seconds / 60)} min</span>
  </span>;
}

export function CornerChip({ viewer, session, owner, fixture, previewAs, clock, onOpenMenu, onCreate }: {
  viewer: Viewer;
  session: SessionState;
  owner: OwnerState | null;
  fixture: boolean;
  previewAs?: 'visitor' | 'player';
  clock: DisplayClock;
  onOpenMenu(id: MenuId): void;
  /** Opens the "Create your gladiator" dialog (signed in without a gladiator). */
  onCreate(): void;
}) {
  const [open, setOpen] = useState(false);
  const [signOutError, setSignOutError] = useState(false);
  const google = useGoogleSignIn();
  const chip = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const signedIn = !fixture && session.status === 'signed-in';
  const account = viewer === 'player' || signedIn;

  // Escape (before the shell's own handler, which then leaves an open panel alone) and a press elsewhere close it. While
  // a modal dialog is open (the creation dialog can open over this menu), Escape is the dialog's (13.6 review I1).
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('dialog:modal')) return;
      event.preventDefault();
      setOpen(false);
      toggle.current?.focus();
    };
    const onPress = (event: PointerEvent) => { if (!chip.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPress, true);
    return () => { document.removeEventListener('keydown', onKey, true); document.removeEventListener('pointerdown', onPress, true); };
  }, [open]);
  useEffect(() => { if (!account) setOpen(false); }, [account]);

  if (!account) {
    const note = fixture ? (previewAs === 'visitor' ? null : viewer === 'unavailable' ? 'The fixture preview could not be loaded.' : 'Loading local preview…')
      : session.status === 'loading' ? 'Checking your session…' : null;
    // Where sign-in cannot start (the fixture preview, or a build without it configured), My gladiator says why.
    const live = !fixture && session.status === 'signed-out';
    return <div ref={chip} className={styles.chip} data-testid="corner-chip">
      {note ? <p className={styles.chipNote} role="status">{note}</p>
        : <button type="button" className={styles.join} disabled={google.busy} onClick={() => (live ? void google.begin() : onOpenMenu('gladiator'))}>
          <GoogleMark />
          {google.busy ? <span>Opening Google…</span>
            : <><span className={styles.wide}>Sign in with Google to join</span><span className={styles.narrow}>Sign in to join</span></>}
        </button>}
      {google.failed && <p className={styles.chipAlert} role="alert">{SIGN_IN_NOT_STARTED}</p>}
    </div>;
  }
  return (
    <div ref={chip} className={styles.chip} data-testid="corner-chip">
      <div className={styles.chipRow}>
        {viewer === 'no-gladiator' && <button type="button" className={styles.create} onClick={() => { setOpen(false); onCreate(); }}>Create your gladiator</button>}
        <button ref={toggle} type="button" className={styles.chipButton} aria-expanded={open} aria-controls={menuId} onClick={() => setOpen(value => !value)}>
          {owner ? <>
            <b data-testid="chip-name">{owner.name}</b>
            <span className={`${styles.wide} ${styles.chipSep}`} aria-hidden="true">|</span>
            <span className={styles.wide} data-testid="chip-stamina" title="Stamina"><span aria-hidden="true">⚡ </span><span className={styles.sr}>Stamina </span>{owner.stamina.current} / {owner.stamina.maximum}</span>
            <span className={styles.wide} data-testid="chip-money" title="Money"><span aria-hidden="true">💰 </span><span className={styles.sr}>Money </span>{owner.wallets.money}</span>
            <span className={styles.wide} data-testid="chip-renown" title="Renown"><span aria-hidden="true">★ </span><span className={styles.sr}>Renown </span>{owner.wallets.renown}</span>
            <span className={styles.chipSep} aria-hidden="true">|</span>
            <Countdown clock={clock} />
          </> : <span>Signed in</span>}
        </button>
      </div>
      {open && (
        <div id={menuId} className={styles.chipMenu} role="group" aria-label="Account">
          {signedIn ? <button type="button" onClick={() => {
            setSignOutError(false);
            void signOut().then(() => setOpen(false), () => setSignOutError(true));
          }}>Sign out</button> : <p>Local preview: no account is signed in.</p>}
          {signOutError && <p role="alert">Sign-out could not be completed. Please try again.</p>}
        </div>
      )}
    </div>
  );
}
