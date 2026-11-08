import { expect, test } from 'vitest';
import { CATALOG_V1 } from '@domain/catalog-v1';
import { loadAssetManifest } from '../../src/game/assets';
import { journeyMap } from '../../src/game/expedition-path';
import { tileCentre } from '../../src/game/iso';
import { renderDungeonStage } from '../../src/game/dungeon-stage';
import { groupPartyReplay } from '../../src/game/party-replay';
import { DUNGEON_FIXTURES } from '../fixtures/dungeons';
import { worldFixture } from '../fixtures/domain';

const scene = () => import('../../src/game/dungeon-scene');
const wolf = CATALOG_V1.dungeons['wolf-den'];
const mapOf = (dungeon: typeof wolf) => journeyMap(loadAssetManifest().maps.find(map => map.id === dungeon.map)!);
const world = { ...worldFixture, actors: [
  { ...worldFixture.actors[0], name: 'Aster and Oak', appearance: { body: 'female' as const, hair: 'long' as const, skin: 1, hairColor: 1, cloth: 1 } },
  { ...worldFixture.actors[0], gladiatorId: 'bot-id', name: 'Grit and Stone', botTeam: 'ludus-nimbus' as const },
] };

test('keeps the three departure seats in order and takes bot identity and appearance from the matching public actor', async () => {
  const { dungeonDepartureParty } = await scene();
  const party = dungeonDepartureParty(wolf, 'Enter Wolf Den with Aster and Oak, a hired Guard and Grit and Stone', world);
  expect(party.map(({ name, role, seat, gladiatorId }) => [name, role, seat, gladiatorId])).toEqual([
    ['Aster and Oak', 'gladiator', 0, world.actors[0].gladiatorId], ['Hired Guard', 'hireling', 1, null], ['Grit and Stone', 'bot', 2, 'bot-id'],
  ]);
  expect(party[0].appearance).toEqual(world.actors[0].appearance);
  expect(party[1].silhouettes).toContain(wolf.hired.guard.equipment.offHand);
  expect(dungeonDepartureParty(wolf, 'Enter Wolf Den with Aster, Grit and Stone', null).map(unit => unit.role)).toEqual(['gladiator', 'gladiator', 'gladiator']);
});

test('leads with seat zero, trails in both walking directions and keeps the logged combat rows distinct', async () => {
  const { dungeonFormation } = await scene();
  const origin = { x: 350, y: 120 };
  const [lead, rear, last] = [0, 1, 2].map(seat => dungeonFormation(origin, 'se', seat, false));
  expect(lead).toEqual(origin);
  expect(last.x).toBeLessThan(rear.x);
  expect(rear.x).toBeLessThan(lead.x);
  expect(last.y).toBeLessThan(lead.y);
  const reverse = dungeonFormation(origin, 'nw', 2, false);
  expect(reverse.x).toBeGreaterThan(lead.x);
  expect(reverse.y).toBeGreaterThan(lead.y);
  expect(dungeonFormation(origin, 'se', 2, true).y).toBeGreaterThan(lead.y);
});

test('uses the three shipped encounter points and the fourth search point with the catalog groups and larger tinted major', async () => {
  const { dungeonEnemyGroups } = await scene();
  for (const dungeon of Object.values(CATALOG_V1.dungeons)) {
    const journey = mapOf(dungeon);
    const groups = dungeonEnemyGroups(dungeon, journey);
    expect(groups.map(group => group.ordinal)).toEqual([1, 2, 3, 4]);
    for (const group of groups.slice(0, 3)) {
      const spot = journey.encounters[group.ordinal - 1];
      expect(group.partyAnchor).toEqual(tileCentre(spot.gladiator.x, spot.gladiator.y));
      expect(group.units[0].feet).toEqual(tileCentre(spot.enemy.x, spot.enemy.y));
      expect(group.units.map(unit => unit.creature)).toEqual(dungeon.rooms[group.ordinal - 1].map(monster => monster.creature));
    }
    const boss = groups[3].units[0];
    expect(boss.feet).toEqual(tileCentre(journey.points['search-4'].x, journey.points['search-4'].y));
    expect(boss.creature).toBe(dungeon.major.creature);
    expect(boss.scale).toBe(groups[0].units[0].scale + 1);
    expect(boss.tint).not.toBeNull();
  }
});

test('draws a revealed fight from its logged roster and HP, then keeps earlier knockouts out of the major', async () => {
  const { dungeonFrame } = await scene();
  const fixture = DUNGEON_FIXTURES['member-fell-party-cleared'];
  const logs = new Map(fixture.fights.map(fight => [fight.ordinal, fight.log]));
  const two = fixture.fights[1], major = fixture.fights[3];
  const at = (ms: number) => dungeonFrame(wolf, mapOf(wolf), renderDungeonStage(fixture.timeline, ms, logs), fixture.timeline.stages[0].label, world, 1);
  const second = at(two.reveal_at_ms + two.log.durationMs);
  expect(second.battle?.ordinal).toBe(2);
  expect(second.party.map(unit => unit.hp)).toEqual(two.log.finalHp.slice(0, 3));
  expect(second.party[0]).toMatchObject({ id: fixture.gladiatorId, hp: 0, action: 'defeat' });
  expect(second.waiting.map(unit => unit.ordinal)).toEqual([3, 3, 3, 4]);
  const boss = at(major.reveal_at_ms);
  expect(boss.battle?.ordinal).toBe(4);
  expect(boss.party.map(({ seat, role }) => [seat, role])).toEqual([[1, 'gladiator'], [2, 'bot']]);
  expect(boss.enemies[0]).toMatchObject({ role: 'major', scale: 2, hp: major.log.participants.at(-1)?.initialHealth });
  expect(boss.party.map(unit => unit.id)).not.toContain(fixture.gladiatorId);
});

test('follows the route to the safe point after the losing room and leaves its major unplayed', async () => {
  const { dungeonFrame } = await scene();
  const fixture = DUNGEON_FIXTURES['room-lost'];
  const dungeon = CATALOG_V1.dungeons['troll-hall'], journey = mapOf(dungeon);
  const state = renderDungeonStage(fixture.timeline, fixture.startsAtMs + 75 * 60_000,
    new Map(fixture.fights.map(fight => [fight.ordinal, fight.log])));
  const frame = dungeonFrame(dungeon, journey, state, fixture.timeline.stages[0].label, null, 1);
  expect(frame.routePoint).toBe('safe');
  expect(frame.follow).toEqual(tileCentre(journey.points.safe.x, journey.points.safe.y));
  expect(frame.battle).toBeNull();
  expect(frame.party.map(unit => unit.id)).not.toContain(fixture.gladiatorId);
  expect(frame.waiting.map(unit => unit.ordinal)).toEqual([3, 3, 3, 4]);
  expect(frame.waiting.at(-1)).toMatchObject({ ordinal: 4, creature: dungeon.major.creature });
});

test('draws all targets of one logged sweep together without shifting the stored major anchor', async () => {
  const { dungeonEnemyGroups, dungeonFrame } = await scene();
  const fixture = DUNGEON_FIXTURES['full-victory'], major = fixture.fights[3];
  const logs = new Map(fixture.fights.map(fight => [fight.ordinal, fight.log]));
  const journey = mapOf(wolf), groups = dungeonEnemyGroups(wolf, journey), anchor = { ...groups[3].units[0].feet };
  const sweep = groupPartyReplay(major.log).find(group => group.events.filter(event => event.kind === 'attack' && event.sweep).length >= 2)!;
  const at = (offset: number) => dungeonFrame(wolf, journey, renderDungeonStage(fixture.timeline, major.reveal_at_ms + sweep.elapsedMs + offset, logs),
    fixture.timeline.stages[0].label, world, 1, { groups });
  expect(at(0).impacts.filter(impact => impact.sweep).map(impact => impact.target)).toEqual(sweep.events.flatMap(event =>
    event.kind === 'attack' && event.sweep ? [event.defenderId] : []));
  const first = at(60);
  expect(first.enemies[0]).toMatchObject({ action: 'attack' });
  expect(first.enemies[0].feet).not.toEqual(anchor);
  expect(groups[3].units[0].feet).toEqual(anchor);
  expect(at(60)).toEqual(first);
});
