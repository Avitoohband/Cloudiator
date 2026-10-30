'use client';

// The "Gladiators" menu: everyone in the shared world, with a name filter, and Find (centre the camera on them) and
// Follow (keep them in view) for each gladiator drawn in the camp; a player also gets Find and Follow for their own.
// Gladiators away on an expedition offer "Watch expedition" instead, which opens their expedition as a scene over the
// camp (the bridge's `view-expedition`, Task 13.8); the menu stays open beneath it to come back to. Each name opens
// that gladiator's profile card (Task 13.7). Every world click has this keyboard path. Without a camp view (no WebGL,
// art that failed to load), or for a gladiator the camp does not draw, the buttons stay, disabled with the reason.
// A gladiator resting at home (Task 23.9) is listed but not drawn: its row says so, and that is its buttons' reason. The
// owner's own resting gladiator says it in the owner's own words (`ownPlace`, fix round 1), in its row and as the reason
// Find and Follow my gladiator are off. Names render as React text.
// Patch A item 2: while anyone is new (in orientation, not resting), "NEW IN CAMP" lists the newcomers first, each name followed by
// a NEW pill, then "EVERYONE" lists the rest; a newcomer is listed once, and the filter applies to both parts.
import { useId, useState } from 'react';
import type { PublicActor, WorldSnapshot } from '@contracts/reads';
import type { SceneBridge } from '../../game/bridge';
import { newcomers } from '../arrivals/arrivals';
import { campViewReason, classLine, countLine, isAway, matchLine, placeOf, playerCounts, restingText } from './actor-text';
import { ownRestingText } from './activity-status';
import styles from './CharacterPanel.module.css';

/** The scene's last `roster` event: who is drawn in the camp, and who is away. */
export type Roster = { inCamp: readonly string[]; away: readonly { gladiatorId: string; name: string; location: string }[] };

export function RosterPanel({ world, ownerId, ownPlace = null, roster, sceneStatus, following, bridge, onDone, onProfile }: {
  world: WorldSnapshot | null;
  /** The player's own gladiator, or null for a visitor. */
  ownerId: string | null;
  /** The owner's own words while its gladiator rests at home (`ownRestingText`), or null (Task 23.9 fix round 1). */
  ownPlace?: string | null;
  roster: Roster | null;
  sceneStatus: 'loading' | 'ready' | 'unavailable';
  /** The gladiator the camera follows (the scene's last `follow-character` answer), or null. */
  following: string | null;
  bridge: SceneBridge;
  /** Find and Follow hand the view back to the camp: the menu closes. */
  onDone(): void;
  /** Opens a gladiator's profile card, as a click on them in the camp does. */
  onProfile(gladiatorId: string): void;
}) {
  const [filter, setFilter] = useState('');
  const reasonId = useId();
  const awayId = useId();
  const absentId = useId();
  const reason = campViewReason(sceneStatus, roster !== null);
  const inCamp = new Set(roster?.inCamp ?? []);
  const query = filter.trim().toLowerCase();
  const actors = [...(world?.actors ?? [])].filter(a => a.name.toLowerCase().includes(query)).sort((a, b) => a.name.localeCompare(b.name));
  const find = (gladiatorId: string) => { bridge.emit('find-character', { gladiatorId }); onDone(); };
  const follow = (gladiatorId: string) => { bridge.emit('follow-character', { gladiatorId: following === gladiatorId ? null : gladiatorId }); onDone(); };
  // The owner's gladiator resting at home is never drawn, whatever the roster last said.
  const ownResting = ownerId !== null && (world?.actors ?? []).some(a => a.gladiatorId === ownerId && a.resting && !isAway(a));
  const ownLine = ownPlace ?? ownRestingText(null);
  const ownerAway = ownerId !== null && !reason && (ownResting || !inCamp.has(ownerId));
  const mineDisabled = !!reason || ownerAway;
  const mineDescribedBy = reason ? reasonId : ownerAway ? awayId : undefined;
  // The line over the list (Patch A item 8): how many players there are and where, or how many match the filter. Counted from
  // the whole world on every render, so each world read refreshes it. Zero matches keep the "No gladiator matches" line instead.
  const counts = playerCounts(world?.actors ?? []);
  const [countLead, countWide] = query && actors.length > 0 ? matchLine(actors.length, counts.total, filter.trim()) : countLine(counts, false);
  const countNarrow = query && actors.length > 0 ? countWide : countLine(counts, true)[1];
  // The newcomers first (newest first), then everyone else by name; a newcomer appears in the first part only.
  const fresh = newcomers(actors);
  const freshIds = new Set(fresh.map(a => a.gladiatorId));
  const rest = actors.filter(a => !freshIds.has(a.gladiatorId));
  const row = (actor: PublicActor, isNew: boolean) => {
    // Neither drawn in the camp nor away (13.5 review): the row says why its buttons are off. A resting gladiator is
    // never drawn, whatever the roster last said; its row says where it is instead, once.
    const away = isAway(actor);
    const resting = actor.resting && !away;
    const absent = !reason && !away && (resting || !inCamp.has(actor.gladiatorId));
    const describedBy = reason ? reasonId : absent ? `${absentId}-${actor.gladiatorId}` : undefined;
    return (
      <li key={actor.gladiatorId} className={styles.row}>
        <p className={styles.who}>
          <button type="button" className={styles.nameButton} aria-label={`Profile: ${actor.name}`} onClick={() => onProfile(actor.gladiatorId)}>{actor.name}</button>
          {actor.gladiatorId === ownerId ? ' (you)' : ''}
          {isNew && <span className={styles.newPill}>NEW</span>}
          <span>{resting ? classLine(actor) : `${classLine(actor)} · ${placeOf(actor)}`}</span>
          {(absent || resting) && <span id={`${absentId}-${actor.gladiatorId}`}>
            {!resting ? 'Not in the camp right now.' : actor.gladiatorId === ownerId ? ownLine : restingText(actor.name)}
          </span>}
        </p>
        {away ? (actor.activityId ? (
          <span className={styles.actions}>
            <button type="button" aria-label={`Watch ${actor.name}'s expedition`}
              onClick={() => bridge.emit('view-expedition', { activityId: actor.activityId!, from: 'gladiators' })}>Watch expedition</button>
          </span>
        ) : <span className={styles.away}>On an expedition</span>) : (
          <span className={styles.actions}>
            <button type="button" disabled={!!reason || absent} aria-describedby={describedBy} aria-label={`Find ${actor.name}`} onClick={() => find(actor.gladiatorId)}>Find</button>
            <button type="button" disabled={!!reason || absent} aria-describedby={describedBy} aria-label={`Follow ${actor.name}`}
              aria-pressed={following === actor.gladiatorId && !reason && !absent} onClick={() => follow(actor.gladiatorId)}>Follow</button>
          </span>
        )}
      </li>
    );
  };
  return (
    <section aria-label="Gladiators in the world">
      {reason && <p id={reasonId} className={styles.reason}>{reason}</p>}
      {ownerId && <>
        <div className={styles.findMine} role="group" aria-label="Your gladiator">
          <button type="button" disabled={mineDisabled} aria-describedby={mineDescribedBy} onClick={() => find(ownerId)}>Find my gladiator</button>
          <button type="button" disabled={mineDisabled} aria-describedby={mineDescribedBy} aria-pressed={following === ownerId && !mineDisabled}
            onClick={() => follow(ownerId)}>Follow my gladiator</button>
        </div>
        {ownerAway && <p id={awayId} className={styles.reason}>{ownResting ? ownLine : 'Your gladiator is away from the camp.'}</p>}
      </>}
      <label className={styles.filter}>Filter by name
        <input type="search" value={filter} onChange={event => setFilter(event.target.value)} autoComplete="off" spellCheck={false} />
      </label>
      {world && actors.length > 0 && (
        <p className={styles.count} data-testid="players-count">
          <b>{countLead}</b>
          {countWide === countNarrow ? <span>{countWide}</span> : <>
            <span className={styles.wide}>{countWide}</span>
            <span className={styles.narrow}>{countNarrow}</span>
          </>}
        </p>
      )}
      {actors.length === 0 ? <p className="muted">{world ? `No gladiator matches “${filter.trim()}”.` : 'The world is still loading.'}</p> : <>
        {fresh.length > 0 && <>
          <p className={`eyebrow ${styles.partTitle}`}>NEW IN CAMP</p>
          <ul className={styles.list} aria-label="New in camp">{fresh.map(actor => row(actor, true))}</ul>
        </>}
        {fresh.length > 0 && rest.length > 0 && <p className={`eyebrow ${styles.partTitle}`}>EVERYONE</p>}
        {rest.length > 0 && <ul className={styles.list} aria-label="Gladiators">{rest.map(actor => row(actor, false))}</ul>}
      </>}
    </section>
  );
}
