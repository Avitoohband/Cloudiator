'use client';

// The arrival banner (Patch A item 2, the approved mockup): an icon 📯, the eyebrow "NEW ARRIVAL", the sentence with the name in bold,
// a gold "Find {name}" button and × ("Dismiss"). The phone drops the icon into the eyebrow, shortens a single arrival's sentence and
// the button ("Find", still named "Find {name}"). It stays 15 s, the remaining time paused while the pointer is over it or the focus
// is inside it, then fades (no fade with reduced motion); × and Find close it at once, and a close always tells the owner
// (`onDismiss`) so the ids are remembered. Find is disabled, with the reason as its description, while the camp view cannot show
// the gladiator, and its label is cut short (never its name for assistive technology) so a 20-character name does not make a tall banner.
// The banner sits in its own slot (`ArrivalSlot`), a polite status that is always in the page so a banner that arrives is announced;
// the shell mounts the banner in it only while no scene covers the camp.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { ArrivalBanner } from './arrivals';
import styles from './arrivals.module.css';

/** How long a banner stays, not counting the time the pointer or the focus holds it. */
export const SHOW_MS = 15_000;
/** The fade at the end; the banner goes when it has run (or a little after it, where the browser ran no animation). */
export const FADE_MS = 400;
const WELCOME_LEAD = 'Welcome to the camp, ';

/**
 * The banner's place: a polite status, always present, with the banner inside it while there is one. `stacked` is the shell's
 * (`bannerPlace`): the slot is the first thing in the column of notices under the chip, not a row of its own across the top; the shell
 * puts it in the right parent, and the styling follows `data-stacked`.
 */
export function ArrivalSlot({ stacked, children }: { stacked: boolean; children?: ReactNode }) {
  return <div className={styles.slot} role="status" data-arrival-slot="" data-stacked={stacked ? 'true' : 'false'}>{children}</div>;
}

/** The sentence with the first name in bold (the newest arrival's, or the welcomed player's). */
function withBoldName(text: string, name: string, kind: ArrivalBanner['kind']): ReactNode {
  const at = kind === 'welcome' ? WELCOME_LEAD.length : 0;
  if (!text.startsWith(name, at)) return text;
  return <>{text.slice(0, at)}<b>{name}</b>{text.slice(at + name.length)}</>;
}

export function ArrivalBannerView({ banner, findReason, onFind, onDismiss }: {
  banner: ArrivalBanner;
  /** Why Find cannot take the camera to the gladiator now (the camp view is unavailable or still opening), or null. */
  findReason: string | null;
  onFind(): void;
  onDismiss(): void;
}) {
  const reasonId = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [fading, setFading] = useState(false);
  const paused = hovered || focused;
  /** The time the banner still has to stay, kept across pauses. */
  const remaining = useRef(SHOW_MS);
  const dismissRef = useRef(onDismiss);
  useEffect(() => { dismissRef.current = onDismiss; });

  // The countdown runs while nothing holds the banner; a hold keeps what was left.
  useEffect(() => {
    if (paused || fading) return;
    const startedAt = performance.now();
    const timer = window.setTimeout(() => {
      remaining.current = 0;
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) dismissRef.current();
      else setFading(true);
    }, remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (performance.now() - startedAt));
    };
  }, [paused, fading]);
  // The fade ends the banner (`onAnimationEnd`); this is the backstop for a browser that ran no animation.
  useEffect(() => {
    if (!fading) return;
    const timer = window.setTimeout(() => dismissRef.current(), FADE_MS + 300);
    return () => window.clearTimeout(timer);
  }, [fading]);

  const sentence = (text: string) => withBoldName(text, banner.findName, banner.kind);
  return (
    <div className={styles.banner} data-testid="arrival-banner" data-kind={banner.kind} data-fading={fading ? 'true' : undefined}
      // A mouse pauses it; a touch is not a hover (a tap would otherwise hold the banner until the next tap elsewhere).
      onPointerEnter={event => { if (event.pointerType === 'mouse') setHovered(true); }} onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}
      onAnimationEnd={event => { if (event.target === event.currentTarget && fading) dismissRef.current(); }}>
      <span className={styles.horn} aria-hidden="true">📯</span>
      <div className={styles.copy}>
        <p className={styles.eyebrow}><span className={styles.narrow} aria-hidden="true">📯 </span>NEW ARRIVAL</p>
        <p className={styles.text}>
          {banner.text === banner.narrowText ? sentence(banner.text) : <>
            <span className={styles.wide}>{sentence(banner.text)}</span>
            <span className={styles.narrow}>{sentence(banner.narrowText)}</span>
          </>}
        </p>
      </div>
      <button type="button" className={styles.find} disabled={findReason !== null} aria-describedby={findReason !== null ? reasonId : undefined}
        aria-label={`Find ${banner.findName}`} onClick={() => { onFind(); onDismiss(); }}>
        <span className={styles.wide}>Find {banner.findName}</span><span className={styles.narrow}>Find</span>
      </button>
      {findReason !== null && <span id={reasonId} className={styles.sr}>{findReason}</span>}
      <button type="button" className={styles.close} aria-label="Dismiss" onClick={onDismiss}>×</button>
    </div>
  );
}
