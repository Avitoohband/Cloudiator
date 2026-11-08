// The named marks under the live view's 0-80 strip (Patch A Task 9, the approved mockup), in place of the minute labels: "Left camp
// · 12:20 AM", each fight, and "Back in camp · 1:40 AM" (`tripMarks`). A fought fight whose log is kept is a button into the
// whole-trip replay at that fight, when the view can show that replay (`onFight`); otherwise it is text. Each mark stands at its
// minute (0, 20, 40, 60, 80); a narrow screen lists them in rows instead.
import type { TripMark } from './trip-text';
import styles from './ExpeditionView.module.css';

export function TripMarks({ marks, fraction, onFight, dungeon = false }: {
  marks: readonly TripMark[];
  /** How far the trip is (0 to 1): the marks it has passed are drawn as passed. */
  fraction: number;
  dungeon?: boolean;
  /** Opens the whole-trip replay at a fight; absent when no replay can be shown here (the marks are then text only). */
  onFight?(fight: NonNullable<TripMark['fight']>): void;
}) {
  const last = Math.max(1, marks.length - 1);
  return <ol className={dungeon ? `${styles.marks} ${styles.dungeonMarks}` : styles.marks} aria-label="Trip marks">
    {marks.map((mark, i) => <li key={mark.id} style={{ left: `${(100 * i) / last}%` }} className={fraction >= i / last ? styles.passed : undefined}>
      {mark.replay && mark.fight && onFight ? <button type="button" className={styles.markButton} title={`Watch the whole trip from fight ${mark.fight}`}
        onClick={() => onFight(mark.fight!)}><span aria-hidden="true">▶ </span>{mark.text.replace(/^▶ /, '')}</button> : mark.text.replace(/^▶ /, '')}
    </li>)}
  </ol>;
}
