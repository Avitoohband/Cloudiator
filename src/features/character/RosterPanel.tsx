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
import { useClockMode } from '../../lib/clock-setting';
import { newcomers } from '../arrivals/arrivals';
import { botDutyText, campViewReason, classLine, countLine, dungeonPlace, isAway, matchLine, placeOf, playerCounts, restingText } from './actor-text';
import { BotTag } from './BotTag';
import { ownRestingText } from './activity-status';
import { titleName } from '../titles/title-text';
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
  const clock = useClockMode();
  const reasonId = useId();
  const awayId = useId();
  const absentId = useId();
  const reason = campViewReason(sceneStatus, roster !== null);
  const inCamp = new Set(roster?.inCamp ?? []);
  const query = filter.trim().toLowerCase();
  const actors = [...(world?.actors ?? [])].filter(a => a.name.toLowerCase().includes(query)).sort((a, b) => a.name.localeCompare(b.name));
  const humans = actors.filter(actor => !actor.botTeam);
  const bots = actors.filter(actor => actor.botTeam === 'ludus-nimbus');
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
  const players = world?.actors.filter(actor => !actor.botTeam) ?? [];
  const counts = playerCounts(players);
  const matching = !!query && humans.length > 0;
  const hasDungeon = players.some(actor => actor.location.startsWith('dungeon:'));
  const [countLead, countWide] = matching ? matchLine(humans.length, counts.total, filter.trim()) : countLine(counts, hasDungeon);
  const countNarrow = matching ? countWide : countLine(counts, true)[1];
  // The newcomers first (newest first), then everyone else by name; a newcomer appears in the first part only.
  const fresh = newcomers(humans);
  const freshIds = new Set(fresh.map(a => a.gladiatorId));
  const rest = humans.filter(a => !freshIds.has(a.gladiatorId));
  const row = (actor: PublicActor, isNew: boolean) => {
    // Neither drawn in the camp nor away (13.5 review): the row says why its buttons are off. A resting gladiator is
    // never drawn, whatever the roster last said; its row says where it is instead, once.
    const away = isAway(actor);
    const dungeon = dungeonPlace(actor.location);
    // Bot activities are internal. A public dungeon timeline belongs to a human member.
    const activityId = actor.botTeam ? null : actor.activityId;
    const duty = actor.botTeam ? botDutyText(actor, clock) : null;
    const resting = actor.resting && !away;
    const absent = !reason && !away && (resting || !inCamp.has(actor.gladiatorId));
    // Patch 1.7: the title worn now, by name only (the list carries no prestige, so Champion is just "Champion"); an id this client does not know shows nothing.
    const worn = titleName(actor.title);
    const describedBy = reason ? reasonId : absent ? `${absentId}-${actor.gladiatorId}` : undefined;
    return (
      <li key={actor.gladiatorId} className={styles.row}>
        <p className={styles.who}>
          <button type="button" className={styles.nameButton} aria-label={`Profile: ${actor.name}`} onClick={() => onProfile(actor.gladiatorId)}>{actor.name}</button>
          {actor.gladiatorId === ownerId ? ' (you)' : ''}
          {actor.botTeam && <BotTag />}
          {isNew && <span className={styles.newPill}>NEW</span>}
          {worn && <>{' '}<em className={styles.wornTitle}>{worn}</em></>}
          <span>{resting ? classLine(actor) : `${classLine(actor)} · ${placeOf(actor)}`}</span>
          {duty && <span>{duty}</span>}
          {(absent || resting) && <span id={`${absentId}-${actor.gladiatorId}`}>
            {!resting ? 'Not in the camp right now.' : actor.gladiatorId === ownerId ? ownLine : restingText(actor.name)}
          </span>}
        </p>
        {away ? (activityId ? (
          <span className={styles.actions}>
            <button type="button" aria-label={`Watch ${actor.name}'s ${dungeon ? 'dungeon' : 'expedition'}`}
              onClick={() => bridge.emit(dungeon ? 'view-dungeon' : 'view-expedition', { activityId, from: 'gladiators' })}>
              {dungeon ? 'Watch dungeon' : 'Watch expedition'}
            </button>
          </span>
        ) : !actor.botTeam && <span className={styles.away}>{dungeon ?? 'On an expedition'}</span>) : (
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
      {world && humans.length > 0 && (
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
        {bots.length > 0 && <>
          <p className={`eyebrow ${styles.partTitle}`}>Ludus Nimbus · {bots.length} {bots.length === 1 ? 'bot' : 'bots'} · Unranked</p>
          <p className="muted">Gladiators run by the game. Players get first pick of dungeon seats.</p>
          <ul className={styles.list} aria-label="Ludus Nimbus">{bots.map(actor => row(actor, false))}</ul>
        </>}
      </>}
    </section>
  );
}
