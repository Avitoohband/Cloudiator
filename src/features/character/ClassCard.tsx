// The class card on My gladiator (Patch A item 4): what the class gives and the way it splits attribute points, between the class
// line and the activity box. The chips are also shown beside "Class: …" in Plan a build (`ClassChips`). On a phone (the touch
// layout) the bars give way to one line and the meaning is left out, to keep the sheet short; both forms are in the page and the
// layout picks one, as the Gladiators count does.
import { Fragment, useId } from 'react';
import type { ClassId } from '@contracts/commands';
import { CLASS_MEANING, bonusText, classBonuses, suggestedShares } from './class-bonus';
import styles from './CharacterPanel.module.css';

const title = (value: string) => value[0].toUpperCase() + value.slice(1);

/** The class's bonuses as chips ("Vitality +5%"). */
export function ClassChips({ classId }: { classId: ClassId }) {
  return <ul className={styles.chips}>
    {classBonuses(classId).map(bonus => <li key={bonus.attribute} className={styles.chip} data-testid="class-bonus">{bonusText(bonus)}</li>)}
  </ul>;
}

export function ClassCard({ classId }: { classId: ClassId }) {
  const headingId = useId();
  const shares = suggestedShares(classId);
  const biggest = Math.max(1, ...shares.map(share => share.points));
  const spent = shares.filter(share => share.points > 0);
  return (
    <section className={styles.classCard} aria-labelledby={headingId} data-testid="class-card">
      <p id={headingId} className={`eyebrow ${styles.cardEyebrow}`}>{classId.toUpperCase()} BONUSES</p>
      <ClassChips classId={classId} />
      <p className={`${styles.meaning} ${styles.splitWide}`}>{CLASS_MEANING[classId]}</p>
      <p className={`eyebrow ${styles.cardEyebrow} ${styles.splitEyebrow} ${styles.splitWide}`}>SUGGESTED SPLIT · OF EVERY 10 POINTS</p>
      <ul className={`${styles.shares} ${styles.splitWide}`}>
        {shares.map(share => <li key={share.attribute}>
          <span>{title(share.attribute)}</span>
          <span className={styles.bar} aria-hidden="true"><i style={{ width: `${(share.points / biggest) * 100}%` }} /></span>
          <span className={styles.points} data-testid="split-points">{share.points}</span>
        </li>)}
      </ul>
      <p className={`eyebrow ${styles.cardEyebrow} ${styles.splitEyebrow} ${styles.splitNarrow}`}>SUGGESTED SPLIT · OF EVERY 10</p>
      <p className={`${styles.splitLine} ${styles.splitNarrow}`}>
        {spent.map((share, index) => <Fragment key={share.attribute}>{index > 0 && ' · '}{title(share.attribute)} <b>{share.points}</b></Fragment>)}
      </p>
    </section>
  );
}
