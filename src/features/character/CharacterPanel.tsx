'use client';

// The "My gladiator" menu. A player sees a summary (name, class, level, league, stamina, wallets and the activity line
// from `activityStatus`) and the build planner; with a refresh that failed it keeps the last loaded summary and says so.
// Patch 1.7: beside the name, the Title button (the worn title; it opens "Choose your title"), and under it the status after a wear.
// Without a gladiator it holds the joining path (Task 13.6): a visitor is told everything is open to watch and offered
// "Sign in with Google to create your gladiator"; signed in without one, "Create your gladiator" reopens the creation
// dialog over the camp; and the session and owner-load states. Names render as React text.
// Patch 1.9 Task 10: the XP bar under Stamina, the Attributes and Stats blocks, and help on their labels (and on Stamina and Load).
// Patch 1.9: Worn equipment's slots open the equip picker (`WornEquipment`); a phone's picker is a sheet over the panel body, and the
// summary and the build planner it covers are hidden meanwhile.
// Patch 1.9 Task 18: ⚔ Practice fight under Stats opens the shell's practice dialog (a fight against a training dummy; nothing is saved).
import { useEffect, useId, useState, type ReactNode } from 'react';
import type { OwnerState } from '@contracts/reads';
import { RULES_V2 } from '@domain/rules-v2';
import type { Rules } from '@domain/types';
import type { GameGateway } from '../../lib/api/gateway';
import type { SessionState } from '../../lib/api/session';
import type { DisplayClock } from '../../game/display-clock';
import { SignIn } from '../auth/SignIn';
import { BuildPanel } from '../build/BuildPanel';
import { useClockMode } from '../../lib/clock-setting';
import { RestGainText } from '../schedule/RestGainText';
import { restingGain, restingGainText } from '../schedule/rest-stamina';
import { slotTimeText } from '../schedule/slot-time';
import { TitleButton } from '../titles/TitlePicker';
import { activityStatus, settledActivity } from './activity-status';
import { ClassCard } from './ClassCard';
import { attributeHelp, attributeRows, cardStats, contextLines, ownBuild, pointsTotal, statHelp, statRows } from './profile-card';
import { useStatHints } from './stat-hints';
import { attributeNumbers, loadHelp, staminaHelp, statNumbers } from './stat-numbers';
import { xpView } from './xp-progress';
import { WornEquipment } from './WornEquipment';
import type { Viewer } from './useGameState';
import styles from './CharacterPanel.module.css';

const TICK_MS = 1000;
const title = (value: string) => value[0].toUpperCase() + value.slice(1);

/** The display clock's time, every second while the tab is visible and whenever the clock is held or moved. */
function useNow(clock: DisplayClock) {
  const [now, setNow] = useState(() => clock.now());
  useEffect(() => {
    const update = () => setNow(clock.now());
    const off = clock.subscribe(update);
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') update(); }, TICK_MS);
    return () => { off(); window.clearInterval(timer); };
  }, [clock]);
  return now;
}

/**
 * The owner's title on My gladiator (patch 1.7): the title shown as worn (the shell's, which a wear answer sets at once), the status line
 * after a wear ("You now wear Wanderer."), and what the Title button opens.
 */
export type TitleControls = { worn: string | null; status: string | null; onOpen(): void };

type Hints = ReturnType<typeof useStatHints>;

/**
 * The XP bar (Patch 1.9 Task 10): the level, the XP into it, what is left, the level's price, and the next expedition's XP as a ghost segment
 * after the fill (hatched blue, hatched gold where it reaches the end) with the line that says so. The XP is from the saved schedule and the
 * active rules; an expedition pays it only on a win, so the words say "up to".
 */
function XpBar({ owner, rules, nowMs, location }: { owner: OwnerState; rules: Rules; nowMs: number; location: string | null }) {
  const hintId = useId();
  const view = xpView(owner, rules, nowMs, location);
  const percent = (fraction: number) => `${Math.round(fraction * 10000) / 100}%`;
  return (
    <div className={styles.xp} data-testid="xp-block">
      <div className={styles.xpLabel}><span>{view.levelText}</span><span>{view.valueText}</span></div>
      <div className={styles.xpBar} role="progressbar" aria-label="Experience" aria-valuemin={0} aria-valuenow={view.max ? 1 : view.xp} aria-valuemax={view.max ? 1 : view.need}
        aria-valuetext={view.valueText} aria-describedby={view.hint ? hintId : undefined}>
        <i className={styles.xpFill} data-testid="xp-fill" style={{ width: percent(view.fill) }} />
        {view.ghost > 0 && <i className={`${styles.xpGhost} ${view.crosses ? styles.xpGhostUp : ''}`} data-testid="xp-ghost" data-crosses={view.crosses || undefined} style={{ width: percent(view.ghost) }} />}
      </div>
      {!view.max && <p className={styles.xpSub}><span><strong>{view.leftText}</strong> to {view.nextLevelText}</span><span>{view.ruleText}</span></p>}
      {view.hint && <p id={hintId} className={`${styles.xpHint} ${view.crosses ? styles.xpHintUp : ''}`} data-testid="xp-hint"><span className={styles.xpSwatch} aria-hidden="true" />{view.hint}</p>}
    </div>
  );
}

/**
 * Attributes (the build's points and the class's bonus) beside Stats (what a fight uses), each label with its help (Patch 1.9 Task 10).
 * Under them, Patch 1.9 Task 18: ⚔ Practice fight, which tests this build against a training dummy (only for a build the rules can fight).
 */
function BuildFacts({ owner, hints, onPractice }: { owner: OwnerState; hints: Hints; onPractice?: () => void }) {
  const build = ownBuild(owner);
  const classId = owner.currentBuild.classId;
  const stats = cardStats(classId, build);
  // Patch 1.9 Task 13: what Damage and Armor are in each context, in the tooltip (only where they differ).
  const contexts = stats ? contextLines(stats) : {};
  const practiceId = useId();
  return <>
    <div className={styles.facts}>
      <section aria-label="Attributes">
        <h3 className={styles.factsHead}>Attributes · {pointsTotal(build.allocations)} points</h3>
        <ul className={styles.factRows}>
          {attributeRows(classId, build.allocations).map(row => <li key={row.attribute} className={styles.factRow} {...hints.hintRow(row.label)}>
            <span className={styles.factName}>{hints.hintLabel(row.label, attributeHelp[row.attribute], attributeNumbers[row.attribute])}</span>
            <span className={styles.track} aria-hidden="true"><i style={{ width: `${row.width * 100}%` }} /></span>
            <span className={styles.factValue}>{row.points}{row.bonus && <span className={styles.bonus}> {row.bonus}</span>}</span>
          </li>)}
        </ul>
      </section>
      {stats && <section aria-label="Stats">
        <h3 className={styles.factsHead}>Stats</h3>
        <ul className={styles.factRows}>
          {statRows(stats).map(([label, value, arena]) => <li key={label} className={styles.factRow} {...hints.hintRow(label)}>
            <span className={styles.factName}>{hints.hintLabel(label, statHelp[label], [statNumbers[label], ...(contexts[label] ?? [])])}</span>
            <span className={styles.factValue}>{value}{arena && <small className={styles.arenaLine} data-testid="arena-line">{arena}</small>}</span>
          </li>)}
        </ul>
      </section>}
    </div>
    {stats && onPractice && <div className={styles.practice}>
      <button type="button" className={styles.practiceButton} data-practice-button="" aria-describedby={practiceId} onClick={onPractice}>
        <span aria-hidden="true">⚔</span> Practice fight
      </button>
      <p id={practiceId}>Test this build against a training dummy you set up. Free: no stamina, no schedule slot, no rating. Nothing is saved.</p>
    </div>}
  </>;
}

function OwnerSummary({ owner, slotIndex, clock, fixture, stale, resting, onRetry, titles, covered, rules, location, hints, onPractice }: {
  owner: OwnerState; slotIndex: number | null; clock: DisplayClock; fixture: boolean; stale: boolean; resting: boolean; onRetry(): void;
  titles?: TitleControls;
  rules: Rules;
  /** Where the owner's world actor is (`expedition:<id>` while away), which names a running expedition for the XP bar; null when unknown. */
  location: string | null;
  /** The panel's one set of help tooltips (shared with the Worn equipment's Load). */
  hints: Hints;
  /** A phone's equip sheet is open over the panel: this is hidden under it. */
  covered: boolean;
  /** Opens the practice dialog (Patch 1.9 Task 18). */
  onPractice?: () => void;
}) {
  const now = useNow(clock);
  const clockMode = useClockMode();
  const headingId = useId();
  const staminaId = useId();
  const activity = owner.currentActivity;
  const status = activityStatus(owner, slotIndex ?? 0, now, { resting, clock: clockMode });
  // The end is shown as every slot time is (Task 24.0b); one that cannot be shown (`slotTimeText` gives '') is left out.
  const ends = status.endsAtMs === null ? '' : slotTimeText(status.endsAtMs, now, clockMode);
  // While a Rest runs (also the one a skipped activity became, "Resting (not enough stamina)") the box says what it will give back when
  // its slot ends (Patch A item 6). A Rest that has not started, or is over, shows none; nor does resting at home, which has no activity.
  const gain = activity?.kind === 'rest' && status.status === 'in-progress' ? restingGainText(restingGain(owner)) : null;
  return (
    <section className={styles.summary} aria-labelledby={headingId} data-covered={covered || undefined}>
      <p className="eyebrow">{fixture ? 'SAMPLE GLADIATOR' : 'YOUR GLADIATOR'}</p>
      <div className={styles.nameRow}>
        <h2 id={headingId} className={styles.name}>{owner.name}</h2>
        {titles && <TitleButton wornTitle={titles.worn} onOpen={titles.onOpen} />}
      </div>
      <p className={styles.class}>{title(owner.currentBuild.classId)} · Level {owner.progression.level} · {title(owner.progression.league)} league</p>
      {/* The status after a wear: always there (empty and boxless until then), so the line is announced when it arrives. */}
      {titles && <p className={styles.titleStatus} role="status" data-testid="title-status">{titles.status ?? ''}</p>}
      {stale && (
        <div className={styles.stale} role="status">
          <p>Your gladiator could not be refreshed. Showing the last loaded details.</p>
          <button type="button" onClick={onRetry}>Retry</button>
        </div>
      )}
      <ClassCard classId={owner.currentBuild.classId} />
      <div className={styles.activity}>
        <span className="eyebrow">{fixture ? 'SAMPLE ACTIVITY' : 'CURRENT ACTIVITY'}</span>
        {/* Patch 1.9 Task 29 (A3): the next slot's activity is named once its slot is processed, never while the server prepares it. */}
        {settledActivity(owner) && <p>{activity!.label}</p>}
        <p className={styles.status} role="status">{status.label}{ends ? ` · ends ${ends}` : ''}</p>
        {gain && <p className={styles.gain} data-testid="rest-gain"><RestGainText text={gain} /></p>}
      </div>
      <div className={`${styles.stamina} ${styles.hintRow}`} {...hints.hintRow('Stamina')}>
        <span>{hints.hintLabel('Stamina', staminaHelp, statNumbers.Stamina)}</span>
        <span id={staminaId}>{owner.stamina.current} / {owner.stamina.maximum}</span>
      </div>
      <progress className={styles.bar} aria-label="Stamina" aria-describedby={staminaId} value={owner.stamina.current} max={owner.stamina.maximum} />
      <XpBar owner={owner} rules={rules} nowMs={now} location={location} />
      <dl className={styles.wallets}><div><dt>Gold</dt><dd>{owner.wallets.money}</dd></div><div><dt>Renown</dt><dd>{owner.wallets.renown}</dd></div></dl>
      <BuildFacts owner={owner} hints={hints} onPractice={onPractice} />
    </section>
  );
}

export function CharacterPanel({ viewer, session, owner, ownerError, slotIndex, clock, gateway, fixture, previewAs, previewFailed, refreshOwner, onCreate,
  resting = false, titles, rules = RULES_V2, location = null, onPractice }: {
  viewer: Viewer;
  session: SessionState;
  owner: OwnerState | null;
  ownerError: 'unavailable' | null;
  slotIndex: number | null;
  clock: DisplayClock;
  /** The live gateway: build commands always go online. */
  gateway: GameGateway;
  fixture: boolean;
  previewAs?: 'visitor' | 'player';
  /** Fixture mode: the fixture gateway could not be loaded. */
  previewFailed: boolean;
  refreshOwner(): Promise<void>;
  /** Opens the "Create your gladiator" dialog over the camp (signed in without a gladiator). */
  onCreate(): void;
  /** The own gladiator's Title button and status line (patch 1.7); a visitor, who has no gladiator, has neither. */
  titles?: TitleControls;
  /** The owner's own gladiator rests at home in the shared world (Task 23.9 fix round 1). */
  resting?: boolean;
  /** The active rules (`displayRules` of the latest revision read's version): the XP an expedition pays is theirs. */
  rules?: Rules;
  /** The owner's world actor's location (`expedition:<id>` while away), for the XP bar; null while the world is not loaded. */
  location?: string | null;
  /** ⚔ Practice fight under Stats opens the practice dialog (Patch 1.9 Task 18); without it there is no button. */
  onPractice?: () => void;
}) {
  const retry = () => { void refreshOwner().catch(() => undefined); };
  // Patch 1.9: a Worn equipment slot opens the equip picker. The build planner is inert while it is open (the desktop popover lies over its
  // top, so Tab from the picker must not land there); on a phone the picker is a sheet over the panel body, and what it covers is hidden.
  const [picking, setPicking] = useState(false);
  // One set of help tooltips for the whole panel (the stamina, attribute and stat labels and the Worn equipment's Load): one is open at a time.
  const hints = useStatHints({ buttonClass: styles.hintButton, tipClass: styles.hint, aboveClass: styles.hintAbove, numbersClass: styles.hintNumbers });
  if (owner) {
    return <>
      <OwnerSummary owner={owner} slotIndex={slotIndex} clock={clock} fixture={fixture} stale={ownerError !== null} resting={resting} onRetry={retry}
        titles={titles} covered={picking} rules={rules} location={location} hints={hints} onPractice={onPractice} />
      <WornEquipment key={`worn-${owner.gladiatorId}`} owner={owner} gateway={gateway} refresh={refreshOwner} clock={clock} preview={fixture} onPicking={setPicking}
        loadHelp={{ row: hints.hintRow('Load'), label: hints.hintLabel('Load', loadHelp, statNumbers.Load), className: styles.loadRow }} />
      <div className={styles.planner} data-covered={picking || undefined} inert={picking}>
        {fixture ? <p className="panel-notice">This preview cannot change the build.</p>
          : <BuildPanel key={owner.gladiatorId} owner={owner} gateway={gateway} refresh={refreshOwner} clock={clock} />}
      </div>
    </>;
  }
  let joining: ReactNode;
  if (fixture) {
    joining = previewAs === 'visitor' ? <SignIn unavailable="This preview cannot sign in." />
      : <p role="status">{previewFailed || viewer === 'unavailable' ? 'The fixture preview could not be loaded.' : 'Loading local preview…'}</p>;
  } else if (session.status === 'loading') joining = <p role="status">Checking your session…</p>;
  else if (session.status !== 'signed-in') {
    joining = <SignIn unavailable={session.status === 'signed-out' ? null : 'Google sign-in is unavailable until the project is configured.'} />;
  } else if (ownerError) {
    // A failed read is never "no gladiator": it offers no creation.
    joining = <><p role="alert">Your character could not be loaded. Please retry before creating a gladiator.</p>
      <button type="button" className={styles.retry} onClick={retry}>Retry owner load</button></>;
  } else if (viewer === 'no-gladiator') {
    joining = <div className={styles.join}>
      <p>You’re signed in. Create your gladiator to join; the camp keeps running while you choose.</p>
      <button type="button" className={styles.create} onClick={onCreate}>Create your gladiator</button>
    </div>;
  } else joining = <p role="status">Loading your gladiator…</p>;
  return (
    <section className={styles.summary} aria-label="Your gladiator">
      <p className="eyebrow">YOUR GLADIATOR</p>
      <h2 className={styles.name}>A legend awaits</h2>
      <p className={styles.class}>One fighter. Your choices.</p>
      {joining}
    </section>
  );
}
