'use client';

// The "Gladiators" menu: everyone in the shared world, with a name filter, and Find (centre the camera on them) and
// Follow (keep them in view) for each gladiator drawn in the camp; a player also gets Find and Follow for their own.
// Gladiators away on an expedition offer "Watch expedition" instead, which opens their expedition as a scene over the
// camp (the bridge's `view-expedition`, Task 13.8); the menu stays open beneath it to come back to. Each name opens
// that gladiator's profile card (Task 13.7). Every world click has this keyboard path. Without a camp view (no WebGL,
// art that failed to load), or for a gladiator the camp does not draw, the buttons stay, disabled with the reason.
// Names render as React text.
import { useId, useState } from 'react';
import type { WorldSnapshot } from '@contracts/reads';
import type { SceneBridge } from '../../game/bridge';
import { classLine, isAway, placeOf } from './actor-text';
import styles from './CharacterPanel.module.css';

/** The scene's last `roster` event: who is drawn in the camp, and who is away. */
export type Roster = { inCamp: readonly string[]; away: readonly { gladiatorId: string; name: string; location: string }[] };

export function RosterPanel({ world, ownerId, roster, sceneStatus, following, bridge, onDone, onProfile }: {
  world: WorldSnapshot | null;
  /** The player's own gladiator, or null for a visitor. */
  ownerId: string | null;
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
  const reason = sceneStatus === 'unavailable' ? 'The camp view is unavailable, so gladiators cannot be shown on the map.'
    : sceneStatus === 'loading' || !roster ? 'The camp view is still opening.' : null;
  const inCamp = new Set(roster?.inCamp ?? []);
  const query = filter.trim().toLowerCase();
  const actors = [...(world?.actors ?? [])].filter(a => a.name.toLowerCase().includes(query)).sort((a, b) => a.name.localeCompare(b.name));
  const find = (gladiatorId: string) => { bridge.emit('find-character', { gladiatorId }); onDone(); };
  const follow = (gladiatorId: string) => { bridge.emit('follow-character', { gladiatorId: following === gladiatorId ? null : gladiatorId }); onDone(); };
  const ownerAway = ownerId !== null && !reason && !inCamp.has(ownerId);
  const mineDisabled = !!reason || ownerAway;
  const mineDescribedBy = reason ? reasonId : ownerAway ? awayId : undefined;
  return (
    <section aria-label="Gladiators in the world">
      {reason && <p id={reasonId} className={styles.reason}>{reason}</p>}
      {ownerId && <>
        <div className={styles.findMine} role="group" aria-label="Your gladiator">
          <button type="button" disabled={mineDisabled} aria-describedby={mineDescribedBy} onClick={() => find(ownerId)}>Find my gladiator</button>
          <button type="button" disabled={mineDisabled} aria-describedby={mineDescribedBy} aria-pressed={following === ownerId && !mineDisabled}
            onClick={() => follow(ownerId)}>Follow my gladiator</button>
        </div>
        {ownerAway && <p id={awayId} className={styles.reason}>Your gladiator is away from the camp.</p>}
      </>}
      <label className={styles.filter}>Filter by name
        <input type="search" value={filter} onChange={event => setFilter(event.target.value)} autoComplete="off" spellCheck={false} />
      </label>
      {actors.length === 0 ? <p className="muted">{world ? `No gladiator matches “${filter.trim()}”.` : 'The world is still loading.'}</p> : (
        <ul className={styles.list} aria-label="Gladiators">
          {actors.map(actor => {
            // Neither drawn in the camp nor away (13.5 review): the row says why its buttons are off.
            const away = isAway(actor);
            const absent = !reason && !away && !inCamp.has(actor.gladiatorId);
            const describedBy = reason ? reasonId : absent ? `${absentId}-${actor.gladiatorId}` : undefined;
            return (
              <li key={actor.gladiatorId} className={styles.row}>
                <p className={styles.who}>
                  <button type="button" className={styles.nameButton} aria-label={`Profile: ${actor.name}`} onClick={() => onProfile(actor.gladiatorId)}>{actor.name}</button>
                  {actor.gladiatorId === ownerId ? ' (you)' : ''}
                  <span>{classLine(actor)} · {placeOf(actor)}</span>
                  {absent && <span id={`${absentId}-${actor.gladiatorId}`}>Not in the camp right now.</span>}
                </p>
                {away ? (actor.activityId ? (
                  <span className={styles.actions}>
                    <button type="button" aria-label={`Watch ${actor.name}'s expedition`}
                      onClick={() => bridge.emit('view-expedition', { activityId: actor.activityId! })}>Watch expedition</button>
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
          })}
        </ul>
      )}
    </section>
  );
}
