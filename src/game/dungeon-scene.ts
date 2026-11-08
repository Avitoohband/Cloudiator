import type * as PhaserNS from 'phaser';
import type { PartyAttack, PartyBattleLog, PartyCombatant, PartyRole } from '@contracts/events';
import type { PublicActor, WorldSnapshot } from '@contracts/reads';
import type { Appearance } from '@domain/appearance';
import type { Dungeon, HiredRole } from '@domain/types';
import type { ActionId, AssetManifest, Direction, EffectId } from './assets';
import { layersFor, lookFor, tintFor } from './actors';
import { frameIndex, NPC_CLOTH } from './battle-stage';
import type { SceneBridge } from './bridge';
import { ZOOM_STEP } from './camera';
import type { DungeonFightOrdinal, DungeonSceneState } from './dungeon-stage';
import type { GladiatorLook } from './expedition-scene';
import { gladiatorPose, journeyMap, type JourneyMap } from './expedition-path';
import { clearOfLabel, CREATURE_FADE_MS, type LabelBox } from './expedition-creatures';
import type { JourneyPoint } from './expedition-stage';
import { tileCentre, worldToScreen, type Point } from './iso';
import { createMapCamera, createMapLayer, NAME_LABEL_DEPTH, NAME_LABEL_STYLE, type MapLayer } from './map-layer';
import { groupPartyReplay, reducePartyReplay } from './party-replay';
import { REPLAY_OUTRO_MS } from './replay';

type Phaser = typeof PhaserNS;
type Sprite = PhaserNS.GameObjects.Sprite;
type SeatLook = { id: string; gladiatorId: string | null; name: string; role: PartyRole; seat: number | null;
  appearance: Appearance | null; silhouettes: readonly string[] };
type Unit = SeatLook & {
  feet: Point; facing: Direction; scale: number; tint: number | null; creature: string | null;
  action: ActionId; animationMs: number; alpha: number; hp: number | null; max: number | null;
};
type Enemy = { id: string; ordinal: DungeonFightOrdinal; name: string; creature: string; feet: Point; scale: number; tint: number | null; facing: Direction };
type EnemyGroup = { ordinal: DungeonFightOrdinal; point: JourneyPoint; partyAnchor: Point; partyFacing: Direction; units: Enemy[] };
type Impact = { target: string; effect: EffectId; elapsedMs: number; sweep: boolean };
type DungeonFrame = {
  routePoint: JourneyPoint | null; follow: Point; party: Unit[]; enemies: Unit[]; waiting: Enemy[];
  battle: { ordinal: DungeonFightOrdinal; elapsedMs: number; battleId: string } | null; impacts: Impact[];
};

const HIRED = { 'a hired Guard': 'guard', 'a hired Striker': 'striker', 'a hired Skirmisher': 'skirmisher' } as const;
const FIGHTS = ['encounter-1', 'encounter-2', 'encounter-3', 'search-4'] as const;
const MAJOR_TINT = 0xe69e90;
const REACTION_MS = 380;
const IMPACT_MS = 260;
const BACKGROUND = 0x1f3326;

function actorNamed(world: WorldSnapshot | null, name: string): PublicActor | undefined {
  const matching = world?.actors.filter(actor => actor.name === name);
  return matching?.length === 1 ? matching[0] : undefined;
}

/** The public departure label is the only lineup before a fight log. Exact world matches supply appearance and the team marker. */
export function dungeonDepartureParty(dungeon: Dungeon, departure: string | null, world: WorldSnapshot | null): SeatLook[] {
  const prefix = `Enter ${dungeon.name} with `;
  if (!departure?.startsWith(prefix)) return [];
  const names = departure.slice(prefix.length).split(', '), tail = names.pop() ?? '';
  // Names may themselves include " and ". Prefer the split with the most exact public matches or known hired labels.
  const match = (name: string) => Number(Object.hasOwn(HIRED, name) || !!actorNamed(world, name));
  const splits = [...tail.matchAll(/ and /g)].map(({ index }) => [tail.slice(0, index), tail.slice(index + 5)]);
  const pair = splits.sort((a, b) => match(b[0]) + match(b[1]) - match(a[0]) - match(a[1]))[0];
  names.push(...(pair ?? [tail]));
  if (names.length > 3 || names.some(name => !name.trim())) return [];
  return names.map((name, seat) => {
    if (Object.hasOwn(HIRED, name)) {
      const role: HiredRole = HIRED[name as keyof typeof HIRED];
      const silhouettes = Object.values(dungeon.hired[role].equipment).filter((id): id is string => id !== null);
      return { id: `hired:${seat}`, name: name.slice(2).replace(/^h/, 'H'), seat, role: 'hireling', gladiatorId: null, appearance: null, silhouettes };
    }
    const actor = actorNamed(world, name);
    return { id: actor?.gladiatorId ?? `departure:${seat}`, gladiatorId: actor?.gladiatorId ?? null, name, seat,
      role: actor?.botTeam === 'ludus-nimbus' ? 'bot' : 'gladiator', appearance: actor?.appearance ?? null, silhouettes: actor?.equipmentSilhouettes ?? [] };
  });
}

/** Seat zero leads. Travel rows trail the facing; battle rows stagger down the field for readable silhouettes. */
export function dungeonFormation(origin: Point, facing: Direction, seat: number, fighting: boolean): Point {
  const right = facing === 'se' || facing === 'ne';
  const down = facing === 'se' || facing === 'sw';
  return { x: origin.x + (right ? -1 : 1) * seat * 20, y: origin.y + (fighting || !down ? 1 : -1) * seat * 14 };
}

export function dungeonEnemyGroups(dungeon: Dungeon, journey: JourneyMap): EnemyGroup[] {
  return FIGHTS.map((point, i) => {
    const ordinal = (i + 1) as DungeonFightOrdinal, spot = journey.encounters[i];
    const major = ordinal === 4;
    const tile = major ? journey.points['search-4'] : spot.enemy;
    const anchor = tileCentre(tile.x, tile.y), facing = major ? 'sw' : spot.enemyFacing;
    const partyAnchor = major ? { x: anchor.x - 72, y: anchor.y } : tileCentre(spot.gladiator.x, spot.gladiator.y);
    const units = (major ? [dungeon.major] : dungeon.rooms[i]).map((monster, index): Enemy => ({
      id: `waiting:${ordinal}:${index}`, ordinal, name: monster.name, creature: monster.creature, facing,
      feet: dungeonFormation(anchor, facing, index, true), scale: major ? 2 : 1, tint: major ? MAJOR_TINT : null,
    }));
    return { ordinal, point, partyAnchor, partyFacing: major ? 'se' : spot.facing, units };
  });
}

function recordedLook(unit: PartyCombatant, world: WorldSnapshot | null): SeatLook {
  const actor = unit.gladiatorId ? world?.actors.find(candidate => candidate.gladiatorId === unit.gladiatorId) : undefined;
  return { id: unit.id, gladiatorId: unit.gladiatorId, name: unit.name, seat: unit.seat, role: unit.role,
    appearance: actor?.appearance ?? null, silhouettes: unit.equipmentSilhouettes };
}

function idleEnemy(enemy: Enemy, now: number): Unit {
  return { ...enemy, gladiatorId: null, role: enemy.ordinal === 4 ? 'major' : 'monster', seat: null, silhouettes: [], appearance: null,
    action: 'idle', animationMs: now + enemy.ordinal * 370 + (enemy.feet.y % 100), hp: null, max: null, alpha: 1 };
}

function reaction(event: PartyAttack): ActionId {
  if (event.defend) return 'defend';
  if (event.evade || !event.hit) return 'evade';
  return 'hit';
}

function animationFor(log: PartyBattleLog, frame: ReturnType<typeof reducePartyReplay>, unit: PartyCombatant, hp: number, elapsed: number) {
  if (frame.result) return { action: hp === 0 ? 'defeat' : unit.side === frame.result.winnerSide ? 'victory' : 'idle', animationMs: elapsed - log.durationMs } as const;
  const groups = groupPartyReplay(log);
  for (let i = frame.groupIndex; i >= 0; i -= 1) {
    const group = groups[i], animationMs = elapsed - group.elapsedMs;
    if (animationMs >= REACTION_MS) break;
    const attack = group.events.some(event => event.kind === 'attack' && event.attackerId === unit.id);
    const hit = group.events.find((event): event is PartyAttack => event.kind === 'attack' && event.defenderId === unit.id);
    if (hp === 0) return { action: 'defeat' as const, animationMs: hit ? animationMs : REACTION_MS };
    if (attack) return { action: 'attack' as const, animationMs };
    if (hit) return { action: reaction(hit), animationMs };
  }
  return hp === 0 ? { action: 'defeat' as const, animationMs: REACTION_MS } : { action: 'idle' as const, animationMs: elapsed };
}

/** Derive a seekable map picture from published state. The camera and sprites only draw this picture. */
export function dungeonFrame(dungeon: Dungeon, journey: JourneyMap, state: DungeonSceneState, departure: string | null,
  world: WorldSnapshot | null, speed: number, options: { reduced?: boolean; replay?: boolean; groups?: EnemyGroup[] } = {}): DungeonFrame {
  const groups = options.groups ?? dungeonEnemyGroups(dungeon, journey);
  const { route, fight, displayNowMs: now } = state;
  const pose = route ? gladiatorPose(journey, route, speed, { wander: !options.reduced && !options.replay }) : null;
  let anchor = pose ? worldToScreen(pose.x, pose.y) : tileCentre(journey.points.start.x, journey.points.start.y);
  if (route?.to === 'search-4') {
    const stage = groups[3].partyAnchor;
    anchor = pose?.walking ? { ...anchor, x: Math.min(anchor.x, stage.x) } : stage;
  }
  let follow = pose?.follow ? worldToScreen(pose.follow.x, pose.follow.y) : anchor;
  const drawingFight = fight && route?.then === 'fight' && FIGHTS[fight.ordinal - 1] === route.to;
  const after = fight ? fight.elapsedMs - fight.log.durationMs - REPLAY_OUTRO_MS : 0;
  const fadingWin = fight?.log.winnerSide === 0 && !options.reduced && after < CREATURE_FADE_MS;
  const battle = drawingFight && (after <= 0 || fadingWin) && fight.elapsedMs >= 0 ? fight : null;
  const stoppedAt = state.stages.find(stage => stage.outcome === 'defeat')?.ordinal;
  const waiting = groups.flatMap(group => {
    if (group.ordinal === battle?.ordinal) return [];
    const stage = state.stages.find(value => value.ordinal === group.ordinal);
    return stage?.outcome === 'victory' ? [] : group.units;
  });
  const picture: DungeonFrame = { routePoint: route?.to ?? null, follow, party: [], enemies: [], waiting, battle: null, impacts: [] };
  if (battle) {
    const { log, elapsedMs, ordinal } = battle;
    const { partyAnchor, partyFacing, units: seats } = groups[ordinal - 1];
    const mid = seats[0].feet;
    follow = { x: (partyAnchor.x + mid.x) / 2, y: (partyAnchor.y + mid.y) / 2 + 10 };
    const frame = reducePartyReplay(log, elapsedMs);
    let enemySeat = 0;
    log.participants.forEach((unit, index) => {
      const friendly = unit.side === 0, hp = frame.hp[index];
      const enemy = friendly ? null : seats[enemySeat++];
      const facing = friendly ? partyFacing : enemy?.facing ?? 'sw';
      const feet = friendly ? dungeonFormation(partyAnchor, facing, unit.seat ?? index, true) : { ...(enemy?.feet ?? mid) };
      const animation = animationFor(log, frame, unit, hp, elapsedMs);
      if (!options.reduced && animation.action === 'attack') {
        const right = facing === 'se' || facing === 'ne';
        feet.x += (right ? 1 : -1) * Math.round(8 * Math.sin(Math.PI * Math.min(1, animation.animationMs / REACTION_MS)));
      }
      const creature = friendly ? null : /^creature:([a-z0-9-]+):/.exec(unit.id)?.[1] ?? enemy?.creature ?? null;
      const major = unit.role === 'major';
      (friendly ? picture.party : picture.enemies).push({ ...recordedLook(unit, world), ...animation, feet, facing, creature,
        scale: major ? 2 : 1, tint: major ? MAJOR_TINT : null, hp, max: unit.maxHealth,
        alpha: !friendly && after > 0 ? Math.max(0, 1 - after / CREATURE_FADE_MS) : 1 });
    });
    const since = frame.group ? elapsedMs - frame.group.elapsedMs : Infinity;
    if (!frame.finished && since < IMPACT_MS) {
      picture.impacts = (frame.group?.events ?? []).flatMap(event => event.kind === 'attack' ? [{ target: event.defenderId,
        effect: event.defend ? 'defend' : event.evade || !event.hit ? 'evade' : event.critical ? 'critical' : 'hit', elapsedMs: since, sweep: event.sweep }] : []);
    }
    return { ...picture, follow, battle: { ordinal, elapsedMs, battleId: log.battleId } };
  }
  if (!pose) return picture;
  const alpha = route?.then !== 'leave' ? 1 : options.reduced ? 0 : Math.max(0, 1 - route.walkedMs / CREATURE_FADE_MS);
  if (!alpha) return picture;
  const known = state.party;
  let roster: SeatLook[];
  if (fight) {
    const logged = fight.log.participants.filter(unit => unit.side === 0);
    const standing = logged.filter(unit => known.find(health => health.unitId === unit.id)?.hp !== 0);
    // At the safe point the last room's whole surviving lineup may have been knocked out together.
    roster = (standing.length ? standing : stoppedAt || route?.then === 'rest' ? logged : []).map(unit => recordedLook(unit, world));
  } else {
    roster = dungeonDepartureParty(dungeon, departure, world).filter(unit => known.find(health => health.unitId === unit.id || health.name === unit.name)?.hp !== 0);
    if (!roster.length) roster = known.filter(unit => unit.hp > 0).map((unit, seat) => {
      const actor = world?.actors.find(candidate => candidate.gladiatorId === unit.unitId);
      return { id: unit.unitId, gladiatorId: unit.role === 'hireling' ? null : unit.unitId, name: unit.name, role: unit.role,
        seat, appearance: actor?.appearance ?? null, silhouettes: actor?.equipmentSilhouettes ?? [] };
    });
  }
  picture.party = roster.map((unit, i) => {
    const health = known.find(value => value.unitId === unit.id || value.name === unit.name);
    const action = pose.action === 'fight' ? 'idle' : pose.action;
    return { ...unit, action, animationMs: (pose.animMs ?? now) + i * 95, facing: pose.facing,
      feet: dungeonFormation(anchor, pose.facing, i, !pose.walking), scale: 1, tint: null, creature: null,
      hp: health?.hp ?? null, max: health?.max ?? null, alpha };
  });
  return picture;
}

export function dungeonLeaderLook(dungeon: Dungeon, departure: string | null, world: WorldSnapshot | null, fight: DungeonSceneState['fight']): GladiatorLook {
  const departureLead = dungeonDepartureParty(dungeon, departure, world)[0];
  const recorded = fight?.log.participants.find(unit => unit.side === 0 && unit.seat === 0);
  const unit = recorded ? recordedLook(recorded, world) : departureLead;
  const key = unit?.id ?? 'dungeon-party';
  return { key, name: unit?.name ?? 'Party leader', ...lookFor(unit?.appearance ?? null, key, unit?.silhouettes ?? []) };
}

type Painted = { container: PhaserNS.GameObjects.Container; layers: { id: string; sprite: Sprite }[];
  label: PhaserNS.GameObjects.Text; bar: PhaserNS.GameObjects.Graphics; key: string };
export type DungeonSceneDebug = DungeonFrame & { ready: boolean; phase: DungeonSceneState['phase'] | null;
  displayNowMs: number | null; following: boolean; camera: ReturnType<ReturnType<typeof createMapCamera>['view']> };
type SceneInput = { state: DungeonSceneState; departure: string | null; world: WorldSnapshot | null; replay: boolean; paused: boolean; reduced: boolean };
export type DungeonSceneHandle = { dispose(): void; ready(): boolean; debug(): DungeonSceneDebug | null };
type SceneDeps = {
  manifest: AssetManifest; atlasData: Record<string, unknown>; assetBase: string; dungeon: Dungeon; input: () => SceneInput; bridge: SceneBridge;
  onReady(): void; onError(reason: 'assets' | 'error', message: string): void;
};

/** Renders only the view clock, with a shared map/camera layer and local atlas sprites. */
export function createDungeonScene(P: Phaser, deps: SceneDeps): { scene: PhaserNS.Scene; handle: DungeonSceneHandle } {
  const { manifest, dungeon } = deps;
  const map = manifest.maps.find(item => item.id === dungeon.map);
  if (!map?.expedition) throw new Error(`Missing dungeon map ${dungeon.map}`);
  const journey = journeyMap(map), groups = dungeonEnemyGroups(dungeon, journey), gladiator = manifest.actors.gladiator;
  const sprites = new Map<string, Painted>(), effects: Sprite[] = [];
  let ready = false, disposed = false, failed = false, snap = true;
  let layer: MapLayer | null = null, current: SceneInput | null = null, frame: DungeonFrame | null = null;

  class DungeonMapScene extends P.Scene {
    constructor() { super({ key: 'dungeon' }); }

    init() {
      this.events.once(P.Scenes.Events.DESTROY, dispose);
      const repaint = () => layer?.paint();
      this.renderer.on(P.Renderer.Events.RESTORE_WEBGL, repaint);
      this.events.once(P.Scenes.Events.DESTROY, () => this.renderer.off(P.Renderer.Events.RESTORE_WEBGL, repaint));
      this.events.on(P.Scenes.Events.WAKE, () => { snap = true; });
    }

    preload() {
      for (const key of new Set([gladiator.atlas, 'creatures', 'effects', journey.map.tilesAtlas, journey.map.propsAtlas])) {
        const atlas = manifest.atlases[key];
        this.load.atlas(key, `${deps.assetBase}${atlas.image}`, deps.atlasData[atlas.data] as object);
      }
      this.load.on(P.Loader.Events.FILE_LOAD_ERROR, (file: PhaserNS.Loader.File) => fail('assets', `could not load ${file.key}`));
    }

    create() {
      if (failed || disposed) return;
      try {
        this.cameras.main.setBackgroundColor(BACKGROUND);
        layer = createMapLayer(P, this, manifest, journey.map);
        camera.start(tileCentre(journey.points.start.x, journey.points.start.y));
        ready = true;
        this.tick();
        deps.onReady();
      } catch (error) { fail('error', error instanceof Error ? error.message : String(error)); }
    }

    update() {
      if (!ready || disposed || failed || document.visibilityState === 'hidden' || deps.input().paused) return;
      try { this.tick(); } catch (error) { fail('error', error instanceof Error ? error.message : String(error)); }
    }

    tick() {
      const next = deps.input();
      if (next !== current || !frame) {
        current = next;
        frame = dungeonFrame(dungeon, journey, next.state, next.departure, next.world, gladiator.walk.tilesPerSecond,
          { groups, reduced: next.reduced, replay: next.replay });
        layer?.update(next.state.displayNowMs, next.reduced);
        this.paint(frame, next.state.displayNowMs, next.reduced);
      }
      if (camera.following()) camera.follow(frame.follow, snap);
      snap = false;
      layer?.occlude(frame.party[0]?.feet ?? null);
    }

    paint(frame: DungeonFrame, now: number, reduced: boolean) {
      const drawn = [...frame.party, ...frame.enemies, ...frame.waiting.map(enemy => idleEnemy(enemy, now))];
      const ids = new Set(drawn.map(unit => unit.id));
      for (const [id, view] of sprites) {
        if (ids.has(id)) continue;
        view.container.destroy(); view.label.destroy(); view.bar.destroy(); sprites.delete(id);
      }
      const labels: LabelBox[] = [];
      for (const unit of drawn) this.drawUnit(unit, labels, reduced);
      let index = 0;
      if (!reduced) for (const impact of frame.impacts) {
        const target = drawn.find(unit => unit.id === impact.target);
        if (!target) continue;
        const animation = manifest.animations[manifest.effects[impact.effect]];
        const name = animation.frames[frameIndex(animation, impact.elapsedMs)];
        const sprite = effects[index] ?? (effects[index] = this.add.sprite(0, 0, 'effects', name).setDepth(NAME_LABEL_DEPTH + 2));
        sprite.setFrame(name).setPosition(target.feet.x, target.feet.y - 22 * target.scale).setVisible(true);
        if (impact.sweep) sprite.setTint(MAJOR_TINT); else sprite.clearTint();
        index++;
      }
      for (; index < effects.length; index += 1) effects[index].setVisible(false);
    }

    drawUnit(unit: Unit, labels: LabelBox[], reduced: boolean) {
      const creature = manifest.actors.creatures.find(value => value.id === unit.creature);
      const isHireling = unit.role === 'hireling';
      const look = isHireling ? { layers: layersFor(unit.silhouettes), tint: { ...tintFor(unit.id), cloth: NPC_CLOTH } }
        : lookFor(unit.appearance, unit.gladiatorId ?? unit.id, unit.silhouettes);
      const atlas = creature?.atlas ?? gladiator.atlas, layers = creature ? [''] : look.layers;
      const weapon = look.layers.find(value => value.startsWith('weapon-'))?.slice('weapon-'.length);
      const variant = unit.action === 'attack' && weapon ? gladiator.attackVariants[weapon] : undefined;
      const back = unit.facing === 'ne' || unit.facing === 'nw';
      const creatureAction = creature?.animations[unit.action as keyof typeof creature.animations];
      const directions = creature ? creatureAction ?? creature.animations.idle! : gladiator.animations[variant || unit.action];
      const animation = manifest.animations[back && directions.ne ? directions.ne : directions.se];
      const milliseconds = reduced ? (unit.action === 'defeat' ? Number.MAX_SAFE_INTEGER : 0) : unit.animationMs;
      const frame = animation.frames[frameIndex(animation, milliseconds)];
      const lookKey = [atlas, ...layers, look.tint.skin, look.tint.cloth, look.tint.hair, unit.tint].join('|');
      let view = sprites.get(unit.id);
      if (view?.key !== lookKey) {
        view?.container.destroy(); view?.label.destroy(); view?.bar.destroy();
        const art = layers.map(id => {
          const sprite = this.add.sprite(0, 0, atlas, creature ? frame : frame.replace(/^body\//, `${id}/`));
          const tintKey = gladiator.layers.find(value => value.id === id)?.tint;
          if (unit.tint !== null) sprite.setTint(unit.tint);
          else if (tintKey) sprite.setTint(look.tint[tintKey]);
          return { id, sprite };
        });
        view = { key: lookKey, layers: art, container: this.add.container(0, 0, art.map(item => item.sprite)),
          label: this.add.text(0, 0, '', NAME_LABEL_STYLE).setOrigin(0.5, 1).setDepth(NAME_LABEL_DEPTH).setResolution(2),
          bar: this.add.graphics().setDepth(NAME_LABEL_DEPTH + 1) };
        sprites.set(unit.id, view);
      }
      for (const { id, sprite } of view.layers) {
        const name = creature ? frame : frame.replace(/^body\//, `${id}/`);
        if (sprite.frame.name !== name) sprite.setFrame(name);
      }
      const x = Math.round(unit.feet.x), y = Math.round(unit.feet.y), flipped = unit.facing === 'sw' || unit.facing === 'nw';
      view.container.setPosition(x, y).setDepth(y).setScale(flipped ? -unit.scale : unit.scale, unit.scale).setAlpha(unit.alpha);
      view.label.setText(unit.role === 'bot' ? `${unit.name} · BOT` : unit.name).setAlpha(unit.alpha);
      // Show friendly names and the distinct major. Ordinary enemies in a tight group share the space with fight effects.
      const labelVisible = !creature || unit.role === 'major';
      view.label.setVisible(labelVisible);
      if (labelVisible) {
        const box = { x, y: y - (unit.action === 'defeat' ? 20 : 45 * unit.scale), width: view.label.width, height: view.label.height };
        for (const above of labels) box.y = clearOfLabel(box, above);
        view.label.setPosition(box.x, box.y);
        labels.push(box);
      }
      view.bar.clear().setAlpha(unit.alpha);
      if (unit.hp !== null && unit.max) {
        view.bar.fillStyle(0x1a1423, 1).fillRect(x - 13, y + 4, 26, 4);
        view.bar.fillStyle(creature ? 0xd78175 : 0x8ad399, 1).fillRect(x - 12, y + 5, Math.round(24 * unit.hp / unit.max), 2);
      }
    }
  }

  const scene = new DungeonMapScene();
  const camera = createMapCamera(P, scene, { map, zoom: ZOOM_STEP, bridge: deps.bridge, reducedMotion: () => deps.input().reduced,
    live: () => ready && !disposed && !failed });
  function fail(reason: 'assets' | 'error', message: string) {
    if (failed || disposed) return;
    failed = true;
    deps.onError(reason, message);
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    camera.dispose();
  }
  return { scene, handle: {
    dispose, ready: () => ready && !disposed && !failed,
    debug: () => frame ? { ...frame, ready: ready && !disposed && !failed, phase: current?.state.phase ?? null,
      displayNowMs: current?.state.displayNowMs ?? null, following: camera.following(), camera: camera.view() } : null,
  } };
}
