'use client';

// A gladiator's public profile card (spec "Clicking a gladiator", the approved mockup): name, class, level and league,
// their season champion title and badges (Task 21.4; nothing without prestige), what they are doing now, their rating
// (and their record when a standings row opened the card) and their equipped gear, with Follow and, for an Arena entrant,
// Watch bout. The viewer's own card adds the "My gladiator" and "Schedule" shortcuts and no private value. The card
// renders from the public world actor at once and loads the public profile (`gateway.profile`) on demand; a gladiator who
// is not in the world (a standings row) shows once that profile arrives.
//
// The layer is a labelled, non-modal dialog over the camp: on desktop beside the click that opened it, clear of the
// gladiator (or beside the menus when a list row opened it); on touch a sheet above the ☰ button. A row (the keyboard
// path of a camp click) gives it the focus; a camp click leaves the focus with the camp. Names render as React text.
//
// Task 11c (Patch A spec, "A richer profile card"; Avi approved the mockup, 2026-10-29): the card is filled in sections. The look (a
// portrait as the camp draws it) beside the name, class line and the class's bonus chips; then ATTRIBUTES (the current build's points)
// beside STATS (what they make, computed with the shared rules), and GEAR beside RECORD (now, rating, the Arena record over all seasons,
// "This season" from a standings row, and "In camp since"). 520 px in two columns on a desktop; on touch the sheet's body scrolls and
// its actions stay at its foot. Before the one profile read arrives the build's sections say "Loading…", and "Not available" when it
// failed or has no usable build; GEAR then keeps the world's "Equipped" line. The own card shows what others see, and says so.
//
// Patch 1.6 (spec "The Arena banner"): a gladiator who owns the Arena banner (the profile read's `banner`) shows the pill "🚩 Arena banner"
// right after the name line, its flag decorative; every viewer sees the same card.
//
// Patch 1.9 Task 19: a player's card (any gladiator's, their own too: a mirror) offers "⚔ Spar a copy" after Follow, which fights a copy of the
// build the card shows, at once, in the browser (`copySide`; nothing is sent, and the gladiator is not told). It is disabled until the card
// has a build to copy; a visitor or an account without a gladiator is offered none.
//
// Patch 1.9 Task 23c: a player's card on another gladiator offers "⇄ Compare with mine" after Follow (never on the viewer's own card, never to a visitor
// or an account without a gladiator). While it is on, the Attributes, Stats, Gear and Record sections give way to the comparison (`ProfileCompare`). The
// on/off state lives in the shell (a card is re-created for each gladiator), so it stays on while other cards open.
//
// Patch 1.9 Task 27 (Avi, 2026-11-12; the approved mockup `.superpowers/design/2026-11-12-gladiator-history/`): every player's card (never a Ludus
// Nimbus bot's) opens their History: "📜 History" after ⚔ Spar a copy, or "See all" on the History line of RECORD. The history then stands in
// for the card's sections and actions (`GladiatorHistory`) until ← goes back to the card, the focus back on what opened it; the chip chosen
// stays while the card is open. Its lists are public (the same for every reader, visitors too); the viewer's own card adds its own rewards.
// ▶ Watch opens the scene over the camp, which closes the card.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { HistoryKind, PublicActor, WorldSnapshot } from '@contracts/reads';
import type { GameGateway } from '../../lib/api/gateway';
import type { ProfileRead } from '../../lib/api/reads';
import type { Point } from '../../game/iso';
import { useClockMode } from '../../lib/clock-setting';
import type { MenuPlace } from '../shell/menu-prefs';
import type { MenuId } from '../shell/menus';
import { COMPACT_QUERY } from '../shell/rail-reveal';
import type { Roster } from './RosterPanel';
import { botDutyText, classLine, dungeonPlace, gearText, isAway, placeOf } from './actor-text';
import { BotTag } from './BotTag';
import { ownRestingText } from './activity-status';
import { badgeText, seasonName } from '../seasons/season-text';
import { wornTitleText } from '../titles/title-text';
import { ActorPortrait } from './ActorPortrait';
import { useStatHints } from './stat-hints';
import { ClassChips } from './ClassCard';
import { attributeHelp, attributeRows, cardStats, compareStats, gearRows, overloadLine, pointsTotal, recordText, sinceText, statHelp, statRows, type CompareSide } from './profile-card';
import { CompareBlock } from './ProfileCompare';
import { GladiatorHistory } from './GladiatorHistory';
import { createHistoryStore, type HistoryReads, type HistoryStore } from './history-store';
import { withHistoryOrigin, type SceneView } from '../shell/scene-url';
import { copySide, type PracticeSide } from '../practice/practice';
import styles from './ProfileCard.module.css';

/**
 * Human wins and losses from a standings row, and the season those standings show: a closed season's id ("Season 1 · 12–3"), or null
 * for the current season ("This season"; Avi, 2026-10-30).
 */
export type ProfileRecord = { wins: number; losses: number; season?: string | null };

/** Whose card to show, and how it was opened. */
export type ProfileTarget = {
  gladiatorId: string;
  /** Shown until the gladiator's public actor is known (a standings row's name). */
  name: string;
  /** The clicked gladiator's body, canvas-relative CSS px (a camp click); null opens the card beside the menus. */
  screen: Point | null;
  /** Human wins and losses, when a standings row opened the card. */
  record: ProfileRecord | null;
  /** Opened from a list row (a keyboard path): the card takes the focus. */
  focus: boolean;
  /** Opens on the History view at this chip (Patch 1.9 Task 27 fix round 1: Back from a scene opened from a History row). */
  history?: HistoryKind;
};

const RARITY_CLASS = { common: styles.rCommon, uncommon: styles.rUncommon, rare: styles.rRare } as const;

/** Compare with mine (Patch 1.9 Task 23c): the viewer's own side, whether the comparison is on, and its toggle. */
export type CompareProp = { mine: CompareSide; on: boolean; onToggle(): void };

export function ProfileCard({ actor, profile, profileFailed = false, own, ownPlace = null, record = null, followReason = null, following = false, nowMs, onFollow,
  onWatch, onOpenMenu, onSpar, compare, history = null, onWatchHistory, initialHistory }: {
  actor: PublicActor;
  /** The public profile with its card data, once loaded (null while it loads or when it failed). */
  profile: ProfileRead | null;
  profileFailed?: boolean;
  /** The viewer's clock (the shell's minute clock), for "In camp since". */
  nowMs: number;
  /** The viewer's own gladiator: the card adds the management shortcuts. */
  own: boolean;
  /**
   * The owner's own words while its gladiator rests at home (`ownRestingText`; Task 23.9 fix round 1): its own card's Now
   * says this, never the public "back when {name}'s owner returns."
   */
  ownPlace?: string | null;
  record?: ProfileRecord | null;
  /** Why Follow is unavailable now, or null. */
  followReason?: string | null;
  /** Whether the camera follows this gladiator now. */
  following?: boolean;
  onFollow(gladiatorId: string): void;
  /** Watches an Arena entrant's bout. */
  onWatch?(activityId: string): void;
  onOpenMenu(id: MenuId): void;
  /** ⚔ Spar a copy (Patch 1.9 Task 19): a player's only; without it the card offers none. */
  onSpar?(copy: PracticeSide): void;
  /** ⇄ Compare with mine: a player's only, and never on their own card (Patch 1.9 Task 23c); without it the card offers none. */
  compare?: CompareProp;
  /** The card's history (Patch 1.9 Task 27): its lists, counts and (own card) rewards; without it the card offers no History. */
  history?: HistoryStore | null;
  /** ▶ Watch on a history row: the scene to open over the camp, and the chip it was under. */
  onWatchHistory?(view: Exclude<SceneView, { kind: 'bout' }>, kind: HistoryKind): void;
  /** Opens on the History view at this chip (Back from a scene opened from a History row). */
  initialHistory?: HistoryKind;
}) {
  const reasonId = useId();
  // The History view (Task 27): open or not, and the chip chosen (kept while the card is open). The focus goes to ← when it opens and
  // back to what opened it (📜 History or See all) when it closes.
  const [shown, setShown] = useState<{ open: boolean; kind: HistoryKind }>({ open: initialHistory !== undefined, kind: initialHistory ?? 'arena' });
  const historyButton = useRef<HTMLButtonElement>(null);
  const seeAll = useRef<HTMLButtonElement>(null);
  const historyBack = useRef<HTMLButtonElement>(null);
  const opener = useRef<'button' | 'link' | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const compareRef = useRef<HTMLButtonElement>(null);
  // The help tooltips are shared with My gladiator (`useStatHints`); here the body scrolls on touch, the card itself on desktop.
  const { hintRow, hintLabel } = useStatHints({ buttonClass: styles.hintButton, tipClass: styles.hint, aboveClass: styles.hintAbove,
    scrollport: () => {
      const body = bodyRef.current;
      return body && (getComputedStyle(body).overflowY === 'auto' ? body : body.closest<HTMLElement>('[data-profile-card]') ?? body);
    } });

  const clock = useClockMode();
  const bot = actor.botTeam === 'ludus-nimbus';
  const duty = bot ? botDutyText(actor, clock) : null;
  const rating = profile ? String(profile.rating) : profileFailed ? 'Not available' : 'Loading…';
  const bout = actor.location === 'arena' ? actor.activityId : null;
  // Season prestige (Task 21.4): the badges newest season first. Patch 1.7: the title line is the title the gladiator wears now (Champion
  // reads its latest first place from the prestige); an id this client does not know shows none.
  const awards = [...(profile?.prestige ?? [])].sort((p, q) => Number(q.seasonId) - Number(p.seasonId));
  const title = wornTitleText(actor.title, awards);
  // The build's sections: from the profile's build once it is read; "Loading…" before, "Not available" without a usable build.
  const build = profile?.build ?? null;
  const stats = build ? cardStats(actor.classId, build) : null;
  const missing = profile || profileFailed ? 'Not available' : 'Loading…';
  const gear = build ? gearRows(build) : null;
  const overload = stats ? overloadLine(stats) : null;
  const since = profile && profile.joinedAtMs !== null ? sinceText(profile.joinedAtMs, nowMs) : '';
  // The copy a spar fights: the card's build under the Arena's rules, once there is one the rules accept.
  const copy = useMemo(() => {
    if (!onSpar || !build) return null;
    try { return copySide(actor, build); } catch { return null; }
  }, [onSpar, actor, build]);
  // Compare with mine: both builds are known (this card's, once loaded, and the viewer's) and the rules accept both.
  const comparison = useMemo(() => (compare && !own && build ? compareStats(compare.mine, { name: actor.name, level: actor.level, classId: actor.classId, build }) : null),
    [compare, own, actor.name, actor.level, actor.classId, build]);
  const comparing = !!compare && !own && compare.on && comparison !== null;
  const historyOn = history !== null && !bot;
  const historyOpen = historyOn && shown.open;
  useEffect(() => {
    if (historyOpen) { historyBack.current?.focus({ preventScroll: true }); return; }
    const from = opener.current;
    if (!from) return;
    opener.current = null;
    (from === 'link' ? seeAll : historyButton).current?.focus({ preventScroll: true });
  }, [historyOpen]);
  const openHistory = (from: 'button' | 'link') => { opener.current = from; setShown(current => ({ ...current, open: true })); };
  if (historyOpen && history) {
    return <div ref={bodyRef} className={`${styles.body} ${styles.historyBody}`} data-testid="profile-body">
      <GladiatorHistory store={history} kind={shown.kind} onKind={kind => setShown({ open: true, kind })} name={actor.name} own={own} nowMs={nowMs}
        onBack={() => setShown(current => ({ ...current, open: false }))} onWatch={view => onWatchHistory?.(view, shown.kind)} backRef={historyBack} />
    </div>;
  }
  return <>
    <div ref={bodyRef} className={`${styles.body} ${comparing ? styles.comparing : ''}`} data-testid="profile-body" data-comparing={comparing ? '' : undefined}>
      <div className={styles.head}>
        <ActorPortrait actor={actor} />
        <div className={styles.who}>
          {own && <p className="eyebrow">YOUR GLADIATOR</p>}
          {bot && <p className="eyebrow">Ludus Nimbus</p>}
          <h2 className={styles.name}>{actor.name}{bot && <BotTag />}</h2>
          {profile?.banner && <p className={styles.banner}><span aria-hidden="true">🚩</span> Arena banner</p>}
          {title && <p className={styles.title}>{title}</p>}
          <p className={styles.class}>{classLine(actor)}</p>
          {bot && <p className={styles.class}>Unranked · Fixed build</p>}
          {duty && <p className={styles.class}>{duty}</p>}
          <ClassChips classId={actor.classId} />
          {awards.length > 0 && <ul className={styles.badges} aria-label="Season badges">{awards.map(award => <li key={award.seasonId}>{badgeText(award)}</li>)}</ul>}
        </div>
      </div>
      {comparing && comparison && <CompareBlock comparison={comparison} name={actor.name} onBack={() => { compare.onToggle(); setTimeout(() => compareRef.current?.focus(), 0); }} />}
      {!comparing && <div className={styles.grid}>
        <section className={styles.section} aria-label="Attributes">
          <p className="eyebrow">{build ? `ATTRIBUTES · ${pointsTotal(build.allocations)} POINTS` : 'ATTRIBUTES'}</p>
          {build ? <ul className={styles.attributes}>
            {attributeRows(actor.classId, build.allocations).map(row => <li key={row.attribute} {...hintRow(row.label)}>
              <span>{hintLabel(row.label, attributeHelp[row.attribute])}{row.bonus && <span className={styles.bonus}> {row.bonus}</span>}</span>
              <span className={styles.bar} aria-hidden="true"><i style={{ width: `${row.width * 100}%` }} /></span>
              <b>{row.points}</b>
            </li>)}
          </ul> : <p className={styles.state}>{missing}</p>}
        </section>
        <section className={styles.section} aria-label="Stats">
          <p className="eyebrow">{stats && build ? `STATS · ${build.stance.toUpperCase()} STANCE` : 'STATS'}</p>
          {stats ? <>
            <dl className={`${styles.facts} ${styles.stats}`}>{statRows(stats).map(([label, value, arena]) => <div key={label} className={styles.statRow} {...hintRow(label)}>
              <dt>{hintLabel(label, statHelp[label])}</dt><dd>{value}{arena && <small className={styles.arenaLine} data-testid="arena-line">{arena}</small>}</dd>
            </div>)}</dl>
            {overload && <p className={styles.overload}>{overload}</p>}
          </> : <p className={styles.state}>{missing}</p>}
        </section>
        <section className={styles.section} aria-label="Gear">
          <p className="eyebrow">GEAR</p>
          {!build ? <dl className={styles.facts}><div><dt>Equipped</dt><dd>{gearText(actor.equipmentSilhouettes)}</dd></div></dl>
            : gear ? <dl className={styles.facts}>{gear.map(row => <div key={row.slot}><dt>{row.label}</dt><dd>
              {row.name ? <><span className={row.rarity ? RARITY_CLASS[row.rarity] : undefined}>{row.name}</span><span className={styles.detail}>{row.detail}</span></>
                : <span className={styles.empty}>{row.note}</span>}
            </dd></div>)}</dl>
              : <p className={styles.state}>Nothing worn yet.</p>}
        </section>
        <section className={styles.section} aria-label="Record">
          <p className="eyebrow">RECORD</p>
          <dl className={styles.facts}>
            <div><dt>Now</dt><dd>{own && actor.resting ? ownPlace ?? ownRestingText(null) : placeOf(actor)}</dd></div>
            {!bot && <div><dt>Rating</dt><dd>{rating}</dd></div>}
            {profile && <div><dt>Titles</dt><dd>{profile.titlesEarned > 0 ? `${profile.titlesEarned.toLocaleString('en-US')} earned` : 'None yet'}</dd></div>}
            {!bot && profile?.arenaRecord && <div><dt>Arena record</dt><dd>{recordText(profile.arenaRecord)}
              {profile.arenaRecord.wins + profile.arenaRecord.losses > 0 && <small> · all seasons</small>}</dd></div>}
            {record && <div><dt>{record.season ? seasonName(record.season) : 'This season'}</dt><dd>{record.wins}–{record.losses}</dd></div>}
            {historyOn && <div><dt>History</dt><dd><button ref={seeAll} type="button" className={styles.back} data-history-link="" onClick={() => openHistory('link')}>See all</button></dd></div>}
            {since && <div><dt>In camp since</dt><dd>{since}</dd></div>}
          </dl>
          {own && profile && <p className={styles.see}>Other players see this card too.</p>}
        </section>
      </div>}
      {followReason && <p id={reasonId} className={styles.reason}>{followReason}</p>}
      {/* One live region, mounted with the card and filled when Compare turns on, so its sentence is announced (final review, fix round 1). */}
      {compare && !own && <p className={styles.srOnly} role="status" data-compare-status="">{comparing ? `Showing a comparison of your gladiator with ${actor.name}.` : ''}</p>}
    </div>
    <div className={styles.actions} data-card-actions="">
      {own && <>
        <button type="button" className={styles.gold} onClick={() => onOpenMenu('gladiator')}>My gladiator</button>
        <button type="button" onClick={() => onOpenMenu('schedule')}>Schedule</button>
      </>}
      <button type="button" disabled={!!followReason} aria-describedby={followReason ? reasonId : undefined} aria-pressed={following && !followReason}
        onClick={() => onFollow(actor.gladiatorId)}>Follow</button>
      {compare && !own && <button type="button" data-compare-button="" ref={compareRef} disabled={!comparison} aria-pressed={compare.on} onClick={compare.onToggle}>
        <span aria-hidden="true">⇄</span> Compare with mine
      </button>}
      {onSpar && <button type="button" data-spar-button="" disabled={!copy} onClick={() => { if (copy) onSpar(copy); }}>
        <span aria-hidden="true">⚔</span> Spar a copy
      </button>}
      {historyOn && <button ref={historyButton} type="button" data-history-button="" onClick={() => openHistory('button')}>
        <span aria-hidden="true">📜</span> History
      </button>}
      {bout && onWatch && <button type="button" onClick={() => onWatch(bout)}>Watch bout</button>}
    </div>
  </>;
}

type Size = { width: number; height: number };
/** The open menu panel's box in the shell (layout coordinates), for a card that opens beside it. */
export type PanelBox = { left: number; top: number; width: number };
/** Which edge the menu is on and the open panel's box (null when none is measured): a card opened from a list sits beside that panel. */
export type MenuSide = { place: MenuPlace; panel: PanelBox | null };
/** The menus' left edge (beside a left rail) and the panel's right edge (shell.module.css), the chip row's height, a margin. */
const RAIL_RIGHT = 66, PANEL_RIGHT = 66 + 380 + 12, TOP = 64, MARGIN = 12;
/** A right rail takes this much of the window's right side (its 8 px, 54 px and a gap), and a bottom bar this much of the bottom. */
const RAIL_SIDE = 66, BAR = 8 + 54 + 12;
/** The card's bottom sits this far above a clicked body's centre (clear of the head), or its top this far below. */
const ABOVE = 64, BELOW = 44;
/** Beside a clicked body: the card's near edge this far from the body's centre (clear of the gladiator at the camp's zoom). */
const SIDE = 40;
/**
 * The narrowest a card is made to sit beside a panel (it is 520 px wide when it has the room): measured, the card's sections fit
 * without a sideways scroll from 280 px (Task 21; it was a 300 px floor that could lie over the panel).
 */
const MIN_CARD = 280, CARD_WIDTH = 520;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

/**
 * Where the card sits on desktop. Beside a clicked gladiator: centred over them and above their head, or below their feet
 * when there is no room above; beside the open menu panel otherwise (right of a left panel, left of a right panel, left of a
 * panel above a bottom bar, or right of it when there is no room). Always clear of the rail, below the corner chip, in the view.
 */
export function placeCard(screen: Point | null, card: Size, view: Size, side: MenuSide = { place: 'left', panel: null }): { left: number; top: number; width?: number; covers?: true } {
  const { place, panel } = side;
  const minLeft = place === 'left' ? RAIL_RIGHT : MARGIN;
  const maxLeft = view.width - card.width - (place === 'right' ? RAIL_SIDE : MARGIN);
  const maxTop = view.height - card.height - (place === 'bottom' ? BAR : MARGIN);
  if (!screen) {
    // A left panel starts under the chip row; right and bottom panels start below the chip and the notices, so the card lines up
    // with the panel's top.
    const top = place === 'left' ? TOP : clamp(panel?.top ?? TOP, TOP, Math.max(TOP, maxTop));
    const panelLeft = panel?.left ?? (place === 'left' ? RAIL_RIGHT : place === 'right' ? view.width - 78 - 380 : view.width / 2 - 190);
    const panelWidth = panel?.width ?? PANEL_RIGHT - MARGIN - RAIL_RIGHT;
    // Room left of the panel (not beside a left rail), and right of it (not beside a right rail). A left panel's card prefers its right.
    const leftRoom = place === 'left' ? 0 : panelLeft - MARGIN - minLeft;
    const rightRoom = place === 'right' ? 0 : view.width - MARGIN - (panelLeft + panelWidth + MARGIN);
    if (card.width <= leftRoom) return { left: panelLeft - MARGIN - card.width, top };
    if (card.width <= rightRoom) return { left: panelLeft + panelWidth + MARGIN, top };
    // Neither side holds the full card: it narrows to the roomier side rather than lie over the panel.
    const roomier = rightRoom > leftRoom ? 'right' : 'left';
    const room = Math.floor(roomier === 'right' ? rightRoom : leftRoom);
    if (room >= MIN_CARD) return roomier === 'right' ? { left: panelLeft + panelWidth + MARGIN, top, width: room } : { left: panelLeft - MARGIN - room, top, width: room };
    // Task 21: not even the narrowest card fits beside it (a pointer window under about 750 px, or 990 px with the bar at the
    // bottom). Rather than lie partly over the panel, the card replaces it while it is open: on the panel's own box, at its width
    // (`covers`: the shell hides the panel and makes it inert meanwhile, fix round 1).
    return { left: panelLeft, top, width: panelWidth, covers: true };
  }
  const above = screen.y - ABOVE - card.height, below = screen.y + BELOW;
  const centred = clamp(screen.x - card.width / 2, minLeft, maxLeft);
  if (above >= TOP) return { left: centred, top: above };
  if (below <= maxTop) return { left: centred, top: below };
  // Task 11c: a card too tall for either (the richer card in a short window) sits beside the gladiator instead, right of the click
  // or, near the right edge, left of it, so the gladiator stays in view.
  const right = screen.x + SIDE, left = screen.x - SIDE - card.width;
  return { left: right <= maxLeft ? right : left >= minLeft ? left : centred, top: clamp(screen.y - card.height / 2, TOP, maxTop) };
}

/**
 * Why Follow cannot apply to `actor` now (the camera only follows a gladiator drawn in the camp), or null. A gladiator
 * resting at home is never drawn, whatever the roster last said (Task 23.9 fix round 1).
 */
function followReasonOf(actor: PublicActor, roster: Roster | null, sceneStatus: 'loading' | 'ready' | 'unavailable'): string | null {
  if (sceneStatus === 'unavailable') return 'The camp view is unavailable, so gladiators cannot be shown on the map.';
  if (sceneStatus === 'loading' || !roster) return 'The camp view is still opening.';
  if (!actor.resting && roster.inCamp.includes(actor.gladiatorId)) return null;
  const dungeon = dungeonPlace(actor.location);
  return dungeon ? `${actor.name} is away. ${dungeon}.`
    : isAway(actor) ? `${actor.name} is away on an expedition.` : `${actor.name} is not in the camp right now.`;
}

/** The profile card over the camp: resolves the actor, loads the public profile and places the card. */
export function ProfileLayer({ target, world, reads, ownerId, ownPlace = null, roster, sceneStatus, following, nowMs, menuPlace = 'left', onFollow, onWatch, onOpenMenu, onClose,
  onCover, onSpar, compare, onWatchHistory }: {
  target: ProfileTarget;
  world: WorldSnapshot | null;
  /** Public profile reads (null until the fixture preview's reads load), and the history reads (Patch 1.9 Task 27). */
  reads: (Pick<GameGateway, 'profile'> & HistoryReads) | null;
  /** The viewer's own gladiator, or null. */
  ownerId: string | null;
  /** The owner's own words while its gladiator rests at home, for its own card (Task 23.9 fix round 1). */
  ownPlace?: string | null;
  roster: Roster | null;
  sceneStatus: 'loading' | 'ready' | 'unavailable';
  /** The gladiator the camera follows, or null. */
  following: string | null;
  /** The viewer's clock (the shell's minute clock), for "In camp since". */
  nowMs: number;
  /** The edge the menu is on (Settings): the card sits beside the open panel there. */
  menuPlace?: MenuPlace;
  onFollow(gladiatorId: string): void;
  onWatch(activityId: string, gladiatorId: string): void;
  onOpenMenu(id: MenuId): void;
  onClose(): void;
  /** Whether the card replaces the open panel now (no side of it holds the card: `placeCard`'s `covers`), told on every placement. */
  onCover?(covers: boolean): void;
  /** ⚔ Spar a copy: a player's (Patch 1.9 Task 19). */
  onSpar?(copy: PracticeSide): void;
  /** ⇄ Compare with mine: a player's (Patch 1.9 Task 23c); the state is the shell's. */
  compare?: CompareProp;
  /** ▶ Watch on a history row (Patch 1.9 Task 27): the shell opens the scene (its origin this card's History), told the gladiator's name. */
  onWatchHistory?(view: SceneView, name: string): void;
}) {
  const card = useRef<HTMLElement>(null);
  const [loaded, setLoaded] = useState<{ profile: ProfileRead | null; failed: boolean } | null>(null);
  const [place, setPlace] = useState<{ left: number; top: number; width?: number } | null>(null);
  // A card narrowed to fit beside a panel measures its narrow width; its natural one (CARD_WIDTH) is what it asks the room for.
  const narrowed = useRef(false);
  // The shell's cover callback, read at each placement; the panel comes back when the card goes.
  const onCoverRef = useRef(onCover);
  onCoverRef.current = onCover;
  useLayoutEffect(() => () => onCoverRef.current?.(false), []);
  const id = target.gladiatorId;
  // The card's history: read only when it is shown; the viewer's own card asks for its own rewards too.
  const history = useMemo(() => (reads?.history ? createHistoryStore(reads, id, ownerId === id) : null), [reads, id, ownerId]);

  useEffect(() => {
    if (!reads) return;
    let alive = true;
    reads.profile(id).then(profile => { if (alive) setLoaded({ profile, failed: false }); }, () => { if (alive) setLoaded({ profile: null, failed: true }); });
    return () => { alive = false; };
  }, [reads, id]);

  // A card that opens on its History gives the focus to the History's ← instead (ProfileCard), once its gladiator is known.
  useEffect(() => { if (target.focus && !target.history) card.current?.focus({ preventScroll: true }); }, [target.focus, target.history]);

  // Placed before paint, and again when the card's size (a loaded profile) or the window changes. Touch: CSS places the sheet.
  const screen = target.screen;
  useLayoutEffect(() => {
    const element = card.current;
    if (!element) return;
    const update = () => {
      if (window.matchMedia?.(COMPACT_QUERY).matches) { setPlace(null); onCoverRef.current?.(false); return; }
      const surface = document.querySelector<HTMLElement>('[data-menu-surface]:not([hidden])');
      const panel = surface ? { left: surface.offsetLeft, top: surface.offsetTop, width: surface.offsetWidth } : null;
      const next = placeCard(screen, { width: narrowed.current ? CARD_WIDTH : element.offsetWidth, height: element.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, { place: menuPlace, panel });
      narrowed.current = next.width !== undefined;
      onCoverRef.current?.(!!next.covers);
      setPlace(current => (current && current.left === next.left && current.top === next.top && current.width === next.width ? current : { left: next.left, top: next.top, width: next.width }));
    };
    update();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    observer?.observe(element);
    // The open panel too (Task 21): after a resize it moves (and so resizes) once the shell has measured the notices again, and a
    // card beside or over it follows.
    const surface = document.querySelector<HTMLElement>('[data-menu-surface]:not([hidden])');
    if (surface) observer?.observe(surface);
    window.addEventListener('resize', update);
    return () => { observer?.disconnect(); window.removeEventListener('resize', update); };
  }, [screen, menuPlace]);

  const actor = world?.actors.find(a => a.gladiatorId === id) ?? loaded?.profile?.actor ?? null;
  const name = actor?.name ?? target.name;
  const style = place ? ({ '--card-left': `${place.left}px`, '--card-top': `${place.top}px`, ...(place.width ? { '--card-width': `${place.width}px` } : {}) } as CSSProperties) : undefined;
  return (
    <section ref={card} className={styles.card} role="dialog" aria-label={`Profile: ${name}`} tabIndex={-1} style={style} data-profile-card="">
      <button type="button" className={styles.close} aria-label="Close profile" onClick={onClose}>×</button>
      {actor ? (
        <ProfileCard key={id} actor={actor} profile={loaded?.profile ?? null} profileFailed={loaded?.failed ?? false} own={ownerId === id} ownPlace={ownPlace} record={target.record}
          followReason={followReasonOf(actor, roster, sceneStatus)} following={following === id} nowMs={nowMs} onFollow={onFollow}
          onWatch={activityId => onWatch(activityId, id)} onOpenMenu={onOpenMenu} onSpar={onSpar} compare={compare} history={history} initialHistory={target.history}
          onWatchHistory={(view, kind) => onWatchHistory?.(withHistoryOrigin(view, { gladiatorId: id, kind }), actor.name)} />
      ) : <div className={styles.body} data-testid="profile-body">
        <div className={styles.headPlain}><h2 className={styles.name}>{name}</h2></div>
        {target.record && <dl className={styles.facts}><div><dt>Record</dt><dd>{target.record.wins}–{target.record.losses}</dd></div></dl>}
        <p className={styles.reason} role="status">{loaded?.failed ? 'This profile is not available right now.' : 'Loading the profile…'}</p>
      </div>}
    </section>
  );
}
