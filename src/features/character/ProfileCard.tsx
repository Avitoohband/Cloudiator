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
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { PublicActor, WorldSnapshot } from '@contracts/reads';
import type { GameGateway } from '../../lib/api/gateway';
import type { ProfileRead } from '../../lib/api/reads';
import type { Point } from '../../game/iso';
import type { MenuId } from '../shell/menus';
import { COMPACT_QUERY } from '../shell/rail-reveal';
import type { Roster } from './RosterPanel';
import { classLine, gearText, isAway, placeOf } from './actor-text';
import { ownRestingText } from './activity-status';
import { badgeText, seasonName, titleText } from '../seasons/season-text';
import { ActorPortrait } from './ActorPortrait';
import { ClassChips } from './ClassCard';
import { attributeRows, cardStats, gearRows, overloadLine, pointsTotal, recordText, sinceText, statRows } from './profile-card';
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
};

const RARITY_CLASS = { common: styles.rCommon, uncommon: styles.rUncommon, rare: styles.rRare } as const;

export function ProfileCard({ actor, profile, profileFailed = false, own, ownPlace = null, record = null, followReason = null, following = false, nowMs, onFollow,
  onWatch, onOpenMenu }: {
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
}) {
  const reasonId = useId();
  const rating = profile ? String(profile.rating) : profileFailed ? 'Not available' : 'Loading…';
  const bout = actor.location === 'arena' ? actor.activityId : null;
  // Season prestige (Task 21.4): the badges newest season first, and the title of the latest champion award.
  const awards = [...(profile?.prestige ?? [])].sort((p, q) => Number(q.seasonId) - Number(p.seasonId));
  const title = awards.map(titleText).find(text => text !== null) ?? null;
  // The build's sections: from the profile's build once it is read; "Loading…" before, "Not available" without a usable build.
  const build = profile?.build ?? null;
  const stats = build ? cardStats(actor.classId, build) : null;
  const missing = profile || profileFailed ? 'Not available' : 'Loading…';
  const gear = build ? gearRows(build) : null;
  const overload = stats ? overloadLine(stats) : null;
  const since = profile && profile.joinedAtMs !== null ? sinceText(profile.joinedAtMs, nowMs) : '';
  return <>
    <div className={styles.body} data-testid="profile-body">
      <div className={styles.head}>
        <ActorPortrait actor={actor} />
        <div className={styles.who}>
          {own && <p className="eyebrow">YOUR GLADIATOR</p>}
          <h2 className={styles.name}>{actor.name}</h2>
          {profile?.banner && <p className={styles.banner}><span aria-hidden="true">🚩</span> Arena banner</p>}
          {title && <p className={styles.title}>{title}</p>}
          <p className={styles.class}>{classLine(actor)}</p>
          <ClassChips classId={actor.classId} />
          {awards.length > 0 && <ul className={styles.badges} aria-label="Season badges">{awards.map(award => <li key={award.seasonId}>{badgeText(award)}</li>)}</ul>}
        </div>
      </div>
      <div className={styles.grid}>
        <section className={styles.section} aria-label="Attributes">
          <p className="eyebrow">{build ? `ATTRIBUTES · ${pointsTotal(build.allocations)} POINTS` : 'ATTRIBUTES'}</p>
          {build ? <ul className={styles.attributes}>
            {attributeRows(actor.classId, build.allocations).map(row => <li key={row.attribute}>
              <span>{row.label}{row.bonus && <span className={styles.bonus}> {row.bonus}</span>}</span>
              <span className={styles.bar} aria-hidden="true"><i style={{ width: `${row.width * 100}%` }} /></span>
              <b>{row.points}</b>
            </li>)}
          </ul> : <p className={styles.state}>{missing}</p>}
        </section>
        <section className={styles.section} aria-label="Stats">
          <p className="eyebrow">{stats && build ? `STATS · ${build.stance.toUpperCase()} STANCE` : 'STATS'}</p>
          {stats ? <>
            <dl className={`${styles.facts} ${styles.stats}`}>{statRows(stats).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
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
            <div><dt>Rating</dt><dd>{rating}</dd></div>
            {profile?.arenaRecord && <div><dt>Arena record</dt><dd>{recordText(profile.arenaRecord)}
              {profile.arenaRecord.wins + profile.arenaRecord.losses > 0 && <small> · all seasons</small>}</dd></div>}
            {record && <div><dt>{record.season ? seasonName(record.season) : 'This season'}</dt><dd>{record.wins}–{record.losses}</dd></div>}
            {since && <div><dt>In camp since</dt><dd>{since}</dd></div>}
          </dl>
          {own && profile && <p className={styles.see}>Other players see this card too.</p>}
        </section>
      </div>
      {followReason && <p id={reasonId} className={styles.reason}>{followReason}</p>}
    </div>
    <div className={styles.actions}>
      {own && <>
        <button type="button" className={styles.gold} onClick={() => onOpenMenu('gladiator')}>My gladiator</button>
        <button type="button" onClick={() => onOpenMenu('schedule')}>Schedule</button>
      </>}
      <button type="button" disabled={!!followReason} aria-describedby={followReason ? reasonId : undefined} aria-pressed={following && !followReason}
        onClick={() => onFollow(actor.gladiatorId)}>Follow</button>
      {bout && onWatch && <button type="button" onClick={() => onWatch(bout)}>Watch bout</button>}
    </div>
  </>;
}

type Size = { width: number; height: number };
/** The menus' left edge (beside the rail) and the panel's right edge (shell.module.css), the chip row's height, a margin. */
const RAIL_RIGHT = 66, PANEL_RIGHT = 66 + 380 + 12, TOP = 64, MARGIN = 12;
/** The card's bottom sits this far above a clicked body's centre (clear of the head), or its top this far below. */
const ABOVE = 64, BELOW = 44;
/** Beside a clicked body: the card's near edge this far from the body's centre (clear of the gladiator at the camp's zoom). */
const SIDE = 40;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

/**
 * Where the card sits on desktop. Beside a clicked gladiator: centred over them and above their head, or below their feet
 * when there is no room above; beside the menus otherwise. Always right of the rail, below the corner chip, in the view.
 */
export function placeCard(screen: Point | null, card: Size, view: Size): { left: number; top: number } {
  const maxLeft = view.width - card.width - MARGIN, maxTop = view.height - card.height - MARGIN;
  if (!screen) return { left: clamp(PANEL_RIGHT, RAIL_RIGHT, maxLeft), top: TOP };
  const above = screen.y - ABOVE - card.height, below = screen.y + BELOW;
  const centred = clamp(screen.x - card.width / 2, RAIL_RIGHT, maxLeft);
  if (above >= TOP) return { left: centred, top: above };
  if (below <= maxTop) return { left: centred, top: below };
  // Task 11c: a card too tall for either (the richer card in a short window) sits beside the gladiator instead, right of the click
  // or, near the right edge, left of it, so the gladiator stays in view.
  const right = screen.x + SIDE, left = screen.x - SIDE - card.width;
  return { left: right <= maxLeft ? right : left >= RAIL_RIGHT ? left : centred, top: clamp(screen.y - card.height / 2, TOP, maxTop) };
}

/**
 * Why Follow cannot apply to `actor` now (the camera only follows a gladiator drawn in the camp), or null. A gladiator
 * resting at home is never drawn, whatever the roster last said (Task 23.9 fix round 1).
 */
function followReasonOf(actor: PublicActor, roster: Roster | null, sceneStatus: 'loading' | 'ready' | 'unavailable'): string | null {
  if (sceneStatus === 'unavailable') return 'The camp view is unavailable, so gladiators cannot be shown on the map.';
  if (sceneStatus === 'loading' || !roster) return 'The camp view is still opening.';
  if (!actor.resting && roster.inCamp.includes(actor.gladiatorId)) return null;
  return isAway(actor) ? `${actor.name} is away on an expedition.` : `${actor.name} is not in the camp right now.`;
}

/** The profile card over the camp: resolves the actor, loads the public profile and places the card. */
export function ProfileLayer({ target, world, reads, ownerId, ownPlace = null, roster, sceneStatus, following, nowMs, onFollow, onWatch, onOpenMenu, onClose }: {
  target: ProfileTarget;
  world: WorldSnapshot | null;
  /** Public profile reads (null until the fixture preview's reads load). */
  reads: Pick<GameGateway, 'profile'> | null;
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
  onFollow(gladiatorId: string): void;
  onWatch(activityId: string, gladiatorId: string): void;
  onOpenMenu(id: MenuId): void;
  onClose(): void;
}) {
  const card = useRef<HTMLElement>(null);
  const [loaded, setLoaded] = useState<{ profile: ProfileRead | null; failed: boolean } | null>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const id = target.gladiatorId;

  useEffect(() => {
    if (!reads) return;
    let alive = true;
    reads.profile(id).then(profile => { if (alive) setLoaded({ profile, failed: false }); }, () => { if (alive) setLoaded({ profile: null, failed: true }); });
    return () => { alive = false; };
  }, [reads, id]);

  useEffect(() => { if (target.focus) card.current?.focus({ preventScroll: true }); }, [target.focus]);

  // Placed before paint, and again when the card's size (a loaded profile) or the window changes. Touch: CSS places the sheet.
  const screen = target.screen;
  useLayoutEffect(() => {
    const element = card.current;
    if (!element) return;
    const update = () => {
      if (window.matchMedia?.(COMPACT_QUERY).matches) { setPlace(null); return; }
      const next = placeCard(screen, { width: element.offsetWidth, height: element.offsetHeight }, { width: window.innerWidth, height: window.innerHeight });
      setPlace(current => (current && current.left === next.left && current.top === next.top ? current : next));
    };
    update();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    observer?.observe(element);
    window.addEventListener('resize', update);
    return () => { observer?.disconnect(); window.removeEventListener('resize', update); };
  }, [screen]);

  const actor = world?.actors.find(a => a.gladiatorId === id) ?? loaded?.profile?.actor ?? null;
  const name = actor?.name ?? target.name;
  const style = place ? ({ '--card-left': `${place.left}px`, '--card-top': `${place.top}px` } as CSSProperties) : undefined;
  return (
    <section ref={card} className={styles.card} role="dialog" aria-label={`Profile: ${name}`} tabIndex={-1} style={style} data-profile-card="">
      <button type="button" className={styles.close} aria-label="Close profile" onClick={onClose}>×</button>
      {actor ? (
        <ProfileCard actor={actor} profile={loaded?.profile ?? null} profileFailed={loaded?.failed ?? false} own={ownerId === id} ownPlace={ownPlace} record={target.record}
          followReason={followReasonOf(actor, roster, sceneStatus)} following={following === id} nowMs={nowMs} onFollow={onFollow}
          onWatch={activityId => onWatch(activityId, id)} onOpenMenu={onOpenMenu} />
      ) : <div className={styles.body} data-testid="profile-body">
        <div className={styles.headPlain}><h2 className={styles.name}>{name}</h2></div>
        {target.record && <dl className={styles.facts}><div><dt>Record</dt><dd>{target.record.wins}–{target.record.losses}</dd></div></dl>}
        <p className={styles.reason} role="status">{loaded?.failed ? 'This profile is not available right now.' : 'Loading the profile…'}</p>
      </div>}
    </section>
  );
}
