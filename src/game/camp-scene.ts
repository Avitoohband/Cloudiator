// The living isometric camp. Phaser is injected (loaded lazily in the browser) so this
// module stays importable during the static build. The scene only renders public world
// state; it never decides outcomes or rewards.
import type * as PhaserNS from 'phaser';
import type { WorldSnapshot, PublicActor } from '@contracts/reads';
import type { ActionId, AnimationDef, AssetManifest, Direction, MapData, TilePoint } from './assets';
import { layoutCamp, type Placement } from './actors';
import { NPC_ROUTINES, facingFor, planNpcPosition } from './npcs';
import { clampView, panBy, zoomAround, ZOOM_STEP, type ViewState } from './camera';
import { mapScreenBounds, worldToScreen, type Rect } from './iso';
import { findPath, gridFromMap, pathLength, pointAlong, type Grid } from './paths';
import { lightingAt } from './lighting';
import { needsSlices, propSlices } from './depth';
import type { SceneBridge } from './bridge';

type Phaser = typeof PhaserNS;
type Sprite = PhaserNS.GameObjects.Sprite;
type Container = PhaserNS.GameObjects.Container;

export type CampSceneDeps = {
  manifest: AssetManifest;
  atlasData: Record<string, unknown>;
  assetBase: string;
  world: WorldSnapshot | null;
  bridge: SceneBridge;
  /** Estimated server time in ms. */
  now: () => number;
  onReady: () => void;
  onError: (reason: 'assets' | 'error', message: string) => void;
};

export type CampSceneHandle = {
  setWorld(world: WorldSnapshot): void;
  debug(): CampDebugState;
};

export type CampDebugState = {
  ready: boolean;
  players: number;
  ambientNpcs: number;
  away: number;
  zones: string[];
  camera: { centerX: number; centerY: number; zoom: number; worldView: Rect; bounds: Rect };
  actors: { id: string; kind: 'player' | 'npc'; x: number; y: number; action: string; frame: string; visible: boolean; depth: number }[];
  selected: string | null;
  following: string | null;
};

const GATE: TilePoint = { x: 41, y: 22 };
const BG = 0x1c3f24;

type ActorView = {
  id: string;
  kind: 'player' | 'npc';
  name: string;
  container: Container;
  layers: { id: string; sprite: Sprite }[];
  atlas: string;
  label: PhaserNS.GameObjects.Text;
  x: number;
  y: number;
  action: string;
  facing: Direction;
  offsetMs: number;
  walk: { path: TilePoint[]; startedAt: number; then: { action: ActionId; facing: Direction }; remove?: boolean } | null;
  placement: Placement | null;
  npcRoutine?: (typeof NPC_ROUTINES)[number];
  merchant?: 'weapons' | 'armor';
  frame: string;
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

export function createCampScene(P: Phaser, deps: CampSceneDeps): { scene: PhaserNS.Scene; handle: CampSceneHandle } {
  const { manifest } = deps;
  const map = manifest.maps.find(m => m.id === 'camp') as MapData;
  const grid: Grid = gridFromMap(map);
  const tileBounds = mapScreenBounds(map.width, map.height);
  const bounds: Rect = { x: tileBounds.x, y: tileBounds.y - 96, width: tileBounds.width, height: tileBounds.height + 96 };
  const gladiator = manifest.actors.gladiator;
  const WALK_SPEED = gladiator.walk.tilesPerSecond / 1000; // tiles per ms
  const layerTint = new Map(gladiator.layers.map(l => [l.id, l.tint]));

  let ready = false;
  let world = deps.world;
  let awayCount = 0;
  let selected: string | null = null;
  let following: string | null = null;
  const views = new Map<string, ActorView>();
  const animatedProps: { image: PhaserNS.GameObjects.Image; anim: AnimationDef }[] = [];
  const occluders: { image: PhaserNS.GameObjects.Image; depth: number }[] = [];
  const lights: { image: PhaserNS.GameObjects.Image; base: number; seed: number }[] = [];
  const unsubscribe: (() => void)[] = [];
  let view: ViewState = { centerX: 0, centerY: tileBounds.height / 2, zoom: 1, viewWidth: 800, viewHeight: 600 };
  let overlay: PhaserNS.GameObjects.Rectangle | null = null;
  let ring: PhaserNS.GameObjects.Ellipse | null = null;

  class CampScene extends P.Scene {
    constructor() { super({ key: 'camp' }); }

    preload() {
      const keys = new Set([gladiator.atlas, 'npcs', map.tilesAtlas, map.propsAtlas]);
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
        overlay = this.add.rectangle(0, 0, 10, 10, 0xffffff, 0).setOrigin(0.5).setDepth(2_000_000);
        ring = this.add.ellipse(0, 0, 30, 14).setStrokeStyle(2, 0xffe48f).setVisible(false);
        this.buildNpcs();
        if (world) this.applyWorld(world, true);
        this.setupInput();
        this.setupBridge();
        this.scale.on(P.Scale.Events.RESIZE, () => this.syncCamera());
        const spawn = worldToScreen(map.arena!.centre[0], map.arena!.centre[1] + 4);
        view = { ...view, centerX: spawn.x, centerY: spawn.y };
        this.syncCamera();
        this.events.once(P.Scenes.Events.SHUTDOWN, () => { for (const off of unsubscribe) off(); unsubscribe.length = 0; });
        ready = true;
        deps.onReady();
      } catch (error) {
        deps.onError('error', error instanceof Error ? error.message : String(error));
      }
    }

    buildGround() {
      for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
        const s = worldToScreen(x, y);
        this.add.image(s.x, s.y, map.tilesAtlas, map.groundFrames[map.ground[y * map.width + x]]).setDepth(-10_000_000);
      }
    }

    buildProps() {
      const frames = manifest.atlases[map.propsAtlas].frames;
      for (const p of map.props) {
        const s = worldToScreen(p.x, p.y);
        const images: { image: PhaserNS.GameObjects.Image; depth: number }[] = [];
        if (needsSlices({ w: p.w, d: p.d }, p.layer)) {
          // Wide props are sliced so actors in front of any face draw over it (src/game/depth.ts).
          const f = frames[p.frame];
          for (const slice of propSlices({ w: p.w, d: p.d }, -f.anchorX, f.w)) {
            const image = this.add.image(s.x, s.y, map.propsAtlas, p.frame).setCrop(slice.left + f.anchorX, 0, slice.width, f.h);
            images.push({ image, depth: s.y + slice.depthOffset });
          }
        } else {
          const depth = p.layer === 'floor' ? -1_000_000 + s.y : p.layer === 'foreground' ? 1_000_000 + s.y : s.y + p.sortY;
          images.push({ image: this.add.image(s.x, s.y, map.propsAtlas, p.frame), depth });
        }
        for (const { image, depth } of images) {
          image.setDepth(depth);
          if (p.occludes) occluders.push({ image, depth });
        }
        if (p.animation) {
          const anim = manifest.animations[`prop-${map.propsAtlas}-${p.animation}`];
          if (anim) for (const { image } of images) animatedProps.push({ image, anim });
        }
        if (p.interact === 'merchant-weapons' || p.interact === 'merchant-armor') {
          const merchant = p.interact === 'merchant-weapons' ? 'weapons' : 'armor';
          const target = images[0].image.setInteractive({ useHandCursor: true });
          target.on('pointerup', (pointer: PhaserNS.Input.Pointer) => { if (!dragged(pointer)) deps.bridge.emit('open-merchant', { merchant }); });
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
        lights.push({ image, base, seed: i * 1.7 });
      });
    }

    makeLabel(name: string) {
      return this.add.text(0, 0, name, { fontFamily: 'monospace', fontSize: '10px', color: '#f4e8cb', stroke: '#1a1423', strokeThickness: 3 })
        .setOrigin(0.5, 1).setDepth(2_000_002).setResolution(2);
    }

    buildNpcs() {
      for (const routine of NPC_ROUTINES) {
        const npc = manifest.actors.npcs.find(n => n.id === routine.npcId);
        if (!npc) continue;
        const sprite = this.add.sprite(0, 0, npc.atlas, manifest.animations[npc.animations.idle!.se].frames[0]);
        const container = this.add.container(0, 0, [sprite]);
        container.setSize(26, 46);
        container.setInteractive(new P.Geom.Rectangle(-13, -46, 26, 46), P.Geom.Rectangle.Contains);
        const merchant = npc.role === 'merchant-weapons' ? 'weapons' : npc.role === 'merchant-armor' ? 'armor' : undefined;
        container.on('pointerup', (pointer: PhaserNS.Input.Pointer) => { if (!dragged(pointer) && merchant) deps.bridge.emit('open-merchant', { merchant }); });
        const label = this.makeLabel(npc.name).setColor('#ffe48f').setVisible(false);
        views.set(`npc:${npc.id}`, {
          id: `npc:${npc.id}`, kind: 'npc', name: npc.name, container, layers: [{ id: 'npc', sprite }], atlas: npc.atlas, label,
          x: 0, y: 0, action: 'idle', facing: 'se', offsetMs: 0, walk: null, placement: null, npcRoutine: routine, merchant, frame: '',
        });
      }
    }

    createPlayer(actor: PublicActor, placement: Placement): ActorView {
      const sprites = placement.routine.layers.map(id => {
        const sprite = this.add.sprite(0, 0, gladiator.atlas, `${id}/idle/se/0`);
        const key = layerTint.get(id);
        if (key) sprite.setTint(placement.routine.tint[key]);
        return { id, sprite };
      });
      const container = this.add.container(0, 0, sprites.map(s => s.sprite));
      container.setSize(26, 46);
      container.setInteractive(new P.Geom.Rectangle(-13, -46, 26, 46), P.Geom.Rectangle.Contains);
      container.on('pointerup', (pointer: PhaserNS.Input.Pointer) => {
        if (dragged(pointer)) return;
        selected = actor.gladiatorId;
        deps.bridge.emit('select-character', { gladiatorId: actor.gladiatorId });
      });
      return {
        id: actor.gladiatorId, kind: 'player', name: actor.name, container, layers: sprites, atlas: gladiator.atlas,
        label: this.makeLabel(actor.name), x: placement.x + 0.5, y: placement.y + 0.5, action: placement.action, facing: placement.facing,
        offsetMs: placement.routine.offsetMs, walk: null, placement, frame: '',
      };
    }

    applyWorld(next: WorldSnapshot, initial: boolean) {
      world = next;
      const { placements, away } = layoutCamp(next.actors, map, next.slotIndex);
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
          if (!initial) this.walkTo(v, { x: placement.x, y: placement.y }, now, { action: placement.action, facing: placement.facing }, GATE);
          continue;
        }
        existing.placement = placement;
        existing.offsetMs = placement.routine.offsetMs;
        const target = existing.walk ? existing.walk.path[existing.walk.path.length - 1] : { x: Math.floor(existing.x), y: Math.floor(existing.y) };
        if (target.x !== placement.x || target.y !== placement.y) this.walkTo(existing, { x: placement.x, y: placement.y }, now, { action: placement.action, facing: placement.facing });
        else if (!existing.walk) { existing.action = placement.action; existing.facing = placement.facing; }
      }
      for (const [id, v] of views) {
        if (v.kind !== 'player' || seen.has(id)) continue;
        const leaving = away.some(a => a.gladiatorId === id);
        if (leaving && !initial) this.walkTo(v, GATE, now, { action: 'idle', facing: 'se' }, undefined, true);
        else this.removeView(v);
      }
      awayCount = away.length;
      deps.bridge.emit('roster', {
        inCamp: [...placements.keys()],
        away: away.map(a => ({ gladiatorId: a.gladiatorId, name: a.name, location: a.location })),
      });
    }

    walkTo(v: ActorView, to: TilePoint, now: number, then: { action: ActionId; facing: Direction }, from?: TilePoint, remove = false) {
      const start = from ?? { x: Math.floor(v.x), y: Math.floor(v.y) };
      const path = findPath(grid, start, to);
      if (!path) { v.x = to.x + 0.5; v.y = to.y + 0.5; v.action = then.action; v.facing = then.facing; v.walk = null; if (remove) this.removeView(v); return; }
      v.walk = { path, startedAt: now, then, remove };
    }

    removeView(v: ActorView) {
      v.container.destroy();
      v.label.destroy();
      views.delete(v.id);
      if (selected === v.id) selected = null;
      if (following === v.id) following = null;
    }

    setupInput() {
      this.input.addPointer(1);
      let pinch: { distance: number; zoom: number } | null = null;
      this.input.on(P.Input.Events.POINTER_MOVE, (pointer: PhaserNS.Input.Pointer) => {
        const p1 = this.input.pointer1;
        const p2 = this.input.pointer2;
        if (p1?.isDown && p2?.isDown) {
          const distance = P.Math.Distance.Between(p1.x, p1.y, p2.x, p2.y);
          if (!pinch) pinch = { distance, zoom: view.zoom };
          const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
          const factor = (pinch.zoom * (distance / pinch.distance)) / view.zoom;
          view = zoomAround(view, factor, mid, bounds);
          this.syncCamera();
          return;
        }
        pinch = null;
        if (!pointer.isDown) return;
        following = null;
        view = panBy(view, pointer.x - pointer.prevPosition.x, pointer.y - pointer.prevPosition.y, bounds);
        this.syncCamera();
      });
      this.input.on(P.Input.Events.POINTER_UP, () => { pinch = null; });
      this.input.on(P.Input.Events.POINTER_WHEEL, (pointer: PhaserNS.Input.Pointer, _over: unknown, _dx: number, dy: number) => {
        view = zoomAround(view, dy > 0 ? 1 / 1.12 : 1.12, { x: pointer.x, y: pointer.y }, bounds);
        this.syncCamera();
      });
    }

    setupBridge() {
      const b = deps.bridge;
      unsubscribe.push(b.on('camera-zoom', ({ direction }) => {
        const centre = { x: view.viewWidth / 2, y: view.viewHeight / 2 };
        view = direction === 'reset' ? clampView({ ...view, zoom: 1 }, bounds) : zoomAround(view, direction === 'in' ? ZOOM_STEP : 1 / ZOOM_STEP, centre, bounds);
        this.syncCamera();
      }));
      unsubscribe.push(b.on('camera-pan', ({ dx, dy }) => {
        following = null;
        view = panBy(view, dx, dy, bounds);
        this.syncCamera();
      }));
      unsubscribe.push(b.on('find-character', ({ gladiatorId }) => {
        const v = views.get(gladiatorId);
        if (!v) return;
        selected = gladiatorId;
        const s = worldToScreen(v.x, v.y);
        view = clampView({ ...view, centerX: s.x, centerY: s.y - 24 }, bounds);
        this.syncCamera();
      }));
      unsubscribe.push(b.on('follow-character', ({ gladiatorId }) => {
        following = gladiatorId && views.has(gladiatorId) ? gladiatorId : null;
        if (following) selected = following;
      }));
    }

    syncCamera() {
      const cam = this.cameras.main;
      view = clampView({ ...view, viewWidth: cam.width, viewHeight: cam.height }, bounds);
      cam.setZoom(view.zoom);
      cam.centerOn(view.centerX, view.centerY);
    }

    update() {
      if (!ready) return;
      const now = deps.now();
      const cam = this.cameras.main;
      const light = lightingAt(now);
      if (overlay) {
        overlay.setPosition(cam.midPoint.x, cam.midPoint.y).setSize(cam.width / cam.zoom + 8, cam.height / cam.zoom + 8);
        overlay.setFillStyle(light.overlayColor, light.overlayAlpha);
      }
      for (const l of lights) l.image.setAlpha(Math.min(1, 0.12 + 0.55 * light.torchIntensity) * (0.88 + 0.12 * Math.sin(now / 170 + l.seed)));
      for (const { image, anim } of animatedProps) image.setFrame(anim.frames[frameIndex(anim, now)]);

      const viewRect = cam.worldView;
      const margin = 80;
      for (const v of views.values()) {
        if (v.npcRoutine) {
          const p = planNpcPosition(v.npcRoutine, map, now);
          v.x = p.x; v.y = p.y; v.action = p.action; v.facing = p.facing;
        } else if (v.walk) {
          const walked = (now - v.walk.startedAt) * WALK_SPEED;
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
        const s = worldToScreen(v.x, v.y);
        v.container.setPosition(s.x, s.y).setDepth(s.y);
        const visible = s.x > viewRect.x - margin && s.x < viewRect.right + margin && s.y > viewRect.y - margin && s.y < viewRect.bottom + margin * 1.5;
        v.container.setVisible(visible);
        const showLabel = visible && v.kind === 'player' && (cam.zoom >= 1.4 || selected === v.id || following === v.id);
        v.label.setVisible(showLabel || (visible && v.kind === 'npc' && cam.zoom >= 2));
        if (v.label.visible) v.label.setPosition(s.x, s.y - 46);
        if (!visible) continue;
        this.updateFrames(v, now);
      }
      const focus = following ?? selected;
      const fv = focus ? views.get(focus) : undefined;
      if (ring) {
        ring.setVisible(!!fv && fv.container.visible);
        if (fv) { const s = worldToScreen(fv.x, fv.y); ring.setPosition(s.x, s.y).setDepth(s.y - 0.5); }
      }
      if (following && fv) {
        const s = worldToScreen(fv.x, fv.y);
        view = clampView({ ...view, centerX: view.centerX + (s.x - view.centerX) * 0.12, centerY: view.centerY + (s.y - 24 - view.centerY) * 0.12 }, bounds);
        this.syncCamera();
      }
      // Fade buildings that hide the focused character.
      for (const o of occluders) o.image.setAlpha(1);
      if (fv) {
        const s = worldToScreen(fv.x, fv.y);
        for (const o of occluders) if (o.depth > s.y && o.image.getBounds().contains(s.x, s.y - 20)) o.image.setAlpha(0.45);
      }
    }

    updateFrames(v: ActorView, now: number) {
      const { frame, flip } = frameFor(v, now);
      if (v.kind === 'npc') v.layers[0].sprite.setFrame(frame);
      else for (const l of v.layers) l.sprite.setFrame(`${l.id}/${frame}`);
      v.container.setScale(flip ? -1 : 1, 1);
      v.frame = frame;
    }
  }

  /** Frame (layer-relative suffix for players, full name for NPCs) and mirroring for an actor at `now`. */
  function frameFor(v: ActorView, now: number): { frame: string; flip: boolean } {
    const flip = v.facing === 'sw' || v.facing === 'nw';
    const back = v.facing === 'ne' || v.facing === 'nw';
    if (v.kind === 'npc') {
      const npc = manifest.actors.npcs.find(n => `npc:${n.id}` === v.id)!;
      const dirs = npc.animations[v.action as 'idle'] ?? npc.animations.idle!;
      const anim = manifest.animations[back && dirs.ne ? dirs.ne : dirs.se];
      return { frame: anim.frames[frameIndex(anim, now)], flip };
    }
    const dirs = gladiator.animations[v.action as ActionId] ?? gladiator.animations.idle;
    const anim = manifest.animations[back && dirs.ne ? dirs.ne : dirs.se];
    const frame = anim.frames[frameIndex(anim, now + v.offsetMs)];
    return { frame: frame.slice(frame.indexOf('/') + 1), flip };
  }

  function dragged(pointer: PhaserNS.Input.Pointer): boolean {
    return P.Math.Distance.Between(pointer.downX, pointer.downY, pointer.upX, pointer.upY) > 6;
  }

  const scene = new CampScene();
  const handle: CampSceneHandle = {
    setWorld(next) {
      world = next;
      if (ready) scene.applyWorld(next, false);
    },
    debug() {
      const cam = scene.cameras?.main;
      return {
        ready,
        players: [...views.values()].filter(v => v.kind === 'player').length,
        ambientNpcs: [...views.values()].filter(v => v.kind === 'npc').length,
        away: awayCount,
        zones: map.zones.map(z => z.id),
        camera: cam
          ? { centerX: cam.midPoint.x, centerY: cam.midPoint.y, zoom: cam.zoom, worldView: { x: cam.worldView.x, y: cam.worldView.y, width: cam.worldView.width, height: cam.worldView.height }, bounds }
          : { centerX: 0, centerY: 0, zoom: 1, worldView: { x: 0, y: 0, width: 0, height: 0 }, bounds },
        actors: [...views.values()].map(v => ({ id: v.id, kind: v.kind, x: v.x, y: v.y, action: v.action, frame: frameFor(v, deps.now()).frame, visible: v.container.visible, depth: v.container.depth })),
        selected,
        following,
      };
    },
  };
  return { scene, handle };
}
