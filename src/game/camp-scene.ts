// The living isometric camp. Phaser is injected (loaded lazily in the browser) so this
// module stays importable during the static build. The scene only renders public world
// state; it never decides outcomes or rewards. Arena entrants warm up in staging; a revealed
// bout (from the entrants' timelines) jogs its pair into a sparring ring and plays the
// battle log there, seeked to the display time (src/game/arena-layout.ts, battle-stage.ts).
// Tournament entrants wait in staging, fight their revealed bouts in the same rings and, once
// eliminated, watch from spectator spots outside the arena wall (src/game/tournament-camp.ts).
import type * as PhaserNS from 'phaser';
import type { WorldSnapshot, PublicActor, TournamentView } from '@contracts/reads';
import type { RevealedTimeline } from '@contracts/events';
import type { ActionId, AnimationDef, AssetManifest, Direction, MapData, TilePoint } from './assets';
import { layersFor, layoutCamp, type Placement } from './actors';
import { ARENA_REVEAL_MS } from './arena-stage';
import {
  ARENA_GATE, ARENA_JOG_PACE, arenaRings, campArenaFights, fightStatus, scheduleArenaRings, type ArenaRing, type CampFight, type FightStatus, type RingSlot, type RingSpot,
} from './arena-layout';
import { assignSpectators, campTournamentFights, campTournamentRoles, mergeCampFights, spectatorSpots, type CampTournamentRole, type SpectatorSpot } from './tournament-camp';
import { LABEL_BASE, NPC_CLOTH, fighterLook, planStage, stageAt, type LabelPose, type StageFrame, type StageLayout, type StagePlan } from './battle-stage';
import { NPC_ROUTINES, facingFor, npcPostTiles, planNpcPosition, type NpcRoutine } from './npcs';
import { clampView, panBy, stepZoom, zoomAround, type ViewState } from './camera';
import { mapScreenBounds, worldToScreen, type Point, type Rect } from './iso';
import { findPath, gridFromMap, pathLength, pointAlong, type Grid } from './paths';
import { lightingAt } from './lighting';
import { drawSlices, hidesActor, type PlacedImage } from './depth';
import type { ArenaFightSummary, SceneBridge } from './bridge';

type Phaser = typeof PhaserNS;
type Sprite = PhaserNS.GameObjects.Sprite;
type Image = PhaserNS.GameObjects.Image;
type Container = PhaserNS.GameObjects.Container;

export type CampSceneDeps = {
  manifest: AssetManifest;
  atlasData: Record<string, unknown>;
  assetBase: string;
  world: WorldSnapshot | null;
  bridge: SceneBridge;
  /** Estimated server time in ms. */
  now: () => number;
  /** Gladiator to centre on when the first world arrives (the owner); the arena otherwise. */
  focusId?: () => string | null;
  reducedMotion?: boolean;
  onReady: () => void;
  onError: (reason: 'assets' | 'error', message: string) => void;
};

export type CampSceneHandle = {
  setWorld(world: WorldSnapshot): void;
  /** Revealed timelines of Arena entrants by activity id; only stages revealed by the display time are used. */
  setTimelines(timelines: ReadonlyMap<string, RevealedTimeline>): void;
  /** Public tournament views by id, for the entrants' waiting, fighting and spectating roles. */
  setTournaments(views: ReadonlyMap<string, TournamentView>): void;
  setReducedMotion(reduced: boolean): void;
  /** Removes the scene's bridge listeners. Idempotent; also runs when the game destroys the scene. */
  dispose(): void;
  debug(): CampDebugState;
  props(): PropDebug[];
  /** Centre the camera on a tile (fixture tests and evidence captures). */
  centerOn(x: number, y: number, zoom?: number): void;
  /** Canvas-relative CSS pixel position of an actor's body, or null when it is not placed. */
  screenOf(id: string): Point | null;
};

export type CampDebugActor = {
  id: string; kind: 'player' | 'npc' | 'arena-npc'; name: string; x: number; y: number;
  zone: string | null; location: string | null; action: string; frame: string;
  layers: string[]; tint: { skin: number; cloth: number; hair: number } | null;
  visible: boolean; depth: number; walking: boolean;
  /** Mirrored to face south-west (or west in a ring). */
  flip: boolean;
  /** The always-visible tag over an NPC fallback opponent, else null. */
  marker: string | null;
  /** World-space boxes of the nameplate and NPC tag drawn over the actor now. */
  plates: Rect[];
};
export type CampDebugState = {
  ready: boolean;
  disposed: boolean;
  failed: boolean;
  reducedMotion: boolean;
  players: number;
  ambientNpcs: number;
  away: number;
  camera: { centerX: number; centerY: number; zoom: number; worldView: Rect; bounds: Rect };
  actors: CampDebugActor[];
  selected: string | null;
  following: string | null;
  faded: string[];
  /** What the scene actually applied this frame. */
  lighting: { overlayColor: number; overlayAlpha: number; torchAlpha: number };
  /** Revealed bouts the camp knows, with their ring window and what each shows now. */
  arena: {
    fights: CampDebugFight[];
    effects: { effect: string; battleId: string; target: 0 | 1 }[];
    /** Damage labels drawn now, with their world-space boxes. */
    labels: { text: string; battleId: string; target: 0 | 1; box: Rect }[];
    /** Battles whose stage plan the scene keeps. */
    plans: string[];
  };
  /** Tournament entrants' roles in camp, the champion and who stands at a spectator spot. */
  tournament: { roles: Record<string, CampTournamentRole['role']>; champion: string | null; spectators: string[] };
};
export type CampDebugFight = {
  battleId: string; ring: number; status: FightStatus; positionMs: number; fighters: [string | null, string | null];
  boutStartMs: number; boutEndsAtMs: number; enterAtMs: number; fightStartMs: number; leaveAtMs: number; npc: string | null;
};
export type PropDebug = { id: string; frame: string; x: number; y: number; occludes: boolean; slices: { left: number; width: number; depth: number }[]; alpha: number };

const BG = 0x1c3f24;
const FADED_ALPHA = 0.45;
/** Wheel delta (CSS px) per zoom step: one mouse notch, or a short trackpad swipe. */
const WHEEL_STEP = 100;
/** CSS px per wheel line (deltaMode 1), so a three-line notch makes one step. */
const WHEEL_LINE = 40;
/** A pause this long ends a wheel gesture; leftover delta does not carry into the next one. */
const WHEEL_IDLE_MS = 250;
/** Pointer travel (CSS px) before a press becomes a drag. */
const DRAG_THRESHOLD = 6;
const LABEL_COLORS: Record<LabelPose['kind'], string> = { damage: '#ffffff', critical: '#ffe48f', guard: '#8edcf4', miss: '#d4d4d8' };
/** Nameplates sit this far over the feet, and an NPC tag this far when its nameplate shows too (art px). */
const PLATE_LIFT = 46;
const TAG_LIFT = 58;
/** Fight damage labels keep this gap over their target's nameplate or NPC tag. */
const LABEL_GAP = 3;
/** Arena fights are re-derived this often (display ms), and whenever new data arrives. */
const ARENA_REFRESH_MS = 1000;

type Pose = { x: number; y: number; depth: number; flip: boolean; body: string };
type ActorView = {
  id: string;
  kind: 'player' | 'npc' | 'arena-npc';
  name: string;
  container: Container;
  layers: { id: string; sprite: Sprite }[];
  look: string;
  label: PhaserNS.GameObjects.Text;
  x: number;
  y: number;
  action: string;
  facing: Direction;
  offsetMs: number;
  /** `pace` multiplies the manifest walk speed and the walk loop's frame rate (3 for a jog into an Arena ring). */
  walk: { path: TilePoint[]; startedAt: number; then: { action: ActionId; facing: Direction }; remove?: boolean; pace: number } | null;
  placement: Placement | null;
  location: string | null;
  npcRoutine?: NpcRoutine;
  npcAnimations?: AssetManifest['actors']['npcs'][number]['animations'];
  frame: string;
  flip: boolean | null;
  depth: number;
  /** Public activity and slot start (arena entrants warm up until minute 60). */
  activityId?: string | null;
  startsAtMs?: number | null;
  /** The ring side and spot this view stands on while its revealed bout is on. */
  arena?: { key: string; battleId: string; spot: RingSpot } | null;
  /** A fight pose from the battle log, drawn instead of the routine frame. */
  pose?: Pose | null;
  /** NPC fallback opponents carry a small always-visible "NPC" tag; a tournament champion a "Champion" tag. */
  marker?: PhaserNS.GameObjects.Text;
  /** The spectator spot an eliminated tournament entrant stands at. */
  spectator?: SpectatorSpot | null;
};

type PropGroup = Omit<PlacedImage, 'slices'> & {
  id: string;
  frame: string;
  x: number;
  y: number;
  occludes: boolean;
  images: Image[];
  /** Absolute screen ranges and sort depths of the drawn slices, plus their anchor-relative ranges. */
  slices: { x0: number; x1: number; depth: number; left: number; width: number }[];
};

function frameIndex(anim: AnimationDef, t: number): number {
  const total = anim.durationsMs.reduce((s, d) => s + d, 0);
  let local = anim.loop ? ((t % total) + total) % total : Math.min(Math.max(0, t), total - 1);
  for (let i = 0; i < anim.durationsMs.length; i += 1) {
    if (local < anim.durationsMs[i]) return i;
    local -= anim.durationsMs[i];
  }
  return anim.frames.length - 1;
}

const lookKey = (p: Placement) => `${p.routine.layers.join('+')}|${p.routine.tint.skin}|${p.routine.tint.cloth}|${p.routine.tint.hair}`;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createCampScene(P: Phaser, deps: CampSceneDeps): { scene: PhaserNS.Scene; handle: CampSceneHandle } {
  const { manifest } = deps;
  const map = manifest.maps.find(m => m.id === 'camp') as MapData;
  const grid: Grid = gridFromMap(map);
  const tileBounds = mapScreenBounds(map.width, map.height);
  const bounds: Rect = { x: tileBounds.x, y: tileBounds.y - 96, width: tileBounds.width, height: tileBounds.height + 96 };
  const gladiator = manifest.actors.gladiator;
  const walkTilesPerSecond = gladiator.walk.tilesPerSecond;
  const WALK_SPEED = walkTilesPerSecond / 1000; // tiles per ms
  const layerTint = new Map(gladiator.layers.map(l => [l.id, l.tint]));
  const stations = map.zones.flatMap(z => z.stations);
  const gateStation = stations.find(s => s.kind === 'gate');
  if (!gateStation) throw new Error('camp map has no gate station');
  const GATE: TilePoint = { x: gateStation.x, y: gateStation.y };
  const reserved = npcPostTiles();

  let ready = false;
  let disposed = false;
  let failed = false;
  let reducedMotion = !!deps.reducedMotion;
  let world = deps.world;
  let worldApplied = false;
  let awayCount = 0;
  let selected: string | null = null;
  let following: string | null = null;
  let placements = new Map<string, Placement>();
  const views = new Map<string, ActorView>();
  const animatedProps: { image: Image; anim: AnimationDef; index: number }[] = [];
  const propGroups: PropGroup[] = [];
  const faded = new Set<PropGroup>();
  const alphaMasks = new Map<string, { width: number; alpha: Uint8Array }>();
  const lights: { image: Image; seed: number }[] = [];
  let lastLight = { color: -1, alpha: -1, torch: -1 };
  let view: ViewState = { centerX: 0, centerY: tileBounds.height / 2, zoom: 1, viewWidth: 800, viewHeight: 600 };
  let overlay: PhaserNS.GameObjects.Rectangle | null = null;
  let ring: PhaserNS.GameObjects.Ellipse | null = null;
  let ringDepth = NaN;
  let groundChunks: { rt: PhaserNS.GameObjects.RenderTexture; left: number; top: number; tiles: { frame: string; left: number; top: number }[] }[] = [];
  // Arena: revealed bouts of the entrants in camp, their ring windows and what is drawn for them.
  const rings: ArenaRing[] = arenaRings(map);
  let timelines: ReadonlyMap<string, RevealedTimeline> = new Map();
  let arenaDirty = true;
  let arenaComputedAt = -Infinity;
  let fights: CampFight[] = [];
  let fightsKey = '';
  let schedule = new Map<string, RingSlot>();
  const plans = new Map<string, StagePlan>();
  const npcFighters = new Map<string, ActorView>();
  const effectPool: Sprite[] = [];
  const labelPool: PhaserNS.GameObjects.Text[] = [];
  // What the rings drew last frame, in reused arrays (no per-frame allocation), for debug() to report on demand.
  const drawnIds: string[] = [];
  const drawnFrames: StageFrame[] = [];
  let drawnCount = 0;
  const labelBattle: string[] = [];
  const labelTarget: (0 | 1)[] = [];
  let labelsShown = 0;
  // The Arena ring fights last told to the UI (never tournament bouts), and their statuses.
  let emittedIds: string[] = [];
  let emittedStatus: FightStatus[] = [];
  // Bouts whose ring window has ended, this frame.
  const finished = new Set<string>();
  // Fighters whose bout the rings have not finished playing (queued, jogging in or fighting), this frame.
  const unfinished = new Set<string>();
  // Tournaments: entrants' views, the bouts among the fights above, roles and spectator spots outside the wall.
  let tournaments: ReadonlyMap<string, TournamentView> = new Map();
  let tournamentBattles = new Set<string>();
  let tournamentRoles = new Map<string, CampTournamentRole>();
  let seats = new Map<string, SpectatorSpot>();
  const spots = spectatorSpots(map, reserved);

  class CampScene extends P.Scene {
    constructor() { super({ key: 'camp' }); }

    init() {
      // Game.destroy emits DESTROY (never SHUTDOWN); the host also calls dispose() directly.
      this.events.once(P.Scenes.Events.DESTROY, dispose);
      // Render textures come back empty after a WebGL context restore; repaint the baked ground.
      const repaint = () => this.paintGround();
      this.renderer.on(P.Renderer.Events.RESTORE_WEBGL, repaint);
      this.events.once(P.Scenes.Events.DESTROY, () => this.renderer.off(P.Renderer.Events.RESTORE_WEBGL, repaint));
    }

    preload() {
      const keys = new Set([gladiator.atlas, 'npcs', 'effects', map.tilesAtlas, map.propsAtlas]);
      for (const key of keys) {
        const def = manifest.atlases[key];
        this.load.atlas(key, `${deps.assetBase}${def.image}`, deps.atlasData[def.data] as object);
      }
      this.load.on(P.Loader.Events.FILE_LOAD_ERROR, (file: PhaserNS.Loader.File) => deps.onError('assets', `Could not load ${file.key}`));
    }

    create() {
      try {
        this.cameras.main.setBackgroundColor(BG);
        this.buildGround();
        this.buildProps();
        this.buildLights();
        // Large enough to cover the view at minimum zoom wherever the clamped camera sits.
        overlay = this.add.rectangle(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, bounds.width + 8000, bounds.height + 8000, 0xffffff, 0).setDepth(2_000_000);
        ring = this.add.ellipse(0, 0, 30, 14).setStrokeStyle(2, 0xffe48f).setVisible(false);
        this.buildNpcs();
        this.setupInput();
        this.scale.on(P.Scale.Events.RESIZE, () => this.syncCamera());
        const spawn = worldToScreen(map.arena!.centre[0], map.arena!.centre[1] + 4);
        view = { ...view, centerX: spawn.x, centerY: spawn.y };
        this.syncCamera();
        ready = true;
        if (world) this.applyWorld(world);
        deps.onReady();
      } catch (error) {
        this.fail(error);
      }
    }

    fail(error: unknown) {
      if (failed) return;
      failed = true;
      deps.onError('error', errorText(error));
    }

    /** Ground tiles never change, so they are baked into four render textures instead of 2,116 images. */
    buildGround() {
      const frames = manifest.atlases[map.tilesAtlas].frames;
      const tiles: { frame: string; left: number; top: number; w: number; h: number }[] = [];
      let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
      for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
        const frame = map.groundFrames[map.ground[y * map.width + x]];
        const f = frames[frame];
        const s = worldToScreen(x, y);
        const t = { frame, left: s.x - f.anchorX, top: s.y - f.anchorY, w: f.w, h: f.h };
        tiles.push(t);
        minX = Math.min(minX, t.left); minY = Math.min(minY, t.top);
        maxX = Math.max(maxX, t.left + t.w); maxY = Math.max(maxY, t.top + t.h);
      }
      const chunkW = Math.ceil((maxX - minX) / 2);
      const chunkH = Math.ceil((maxY - minY) / 2);
      groundChunks = [];
      for (let cy = 0; cy < 2; cy += 1) for (let cx = 0; cx < 2; cx += 1) {
        const left = minX + cx * chunkW;
        const top = minY + cy * chunkH;
        const rt = this.add.renderTexture(left, top, chunkW, chunkH).setOrigin(0, 0).setDepth(-10_000_000);
        const inside = tiles.filter(t => t.left < left + chunkW && t.left + t.w > left && t.top < top + chunkH && t.top + t.h > top);
        groundChunks.push({ rt, left, top, tiles: inside });
      }
      this.paintGround();
    }

    paintGround() {
      for (const { rt, left, top, tiles } of groundChunks) {
        rt.clear();
        for (const t of tiles) rt.stamp(map.tilesAtlas, t.frame, t.left - left, t.top - top, { originX: 0, originY: 0 });
        rt.render();
      }
    }

    buildProps() {
      const frames = manifest.atlases[map.propsAtlas].frames;
      for (const p of map.props) {
        const s = worldToScreen(p.x, p.y);
        const f = frames[p.frame];
        const slices = drawSlices(p, { w: f.w, anchorX: f.anchorX });
        const whole = slices.length === 1 && slices[0].left === -f.anchorX && slices[0].width === f.w;
        const group: PropGroup = {
          id: p.id, frame: p.frame, x: p.x, y: p.y, occludes: p.occludes, images: [],
          left: s.x - f.anchorX, top: s.y - f.anchorY, width: f.w, height: f.h, slices: [],
        };
        for (const slice of slices) {
          // Wide props draw as slices so actors in front of any face draw over it (src/game/depth.ts).
          const image = this.add.image(s.x, s.y, map.propsAtlas, p.frame).setDepth(s.y + slice.depthOffset);
          if (!whole) image.setCrop(slice.left + f.anchorX, 0, slice.width, f.h);
          group.images.push(image);
          group.slices.push({ x0: s.x + slice.left, x1: s.x + slice.left + slice.width, depth: s.y + slice.depthOffset, left: slice.left, width: slice.width });
        }
        propGroups.push(group);
        if (p.animation) {
          const anim = manifest.animations[`prop-${map.propsAtlas}-${p.animation}`];
          if (anim) for (const image of group.images) animatedProps.push({ image, anim, index: -1 });
        }
        if (p.interact === 'merchant-weapons' || p.interact === 'merchant-armor') {
          const merchant = p.interact === 'merchant-weapons' ? 'weapons' : 'armor';
          for (const image of group.images) {
            image.setInteractive({ useHandCursor: true });
            image.on('pointerup', (pointer: PhaserNS.Input.Pointer) => { if (!dragged(pointer)) deps.bridge.emit('open-merchant', { merchant }); });
          }
        }
      }
    }

    buildLights() {
      const size = 128;
      if (!this.textures.exists('glow')) {
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const g = canvas.getContext('2d')!;
        const grad = g.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2);
        grad.addColorStop(0, 'rgba(255,214,120,0.9)');
        grad.addColorStop(0.45, 'rgba(255,160,60,0.35)');
        grad.addColorStop(1, 'rgba(255,140,40,0)');
        g.fillStyle = grad; g.fillRect(0, 0, size, size);
        this.textures.addCanvas('glow', canvas);
      }
      map.lights.forEach((l, i) => {
        const s = worldToScreen(l.x, l.y);
        const image = this.add.image(s.x, s.y - 24, 'glow').setBlendMode(P.BlendModes.ADD).setDepth(2_000_001);
        const base = (l.radius * 32) / size;
        image.setScale(base * 2, base);
        lights.push({ image, seed: i * 1.7 });
      });
    }

    makeLabel(name: string) {
      return this.add.text(0, 0, name, { fontFamily: 'monospace', fontSize: '10px', color: '#f4e8cb', stroke: '#1a1423', strokeThickness: 3 })
        .setOrigin(0.5, 1).setDepth(2_000_002).setResolution(2).setVisible(false);
    }

    makeContainer(sprites: Sprite[]) {
      const container = this.add.container(0, 0, sprites);
      container.setSize(26, 46);
      // Phaser offsets container hit tests by the display origin (half the size), so this covers the body from
      // 13 px left to 13 px right of the feet and 46 px up: the drawn actor, not a box above and left of it.
      container.setInteractive(new P.Geom.Rectangle(0, -23, 26, 46), P.Geom.Rectangle.Contains);
      return container;
    }

    buildNpcs() {
      for (const routine of NPC_ROUTINES) {
        const npc = manifest.actors.npcs.find(n => n.id === routine.npcId);
        if (!npc) continue;
        const sprite = this.add.sprite(0, 0, npc.atlas, manifest.animations[npc.animations.idle!.se].frames[0]);
        const container = this.makeContainer([sprite]);
        const merchant = npc.role === 'merchant-weapons' ? 'weapons' : npc.role === 'merchant-armor' ? 'armor' : undefined;
        container.on('pointerup', (pointer: PhaserNS.Input.Pointer) => { if (!dragged(pointer) && merchant) deps.bridge.emit('open-merchant', { merchant }); });
        views.set(`npc:${npc.id}`, {
          id: `npc:${npc.id}`, kind: 'npc', name: npc.name, container, layers: [{ id: 'npc', sprite }], look: '', label: this.makeLabel(npc.name).setColor('#ffe48f'),
          x: 0, y: 0, action: 'idle', facing: 'se', offsetMs: 0, walk: null, placement: null, location: null,
          npcRoutine: routine, npcAnimations: npc.animations, frame: '', flip: null, depth: NaN,
        });
      }
    }

    playerSprites(placement: Placement): { id: string; sprite: Sprite }[] {
      return placement.routine.layers.map(id => {
        const sprite = this.add.sprite(0, 0, gladiator.atlas, `${id}/idle/se/0`);
        const key = layerTint.get(id);
        if (key) sprite.setTint(placement.routine.tint[key]);
        return { id, sprite };
      });
    }

    createPlayer(actor: PublicActor, placement: Placement): ActorView {
      const layers = this.playerSprites(placement);
      const container = this.makeContainer(layers.map(l => l.sprite));
      const v: ActorView = {
        id: actor.gladiatorId, kind: 'player', name: actor.name, container, layers, look: lookKey(placement),
        label: this.makeLabel(actor.name), x: placement.x + 0.5, y: placement.y + 0.5, action: placement.action, facing: placement.facing,
        offsetMs: placement.routine.offsetMs, walk: null, placement, location: actor.location, frame: '', flip: null, depth: NaN,
        activityId: actor.activityId, startsAtMs: actor.startsAtMs, arena: null, pose: null,
      };
      container.on('pointerup', (pointer: PhaserNS.Input.Pointer) => {
        if (dragged(pointer)) return;
        selected = actor.gladiatorId;
        // Where the body is drawn, so the profile card opens beside it (Task 13.7).
        deps.bridge.emit('select-character', { gladiatorId: actor.gladiatorId, screen: screenOfView(v) });
        // An Arena entrant (warming up, fighting or done) opens its Arena card.
        if (v.location === 'arena' && v.activityId) deps.bridge.emit('open-arena', { activityId: v.activityId, gladiatorId: actor.gladiatorId });
      });
      return v;
    }

    /** Public equipment or colours changed: swap the layer sprites in place. */
    restyle(v: ActorView, placement: Placement) {
      for (const l of v.layers) l.sprite.destroy();
      v.layers = this.playerSprites(placement);
      v.container.add(v.layers.map(l => l.sprite));
      v.look = lookKey(placement);
      v.frame = '';
    }

    applyWorld(next: WorldSnapshot) {
      world = next;
      // The first world shows everyone where they are; later ones walk arrivals in from the gate.
      const initial = !worldApplied;
      worldApplied = true;
      const layout = layoutCamp(next.actors, map, next.slotIndex, { reserved, previous: placements });
      placements = layout.placements;
      const now = deps.now();
      const seen = new Set<string>();
      for (const actor of next.actors) {
        const placement = placements.get(actor.gladiatorId);
        if (!placement) continue;
        seen.add(actor.gladiatorId);
        const existing = views.get(actor.gladiatorId);
        if (!existing) {
          const v = this.createPlayer(actor, placement);
          views.set(actor.gladiatorId, v);
          if (!initial) this.walkTo(v, { x: placement.x, y: placement.y }, now, { action: placement.action, facing: placement.facing }, { from: GATE });
          continue;
        }
        if (lookKey(placement) !== existing.look) this.restyle(existing, placement);
        existing.placement = placement;
        existing.location = actor.location;
        existing.offsetMs = placement.routine.offsetMs;
        existing.activityId = actor.activityId;
        existing.startsAtMs = actor.startsAtMs;
        // A fighter in a ring stays there; it walks to its new staging spot when its bout is over. A spectator
        // stays at its spot while its tournament runs (updateArena moves it).
        if (existing.arena || existing.spectator) continue;
        const target = existing.walk ? existing.walk.path[existing.walk.path.length - 1] : { x: Math.floor(existing.x), y: Math.floor(existing.y) };
        if (target.x !== placement.x || target.y !== placement.y) this.walkTo(existing, { x: placement.x, y: placement.y }, now, { action: placement.action, facing: placement.facing });
        else if (existing.walk) existing.walk.then = { action: placement.action, facing: placement.facing };
        else { existing.action = placement.action; existing.facing = placement.facing; }
      }
      for (const [id, v] of views) {
        if (v.kind !== 'player' || seen.has(id)) continue;
        const leaving = layout.away.some(a => a.gladiatorId === id);
        if (leaving && !initial) this.walkTo(v, GATE, now, { action: 'idle', facing: 'se' }, { remove: true });
        else this.removeView(v);
      }
      awayCount = layout.away.length;
      arenaDirty = true;
      const focusId = initial ? deps.focusId?.() : null;
      const owner = focusId ? views.get(focusId) : undefined;
      if (owner) this.centerOnActor(owner);
      deps.bridge.emit('roster', {
        inCamp: [...placements.keys()],
        away: layout.away.map(a => ({ gladiatorId: a.gladiatorId, name: a.name, location: a.location })),
      });
    }

    walkTo(v: ActorView, to: TilePoint, now: number, then: { action: ActionId; facing: Direction }, options: { from?: TilePoint; remove?: boolean; pace?: number } = {}) {
      const { from, remove = false, pace = 1 } = options;
      const start = from ?? { x: Math.floor(v.x), y: Math.floor(v.y) };
      const path = reducedMotion ? null : findPath(grid, start, to);
      if (!path) {
        v.walk = null;
        if (remove) { this.removeView(v); return; }
        v.x = to.x + 0.5; v.y = to.y + 0.5; v.action = then.action; v.facing = then.facing;
        return;
      }
      v.walk = { path, startedAt: now, then, remove, pace };
      if (from) { v.x = from.x + 0.5; v.y = from.y + 0.5; }
    }

    removeView(v: ActorView) {
      v.container.destroy();
      v.label.destroy();
      v.marker?.destroy();
      views.delete(v.id);
      for (const [battleId, npc] of npcFighters) if (npc === v) npcFighters.delete(battleId);
      if (selected === v.id) selected = null;
      if (following === v.id) stopFollowing();
    }

    setupInput() {
      this.input.addPointer(1);
      let pinch: { distance: number; zoom: number } | null = null;
      let wheel = 0;
      let lastWheelAt = -Infinity;
      let dragging = false;
      this.input.on(P.Input.Events.POINTER_DOWN, () => { dragging = false; });
      this.input.on(P.Input.Events.POINTER_MOVE, (pointer: PhaserNS.Input.Pointer) => {
        const p1 = this.input.pointer1;
        const p2 = this.input.pointer2;
        if (p1?.isDown && p2?.isDown && !offCanvas(p1) && !offCanvas(p2)) {
          const distance = P.Math.Distance.Between(p1.x, p1.y, p2.x, p2.y);
          if (!pinch || pinch.distance < 1) { pinch = { distance, zoom: view.zoom }; return; }
          const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
          view = zoomAround(view, (pinch.zoom * (distance / pinch.distance)) / view.zoom, mid, bounds);
          this.syncCamera();
          return;
        }
        pinch = null;
        if (!pointer.isDown || offCanvas(pointer)) return;
        // A press with a little jitter is a click, not a drag, and keeps a follow going.
        if (!dragging && P.Math.Distance.Between(pointer.downX, pointer.downY, pointer.x, pointer.y) <= DRAG_THRESHOLD) return;
        dragging = true;
        stopFollowing();
        view = panBy(view, pointer.x - pointer.prevPosition.x, pointer.y - pointer.prevPosition.y, bounds);
        this.syncCamera();
      });
      this.input.on(P.Input.Events.POINTER_UP, () => { pinch = null; dragging = false; });
      this.input.on(P.Input.Events.POINTER_WHEEL, (pointer: PhaserNS.Input.Pointer, _over: unknown, _dx: number, dy: number) => {
        if (!dy) return; // horizontal scroll never zooms
        const at = performance.now();
        // A reversal or a pause starts a fresh gesture.
        if (Math.sign(dy) !== Math.sign(wheel) || at - lastWheelAt > WHEEL_IDLE_MS) wheel = 0;
        lastWheelAt = at;
        const mode = (pointer.event as WheelEvent | undefined)?.deltaMode ?? 0;
        wheel += dy * (mode === 1 ? WHEEL_LINE : mode === 2 ? WHEEL_STEP * 3 : 1);
        const steps = Math.trunc(wheel / WHEEL_STEP);
        if (!steps) return;
        wheel -= steps * WHEEL_STEP;
        this.zoomTo(stepZoom(view.zoom, -Math.sign(steps) * Math.min(3, Math.abs(steps))), { x: pointer.x, y: pointer.y });
      });
    }

    zoomTo(zoom: number, anchor: Point) {
      view = zoomAround(view, zoom / view.zoom, anchor, bounds);
      this.syncCamera();
    }

    centerOnActor(v: ActorView) {
      const s = worldToScreen(v.x, v.y);
      view = clampView({ ...view, centerX: s.x, centerY: s.y - 24 }, bounds);
      this.syncCamera();
    }

    syncCamera() {
      const cam = this.cameras.main;
      view = clampView({ ...view, viewWidth: cam.width, viewHeight: cam.height }, bounds);
      cam.setZoom(view.zoom);
      cam.centerOn(view.centerX, view.centerY);
    }

    update() {
      if (!ready || failed || disposed) return;
      try {
        this.tick(deps.now());
      } catch (error) {
        this.fail(error);
      }
    }

    tick(now: number) {
      const cam = this.cameras.main;
      const light = lightingAt(now);
      if (overlay && (light.overlayColor !== lastLight.color || light.overlayAlpha !== lastLight.alpha)) overlay.setFillStyle(light.overlayColor, light.overlayAlpha);
      const torch = Math.min(1, 0.12 + 0.55 * light.torchIntensity);
      if (!reducedMotion || torch !== lastLight.torch) {
        for (const l of lights) l.image.setAlpha(reducedMotion ? torch : torch * (0.88 + 0.12 * Math.sin(now / 170 + l.seed)));
      }
      lastLight = { color: light.overlayColor, alpha: light.overlayAlpha, torch };
      for (const a of animatedProps) {
        const index = reducedMotion ? 0 : frameIndex(a.anim, now);
        if (index !== a.index) { a.index = index; a.image.setFrame(a.anim.frames[index]); }
      }

      this.updateArena(now);

      const viewRect = cam.worldView;
      const margin = 80;
      for (const v of views.values()) {
        if (v.pose) {
          // A fighter in a ring: drawn from the battle log (updateArena), never walked.
        } else if (v.npcRoutine) {
          const p = reducedMotion ? stillNpc(v.npcRoutine) : planNpcPosition(v.npcRoutine, map, now, walkTilesPerSecond);
          v.x = p.x; v.y = p.y; v.action = p.action; v.facing = p.facing;
        } else if (v.walk) {
          const walked = (now - v.walk.startedAt) * WALK_SPEED * v.walk.pace;
          const p = pointAlong(v.walk.path, walked);
          v.x = p.x; v.y = p.y;
          v.facing = facingFor(p.dx, p.dy, v.facing);
          v.action = 'walk';
          if (p.done || walked >= pathLength(v.walk.path)) {
            const { then, remove } = v.walk;
            v.walk = null;
            v.action = then.action;
            v.facing = then.facing;
            if (remove) { this.removeView(v); continue; }
          }
        }
        const pose = v.pose;
        const s = pose ?? worldToScreen(v.x, v.y);
        const depth = pose ? pose.depth : s.y;
        v.container.setPosition(s.x, s.y);
        if (v.depth !== depth) { v.depth = depth; v.container.setDepth(depth); }
        const visible = s.x > viewRect.x - margin && s.x < viewRect.right + margin && s.y > viewRect.y - margin && s.y < viewRect.bottom + margin * 1.5;
        if (v.container.visible !== visible) v.container.setVisible(visible);
        const showLabel = visible && (v.kind !== 'npc' ? cam.zoom >= 1.4 || selected === v.id || following === v.id : cam.zoom >= 2);
        if (v.label.visible !== showLabel) v.label.setVisible(showLabel);
        if (showLabel) v.label.setPosition(s.x, s.y - PLATE_LIFT);
        if (v.marker) {
          if (v.marker.visible !== visible) v.marker.setVisible(visible);
          if (visible) v.marker.setPosition(s.x, s.y - (showLabel ? TAG_LIFT : PLATE_LIFT));
        }
        if (visible) {
          if (pose) this.applyPose(v, pose);
          else this.updateFrames(v, now);
        }
      }
      const focus = following ?? selected;
      const fv = focus ? views.get(focus) : undefined;
      if (ring) {
        const show = !!fv && fv.container.visible;
        if (ring.visible !== show) ring.setVisible(show);
        if (fv && show) {
          const s = worldToScreen(fv.x, fv.y);
          ring.setPosition(s.x, s.y);
          if (ringDepth !== s.y - 0.5) { ringDepth = s.y - 0.5; ring.setDepth(ringDepth); }
        }
      }
      if (following && fv) {
        const s = worldToScreen(fv.x, fv.y);
        const k = reducedMotion ? 1 : 0.12;
        const centerX = view.centerX + (s.x - view.centerX) * k;
        const centerY = view.centerY + (s.y - 24 - view.centerY) * k;
        if (Math.abs(centerX - view.centerX) > 0.01 || Math.abs(centerY - view.centerY) > 0.01) {
          view = clampView({ ...view, centerX, centerY }, bounds);
          this.syncCamera();
        }
      }
      this.updateOccluders(fv);
    }

    /**
     * Arena: each revealed bout of two entrants in camp (or an entrant and its NPC fallback) jogs into its ring,
     * plays the battle log at the bout's real time once both stand there (so it ends when the Arena card shows the
     * result), holds the result and walks back to staging. Everyone else in the arena warms up until minute 60,
     * then waits in staging.
     */
    updateArena(now: number) {
      if (arenaDirty || Math.abs(now - arenaComputedAt) >= ARENA_REFRESH_MS) {
        arenaDirty = false;
        arenaComputedAt = now;
        const inCamp = (world?.actors ?? []).filter(a => views.get(a.gladiatorId)?.kind === 'player');
        const tournamentFights = campTournamentFights(inCamp, tournaments, now);
        tournamentBattles = new Set(tournamentFights.map(f => f.battleId));
        tournamentRoles = campTournamentRoles(inCamp, tournaments, now);
        seats = assignSpectators([...tournamentRoles].filter(([, r]) => r.role === 'spectating').map(([gladiatorId, r]) => ({ gladiatorId, eliminatedInRound: r.eliminatedInRound })), spots);
        const next = mergeCampFights(campArenaFights(inCamp, timelines, now), tournamentFights);
        const key = next.map(f => f.battleId).join('|');
        if (key !== fightsKey) {
          fightsKey = key;
          const kept = new Map([...schedule].filter(([id]) => next.some(f => f.battleId === id)));
          // The first bouts the camp learns show where their logged times put them; later ones never move them.
          schedule = scheduleArenaRings(next, rings.length, kept.size ? { previous: kept, knownAtMs: now } : {});
          fights = next;
          // A bout that left the camp (its fighters left, or their timelines were dropped) drops its stage plan too.
          for (const id of [...plans.keys()]) if (!schedule.has(id)) plans.delete(id);
        }
      }
      type Active = { fight: CampFight; slot: RingSlot; status: FightStatus; positionMs: number };
      const active: Active[] = [];
      const sides = new Map<string, Active & { side: 0 | 1 }>();
      finished.clear();
      unfinished.clear();
      for (const fight of fights) {
        const slot = schedule.get(fight.battleId);
        if (!slot) continue;
        const { status, positionMs } = statusOf(fight, slot, now);
        if (status === 'done') finished.add(fight.battleId);
        // The ring has not finished this bout until it shows the result (from the bout's end, once the pair stands there).
        if (status === 'queued' || status === 'entering' || status === 'fighting') for (const id of fight.fighters) if (id) unfinished.add(id);
        if (status === 'queued' || status === 'done') continue;
        const entry = { fight, slot, status, positionMs };
        active.push(entry);
        fight.fighters.forEach((id, side) => { if (id) sides.set(id, { ...entry, side: side as 0 | 1 }); });
      }

      for (const v of views.values()) {
        if (v.kind !== 'player') continue;
        v.pose = null;
        const mine = sides.get(v.id);
        if (mine) {
          const r = rings[mine.slot.ring];
          const spot = mine.side === 0 ? r.a : r.b;
          const key = `${mine.fight.battleId}:${mine.side}`;
          if (v.arena?.key !== key) {
            v.arena = { key, battleId: mine.fight.battleId, spot };
            if (mine.status === 'entering') this.walkTo(v, spot, now, { action: 'idle', facing: spot.facing }, { pace: ARENA_JOG_PACE });
            else this.standAt(v, spot, 'idle', spot.facing);
          }
        } else if (v.arena) {
          // The clock carried the bout past its end while this fighter was still jogging in (a hidden tab coming
          // back, a late read): it starts back from its ring spot, where the fight and result were due.
          if (v.walk && finished.has(v.arena.battleId)) this.standAt(v, v.arena.spot, 'idle', v.arena.spot.facing);
          v.arena = null;
          if (v.placement) this.walkTo(v, { x: v.placement.x, y: v.placement.y }, now, { action: v.placement.action, facing: v.placement.facing });
        }
        this.placeTournamentEntrant(v, now, unfinished.has(v.id));
        // Warm-up animation until the bout is revealed; it grants nothing.
        if (!v.arena && !v.walk && v.placement?.routine.kind === 'arena') {
          const warm = v.startsAtMs != null && now >= v.startsAtMs && now < v.startsAtMs + ARENA_REVEAL_MS;
          v.action = warm ? 'practice' : 'idle';
        }
      }

      // NPC fallback opponents walk in through the arena gate for their bout and out again after it.
      const npcSeen = new Set<string>();
      for (const { fight, slot, status } of active) {
        const side = fight.fighters[0] === null ? 0 : fight.fighters[1] === null ? 1 : -1;
        if (side === -1) continue;
        npcSeen.add(fight.battleId);
        if (npcFighters.has(fight.battleId)) continue;
        const r = rings[slot.ring];
        const spot = side === 0 ? r.a : r.b;
        const npc = this.createArenaNpc(fight, side, spot);
        if (status === 'entering') this.walkTo(npc, spot, now, { action: 'idle', facing: spot.facing }, { from: ARENA_GATE, pace: ARENA_JOG_PACE });
        else this.standAt(npc, spot, 'idle', spot.facing);
      }
      for (const [battleId, npc] of [...npcFighters]) {
        if (npcSeen.has(battleId)) continue;
        npcFighters.delete(battleId);
        npc.pose = null;
        if (npc.walk && npc.arena && finished.has(battleId)) this.standAt(npc, npc.arena.spot, 'idle', npc.arena.spot.facing);
        npc.arena = null;
        this.walkTo(npc, ARENA_GATE, now, { action: 'idle', facing: 'se' }, { remove: true });
      }

      // Fights: poses, effects and (for the focused fight only) damage labels, all from the logs at the bout's real
      // time. What was drawn is kept in reused arrays for debug(), which builds its report only when asked.
      const focus = following ?? selected;
      let effects = 0;
      let labels = 0;
      drawnCount = 0;
      for (const { fight, slot, status, positionMs } of active) {
        if (status === 'entering') continue;
        const r = rings[slot.ring];
        let plan = plans.get(fight.battleId);
        if (!plan) { plan = planStage(fight.log, manifest); plans.set(fight.battleId, plan); }
        const feet: StageLayout['feet'] = [worldToScreen(r.a.x + 0.5, r.a.y + 0.5), worldToScreen(r.b.x + 0.5, r.b.y + 0.5)];
        const frame = stageAt(plan, positionMs, { width: 0, height: 0, scale: 1, backdropX: 0, backdropY: 0, feet }, { reducedMotion });
        drawnIds[drawnCount] = fight.battleId;
        drawnFrames[drawnCount] = frame;
        drawnCount += 1;
        const shake = reducedMotion ? { x: 0, y: 0 } : frame.shake;
        for (const side of [0, 1] as const) {
          const id = fight.fighters[side];
          const v = id ? views.get(id) : npcFighters.get(fight.battleId);
          if (!v) continue;
          const spot = side === 0 ? r.a : r.b;
          v.walk = null;
          v.x = spot.x + 0.5; v.y = spot.y + 0.5; v.facing = spot.facing;
          const f = frame.fighters[side];
          v.action = f.action;
          v.pose = { x: f.x + shake.x, y: f.y + shake.y, depth: f.y + f.depth / 100, flip: f.flip, body: manifest.animations[f.animation].frames[f.frame] };
        }
        for (const e of frame.effects) {
          const sprite = effectPool[effects] ?? (effectPool[effects] = this.add.sprite(0, 0, 'effects', e.frameName));
          sprite.setFrame(e.frameName).setPosition(e.x + shake.x, e.y + shake.y).setFlipX(e.flip).setDepth(feet[e.target].y + 0.5).setVisible(true);
          effects += 1;
        }
        if (!focus || !fight.fighters.includes(focus) || !frame.labels.length) continue;
        for (const l of frame.labels) {
          // Each label starts just above its own target's nameplate (and NPC tag), never over one, and rises as in the
          // replay only as far as the room under a nameplate or tag drawn above it (a fighter in the ring behind).
          const base = plateTop(fight, l.target, feet[l.target].y) - LABEL_GAP;
          const text = labelPool[labels] ?? (labelPool[labels] = this.add.text(0, 0, '', { fontFamily: 'monospace', fontStyle: 'bold', fontSize: '10px', stroke: '#1a1423', strokeThickness: 3 })
            .setOrigin(0.5, 1).setResolution(2).setDepth(2_000_003));
          if (text.text !== l.text) text.setText(l.text);
          const rise = Math.min(feet[l.target].y - LABEL_BASE - l.y, headroom(l.x, text.displayWidth, base - text.displayHeight));
          text.setColor(LABEL_COLORS[l.kind]).setPosition(l.x, base - rise).setAlpha(l.alpha).setVisible(true);
          labelBattle[labels] = fight.battleId;
          labelTarget[labels] = l.target;
          labels += 1;
        }
      }
      for (let k = effects; k < effectPool.length; k += 1) if (effectPool[k].visible) effectPool[k].setVisible(false);
      for (let k = labels; k < labelPool.length; k += 1) if (labelPool[k].visible) labelPool[k].setVisible(false);
      labelsShown = labels;

      // Tell the UI which Arena bouts are in the rings, for keyboard selection; only when that changes. Tournament
      // bouts are followed in the Tournaments panel instead (they have no Arena card).
      let shown = 0;
      let changed = false;
      for (const { fight, status } of active) {
        if (tournamentBattles.has(fight.battleId)) continue;
        changed ||= emittedIds[shown] !== fight.battleId || emittedStatus[shown] !== status;
        shown += 1;
      }
      if (changed || shown !== emittedIds.length) {
        const arenaBouts = active.filter(({ fight }) => !tournamentBattles.has(fight.battleId));
        emittedIds = arenaBouts.map(a => a.fight.battleId);
        emittedStatus = arenaBouts.map(a => a.status);
        deps.bridge.emit('arena-fights', { fights: arenaBouts.map(({ fight, status }) => ({
          battleId: fight.battleId,
          status: status as ArenaFightSummary['status'],
          sides: ([0, 1] as const).map(side => {
            const id = fight.fighters[side];
            const logged = fight.log.participants[side].name;
            return { gladiatorId: id, name: id ? views.get(id)?.name ?? logged : logged, activityId: fight.activities[side], npc: !id };
          }) as ArenaFightSummary['sides'],
        })) });
      }
    }

    /**
     * A tournament entrant out of the rings: an eliminated one walks to its spectator spot and watches the arena; the
     * others wait at their staging spot; the champion carries a "Champion" tag once its ring has finished the final
     * (unless `inRing`: a bout of theirs is still queued, jogging in or fighting). A view that is no longer a tournament
     * entrant returns to its placement.
     */
    placeTournamentEntrant(v: ActorView, now: number, inRing: boolean) {
      const entrant = v.placement?.routine.kind === 'tournament';
      const seat = entrant && !v.arena ? seats.get(v.id) ?? null : null;
      if (seat && v.spectator !== seat) {
        v.spectator = seat;
        this.walkTo(v, seat, now, { action: 'idle', facing: seat.facing });
      } else if (!seat && v.spectator) {
        v.spectator = null;
        if (!v.arena && v.placement) this.walkTo(v, { x: v.placement.x, y: v.placement.y }, now, { action: v.placement.action, facing: v.placement.facing });
      }
      const champion = entrant && !inRing && tournamentRoles.get(v.id)?.role === 'champion';
      if (champion && !v.marker) {
        v.marker = this.add.text(0, 0, 'Champion', { fontFamily: 'monospace', fontSize: '9px', fontStyle: 'bold', color: '#1a1423', backgroundColor: '#f2c66b', padding: { x: 3, y: 1 } })
          .setOrigin(0.5, 1).setDepth(2_000_002).setResolution(2);
      } else if (!champion && v.marker) {
        v.marker.destroy();
        v.marker = undefined;
      }
    }

    standAt(v: ActorView, spot: TilePoint, action: ActionId, facing: Direction) {
      v.walk = null;
      v.x = spot.x + 0.5; v.y = spot.y + 0.5; v.action = action; v.facing = facing;
    }

    /** An NPC fallback opponent: the entrant's mirrored gear in the neutral NPC grey, with an "NPC" tag. */
    createArenaNpc(fight: CampFight, side: 0 | 1, spot: RingSpot): ActorView {
      const p = fight.log.participants[side];
      const id = `arena-npc:${fight.battleId}`;
      const old = views.get(id);
      if (old) this.removeView(old);
      const look = fighterLook(p, manifest);
      const layers = look.layers.map(l => {
        const sprite = this.add.sprite(0, 0, gladiator.atlas, `${l.id}/idle/se/0`);
        if (l.tint !== null) sprite.setTint(l.tint);
        return { id: l.id, sprite };
      });
      const container = this.makeContainer(layers.map(l => l.sprite));
      const entrant = fight.fighters[1 - side];
      container.on('pointerup', (pointer: PhaserNS.Input.Pointer) => {
        if (dragged(pointer)) return;
        if (entrant) selected = entrant;
        deps.bridge.emit('open-arena', { activityId: fight.activities[side], gladiatorId: entrant });
      });
      const marker = this.add.text(0, 0, 'NPC', { fontFamily: 'monospace', fontSize: '9px', fontStyle: 'bold', color: '#1a1423', backgroundColor: '#c9d3da', padding: { x: 3, y: 1 } })
        .setOrigin(0.5, 1).setDepth(2_000_002).setResolution(2);
      const v: ActorView = {
        id, kind: 'arena-npc', name: p.name, container, layers, look: '', label: this.makeLabel(p.name).setColor('#c9d3da'),
        x: ARENA_GATE.x + 0.5, y: ARENA_GATE.y + 0.5, action: 'idle', facing: 'sw', offsetMs: 0, walk: null, placement: null, location: 'arena',
        frame: '', flip: null, depth: NaN, activityId: fight.activities[side], startsAtMs: null, arena: { key: `${fight.battleId}:${side}`, battleId: fight.battleId, spot }, pose: null, marker,
      };
      views.set(id, v);
      npcFighters.set(fight.battleId, v);
      return v;
    }

    /** Draws a fight pose: every layer shows the logged action's frame. */
    applyPose(v: ActorView, pose: Pose) {
      if (pose.body !== v.frame) {
        for (const l of v.layers) l.sprite.setFrame(pose.body.replace(/^body\//, `${l.id}/`));
        v.frame = pose.body;
      }
      if (pose.flip !== v.flip) { v.container.setScale(pose.flip ? -1 : 1, 1); v.flip = pose.flip; }
    }

    /** Fade whole buildings whose pixels hide the focused character; only faded ones are restored. */
    updateOccluders(fv: ActorView | undefined) {
      const hiding = new Set<PropGroup>();
      if (fv) {
        const feet = worldToScreen(fv.x, fv.y);
        for (const g of propGroups) {
          if (!g.occludes || feet.x < g.left - 8 || feet.x >= g.left + g.width + 8 || feet.y - 40 >= g.top + g.height || feet.y <= g.top) continue;
          const mask = this.alphaMask(g.frame);
          if (hidesActor(g, (x, y) => mask.alpha[y * mask.width + x], feet)) hiding.add(g);
        }
      }
      for (const g of faded) if (!hiding.has(g)) { for (const image of g.images) image.setAlpha(1); faded.delete(g); }
      for (const g of hiding) if (!faded.has(g)) { for (const image of g.images) image.setAlpha(FADED_ALPHA); faded.add(g); }
    }

    /** Alpha of a prop frame, read once from the atlas the first time it might hide someone. */
    alphaMask(frameName: string) {
      let mask = alphaMasks.get(frameName);
      if (mask) return mask;
      const frame = this.textures.getFrame(map.propsAtlas, frameName);
      const canvas = document.createElement('canvas');
      canvas.width = frame.cutWidth;
      canvas.height = frame.cutHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(frame.source.image as CanvasImageSource, frame.cutX, frame.cutY, frame.cutWidth, frame.cutHeight, 0, 0, frame.cutWidth, frame.cutHeight);
      const rgba = ctx.getImageData(0, 0, frame.cutWidth, frame.cutHeight).data;
      const alpha = new Uint8Array(frame.cutWidth * frame.cutHeight);
      for (let i = 0; i < alpha.length; i += 1) alpha[i] = rgba[i * 4 + 3];
      mask = { width: frame.cutWidth, alpha };
      alphaMasks.set(frameName, mask);
      return mask;
    }

    updateFrames(v: ActorView, now: number) {
      const { frame, flip } = frameFor(v, now);
      if (frame !== v.frame) {
        if (v.kind === 'npc') v.layers[0].sprite.setFrame(frame);
        else for (const l of v.layers) l.sprite.setFrame(`${l.id}/${frame}`);
        v.frame = frame;
      }
      if (flip !== v.flip) { v.container.setScale(flip ? -1 : 1, 1); v.flip = flip; }
    }
  }

  /** Dragging or panning ends a follow; tell the UI so its Follow toggle stays truthful. */
  function stopFollowing() {
    if (!following) return;
    following = null;
    deps.bridge.emit('follow-character', { gladiatorId: null });
  }

  /** A fight's status now: the jog-in ends early once both fighters stand on their ring spots. */
  function statusOf(fight: CampFight, slot: RingSlot, now: number) {
    return fightStatus(slot, fight.log.durationMs, now, pairArrived(fight, slot));
  }

  function pairArrived(fight: CampFight, slot: RingSlot): boolean {
    const r = rings[slot.ring];
    for (let side = 0; side < 2; side += 1) {
      const id = fight.fighters[side];
      const v = id ? views.get(id) : npcFighters.get(fight.battleId);
      const spot = side === 0 ? r.a : r.b;
      if (!v || v.arena?.battleId !== fight.battleId || v.walk || Math.floor(v.x) !== spot.x || Math.floor(v.y) !== spot.y) return false;
    }
    return true;
  }

  /** The top of a ring fighter's nameplate (and NPC tag), assuming they show, in world px. */
  function plateTop(fight: CampFight, side: 0 | 1, feetY: number): number {
    const id = fight.fighters[side];
    const v = id ? views.get(id) : npcFighters.get(fight.battleId);
    if (!v) return feetY - PLATE_LIFT;
    const plate = feetY - PLATE_LIFT - v.label.displayHeight;
    return v.marker ? Math.min(plate, feetY - TAG_LIFT - v.marker.displayHeight) : plate;
  }

  /**
   * How far a damage label (centred at `x`, `width` wide, its top at `top`) can rise before it meets a nameplate or
   * NPC tag shown above it in its column, from where they were drawn last frame (bottom-centre origin).
   */
  function headroom(x: number, width: number, top: number): number {
    let room = Infinity;
    for (const v of views.values()) {
      room = Math.min(room, roomUnder(v.label, x, width, top));
      if (v.marker) room = Math.min(room, roomUnder(v.marker, x, width, top));
    }
    return room;
  }

  function roomUnder(t: PhaserNS.GameObjects.Text, x: number, width: number, top: number): number {
    return t.visible && t.y <= top && Math.abs(t.x - x) < (t.displayWidth + width) / 2 ? top - t.y : Infinity;
  }

  /** Arena debug state, built only when a test asks: the ring windows and what the rings drew last frame. */
  function arenaDebugState(now: number): CampDebugState['arena'] {
    const box = (t: PhaserNS.GameObjects.Text) => { const b = t.getBounds(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
    const effects: CampDebugState['arena']['effects'] = [];
    for (let k = 0; k < drawnCount; k += 1) for (const e of drawnFrames[k].effects) effects.push({ effect: e.effect, battleId: drawnIds[k], target: e.target });
    const labels: CampDebugState['arena']['labels'] = [];
    for (let k = 0; k < labelsShown; k += 1) labels.push({ text: labelPool[k].text, battleId: labelBattle[k], target: labelTarget[k], box: box(labelPool[k]) });
    return {
      fights: fights.flatMap(fight => {
        const slot = schedule.get(fight.battleId);
        if (!slot) return [];
        const { status, positionMs } = statusOf(fight, slot, now);
        const npc = fight.fighters.includes(null) ? `arena-npc:${fight.battleId}` : null;
        return [{ battleId: fight.battleId, ring: slot.ring, status, positionMs, fighters: [fight.fighters[0], fight.fighters[1]] as [string | null, string | null],
          boutStartMs: slot.boutStartMs, boutEndsAtMs: slot.boutEndsAtMs, enterAtMs: slot.enterAtMs, fightStartMs: slot.fightStartMs, leaveAtMs: slot.leaveAtMs, npc }];
      }),
      effects,
      labels,
      plans: [...plans.keys()],
    };
  }

  /** Reduced motion: NPCs keep to their first post instead of touring the camp. */
  function stillNpc(routine: NpcRoutine) {
    const first = [...routine.steps].sort((a, b) => a.at - b.at)[0];
    return { x: first.x + 0.5, y: first.y + 0.5, action: first.action, facing: first.facing };
  }

  /** Frame (layer-relative suffix for players, full name for NPCs) and mirroring for an actor at `now`. */
  function frameFor(v: ActorView, now: number): { frame: string; flip: boolean } {
    const flip = v.facing === 'sw' || v.facing === 'nw';
    const back = v.facing === 'ne' || v.facing === 'nw';
    if (v.npcAnimations) {
      const dirs = v.npcAnimations[v.action as 'idle'] ?? v.npcAnimations.idle!;
      const anim = manifest.animations[back && dirs.ne ? dirs.ne : dirs.se];
      return { frame: anim.frames[frameIndex(anim, now)], flip };
    }
    const dirs = gladiator.animations[v.action as ActionId] ?? gladiator.animations.idle;
    const anim = manifest.animations[back && dirs.ne ? dirs.ne : dirs.se];
    // A jog steps through the walk loop as much faster as it moves.
    const at = v.walk && v.walk.pace !== 1 ? v.walk.startedAt + (now - v.walk.startedAt) * v.walk.pace : now;
    const frame = anim.frames[frameIndex(anim, at + v.offsetMs)];
    return { frame: frame.slice(frame.indexOf('/') + 1), flip };
  }

  /**
   * Whether a press is no click on a camp object: it moved further than the drag threshold, or it began or ended off the
   * game canvas, on the page's own controls over the camp (its menus, rail and chip), which Phaser also hears through
   * its window listeners.
   */
  function dragged(pointer: PhaserNS.Input.Pointer): boolean {
    if (offCanvas(pointer) || pointer.upElement !== scene.game.canvas) return true;
    return P.Math.Distance.Between(pointer.downX, pointer.downY, pointer.upX, pointer.upY) > DRAG_THRESHOLD;
  }
  /** A press that began on the page's controls over the camp, never on the canvas: it neither pans nor pinches. */
  function offCanvas(pointer: PhaserNS.Input.Pointer): boolean {
    return pointer.downElement !== scene.game.canvas;
  }

  const scene = new CampScene();
  const live = () => ready && !disposed && !failed;

  // Bridge listeners belong to this scene instance and are removed by dispose(), never by SHUTDOWN.
  const unsubscribe: (() => void)[] = [
    deps.bridge.on('camera-zoom', ({ direction }) => {
      if (!live()) return;
      const centre = { x: view.viewWidth / 2, y: view.viewHeight / 2 };
      scene.zoomTo(direction === 'reset' ? 1 : stepZoom(view.zoom, direction === 'in' ? 1 : -1), centre);
    }),
    deps.bridge.on('camera-pan', ({ dx, dy }) => {
      if (!live()) return;
      stopFollowing();
      view = panBy(view, dx, dy, bounds);
      scene.syncCamera();
    }),
    deps.bridge.on('find-character', ({ gladiatorId }) => {
      if (!live()) return;
      const v = views.get(gladiatorId);
      if (!v) return;
      selected = gladiatorId;
      scene.centerOnActor(v);
    }),
    deps.bridge.on('follow-character', ({ gladiatorId }) => {
      const applied = live() && gladiatorId && views.has(gladiatorId) ? gladiatorId : null;
      if (live()) {
        following = applied;
        if (applied) selected = applied;
      }
      // Answer a refused request with what was applied, so UI toggles never show a follow that is not
      // happening. The answer waits until every listener has seen the request, and is dropped if a
      // later request was accepted meanwhile or this scene was disposed (a replacement scene may own
      // the bridge by then).
      if (gladiatorId && !applied) queueMicrotask(() => { if (!disposed && !following) deps.bridge.emit('follow-character', { gladiatorId: null }); });
    }),
  ];

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const off of unsubscribe.splice(0)) off();
  }

  /** Canvas-relative CSS pixel position of an actor's body (20 art px above its feet), or null without a live camera. */
  function screenOfView(v: ActorView): Point | null {
    if (!live()) return null;
    const cam = scene.cameras.main;
    const s = worldToScreen(v.x, v.y);
    return { x: (s.x - cam.worldView.x) * cam.zoom, y: (s.y - 20 - cam.worldView.y) * cam.zoom };
  }

  const handle: CampSceneHandle = {
    setWorld(next) {
      world = next;
      if (live()) scene.applyWorld(next);
    },
    setTimelines(next) {
      timelines = next;
      arenaDirty = true;
    },
    setTournaments(next) {
      tournaments = next;
      arenaDirty = true;
    },
    setReducedMotion(reduced) {
      reducedMotion = reduced;
    },
    dispose,
    debug() {
      const cam = live() ? scene.cameras.main : undefined;
      const now = deps.now();
      return {
        ready,
        disposed,
        failed,
        reducedMotion,
        players: [...views.values()].filter(v => v.kind === 'player').length,
        ambientNpcs: [...views.values()].filter(v => v.kind === 'npc').length,
        away: awayCount,
        camera: cam
          ? { centerX: cam.midPoint.x, centerY: cam.midPoint.y, zoom: cam.zoom, worldView: { x: cam.worldView.x, y: cam.worldView.y, width: cam.worldView.width, height: cam.worldView.height }, bounds }
          : { centerX: 0, centerY: 0, zoom: 1, worldView: { x: 0, y: 0, width: 0, height: 0 }, bounds },
        actors: [...views.values()].map(v => ({
          id: v.id, kind: v.kind, name: v.name, x: v.x, y: v.y, zone: v.placement?.zone ?? null, location: v.location,
          action: v.action, frame: v.pose ? v.pose.body.slice(v.pose.body.indexOf('/') + 1) : frameFor(v, now).frame, layers: v.layers.map(l => l.id), tint: v.placement ? { ...v.placement.routine.tint } : null,
          visible: v.container.visible, depth: v.container.depth, walking: !!v.walk,
          flip: v.flip ?? (v.facing === 'sw' || v.facing === 'nw'), marker: v.marker?.text ?? null,
          plates: [v.label, v.marker].filter((t): t is PhaserNS.GameObjects.Text => !!t && t.visible).map(t => { const b = t.getBounds(); return { x: b.x, y: b.y, width: b.width, height: b.height }; }),
        })),
        selected,
        following,
        faded: [...faded].map(g => g.id),
        lighting: { overlayColor: overlay?.fillColor ?? 0, overlayAlpha: overlay?.fillAlpha ?? 0, torchAlpha: lights[0]?.image.alpha ?? 0 },
        arena: arenaDebugState(now),
        tournament: {
          roles: Object.fromEntries([...tournamentRoles].map(([id, r]) => [id, r.role])),
          champion: [...tournamentRoles].find(([, r]) => r.role === 'champion')?.[0] ?? null,
          spectators: [...views.values()].filter(v => v.spectator).map(v => v.id),
        },
      };
    },
    props() {
      return propGroups.map(g => ({
        id: g.id, frame: g.frame, x: g.x, y: g.y, occludes: g.occludes, alpha: g.images[0].alpha,
        slices: g.slices.map((s, i) => ({ left: s.left, width: s.width, depth: g.images[i].depth })),
      }));
    },
    centerOn(x, y, zoom) {
      if (!live()) return;
      stopFollowing();
      const s = worldToScreen(x, y);
      view = clampView({ ...view, centerX: s.x, centerY: s.y, zoom: zoom ?? view.zoom }, bounds);
      scene.syncCamera();
    },
    screenOf(id) {
      const v = views.get(id);
      return v ? screenOfView(v) : null;
    },
  };
  return { scene, handle };
}
