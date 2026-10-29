// One replay bar for the whole-trip replay (Patch A Task 9) and, later, the Arena bouts (docs/superpowers/plans/2026-10-29-arena-replays.md
// Task 1, whose signature this is). It only lays out what it is given: ⏮ ▶/⏸ ⏭ icon buttons named by their steps, the chapters
// as buttons with the current one marked, a track, the time and a tail. Desktop: one row `⏮ ▶ ⏭ track time tail`, with the
// chapters on a row below; without a track (the trip) the chapters take the track's place in the row, as the approved mockup
// draws the trip's bar; a bar too narrow for them takes them onto their own row, at their own widths, wrapping rather than cutting
// a label short. In the touch layout the chapters are hidden and one line names the current one ("3 / 8 · Fight 1"). A step that
// is not available is `aria-disabled` (it keeps the focus it may have, at the first or last chapter) and does nothing. It keeps no
// state and reads no clock.
import type { JSX, ReactNode, Ref } from 'react';
import styles from './ReplayBar.module.css';

export type BarStep = { name: string; shortcut?: string; disabled: boolean; onClick(): void };
export type BarChapters = {
  items: readonly { id: string; label: string; disabled?: boolean; title?: string }[];
  current: number;
  onSelect(index: number): void;
};

/** An icon button's name, its hover title (with its key, when it has one) and its key for assistive technology. */
const named = (name: string, shortcut?: string) => ({
  'aria-label': name, title: shortcut ? `${name} (${shortcut})` : name, ...(shortcut ? { 'aria-keyshortcuts': shortcut } : {}),
});

function StepButton({ step, icon }: { step: BarStep; icon: string }) {
  return <button type="button" className={styles.icon} {...named(step.name, step.shortcut)} aria-disabled={step.disabled ? true : undefined}
    onClick={() => { if (!step.disabled) step.onClick(); }}>
    <span aria-hidden="true">{icon}</span>
  </button>;
}

function Chapters({ chapters }: { chapters: BarChapters }) {
  return <ol className={styles.chapters} aria-label="Chapters">
    {chapters.items.map((item, index) => <li key={item.id}>
      <button type="button" aria-current={index === chapters.current ? 'step' : undefined}
        className={index === chapters.current ? styles.current : index < chapters.current ? styles.past : undefined}
        disabled={item.disabled} title={item.title ?? item.label} onClick={() => chapters.onSelect(index)}>{item.label}</button>
    </li>)}
  </ol>;
}

export function ReplayBar({ label, play, previous, next, chapters, track, time, tail }: {
  /** The group's accessible name. */
  label: string;
  play: { playing: boolean; onToggle(): void; shortcut?: string; buttonRef?: Ref<HTMLButtonElement> };
  /** Absent: not rendered. */
  previous?: BarStep;
  next?: BarStep;
  chapters?: BarChapters;
  /** A position control (a bout's range input); the trip has none. */
  track?: ReactNode;
  /** "0:07 / 0:23", "0:13 / now". */
  time: ReactNode;
  /** Whatever follows the time: a speed and ⚑ Result, or the trip's "● Back to live". */
  tail?: ReactNode;
}): JSX.Element {
  const current = chapters ? chapters.items[chapters.current] : undefined;
  const list = chapters ? <Chapters chapters={chapters} /> : null;
  return (
    <div role="group" aria-label={label} className={styles.bar} data-track={track ? '' : undefined}>
      {previous && <StepButton step={previous} icon="⏮" />}
      <button ref={play.buttonRef} type="button" className={`${styles.icon} ${styles.play}`} {...named(play.playing ? 'Pause' : 'Play', play.shortcut)} onClick={play.onToggle}>
        <span aria-hidden="true">{play.playing ? '⏸' : '▶'}</span>
      </button>
      {next && <StepButton step={next} icon="⏭" />}
      {chapters && current && <span className={styles.name}>{`${chapters.current + 1} / ${chapters.items.length} · ${current.label}`}</span>}
      {track ? <div className={styles.track}>{track}</div> : list}
      <span className={styles.time}>{time}</span>
      {tail !== undefined && tail !== null && <span className={styles.tail}>{tail}</span>}
      {track ? list : null}
    </div>
  );
}
