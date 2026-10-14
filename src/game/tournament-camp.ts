// Pure camp tournament layout. During a tournament slot its entrants (public location `tournament`) stand in the
// arena: they wait in the staging spots, fight their revealed bouts in Task 17's sparring rings (the same CampFight
// shape, ring schedule and seek rule as regular Arena bouts, so no second arena layout), and once eliminated watch from
// spectator spots around the outside of the arena wall. The champion is marked once the final has ended. Everything
// comes from the public TournamentView through the stage core's reveal rule (a bout appears only when published and
// its round's reveal time has passed); nothing here simulates a fight, decides a result or adds an actor.
import type { PublicActor, TournamentView } from '@contracts/reads';
import type { Direction, MapData } from './assets';
import type { CampFight } from './arena-layout';
import { RULES_V1 } from '@domain/rules-v1';
import { renderTournament, tournamentIdFor, type TournamentRole } from './tournament-stage';

/** A missing or stale tournament view is asked for again this often while its slot runs. */
export const TOURNAMENT_RETRY_MS = 30_000;
const SLOT_MS = RULES_V1.clock.slotMs;

const isEntrant = (actor: PublicActor) => actor.location === 'tournament' && actor.startsAtMs !== null && !!actor.activityId;
/** The tournament an entrant is in: its league's tournament of the slot its activity started in. */
export function tournamentIdOfActor(actor: PublicActor): string {
  return tournamentIdFor(Math.floor(actor.startsAtMs! / SLOT_MS), actor.league);
}
function entrantsByTournament(actors: readonly PublicActor[]): Map<string, Map<string, PublicActor>> {
  const groups = new Map<string, Map<string, PublicActor>>();
  for (const actor of actors.filter(isEntrant)) {
    const id = tournamentIdOfActor(actor);
    const group = groups.get(id) ?? new Map<string, PublicActor>();
    group.set(actor.gladiatorId, actor);
    groups.set(id, group);
  }
  return groups;
}

const byStart = (p: CampFight, q: CampFight) => p.startedAtMs - q.startedAtMs || (p.battleId < q.battleId ? -1 : p.battleId > q.battleId ? 1 : 0);
/** Arena and tournament fights together, in start then battle-id order (as `campArenaFights` orders its own). */
export function mergeCampFights(...lists: readonly (readonly CampFight[])[]): CampFight[] {
  return lists.flat().sort(byStart);
}

/**
 * Revealed tournament bouts between two entrants in camp at the display time, from their round's reveal time on
 * (fighting or already decided, so a later round never reschedules an earlier fight). Participant 0 takes ring side a.
 */
export function campTournamentFights(actors: readonly PublicActor[], views: ReadonlyMap<string, TournamentView>, displayNowMs: number): CampFight[] {
  const fights: CampFight[] = [];
  for (const [id, entrants] of entrantsByTournament(actors)) {
    const view = views.get(id);
    if (!view) continue;
    for (const bout of renderTournament(view, displayNowMs).rounds.flatMap(r => r.bouts)) {
      if (!bout.log || (bout.status !== 'fighting' && bout.status !== 'decided')) continue;
      const ids = bout.log.participants.map(p => p.gladiatorId);
      if (!ids.every(g => g !== null && entrants.has(g))) continue;
      const [a, b] = ids as [string, string];
      fights.push({ battleId: bout.log.battleId, log: bout.log, startedAtMs: bout.revealAtMs, fighters: [a, b],
        activities: [entrants.get(a)!.activityId!, entrants.get(b)!.activityId!] });
    }
  }
  return fights.sort(byStart);
}

export type CampTournamentRole = { readonly role: TournamentRole; readonly eliminatedInRound: number | null };
/** Each camp entrant's role at the display time (only entrants whose tournament view is known). */
export function campTournamentRoles(actors: readonly PublicActor[], views: ReadonlyMap<string, TournamentView>, displayNowMs: number): Map<string, CampTournamentRole> {
  const roles = new Map<string, CampTournamentRole>();
  for (const [id, entrants] of entrantsByTournament(actors)) {
    const view = views.get(id);
    if (!view) continue;
    for (const e of renderTournament(view, displayNowMs).entrants) {
      if (e.role && entrants.has(e.gladiatorId)) roles.set(e.gladiatorId, { role: e.role, eliminatedInRound: e.eliminatedInRound });
    }
  }
  return roles;
}

export type SpectatorSpot = { readonly x: number; readonly y: number; readonly facing: Direction };
/**
 * Free walkable tiles in a band just outside the arena wall, facing the arena: none on a station, an NPC post
 * (`reserved`), another zone or the gate approach. Sides first (they hide no fight), then behind the arena, then in
 * front of it, nearest the wall first.
 */
export function spectatorSpots(map: MapData, reserved: Iterable<string> = []): SpectatorSpot[] {
  if (!map.arena) return [];
  const [cx, cy] = map.arena.centre;
  const { radius } = map.arena;
  const blocked = new Set<string>([...reserved, ...map.zones.flatMap(z => z.stations.map(s => `${s.x},${s.y}`))]);
  const others = map.zones.filter(z => z.id !== 'arena').map(z => z.bounds);
  // The gate opens to the south-east, where the posts stand on the wall circle at 45°.
  const gate = { x: cx + (radius + 1.5) * Math.SQRT1_2, y: cy + (radius + 1.5) * Math.SQRT1_2 };
  const spots: (SpectatorSpot & { band: number; d: number; angle: number })[] = [];
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    if (map.walkable[y]?.[x] !== '1' || d <= radius + 0.6 || d > radius + 2.6 || blocked.has(`${x},${y}`)) continue;
    if (others.some(b => x >= b.x && y >= b.y && x < b.x + b.w && y < b.y + b.h)) continue;
    if (Math.hypot(x + 0.5 - gate.x, y + 0.5 - gate.y) < 2.5) continue;
    const vertical = x + y - (cx + cy);
    const left = x - y < cx - cy;
    const facing: Direction = vertical < 0 ? (left ? 'se' : 'sw') : (left ? 'ne' : 'nw');
    spots.push({ x, y, facing, band: Math.abs(vertical) <= 2 ? 0 : vertical < 0 ? 1 : 2, d, angle: Math.atan2(y + 0.5 - cy, x + 0.5 - cx) });
  }
  return spots.sort((p, q) => p.band - q.band || p.d - q.d || p.angle - q.angle).map(({ x, y, facing }) => ({ x, y, facing }));
}

/**
 * Spectator spots by elimination round, then gladiator id: earlier spectators keep their spots when later rounds add
 * more. Spectators beyond the spots stay at their staging spot.
 */
export function assignSpectators(spectators: readonly { gladiatorId: string; eliminatedInRound: number | null }[], spots: readonly SpectatorSpot[]): Map<string, SpectatorSpot> {
  const order = [...spectators].sort((a, b) => (a.eliminatedInRound ?? 0) - (b.eliminatedInRound ?? 0) || (a.gladiatorId < b.gladiatorId ? -1 : a.gladiatorId > b.gladiatorId ? 1 : 0));
  return new Map(order.slice(0, spots.length).map((s, i) => [s.gladiatorId, spots[i]]));
}

export type TournamentRead = { readAtMs: number; view: TournamentView | null };
/**
 * Tournaments the camp should read now: each tournament with an entrant in camp during its slot, once; again when a
 * reveal mark (a round, the settlement) has passed since the last read; and every 30 s while the read failed or a due
 * round is unpublished. Never before the start or after the slot.
 */
export function tournamentReadsDue(actors: readonly PublicActor[], known: ReadonlyMap<string, TournamentRead>, displayNowMs: number): string[] {
  const due: string[] = [];
  for (const [id, entrants] of entrantsByTournament(actors)) {
    const start = [...entrants.values()][0].startsAtMs!;
    if (displayNowMs < start || displayNowMs >= start + SLOT_MS) continue;
    const read = known.get(id);
    if (!read) { due.push(id); continue; }
    const waited = displayNowMs - read.readAtMs >= TOURNAMENT_RETRY_MS;
    if (!read.view) { if (waited) due.push(id); continue; }
    const passed = renderTournament(read.view, read.readAtMs).revealMarks.some(mark => mark <= displayNowMs);
    if (passed || (waited && renderTournament(read.view, displayNowMs).status === 'processing')) due.push(id);
  }
  return due;
}
