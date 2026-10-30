'use client';

// One row of My bouts (Arena replays spec 1, the approved mockup's rows): the W or L badge, the gold dot while the bout's replay is kept
// and not watched on this device, the opponent and its tag, the sub-line (a phone's leaves out a leading "Arena" or "Tournament"), and
// ▶ Watch, or Result for a bout whose replay is gone (the row then dimmed). Every word is `boutRow`'s, rendered as text.
import type { BoutRowText } from './bout-text';
import styles from './bouts.module.css';

const SEP = ' · ';

/** A sub-line with its rating part coloured (up green, down red, as the mockup); the text is the sub-line's, unchanged. */
function Sub({ text, which }: { text: string; which: 'wide' | 'narrow' }) {
  const parts = text.split(SEP);
  return <span className={which === 'wide' ? styles.subWide : styles.subNarrow} data-sub={which}>
    {parts.map((part, i) => <span key={i}>
      {i > 0 && SEP}
      <span className={part.startsWith('Rating +') ? `${styles.part} ${styles.up}` : part.startsWith('Rating −') ? `${styles.part} ${styles.down}` : styles.part}>{part}</span>
    </span>)}
  </span>;
}

export function BoutRow({ text, watched, onOpen }: { text: BoutRowText; watched: boolean; onOpen(): void }) {
  const fresh = text.kept && !watched;
  return (
    <li className={text.kept ? styles.row : `${styles.row} ${styles.gone}`} data-bout-row={text.name} data-gone={text.kept ? undefined : ''}>
      {text.badge ? <span className={`${styles.badge} ${text.badge.letter === 'W' ? styles.won : styles.lost}`}>
        <span aria-hidden="true">{text.badge.letter}</span><span className={styles.sr}>{text.badge.name}</span>
      </span> : <span className={styles.badge} aria-hidden="true" />}
      <span className={styles.who}>
        <span className={styles.name}>
          {fresh && <><span className={styles.dot} data-unwatched-dot aria-hidden="true" /><span className={styles.sr}>Not watched yet: </span></>}
          <span data-bout-name>{text.name}</span>
          {text.tag && <span className={styles.tag}>{text.tag}</span>}
        </span>
        <Sub text={text.sub.wide} which="wide" />
        <Sub text={text.sub.narrow} which="narrow" />
      </span>
      {text.action && <button type="button" className={text.kept ? styles.watch : styles.result} aria-label={text.label} onClick={onOpen}>{text.action}</button>}
    </li>
  );
}
