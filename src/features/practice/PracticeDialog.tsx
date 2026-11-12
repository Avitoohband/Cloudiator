'use client';

// The "⚔ Practice fight" dialog (Patch 1.9 Task 18; additions spec section 3, the approved mockup's `dialogHTML`): a modal over My gladiator
// where the player sets up a training dummy (a preset, its level and stance, its points and its shop gear) and sees it beside their own
// current build under the Arena's rules, then fights it. Nothing is sent or saved. The setup is the shell's (`usePractice`), so Change dummy
// reopens it as it was. Every edit goes through `practice-setup.ts`; a Custom dummy with more points than its level allows is said so, has no
// comparison, and ⚔ Fight is unavailable (aria-disabled: it keeps the focus, and a press does nothing; Review Focus 3). The focus starts on
// the title, Tab stays inside, and Escape, × and Cancel close it (the shell gives the focus back to ⚔ Practice fight). A phone (the shell's
// touch layout) shows a small preview under the presets, the comparison at the end, and the short footer.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import type { Stance } from '@contracts/commands';
import type { OwnerState } from '@contracts/reads';
import type { FighterSnapshot } from '@domain/types';
import { PREVIEW_ANCHOR, PREVIEW_FRAME_MS, actorLayers, frameId, layerStyle, nextFrame } from '../character/look-picker';
import { ATLAS_IMAGE, loadAtlas, type Atlas } from '../character/look-atlas';
import { useReducedMotion } from '../character/LookPreview';
import { COMPACT_QUERY } from '../shell/rail-reveal';
import {
  DUMMY_LOOK, DUMMY_NAME, PRACTICE_MAX_LEVEL, comparisonRows, dummyFighter, ownSide, twoHanded, type DummyPreset, type DummySetup, type DummySlot,
} from './practice';
import {
  ATTRIBUTE_ORDER, DUMMY_SLOTS, GEAR_CHOICES, PRESET_ORDER, SLOT_NAMES, STANCE_ORDER, changeLevel, dummySubline, fightable, footerText, gearLevels,
  overloadText, pointsHelp, pointsText, presetLabel, summaryLine, withGear, withGearLevel, withPoint, withPreset, withStance,
} from './practice-setup';
import styles from './practice.module.css';

const subscribeCompact = (onChange: () => void) => {
  const query = window.matchMedia?.(COMPACT_QUERY);
  query?.addEventListener('change', onChange);
  return () => query?.removeEventListener('change', onChange);
};
const readCompact = () => window.matchMedia?.(COMPACT_QUERY).matches ?? false;
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const TABBABLE = 'button, select, input, textarea, a[href], [tabindex]:not([tabindex="-1"])';
/** A fighter, or null where the rules refuse it (the dialog never shows a crash). */
const attempt = <T,>(make: () => T): T | null => { try { return make(); } catch { return null; } };

/** The dummy as the camp would draw it: the straw-and-cream look in its gear, idling (a still frame under reduced motion). Decorative. */
function DummyFigure({ silhouettes, scale }: { silhouettes: readonly string[]; scale: number }) {
  const [atlas, setAtlas] = useState<Atlas | null>(null);
  const [frame, setFrame] = useState(0);
  const reduced = useReducedMotion();
  useEffect(() => {
    let live = true;
    loadAtlas().then(table => { if (live) setAtlas(table); }, () => { /* The art did not load: the ground stays. */ });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    setFrame(0);
    if (reduced) return;
    const timer = setInterval(() => setFrame(current => nextFrame(current, false)), PREVIEW_FRAME_MS);
    return () => clearInterval(timer);
  }, [reduced]);
  const layers = useMemo(() => actorLayers(DUMMY_LOOK, 'practice-dummy', silhouettes), [silhouettes]);
  return <div className={styles.figure} data-testid="practice-figure" aria-hidden="true">
    <div className={styles.sprite} style={{ marginLeft: -PREVIEW_ANCHOR.x * scale, marginTop: -PREVIEW_ANCHOR.y * scale }}>
      {atlas && layers.map(layer => {
        const rect = atlas.frames[frameId(layer.id, frame)]?.frame;
        return rect ? <span key={layer.id} className={styles.layer} data-layer={layer.id} style={layerStyle(layer, rect, atlas.meta.size, ATLAS_IMAGE, scale)} /> : null;
      })}
    </div>
  </div>;
}

/** − value + with names ("Less strength", "More strength"); a step that cannot be taken is aria-disabled and does nothing. */
function Stepper({ less, more, value, testId, canLess, canMore, onLess, onMore }: {
  less: string; more: string; value: number; testId: string; canLess: boolean; canMore: boolean; onLess(): void; onMore(): void;
}) {
  return <span className={styles.stepper}>
    <button type="button" aria-label={less} aria-disabled={!canLess || undefined} onClick={() => { if (canLess) onLess(); }}>−</button>
    <output data-testid={testId}>{value}</output>
    <button type="button" aria-label={more} aria-disabled={!canMore || undefined} onClick={() => { if (canMore) onMore(); }}>+</button>
  </span>;
}

/** A labelled row of pressed-or-not buttons (the presets, the stances). */
function Pills<T extends string>({ label, options, current, name, onPick }: {
  label: string; options: readonly T[]; current: T; name(option: T): string; onPick(option: T): void;
}) {
  const id = useId();
  return <div className={styles.field}>
    <span id={id} className={styles.label}>{label}</span>
    <div className={styles.pills} role="group" aria-labelledby={id}>
      {options.map(option => <button key={option} type="button" aria-pressed={option === current} onClick={() => onPick(option)}>{name(option)}</button>)}
    </div>
  </div>;
}

/** The comparison table, "Arena rules | You | Dummy" (Task 17's rows), or why there is none. */
function Comparison({ rows, over }: { rows: ReturnType<typeof comparisonRows> | null; over: string | null }) {
  if (!rows) return <p className={styles.bad}>{over ?? 'This dummy cannot fight.'}</p>;
  return <table className={styles.table}>
    <caption className={styles.sr}>You vs the dummy under Arena rules</caption>
    <thead><tr><th scope="col">Arena rules</th><th scope="col">You</th><th scope="col">Dummy</th></tr></thead>
    <tbody>{rows.map(([label, you, dummy]) => <tr key={label}><th scope="row">{label}</th><td>{you}</td><td>{dummy}</td></tr>)}</tbody>
  </table>;
}

export function PracticeDialog({ owner, setup, onChange, onFight, onClose }: {
  owner: OwnerState;
  /** The dummy as set up; the shell keeps it between openings. */
  setup: DummySetup;
  onChange(setup: DummySetup): void;
  /** ⚔ Fight: only called while the dummy can fight. */
  onFight(): void;
  /** ×, Cancel, Escape or the browser closing the dialog. */
  onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId(), introId = useId(), levelId = useId(), attributesId = useId(), gearId = useId();
  const compact = useSyncExternalStore(subscribeCompact, readCompact, () => false);
  const closeRef = useRef(onClose);
  useLayoutEffect(() => { closeRef.current = onClose; });

  // Modal over the camp and My gladiator; the title takes the focus so a long dialog (a phone) opens at its top. Unmounted, it closes.
  useLayoutEffect(() => {
    const element = dialog.current!;
    if (!element.open) element.showModal();
    heading.current?.focus({ preventScroll: true });
    return () => { if (element.open) element.close(); };
  }, []);

  const you = useMemo(() => attempt(() => ownSide(owner).snapshot), [owner]);
  const points = pointsText(setup);
  const ready = fightable(setup);
  const dummy: FighterSnapshot | null = useMemo(() => (ready ? attempt(() => dummyFighter(setup)) : null), [ready, setup]);
  const rows = useMemo(() => (you && dummy ? comparisonRows(you, dummy) : null), [you, dummy]);
  const overload = useMemo(() => (ready ? attempt(() => overloadText(setup)) : null), [ready, setup]);
  const canFight = rows !== null;
  const both = twoHanded(setup);
  // The figure wears the gear whatever the points (a Custom dummy over its points still has its gear on).
  const silhouettes = useMemo(() => attempt(() => dummyFighter({ ...setup, allocations: { strength: 0, agility: 0, vitality: 0, endurance: 0, precision: 0 } }).equipmentSilhouettes) ?? [],
    [setup]);

  // Tab and Shift+Tab stay inside: from the last control to the first (×) and back.
  const trap = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== 'Tab' || !dialog.current) return;
    const controls = [...dialog.current.querySelectorAll<HTMLElement>(TABBABLE)].filter(el => !el.matches(':disabled') && el.getClientRects().length > 0);
    if (!controls.length) return;
    const first = controls[0], last = controls[controls.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === heading.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
  };

  const presets = <Pills<DummyPreset> label="Dummy" options={PRESET_ORDER} current={setup.preset} name={presetLabel} onPick={preset => onChange(withPreset(setup, preset))} />;
  const who = <>
    <h3 className={styles.who}>{DUMMY_NAME}</h3>
    <p className={styles.sub}>{dummySubline(setup)}</p>
  </>;
  const levelAndStance = <>
    <div className={styles.two}>
      <div className={styles.field}>
        <span id={levelId} className={styles.label}>Level</span>
        <div role="group" aria-labelledby={levelId}>
          <Stepper less="Lower level" more="Higher level" value={setup.level} testId="practice-level" canLess={setup.level > 1} canMore={setup.level < PRACTICE_MAX_LEVEL}
            onLess={() => onChange(changeLevel(setup, setup.level - 1))} onMore={() => onChange(changeLevel(setup, setup.level + 1))} />
        </div>
      </div>
      <Pills<Stance> label="Stance" options={STANCE_ORDER} current={setup.stance} name={capital} onPick={stance => onChange(withStance(setup, stance))} />
    </div>
    <p className={styles.help}>{pointsHelp(setup.level)}</p>
  </>;
  const attributes = <div className={styles.field}>
    <span id={attributesId} className={styles.label}>Attributes</span>
    <div className={styles.attributes} role="group" aria-labelledby={attributesId}>
      {ATTRIBUTE_ORDER.map(key => <div key={key} className={styles.attribute}>
        <span>{capital(key)}</span>
        <Stepper less={`Less ${key}`} more={`More ${key}`} value={setup.allocations[key]} testId={`practice-${key}`} canLess={setup.allocations[key] > 0} canMore
          onLess={() => onChange(withPoint(setup, key, -1))} onMore={() => onChange(withPoint(setup, key, 1))} />
      </div>)}
    </div>
    <p className={`${styles.points} ${points.over ? styles.bad : ''}`} data-testid="practice-points" aria-live="polite">{points.text}</p>
  </div>;
  const select = (slot: DummySlot) => {
    const off = slot === 'offHand' && both;
    return <div key={slot} className={styles.slot}>
      <label htmlFor={`${gearId}-${slot}`}>{SLOT_NAMES[slot]}</label>
      <select id={`${gearId}-${slot}`} disabled={off} value={off ? '' : setup.gear[slot] ?? ''} onChange={event => onChange(withGear(setup, slot, event.currentTarget.value || null))}>
        <option value="">{off ? 'Two-handed weapon' : 'None'}</option>
        {!off && GEAR_CHOICES[slot].map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
      </select>
    </div>;
  };
  const gear = <div className={styles.field}>
    <span id={`${gearId}-label`} className={styles.label}>Gear</span>
    <div className={styles.gear} role="group" aria-labelledby={`${gearId}-label`}>
      {DUMMY_SLOTS.map(select)}
      <div className={styles.slot}>
        <label htmlFor={`${gearId}-level`}>Gear level</label>
        <select id={`${gearId}-level`} value={String(setup.gearLevel)} onChange={event => onChange(withGearLevel(setup, Number(event.currentTarget.value) as 1 | 5 | 10))}>
          {gearLevels(setup.level).map(tier => <option key={tier} value={tier}>Level {tier}</option>)}
        </select>
      </div>
    </div>
  </div>;
  const overloadLine = overload && <p className={styles.bad} data-testid="practice-overload">{overload}</p>;
  const table = <><Comparison rows={rows} over={points.over ? points.text : null} />{overloadLine}</>;

  let body: ReactNode;
  if (compact) {
    body = <>
      {presets}
      <div className={`${styles.preview} ${styles.mini}`} data-testid="practice-preview">
        <DummyFigure silhouettes={silhouettes} scale={2} />
        <div>{who}<p className={styles.sub}>{rows ? summaryLine(rows) : points.over ? points.text : ''}</p></div>
      </div>
      {levelAndStance}{attributes}{gear}
      <div className={styles.field}>
        <span className={styles.label}>You vs the dummy</span>
        <div className={styles.preview}>{table}</div>
      </div>
    </>;
  } else {
    body = <div className={styles.columns}>
      <div>{presets}{levelAndStance}{attributes}{gear}</div>
      <div className={styles.side}>
        <div className={styles.preview} data-testid="practice-preview">
          <DummyFigure silhouettes={silhouettes} scale={3} />
          {who}{table}
        </div>
      </div>
    </div>;
  }

  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId} aria-describedby={introId} onKeyDown={trap}
    onCancel={event => { event.preventDefault(); closeRef.current(); }}
    // Should the browser close it anyway, follow that. The close event comes a task later, so one from React's development remount (its
    // cleanup closes the dialog, then it opens again) finds the dialog open and is ignored.
    onClose={() => { if (!dialog.current?.open) closeRef.current(); }}>
    <header className={styles.head}>
      <h2 id={titleId} ref={heading} tabIndex={-1}><span aria-hidden="true">⚔</span> Practice fight</h2>
      <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>×</button>
    </header>
    <p id={introId} className={styles.intro}>
      Test your build against a training dummy you set up. <b>Free:</b> no stamina, no schedule slot, no rating. <b>Nothing is saved.</b>
    </p>
    <div className={styles.body} data-practice-body="">{body}</div>
    <footer className={styles.foot} data-testid="practice-footer">
      <p>{footerText(owner, compact)}</p>
      <button type="button" onClick={onClose}>Cancel</button>
      <button type="button" className={styles.gold} aria-disabled={!canFight || undefined} onClick={() => { if (canFight) onFight(); }}>
        <span aria-hidden="true">⚔</span> Fight
      </button>
    </footer>
  </dialog>;
}
