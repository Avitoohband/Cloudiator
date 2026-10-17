'use client';

// The "Gladiators" menu: everyone in the shared world, with a name filter, and Find (centre the camera on them) and
// Follow (keep them in view) for each gladiator drawn in the camp; a player also gets Find and Follow for their own.
// Gladiators away on an expedition say so instead (the link to their expedition arrives in Task 13.8). Every world click
// has this keyboard path. Without a camp view (no WebGL, art that failed to load) the buttons stay, disabled with the
// reason. Names render as React text.
import { useId, useState } from 'react';
import type { PublicActor, WorldSnapshot } from '@contracts/reads';
import type { SceneBridge } from '../../game/bridge';
import styles from './CharacterPanel.module.css';

/** The scene's last `roster` event: who is drawn in the camp, and who is away. */
export type Roster = { inCamp: readonly string[]; away: readonly { gladiatorId: string; name: string; location: string }[] };

const PLACE: Record<string, string> = {
  orientation: 'Arriving at camp', camp: 'At camp', training: 'Training', rest: 'Resting', arena: 'In the arena', tournament: 'In a tournament',
};
const placeOf = (actor: PublicActor) => (actor.location.startsWith('expedition:') ? 'On an expedition' : PLACE[actor.location] ?? 'At camp');
const title = (value: string) => value[0].toUpperCase() + value.slice(1);

export function RosterPanel({ world, ownerId, roster, sceneStatus, following, bridge, onDone }: {
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
}) {
  const [filter, setFilter] = useState('');
  const reasonId = useId();
  const awayId = useId();
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
            const away = actor.location.startsWith('expedition:');
            const disabled = !!reason || !inCamp.has(actor.gladiatorId);
            return (
              <li key={actor.gladiatorId} className={styles.row}>
                <p className={styles.who}>{actor.name}{actor.gladiatorId === ownerId ? ' (you)' : ''}
                  <span>{title(actor.classId)} · Level {actor.level} · {title(actor.league)} league · {placeOf(actor)}</span>
                </p>
                {away ? <span className={styles.away}>On an expedition</span> : (
                  <span className={styles.actions}>
                    <button type="button" disabled={disabled} aria-describedby={reason ? reasonId : undefined} aria-label={`Find ${actor.name}`} onClick={() => find(actor.gladiatorId)}>Find</button>
                    <button type="button" disabled={disabled} aria-describedby={reason ? reasonId : undefined} aria-label={`Follow ${actor.name}`}
                      aria-pressed={following === actor.gladiatorId && !disabled} onClick={() => follow(actor.gladiatorId)}>Follow</button>
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
