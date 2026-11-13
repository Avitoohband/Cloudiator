// Patch 1.9 Task 23c (Avi, 2026-11-12: "compare stats with my gladiator and other gladiators in the camp"; approved mockup
// `.superpowers/design/2026-11-12-compare-stats/`): the profile card's comparison block, which stands in for the card's Attributes, Stats, Gear
// and Record while "⇄ Compare with mine" is on. One table of Stat | You | <Name> and one of the attributes; the marks are on your cell only.
// Pure display of `compareStats`: nothing is read or sent.
import type { Comparison, CompareMark } from './profile-card';
import styles from './ProfileCard.module.css';

const TONE = { better: styles.markUp, worse: styles.markDown, same: styles.markSame, neutral: styles.markSame } as const;

/** A mark: the arrow, sign and number are for the eye, the sentence ("better by 12") for a screen reader; colour is never the only signal. */
function Mark({ mark }: { mark: CompareMark | null }) {
  if (!mark) return null;
  return <span className={`${styles.mark} ${TONE[mark.tone]}`} data-mark={mark.tone}>
    <span aria-hidden="true">{mark.text}</span>{mark.label && <span className={styles.srOnly}>{`, ${mark.label}`}</span>}
  </span>;
}

export function CompareBlock({ comparison, name, onBack }: { comparison: Comparison; name: string; onBack(): void }) {
  const head = (who: string, stance: string) => <th scope="col">{who}<small>{stance} stance</small></th>;
  return <section className={styles.compare} aria-label="Comparison" data-testid="compare">
    <div className={styles.compareHead}>
      <p className="eyebrow">{`COMPARE · YOU AND ${name.toUpperCase()}`}</p>
      <button type="button" className={styles.back} data-compare-back="" onClick={onBack}>Back to their card</button>
    </div>
    <table className={styles.compareTable} data-testid="compare-stats">
      <thead><tr><th scope="col" className={styles.statHead}><span className={styles.srOnly}>Stat</span></th>{head('You', comparison.youStance)}{head(name, comparison.themStance)}</tr></thead>
      <tbody>{comparison.rows.map(row => <tr key={row.label}>
        <th scope="row">{row.label}</th>
        <td className={styles.you}>{row.you}<Mark mark={row.mark} />{row.youArena && <small className={styles.arenaCell} data-testid="arena-line">{row.youArena}</small>}</td>
        <td className={styles.them}>{row.them}{row.themArena && <small className={styles.arenaCell} data-testid="arena-line">{row.themArena}</small>}</td>
      </tr>)}</tbody>
    </table>
    {comparison.overloads.map(line => <p key={line} className={styles.overload}>{line}</p>)}
    <p className="eyebrow">{`ATTRIBUTES · ${comparison.youPoints} AND ${comparison.themPoints} POINTS`}</p>
    <table className={styles.compareTable} data-testid="compare-attributes">
      <thead><tr><th scope="col" className={styles.statHead}><span className={styles.srOnly}>Attribute</span></th>
        <th scope="col" className={styles.srOnly}>You</th><th scope="col" className={styles.srOnly}>{name}</th></tr></thead>
      <tbody>{comparison.attributes.map(row => <tr key={row.attribute}>
        <th scope="row">{row.label}</th>
        <td className={styles.you}>{row.you}<Mark mark={row.mark} /></td>
        <td className={styles.them}>{row.them}</td>
      </tr>)}</tbody>
    </table>
  </section>;
}
