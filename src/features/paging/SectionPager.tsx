'use client';

// Patch 1.9 Task 30: a panel that is a stack of different things (My gladiator, Inventory and shops) shows one named section at a
// time. The bar reads "‹ Level and stamina · 3 of 5 · Worn equipment ›" with the circles; ← and → move too (in the panel, not in a
// field). `SectionStrip` goes under the title: the section's name and quiet dots. `index` is 0-based.
import { useEffect, useRef, useState } from 'react';
import { PageDots } from './PageDots';
import { usePageKeys } from './usePageKeys';
import styles from './paging.module.css';

export type Section = { id: string; name: string };

export function SectionPager({ sections, index, onGo }: { sections: readonly Section[]; index: number; onGo(index: number): void }) {
  const nav = useRef<HTMLElement>(null);
  const count = sections.length;
  const at = Math.min(Math.max(0, index), Math.max(0, count - 1));
  const prev = at > 0 ? sections[at - 1] : null, next = at < count - 1 ? sections[at + 1] : null;
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
  if (count <= 1) return null;
  return (
    <nav ref={nav} className={styles.pager} aria-label="Sections" data-pager="">
      <button type="button" className={styles.back} aria-label={prev ? `Previous section: ${prev.name}` : 'Previous section'} aria-disabled={!prev} onClick={back}>
        ‹ {prev ? prev.name : 'Back'}
      </button>
      <div className={styles.where}><span className={styles.label}><b>{at + 1} of {count}</b></span></div>
      <PageDots count={count} current={at + 1} names={sections.map(section => section.name)} onGo={page => onGo(page - 1)} />
      <button type="button" className={styles.next} aria-label={next ? `Next section: ${next.name}` : 'Next section'} aria-disabled={!next} onClick={forward}>
        {next ? next.name : 'Next'} ›
      </button>
      <p className={styles.sr} role="status">{status}</p>
    </nav>
  );
}

/** Under the panel's title: the section's name and a quiet marker of where it is (the bar's circles are the ones to press). */
export function SectionStrip({ sections, index }: { sections: readonly Section[]; index: number }) {
  return (
    <div className={styles.strip} data-section-strip="">
      <b>{sections[index]?.name}</b>
      <span className={styles.stripDots} aria-hidden="true">{sections.map((section, i) => <i key={section.id} data-on={i === index ? '' : undefined} />)}</span>
    </div>
  );
}
