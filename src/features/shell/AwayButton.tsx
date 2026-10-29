'use client';

// The away button on the camp (Patch A item 3, the approved mockup): while the player's gladiator is away, a glass pill at the bottom of
// the camp (beside ☰ on a phone) says where it is, how far the trip is and what is next, with a gold action that opens the live view;
// once it is back, the same pill offers the whole trip with the owner's own result and a × that closes it for that trip. The words, the
// scene it opens and the progress are `away-trip.ts`'s; this draws them. The main control is one button holding all of the text, so a
// screen reader reads it as one sentence and the pill is one target; the × is a second button beside it (a button cannot hold a button).
// Both are hidden while a menu sheet or the touch icon row covers the bottom (CSS, `data-sheet`, `data-rail`), and the shell does not
// mount the pill while a scene covers the camp. The icon is the state's: a new state names its own (the record is exhaustive).
import { useSyncExternalStore } from 'react';
import { COMPACT_QUERY } from './rail-reveal';
import { awayProgress, awayScene, awayText, type AwayState } from './away-trip';
import type { SceneView } from './scene-url';
import styles from './shell.module.css';

const ICON: Record<AwayState['kind'], string> = { running: '🧭', back: '🏕' };

const subscribeCompact = (onChange: () => void) => {
  const query = window.matchMedia?.(COMPACT_QUERY);
  query?.addEventListener('change', onChange);
  return () => query?.removeEventListener('change', onChange);
};
const readCompact = () => window.matchMedia?.(COMPACT_QUERY).matches ?? false;

export function AwayButton({ state, onOpen, onClose }: {
  state: AwayState;
  /** The pill's action: the scene it opens over the camp. */
  onOpen(view: SceneView): void;
  /** The × of a trip that is over: closes the button for that activity. */
  onClose(activityId: string): void;
}) {
  // The phone's shorter words follow the shell's touch layout; the first render assumes a pointer window.
  const compact = useSyncExternalStore(subscribeCompact, readCompact, () => false);
  const text = awayText(state, compact);
  const progress = awayProgress(state);
  // The action's glyph ("●", "▶") is drawn, not read.
  const [glyph, ...label] = text.action.split(' ');
  // A trip that is over can be closed; any later state that is not running (a bout, patch 1.5) is closable the same way.
  const closable = state.kind !== 'running';
  return (
    <div className={styles.away} role="group" aria-label="Your expedition" data-testid="away-button" data-state={state.kind}>
      <button type="button" className={styles.awayMain} data-away-main="" onClick={() => onOpen(awayScene(state))}>
        {!compact && <span className={styles.awayIcon} aria-hidden="true">{ICON[state.kind]}</span>}
        <span className={styles.awayText}>
          <span className={styles.awayTitle}><b>{text.name}</b>{text.title}</span>
          <span className={styles.awaySub}>{text.sub}</span>
          {progress !== null && <span className={styles.awayMeter} aria-hidden="true"><i style={{ width: `${Math.round(progress * 1000) / 10}%` }} /></span>}
        </span>
        <span className={styles.awayGo}><span aria-hidden="true">{glyph} </span>{label.join(' ')}</span>
      </button>
      {closable && <button type="button" className={styles.awayClose} aria-label="Dismiss" onClick={() => onClose(state.activityId)}>×</button>}
    </div>
  );
}
