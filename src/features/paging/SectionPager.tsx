'use client';

// Patch 1.9 Task 30: a panel that is a stack of different things (My gladiator, Inventory and shops) shows one named section at a
// time. Fix round 1 (I5), as the approved mockup draws it: there is one bottom bar at a time.
// - `SectionStrip`, under the panel's title, is the section navigation everywhere: the section's name, a circle per section (the same
//   circles as a list's), and "‹ Inventory" / "Shops ›" (named "Previous section: Inventory", "Next section: Shops"). It is the
//   `nav` named "Sections", owns ← and → (in the panel, never in a control that uses the arrows itself) and says the section after a
//   move ("Attributes and stats, section 3 of 5").
// - `SectionPager` is the optional bottom bar ("‹ Level and stamina · 3 of 5 · Worn equipment ›", the `nav` named "Section bar"). Render
//   it, in a `PanelFooter`, only in a section that has no paged list or grid of its own; in a section with one, the bottom bar is
//   that list's `Pager`.
// `index` is 0-based everywhere.
import { useEffect, useRef, useState } from 'react';
import { PageDots } from './PageDots';
import { usePageKeys } from './usePageKeys';
import styles from './paging.module.css';

export type Section = { id: string; name: string };

const neighbours = (sections: readonly Section[], index: number) => {
  const at = Math.min(Math.max(0, index), Math.max(0, sections.length - 1));
  return { at, prev: at > 0 ? sections[at - 1] : null, next: at < sections.length - 1 ? sections[at + 1] : null };
};

/** The section navigation under the panel's title. */
export function SectionStrip({ sections, index, onGo }: { sections: readonly Section[]; index: number; onGo(index: number): void }) {
  const nav = useRef<HTMLElement>(null);
  const count = sections.length;
  const { at, prev, next } = neighbours(sections, index);
  const [status, setStatus] = useState('');
  const last = useRef(at);
  useEffect(() => {
    if (at === last.current) return;
    last.current = at;
    setStatus(`${sections[at]?.name ?? ''}, section ${at + 1} of ${count}`);
  }, [at, count, sections]);
  const back = () => { if (prev) onGo(at - 1); };
  const forward = () => { if (next) onGo(at + 1); };
  usePageKeys(nav, { ArrowLeft: back, ArrowRight: forward }, count > 1);
  return (
    <nav ref={nav} className={styles.strip} aria-label="Sections" data-section-strip="">
      <b className={styles.stripName}>{sections[at]?.name}</b>
      {count > 1 && <>
        <button type="button" className={styles.stripMove} aria-label={prev ? `Previous section: ${prev.name}` : 'Previous section'} aria-disabled={!prev}
          onClick={back}>‹{prev ? ` ${prev.name}` : ''}</button>
        <PageDots count={count} current={at + 1} names={sections.map(section => section.name)} onGo={page => onGo(page - 1)} />
        <button type="button" className={styles.stripMove} aria-label={next ? `Next section: ${next.name}` : 'Next section'} aria-disabled={!next}
          onClick={forward}>{next ? `${next.name} ` : ''}›</button>
      </>}
      <p className={styles.sr} role="status">{status}</p>
    </nav>
  );
}

/** The bottom bar of a section with no paged list or grid of its own (put it in a `PanelFooter`). */
export function SectionPager({ sections, index, onGo }: { sections: readonly Section[]; index: number; onGo(index: number): void }) {
  const count = sections.length;
  const { at, prev, next } = neighbours(sections, index);
  if (count <= 1) return null;
  return (
    <nav className={`${styles.pager} ${styles.sectionBar}`} aria-label="Section bar" data-pager="">
      <button type="button" className={styles.back} aria-label={prev ? `Previous section: ${prev.name}` : 'Previous section'} aria-disabled={!prev}
        onClick={() => { if (prev) onGo(at - 1); }}>‹ {prev ? prev.name : 'Back'}</button>
      <div className={styles.where}><span className={styles.label}><b>{at + 1} of {count}</b></span></div>
      <button type="button" className={styles.next} aria-label={next ? `Next section: ${next.name}` : 'Next section'} aria-disabled={!next}
        onClick={() => { if (next) onGo(at + 1); }}>{next ? next.name : 'Next'} ›</button>
    </nav>
  );
}
