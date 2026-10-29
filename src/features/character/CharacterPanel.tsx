'use client';

// The "My gladiator" menu. A player sees a summary (name, class, level, league, stamina, wallets and the activity line
// from `activityStatus`) and the build planner; with a refresh that failed it keeps the last loaded summary and says so.
// Without a gladiator it holds the joining path (Task 13.6): a visitor is told everything is open to watch and offered
// "Sign in with Google to create your gladiator"; signed in without one, "Create your gladiator" reopens the creation
// dialog over the camp; and the session and owner-load states. Names render as React text.
import { useEffect, useId, useState, type ReactNode } from 'react';
import type { OwnerState } from '@contracts/reads';
import type { GameGateway } from '../../lib/api/gateway';
import type { SessionState } from '../../lib/api/session';
import type { DisplayClock } from '../../game/display-clock';
import { SignIn } from '../auth/SignIn';
import { BuildPanel } from '../build/BuildPanel';
import { slotTimeText } from '../schedule/slot-time';
import { activityStatus } from './activity-status';
import type { Viewer } from './useGameState';
import styles from './CharacterPanel.module.css';

const TICK_MS = 1000;
const title = (value: string) => value[0].toUpperCase() + value.slice(1);

/** The display clock's time, every second while the tab is visible and whenever the clock is held or moved. */
function useNow(clock: DisplayClock) {
  const [now, setNow] = useState(() => clock.now());
  useEffect(() => {
    const update = () => setNow(clock.now());
    const off = clock.subscribe(update);
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') update(); }, TICK_MS);
    return () => { off(); window.clearInterval(timer); };
  }, [clock]);
  return now;
}

function OwnerSummary({ owner, slotIndex, clock, fixture, stale, resting, onRetry }: {
  owner: OwnerState; slotIndex: number | null; clock: DisplayClock; fixture: boolean; stale: boolean; resting: boolean; onRetry(): void;
}) {
  const now = useNow(clock);
  const headingId = useId();
  const staminaId = useId();
  const activity = owner.currentActivity;
  const status = activityStatus(owner, slotIndex ?? 0, now, { resting });
  // The end is shown as every slot time is (Task 24.0b); one that cannot be shown (`slotTimeText` gives '') is left out.
  const ends = status.endsAtMs === null ? '' : slotTimeText(status.endsAtMs, now);
  return (
    <section className={styles.summary} aria-labelledby={headingId}>
      <p className="eyebrow">{fixture ? 'SAMPLE GLADIATOR' : 'YOUR GLADIATOR'}</p>
      <h2 id={headingId} className={styles.name}>{owner.name}</h2>
      <p className={styles.class}>{title(owner.currentBuild.classId)} · Level {owner.progression.level} · {title(owner.progression.league)} league</p>
      {stale && (
        <div className={styles.stale} role="status">
          <p>Your gladiator could not be refreshed. Showing the last loaded details.</p>
          <button type="button" onClick={onRetry}>Retry</button>
        </div>
      )}
      <div className={styles.activity}>
        <span className="eyebrow">{fixture ? 'SAMPLE ACTIVITY' : 'CURRENT ACTIVITY'}</span>
        {activity && <p>{activity.label}</p>}
        <p className={styles.status} role="status">{status.label}{ends ? ` · ends ${ends}` : ''}</p>
      </div>
      <label className={styles.stamina} htmlFor={staminaId}>Stamina <span>{owner.stamina.current} / {owner.stamina.maximum}</span></label>
      <progress id={staminaId} className={styles.bar} value={owner.stamina.current} max={owner.stamina.maximum} />
      <dl className={styles.wallets}><div><dt>Gold</dt><dd>{owner.wallets.money}</dd></div><div><dt>Renown</dt><dd>{owner.wallets.renown}</dd></div></dl>
    </section>
  );
}

export function CharacterPanel({ viewer, session, owner, ownerError, slotIndex, clock, gateway, fixture, previewAs, previewFailed, refreshOwner, onCreate,
  resting = false }: {
  viewer: Viewer;
  session: SessionState;
  owner: OwnerState | null;
  ownerError: 'unavailable' | null;
  slotIndex: number | null;
  clock: DisplayClock;
  /** The live gateway: build commands always go online. */
  gateway: GameGateway;
  fixture: boolean;
  previewAs?: 'visitor' | 'player';
  /** Fixture mode: the fixture gateway could not be loaded. */
  previewFailed: boolean;
  refreshOwner(): Promise<void>;
  /** Opens the "Create your gladiator" dialog over the camp (signed in without a gladiator). */
  onCreate(): void;
  /** The owner's own gladiator rests at home in the shared world (Task 23.9 fix round 1). */
  resting?: boolean;
}) {
  const retry = () => { void refreshOwner().catch(() => undefined); };
  if (owner) {
    return <>
      <OwnerSummary owner={owner} slotIndex={slotIndex} clock={clock} fixture={fixture} stale={ownerError !== null} resting={resting} onRetry={retry} />
      {fixture ? <p className="panel-notice">This preview cannot change the build.</p>
        : <BuildPanel key={owner.gladiatorId} owner={owner} gateway={gateway} refresh={refreshOwner} clock={clock} />}
    </>;
  }
  let joining: ReactNode;
  if (fixture) {
    joining = previewAs === 'visitor' ? <SignIn unavailable="This preview cannot sign in." />
      : <p role="status">{previewFailed || viewer === 'unavailable' ? 'The fixture preview could not be loaded.' : 'Loading local preview…'}</p>;
  } else if (session.status === 'loading') joining = <p role="status">Checking your session…</p>;
  else if (session.status !== 'signed-in') {
    joining = <SignIn unavailable={session.status === 'signed-out' ? null : 'Google sign-in is unavailable until the project is configured.'} />;
  } else if (ownerError) {
    // A failed read is never "no gladiator": it offers no creation.
    joining = <><p role="alert">Your character could not be loaded. Please retry before creating a gladiator.</p>
      <button type="button" className={styles.retry} onClick={retry}>Retry owner load</button></>;
  } else if (viewer === 'no-gladiator') {
    joining = <div className={styles.join}>
      <p>You’re signed in. Create your gladiator to join; the camp keeps running while you choose.</p>
      <button type="button" className={styles.create} onClick={onCreate}>Create your gladiator</button>
    </div>;
  } else joining = <p role="status">Loading your gladiator…</p>;
  return (
    <section className={styles.summary} aria-label="Your gladiator">
      <p className="eyebrow">YOUR GLADIATOR</p>
      <h2 className={styles.name}>A legend awaits</h2>
      <p className={styles.class}>One fighter. Your choices.</p>
      {joining}
    </section>
  );
}
