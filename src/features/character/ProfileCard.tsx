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
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { PublicActor, PublicProfile, WorldSnapshot } from '@contracts/reads';
import type { GameGateway } from '../../lib/api/gateway';
import type { Point } from '../../game/iso';
import type { MenuId } from '../shell/menus';
import { COMPACT_QUERY } from '../shell/rail-reveal';
import type { Roster } from './RosterPanel';
import { classLine, gearText, isAway, placeOf } from './actor-text';
import { ownRestingText } from './activity-status';
import { badgeText, titleText } from '../seasons/season-text';
import styles from './ProfileCard.module.css';

export type ProfileRecord = { wins: number; losses: number };

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

export function ProfileCard({ actor, profile, profileFailed = false, own, ownPlace = null, record = null, followReason = null, following = false, onFollow, onWatch,
  onOpenMenu }: {
  actor: PublicActor;
  /** The public profile, once loaded (null while it loads or when it failed). */
  profile: PublicProfile | null;
  profileFailed?: boolean;
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
  return <>
    <div className={styles.head}>
      {own && <p className="eyebrow">YOUR GLADIATOR</p>}
      <h2 className={styles.name}>{actor.name}</h2>
      {title && <p className={styles.title}>{title}</p>}
      <p className={styles.class}>{classLine(actor)}</p>
      {awards.length > 0 && <ul className={styles.badges} aria-label="Season badges">{awards.map(award => <li key={award.seasonId}>{badgeText(award)}</li>)}</ul>}
    </div>
    <dl className={styles.facts}>
      <div><dt>Now</dt><dd>{own && actor.resting ? ownPlace ?? ownRestingText(null) : placeOf(actor)}</dd></div>
      <div><dt>{record ? 'Rating · record' : 'Rating'}</dt><dd>{record ? `${rating} · ${record.wins}–${record.losses}` : rating}</dd></div>
      <div><dt>Equipped</dt><dd>{gearText(actor.equipmentSilhouettes)}</dd></div>
    </dl>
    {followReason && <p id={reasonId} className={styles.reason}>{followReason}</p>}
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
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

/**
 * Where the card sits on desktop. Beside a clicked gladiator: centred over them and above their head, or below their feet
 * when there is no room above; beside the menus otherwise. Always right of the rail, below the corner chip, in the view.
 */
export function placeCard(screen: Point | null, card: Size, view: Size): { left: number; top: number } {
  const maxLeft = view.width - card.width - MARGIN, maxTop = view.height - card.height - MARGIN;
  if (!screen) return { left: clamp(PANEL_RIGHT, RAIL_RIGHT, maxLeft), top: TOP };
  const above = screen.y - ABOVE - card.height;
  return {
    left: clamp(screen.x - card.width / 2, RAIL_RIGHT, maxLeft),
    top: clamp(above >= TOP ? above : screen.y + BELOW, TOP, maxTop),
  };
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
export function ProfileLayer({ target, world, reads, ownerId, ownPlace = null, roster, sceneStatus, following, onFollow, onWatch, onOpenMenu, onClose }: {
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
  onFollow(gladiatorId: string): void;
  onWatch(activityId: string, gladiatorId: string): void;
  onOpenMenu(id: MenuId): void;
  onClose(): void;
}) {
  const card = useRef<HTMLElement>(null);
  const [loaded, setLoaded] = useState<{ profile: PublicProfile | null; failed: boolean } | null>(null);
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
          followReason={followReasonOf(actor, roster, sceneStatus)} following={following === id} onFollow={onFollow}
          onWatch={activityId => onWatch(activityId, id)} onOpenMenu={onOpenMenu} />
      ) : <>
        <div className={styles.head}><h2 className={styles.name}>{name}</h2></div>
        {target.record && <dl className={styles.facts}><div><dt>Record</dt><dd>{target.record.wins}–{target.record.losses}</dd></div></dl>}
        <p className={styles.reason} role="status">{loaded?.failed ? 'This profile is not available right now.' : 'Loading the profile…'}</p>
      </>}
    </section>
  );
}
