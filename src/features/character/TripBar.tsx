// The whole-trip replay's bar (Patch A Task 9, the approved mockup): ⏮ "Previous chapter", ▶/⏸ "Play"/"Pause", ⏭ "Next chapter",
// one button per chapter, the elapsed and total time, and "● Back to live" while the trip still runs. A thin wrapper over the
// generic ReplayBar (the controller's ruling, so the Arena-replays patch reuses the same bar); it keeps no state of its own. During
// a running trip (`catchUp`) the chapters from `allowed` on are locked ("Not yet: plays when it happens"), the total is "now", and
// ⏭ past the last allowed chapter goes back to live, so it is never disabled there.
import type { Ref } from 'react';
import { clockText, type TripPlan } from '../../game/trip-replay';
import { ReplayBar } from '../replay/ReplayBar';
import styles from './ExpeditionView.module.css';

export const LOCKED_TITLE = 'Not yet: plays when it happens';

export function TripBar({ plan, index, positionMs, allowed, catchUp, playing, playRef, onToggle, onPrevious, onNext, onChapter, onLive }: {
  plan: TripPlan;
  /** The chapter the replay is in. */
  index: number;
  positionMs: number;
  /** The first locked chapter (`firstLocked`): it and every chapter after it cannot be played yet. */
  allowed: number;
  /** The trip is still running: the replay may not pass now, and the bar offers the way back to live. */
  catchUp: boolean;
  playing: boolean;
  playRef?: Ref<HTMLButtonElement>;
  onToggle(): void;
  onPrevious(): void;
  onNext(): void;
  onChapter(index: number): void;
  onLive(): void;
}) {
  const last = Math.min(allowed, plan.chapters.length) - 1;
  return <div className={styles.tripBar}>
    <ReplayBar label="Replay controls"
      play={{ playing, onToggle, buttonRef: playRef }}
      previous={{ name: 'Previous chapter', disabled: index <= 0, onClick: onPrevious }}
      next={{ name: 'Next chapter', disabled: !catchUp && index >= last, onClick: onNext }}
      chapters={{
        items: plan.chapters.map((chapter, i) => (i >= allowed
          ? { id: chapter.id, label: chapter.label, disabled: true, title: LOCKED_TITLE } : { id: chapter.id, label: chapter.label })),
        current: index,
        onSelect: onChapter,
      }}
      time={<span data-testid="replay-time">{`${clockText(positionMs)} / ${catchUp ? 'now' : clockText(plan.totalMs)}`}</span>}
      tail={catchUp ? <button type="button" className={styles.backLive} onClick={onLive}>● Back to live</button> : undefined} />
  </div>;
}
