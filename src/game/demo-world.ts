// Deterministic 50-gladiator public world for fixture previews and scene tests.
// Uses only public projection fields; no private schedules, wallets or seeds.
import type { CampLocation, EquipmentSilhouette, PublicActor, WorldSnapshot } from '@contracts/reads';
import type { ClassId, LeagueId } from '@contracts/commands';
import { phaseOfSlot, SLOT_MS } from './lighting';
import { hashString } from './actors';

const NAMES = ['Aster', 'Brennus', 'Cassia', 'Drusus', 'Eira', 'Flavia', 'Gaius', 'Hesper', 'Ilaria', 'Jovan', 'Kael', 'Livius', 'Mira', 'Nero', 'Octavia', 'Pax',
  'Quintus', 'Rhea', 'Severus', 'Talia', 'Ursa', 'Varro', 'Wren', 'Xanthe', 'Yara', 'Zeno', 'Atticus', 'Bryn', 'Corvin', 'Dara', 'Elio', 'Fenna', 'Galen', 'Hale',
  'Isolde', 'Juno', 'Kestrel', 'Lucan', 'Maren', 'Niko', 'Orla', 'Petra', 'Remus', 'Sabine', 'Tiber', 'Una', 'Vesta', 'Wulf', 'Xeno', 'Yorick'];
const CAMP_LOCATIONS: CampLocation[] = [...Array(14).fill('training'), ...Array(12).fill('rest'), ...Array(14).fill('arena'), ...Array(4).fill('orientation'), ...Array(6).fill('camp')];
const AWAY_LOCATIONS: CampLocation[] = ['expedition:woodland', 'expedition:outpost', 'expedition:mountain'];
const LOADOUTS: EquipmentSilhouette[][] = [
  ['weapon-sword', 'offhand-shield'], ['weapon-axe', 'offhand-shield', 'armor-light'], ['weapon-spear', 'armor-heavy', 'head-helmet'],
  ['weapon-bow', 'armor-light', 'head-hood'], ['weapon-sword', 'armor-light'], ['weapon-axe', 'armor-heavy', 'head-helmet', 'offhand-shield'],
  ['weapon-spear', 'armor-light'], ['weapon-sword', 'offhand-shield', 'head-hood'],
];
const CLASSES: ClassId[] = ['berserker', 'guardian', 'duelist'];
const LEAGUES: LeagueId[] = ['bronze', 'bronze', 'bronze', 'silver', 'silver', 'gold', 'champion'];

/** Deterministic version-4-shaped UUID from a label (fixture data only). */
function demoUuid(label: string): string {
  const hex = [0, 1, 2, 3].map(k => hashString(`${label}#${k}`).toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** `inCamp` gladiators spread over the camp zones plus `away` gladiators on expeditions. */
export function createDemoWorld(serverNowMs: number, inCamp = 50, away = 6): WorldSnapshot {
  const count = inCamp + away;
  const slotIndex = Math.floor(serverNowMs / SLOT_MS);
  const startsAtMs = slotIndex * SLOT_MS;
  const actors: PublicActor[] = Array.from({ length: count }, (_, i) => {
    const h = hashString(`demo-${i}`);
    // A stride coprime with 50 spreads even a small crowd over every camp zone (all 50 still use each once).
    const location = i < inCamp ? CAMP_LOCATIONS[(i * 7) % CAMP_LOCATIONS.length] : AWAY_LOCATIONS[(i - inCamp) % AWAY_LOCATIONS.length];
    return {
      gladiatorId: demoUuid(`demo-gladiator-${i}`),
      name: NAMES[i % NAMES.length],
      classId: CLASSES[h % CLASSES.length],
      equipmentSilhouettes: LOADOUTS[(h >>> 3) % LOADOUTS.length],
      league: LEAGUES[(h >>> 7) % LEAGUES.length],
      level: 1 + ((h >>> 11) % 12),
      phase: phaseOfSlot(slotIndex),
      location,
      activityId: demoUuid(`demo-activity-${i}`),
      activityStatus: 'active',
      startsAtMs,
      endsAtMs: startsAtMs + SLOT_MS,
      visibleStage: null,
    };
  });
  return { revision: `demo-${slotIndex}`, serverNowMs, slotIndex, actors };
}

/**
 * Fixture previews only: surround the fixture actors with a demo crowd, filling the world to its 50 public rows
 * (6 of them away). When the fixture world has its own Arena entrants (with timelines), the crowd trains or rests
 * instead, so every Arena entrant in the preview has a real timeline to read.
 */
export function withDemoCrowd(world: WorldSnapshot, away = 6, rows = 50): WorldSnapshot {
  const inCamp = Math.max(0, rows - away - world.actors.length);
  const arena = world.actors.some(a => a.location === 'arena');
  const crowd = createDemoWorld(world.serverNowMs, inCamp, away).actors
    .filter(a => !world.actors.some(b => b.gladiatorId === a.gladiatorId))
    .map((a, i): PublicActor => (arena && a.location === 'arena' ? { ...a, location: i % 2 ? 'rest' : 'training' } : a));
  return { ...world, actors: [...world.actors, ...crowd] };
}
