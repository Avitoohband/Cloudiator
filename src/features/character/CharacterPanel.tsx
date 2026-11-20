'use client';

// The "My gladiator" menu. A player sees a summary (name, class, level, league, stamina, wallets and the activity line
// from `activityStatus`) and the build planner; with a refresh that failed it keeps the last loaded summary and says so.
// Patch 1.7: beside the name, the Title button (the worn title; it opens "Choose your title"), and under it the status after a wear.
// Without a gladiator it holds the joining path (Task 13.6): a visitor is told everything is open to watch and offered
// "Sign in with Google to create your gladiator"; signed in without one, "Create your gladiator" reopens the creation
// dialog over the camp; and the session and owner-load states. Names render as React text.
// Patch 1.9 Task 10: the XP bar under Stamina, the Attributes and Stats blocks, and help on their labels (and on Stamina and Load).
// Patch 1.9: Worn equipment's slots open the equip picker (`WornEquipment`); a phone's picker is a sheet over the panel body, and the
// summary and the build planner it covers are hidden meanwhile. Patch 1.9.2: on the desktop the planner stays usable under an open picker.
// Patch 1.9 Task 18: ⚔ Practice fight under Stats opens the shell's practice dialog (a fight against a training dummy; nothing is saved).
// Patch 1.9 Task 33 (menus with Back and Next, the approved paged-menus mockup): a player's My gladiator is five named sections, one shown at
// a time: Overview (name, Title, class, activity, gold and renown), Level and stamina, Attributes and stats (with ⚔ Practice fight), Worn
// equipment (the slots and the build planner under them, as before) and History (the gladiator's own history, `GladiatorHistory`). The strip
// under the menu's title moves between them, and the bottom bar too where a section has no paged list of its own. The shell keeps the
// section (`section`, `onSection`), so the menu reopens on the last section seen in this visit. Every section stays mounted while another
// shows, so a draft build or an open picker is kept; only History reads when it is first shown.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { HistoryKind, OwnerState } from '@contracts/reads';
import { RULES_V2 } from '@domain/rules-v2';
import type { Rules } from '@domain/types';
import type { GameGateway } from '../../lib/api/gateway';
import type { SessionState } from '../../lib/api/session';
import type { DisplayClock } from '../../game/display-clock';
import { SignIn } from '../auth/SignIn';
import { BuildPanel } from '../build/BuildPanel';
import { pointsToSpend } from '../build/fixed-build';
import { useClockMode } from '../../lib/clock-setting';
import { RestGainText } from '../schedule/RestGainText';
import { restingGain, restingGainText } from '../schedule/rest-stamina';
import { slotTimeText } from '../schedule/slot-time';
import { TitleButton } from '../titles/TitlePicker';
import { PanelFooter } from '../paging/PanelFooter';
import { scroller } from '../paging/scroller';
import { SectionPager, SectionStrip, type Section } from '../paging/SectionPager';
import { useSectionChange } from '../shell/section-change';
import type { SceneView } from '../shell/scene-url';
import { CurrencyIcon } from '../shops/ShopArt';
import { activityStatus, settledActivity } from './activity-status';
import { ClassCard } from './ClassCard';
import { GladiatorHistory } from './GladiatorHistory';
import { createHistoryStore, type HistoryReads } from './history-store';
import { attributeHelp, attributeRows, cardStats, contextLines, ownBuild, pointsTotal, statHelp, statRows } from './profile-card';
import { useStatHints } from './stat-hints';
import { attributeNumbers, loadHelp, staminaHelp, statNumbers } from './stat-numbers';
import { xpView } from './xp-progress';
import { WornEquipment } from './WornEquipment';
import { useCompactLayout } from './useCompactLayout';
import type { Viewer } from './useGameState';
import styles from './CharacterPanel.module.css';

const TICK_MS = 1000;
const title = (value: string) => value[0].toUpperCase() + value.slice(1);

/** My gladiator's sections, in order (Patch 1.9 Task 33). */
export const GLADIATOR_SECTIONS: readonly Section[] = [
  { id: 'overview', name: 'Overview' }, { id: 'level', name: 'Level and stamina' }, { id: 'attributes', name: 'Attributes and stats' },
  { id: 'worn', name: 'Worn equipment' }, { id: 'history', name: 'History' },
];
const HISTORY = GLADIATOR_SECTIONS.length - 1;
/** The Worn equipment section, which holds the build planner (Plan a build) under the slots: where Spend points goes (Patch 1.9.2). */
export const PLAN_SECTION = GLADIATOR_SECTIONS.findIndex(entry => entry.id === 'worn');

/** The History section's reads and actions: the shell's history reads, its minute clock, and ▶ Watch (the scene and the chip it came from). */
export type OwnHistory = { reads: HistoryReads; nowMs: number | null; onWatch(view: Exclude<SceneView, { kind: 'bout' }>, kind: HistoryKind): void };

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
 * Patch 1.9.2: under the attributes, "N points to spend" with Spend points ›, while points wait (`toSpend`) and the planner can take them.
 */
function BuildFacts({ owner, hints, onPractice, toSpend, onSpend }: { owner: OwnerState; hints: Hints; onPractice?: () => void; toSpend: number; onSpend?: () => void }) {
  const build = ownBuild(owner);
  const classId = owner.currentBuild.classId;
  const stats = cardStats(classId, build);
  // Patch 1.9 Task 13: what Damage and Armor are in each context, in the tooltip (only where they differ).
  const contexts = stats ? contextLines(stats) : {};
  const practiceId = useId(), spendId = useId();
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
        {/* The line describes the button, so a screen reader hears how many points wait with it. */}
        {onSpend && toSpend > 0 && <div className={styles.spend}>
          <p id={spendId} data-testid="points-to-spend"><strong>{toSpend}</strong> {toSpend === 1 ? 'point' : 'points'} to spend</p>
          <button type="button" className={styles.spendButton} aria-describedby={spendId} onClick={onSpend}>Spend points <span aria-hidden="true">›</span></button>
        </div>}
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

/** One section's box: shown when it is the current one, kept (hidden) otherwise. */
function SectionBox({ id, at, children }: { id: string; at: string; children: ReactNode }) {
  return <div className={styles.section} data-section={id} hidden={id !== at}>{children}</div>;
}

function OwnerSections({ owner, slotIndex, clock, fixture, stale, resting, onRetry, titles, picking, setPicking, rules, location, hints, onPractice, gateway,
  refreshOwner, section, onSection, history, planRequested, onPlanShown }: {
  owner: OwnerState; slotIndex: number | null; clock: DisplayClock; fixture: boolean; stale: boolean; resting: boolean; onRetry(): void;
  titles?: TitleControls;
  rules: Rules;
  /** Where the owner's world actor is (`expedition:<id>` while away), which names a running expedition for the XP bar; null when unknown. */
  location: string | null;
  /** The panel's one set of help tooltips (shared with the Worn equipment's Load). */
  hints: Hints;
  /** A Worn equipment picker is open (on a phone a sheet over the panel body, which makes what it covers inert). */
  picking: boolean;
  setPicking(open: boolean): void;
  /** Opens the practice dialog (Patch 1.9 Task 18). */
  onPractice?: () => void;
  gateway: GameGateway;
  refreshOwner(): Promise<void>;
  section: number;
  onSection(index: number): void;
  history?: OwnHistory;
  /** The shell asks to show Plan a build (`CharacterPanel`'s `planRequested`), and hears when it is shown. */
  planRequested: boolean;
  onPlanShown?(): void;
}) {
  const now = useNow(clock);
  const clockMode = useClockMode();
  const headingId = useId();
  const staminaId = useId();
  const at = GLADIATOR_SECTIONS[Math.min(Math.max(0, section), HISTORY)].id;
  const index = GLADIATOR_SECTIONS.findIndex(entry => entry.id === at);
  const holder = useRef<HTMLDivElement>(null);
  useSectionChange(index, holder);
  /**
   * Patch 1.9.2: Spend points (`ask`, this panel's own button) or the shell (`planRequested`, the away summary's Open My gladiator, which may
   * mount this panel as it opens the menu) shows Plan a build: Worn equipment, scrolled so the planner's heading is at the top of the part of
   * the menu that scrolls, and the heading takes the focus (as a heading a menu opens on does), so Tab goes on into the form. It runs after
   * the section change's scroll to the top. In the fixture preview, which has no planner, its notice is shown. The focus stays where it is
   * when the heading cannot take it (a phone's open picker sheet covers the planner).
   */
  const [ask, setAsk] = useState(0);
  const asked = useRef(ask);
  useLayoutEffect(() => {
    if ((asked.current === ask && !planRequested) || at !== 'worn') return;
    asked.current = ask;
    if (planRequested) onPlanShown?.();
    const planner = holder.current?.querySelector<HTMLElement>('[data-section="worn"] [data-planner]');
    if (!planner) return;
    const heading = planner.querySelector<HTMLElement>('[data-plan-heading]'), target = heading ?? planner, body = scroller(target);
    if (body) body.scrollTop += target.getBoundingClientRect().top - body.getBoundingClientRect().top - 8;
    if (heading && !heading.closest('[inert]')) heading.focus({ preventScroll: true });
  }, [ask, planRequested, onPlanShown, at]);
  const spend = () => { onSection(PLAN_SECTION); setAsk(n => n + 1); };
  /**
   * Patch 1.9.2: the build planner is inert only while a phone's picker sheet covers it (and hides it). On the desktop the popover lies over
   * its top only, and the planner below looks normal, so it stays usable: a click or the focus there closes the popover (`WornEquipment`).
   * On 1.9 and 1.9.1 it was inert there too, and +1 and Queue build did nothing while a picker was left open.
   */
  const compact = useCompactLayout();
  const plannerCovered = picking && compact;
  /**
   * The section navigation waits only while the Worn equipment section shows its open picker. A picker left open there while the shell moved
   * to another section (Notifications' "Choose a title" shows the Overview) stays open, hidden, until the player comes back (final review I1).
   */
  const locked = picking && at === 'worn';
  /**
   * 1.9.2 review: what a phone's picker sheet covers (the strip, the bottom bar and the stale notice) is inert while it is open. On the desktop
   * the popover lies over the section's own content only, and a press outside closes it before its click lands, so one click on the strip, the
   * bar or Retry both closes it and acts.
   */
  const navCovered = locked && compact;
  /** The section navigation's move: nothing while the Worn equipment section shows a picker (← and → there; a click outside closes it first). */
  const go = (next: number) => { if (!locked) onSection(next); };
  // The History section: the owner's own history (its chip kept while the menu is open), read only once it is first shown.
  const [kind, setKind] = useState<HistoryKind>('arena');
  const [seenHistory, setSeenHistory] = useState(index === HISTORY);
  if (index === HISTORY && !seenHistory) setSeenHistory(true);
  const reads = history?.reads ?? null;
  const store = useMemo(() => (reads?.history ? createHistoryStore(reads, owner.gladiatorId, true) : null), [reads, owner.gladiatorId]);
  const activity = owner.currentActivity;
  const status = activityStatus(owner, slotIndex ?? 0, now, { resting, clock: clockMode });
  // The end is shown as every slot time is (Task 24.0b); one that cannot be shown (`slotTimeText` gives '') is left out.
  const ends = status.endsAtMs === null ? '' : slotTimeText(status.endsAtMs, now, clockMode);
  // While a Rest runs (also the one a skipped activity became, "Resting (not enough stamina)") the box says what it will give back when
  // its slot ends (Patch A item 6). A Rest that has not started, or is over, shows none; nor does resting at home, which has no activity.
  const gain = activity?.kind === 'rest' && status.status === 'in-progress' ? restingGainText(restingGain(owner)) : null;
  return <>
    {/* While the Worn equipment section shows its open picker, the section navigation waits: its keys (← →, the shell's listener) do nothing,
        and a phone's sheet, which covers the strip and the bar, makes them inert (fix round 1, review Important 3; only in that section, final
        review I1; inert on phones only, 1.9.2 review). */}
    <div inert={navCovered}><SectionStrip sections={GLADIATOR_SECTIONS} index={index} onGo={go} /></div>
    {/* The stale notice sits over every section; a phone's picker sheet covers it too (fix round 1, review Minor 1). */}
    {stale && (
      <div className={styles.stale} role="status" data-covered={navCovered || undefined} inert={navCovered}>
        <p>Your gladiator could not be refreshed. Showing the last loaded details.</p>
        <button type="button" onClick={onRetry}>Retry</button>
      </div>
    )}
    <div ref={holder}>
      <SectionBox id="overview" at={at}>
        <section className={styles.summary} aria-labelledby={headingId}>
          <p className="eyebrow">{fixture ? 'SAMPLE GLADIATOR' : 'YOUR GLADIATOR'}</p>
          <div className={styles.nameRow}>
            <h2 id={headingId} className={styles.name}>{owner.name}</h2>
            {titles && <TitleButton wornTitle={titles.worn} onOpen={titles.onOpen} />}
          </div>
          <p className={styles.class}>{title(owner.currentBuild.classId)} · Level {owner.progression.level} · {title(owner.progression.league)} league</p>
          {/* The status after a wear: always there (empty and boxless until then), so the line is announced when it arrives. */}
          {titles && <p className={styles.titleStatus} role="status" data-testid="title-status">{titles.status ?? ''}</p>}
          <ClassCard classId={owner.currentBuild.classId} />
          <div className={styles.activity}>
            <span className="eyebrow">{fixture ? 'SAMPLE ACTIVITY' : 'CURRENT ACTIVITY'}</span>
            {/* Patch 1.9 Task 29 (A3): the next slot's activity is named once its slot is processed, never while the server prepares it. */}
            {settledActivity(owner) && <p>{activity!.label}</p>}
            <p className={styles.status} role="status">{status.label}{ends ? ` · ends ${ends}` : ''}</p>
            {gain && <p className={styles.gain} data-testid="rest-gain"><RestGainText text={gain} /></p>}
          </div>
          {/* Renown wears the gold laurel, as in the shops, the cards and the corner chip (the 1.9 changelog). */}
          <dl className={styles.wallets}><div><dt>Gold</dt><dd>{owner.wallets.money}</dd></div>
            <div><dt><CurrencyIcon currency="renown" size={14} /> Renown</dt><dd>{owner.wallets.renown}</dd></div></dl>
        </section>
      </SectionBox>
      <SectionBox id="level" at={at}>
        <div className={`${styles.stamina} ${styles.hintRow}`} {...hints.hintRow('Stamina')}>
          <span>{hints.hintLabel('Stamina', staminaHelp, statNumbers.Stamina)}</span>
          <span id={staminaId}>{owner.stamina.current} / {owner.stamina.maximum}</span>
        </div>
        <progress className={styles.bar} aria-label="Stamina" aria-describedby={staminaId} value={owner.stamina.current} max={owner.stamina.maximum} />
        <XpBar owner={owner} rules={rules} nowMs={now} location={location} />
      </SectionBox>
      <SectionBox id="attributes" at={at}>
        <BuildFacts owner={owner} hints={hints} onPractice={onPractice} toSpend={pointsToSpend(owner)} onSpend={fixture ? undefined : spend} />
      </SectionBox>
      <SectionBox id="worn" at={at}>
        <WornEquipment key={`worn-${owner.gladiatorId}`} owner={owner} gateway={gateway} refresh={refreshOwner} clock={clock} preview={fixture} onPicking={setPicking}
          loadHelp={{ row: hints.hintRow('Load'), label: hints.hintLabel('Load', loadHelp, statNumbers.Load), className: styles.loadRow }} />
        <div className={styles.planner} data-planner="" data-covered={plannerCovered || undefined} inert={plannerCovered}>
          {fixture ? <p className="panel-notice">This preview cannot change the build.</p>
            : <BuildPanel key={owner.gladiatorId} owner={owner} gateway={gateway} refresh={refreshOwner} clock={clock} />}
        </div>
      </SectionBox>
      <SectionBox id="history" at={at}>
        {/* The History holds the cards' own History (Task 27), paged (Task 32); ← there goes back to the Overview, this menu's card. Kept
            mounted once seen (its page and chip stay), its bar shows only in this section (`active`), where it is the one bottom bar; with
            `gladiatorId`, Back from a replay opened here lands on the page and row it was opened from (the 1.9 merge). */}
        {store && seenHistory ? <GladiatorHistory store={store} kind={kind} onKind={setKind} name={owner.name} own nowMs={history?.nowMs ?? null}
          onBack={() => onSection(0)} onWatch={view => history?.onWatch(view, kind)} gladiatorId={owner.gladiatorId} active={index === HISTORY} />
          : <p className="muted" role="status">Loading the history…</p>}
      </SectionBox>
    </div>
    {/* The bottom bar of a section with no paged list of its own; History's list pages with its own bar (the list rule), its only bottom bar. */}
    {index !== HISTORY && <PanelFooter><div inert={navCovered}><SectionPager sections={GLADIATOR_SECTIONS} index={index} onGo={go} /></div></PanelFooter>}
  </>;
}

export function CharacterPanel({ viewer, session, owner, ownerError, slotIndex, clock, gateway, fixture, previewAs, previewFailed, refreshOwner, onCreate,
  resting = false, titles, rules = RULES_V2, location = null, onPractice, section, onSection, history, planRequested = false, onPlanShown }: {
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
  /** The section shown (0-based, `GLADIATOR_SECTIONS`) and its change: the shell's, so the menu reopens on it. Without them, the panel's own. */
  section?: number;
  onSection?(index: number): void;
  /** The History section's reads (the shell's); without them the section says the history is loading. */
  history?: OwnHistory;
  /**
   * The shell asks to show Plan a build (Patch 1.9.2: the away summary's Open My gladiator when Training left points to spend), with `section`
   * at `PLAN_SECTION`: the planner's heading is scrolled into view and takes the focus, then `onPlanShown` says so (the shell drops the ask).
   */
  planRequested?: boolean;
  onPlanShown?(): void;
}) {
  const retry = () => { void refreshOwner().catch(() => undefined); };
  // Patch 1.9: a Worn equipment slot opens the equip picker. On a phone the picker is a sheet over the panel body, and what it covers is hidden
  // and inert. Patch 1.9.2: on the desktop the popover closes when the click or the focus goes outside it, and the build planner stays usable.
  const [picking, setPicking] = useState(false);
  // One set of help tooltips for the whole panel (the stamina, attribute and stat labels and the Worn equipment's Load): one is open at a time.
  const hints = useStatHints({ buttonClass: styles.hintButton, tipClass: styles.hint, aboveClass: styles.hintAbove, numbersClass: styles.hintNumbers });
  const [ownSection, setOwnSection] = useState(0);
  if (owner) {
    return <OwnerSections owner={owner} slotIndex={slotIndex} clock={clock} fixture={fixture} stale={ownerError !== null} resting={resting} onRetry={retry}
      titles={titles} picking={picking} setPicking={setPicking} rules={rules} location={location} hints={hints} onPractice={onPractice} gateway={gateway}
      refreshOwner={refreshOwner} section={section ?? ownSection} onSection={onSection ?? setOwnSection} history={history}
      planRequested={planRequested} onPlanShown={onPlanShown} />;
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
