// Deterministic 50-gladiator public world for fixture previews and scene tests.
// Uses only public projection fields; no private schedules, wallets or seeds.
import type { PublicActor, WorldSnapshot } from '@contracts/reads';
import type { ClassId, LeagueId } from '@contracts/commands';
import { phaseOfSlot, SLOT_MS } from './lighting';
import { hashString } from './actors';

const NAMES = ['Aster', 'Brennus', 'Cassia', 'Drusus', 'Eira', 'Flavia', 'Gaius', 'Hesper', 'Ilaria', 'Jovan', 'Kael', 'Livius', 'Mira', 'Nero', 'Octavia', 'Pax',
  'Quintus', 'Rhea', 'Severus', 'Talia', 'Ursa', 'Varro', 'Wren', 'Xanthe', 'Yara', 'Zeno', 'Atticus', 'Bryn', 'Corvin', 'Dara', 'Elio', 'Fenna', 'Galen', 'Hale',
  'Isolde', 'Juno', 'Kestrel', 'Lucan', 'Maren', 'Niko', 'Orla', 'Petra', 'Remus', 'Sabine', 'Tiber', 'Una', 'Vesta', 'Wulf', 'Xeno', 'Yorick'];
const CAMP_LOCATIONS = [...Array(14).fill('training'), ...Array(12).fill('rest'), ...Array(14).fill('arena'), ...Array(4).fill('orientation'), ...Array(6).fill('camp')];
const AWAY_LOCATIONS = ['expedition:woodland', 'expedition:outpost', 'expedition:mountain'];
const LOADOUTS = [
  ['weapon-sword', 'offhand-shield'], ['weapon-axe', 'offhand-shield', 'armor-light'], ['weapon-spear', 'armor-heavy', 'head-helmet'],
  ['weapon-bow', 'armor-light', 'head-hood'], ['weapon-sword', 'armor-light'], ['weapon-axe', 'armor-heavy', 'head-helmet', 'offhand-shield'],
  ['weapon-spear', 'armor-light'], ['weapon-sword', 'offhand-shield', 'head-hood'],
];
const CLASSES: ClassId[] = ['berserker', 'guardian', 'duelist'];
const LEAGUES: LeagueId[] = ['bronze', 'bronze', 'bronze', 'silver', 'silver', 'gold', 'champion'];

/** `inCamp` gladiators spread over the camp zones plus `away` gladiators on expeditions. */
export function createDemoWorld(serverNowMs: number, inCamp = 50, away = 6): WorldSnapshot {
  const count = inCamp + away;
  const slotIndex = Math.floor(serverNowMs / SLOT_MS);
  const startsAtMs = slotIndex * SLOT_MS;
  const actors: PublicActor[] = Array.from({ length: count }, (_, i) => {
    const h = hashString(`demo-${i}`);
    const location = i < inCamp ? CAMP_LOCATIONS[i % CAMP_LOCATIONS.length] : AWAY_LOCATIONS[(i - inCamp) % AWAY_LOCATIONS.length];
    return {
      gladiatorId: `d3m0${String(i).padStart(4, '0')}-0000-4000-8000-${h.toString(16).padStart(12, '0')}`,
      name: NAMES[i % NAMES.length],
      classId: CLASSES[h % CLASSES.length],
      equipmentSilhouettes: LOADOUTS[(h >>> 3) % LOADOUTS.length],
      league: LEAGUES[(h >>> 7) % LEAGUES.length],
      level: 1 + ((h >>> 11) % 12),
      phase: phaseOfSlot(slotIndex),
      location,
      activityId: `demo-activity-${i}`,
      activityStatus: 'active',
      startsAtMs,
      endsAtMs: startsAtMs + SLOT_MS,
      visibleStage: null,
    };
  });
  return { revision: `demo-${slotIndex}`, serverNowMs, slotIndex, actors };
}

/** Fixture previews only: surround the real fixture actors with a demo crowd so the camp shows a full population. */
export function withDemoCrowd(world: WorldSnapshot, inCamp = 49, away = 6): WorldSnapshot {
  const crowd = createDemoWorld(world.serverNowMs, inCamp, away).actors.filter(a => !world.actors.some(b => b.gladiatorId === a.gladiatorId));
  return { ...world, actors: [...world.actors, ...crowd] };
}
