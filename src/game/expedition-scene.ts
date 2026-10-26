// The followable expedition scene. Phaser is injected (loaded lazily in the browser) so this module
// stays importable during the static build. Every frame it reads the stage state for the display clock
// (src/game/expedition-stage.ts) and only draws it: the gladiator walks the map route, searches, waits,
// fights a revealed encounter (its battle log, seeked with the replay controller and staged by
// battle-stage) or rests at the safe point; once the expedition is back at camp it leaves the scene.
// Each encounter's creature waits idling at its spot, named like the gladiator, until its fight
// (src/game/expedition-creatures.ts): a creature the gladiator beat fades after the fight, one that won stays
// idling at its spot.
// It never reveals a stage, simulates a fight or settles anything. The map follows the camp's
// conventions: baked ground, depth-sliced props (src/game/depth.ts) and buildings that fade while their
// opaque pixels hide the gladiator. A hidden tab draws nothing; on return the scene shows the current
// display time directly.
import type * as PhaserNS from 'phaser';
import type { AnimationDef, AssetManifest, Direction, MapData } from './assets';
import type { SceneBridge } from './bridge';
import type { ExpeditionSceneState } from './expedition-stage';
import { REPLAY_OUTRO_MS, createReplayController, type ReplayController } from './replay';
import { frameIndex, planStage, stageAt, type LabelPose, type StageLayout, type StagePlan } from './battle-stage';
import { gladiatorPose, journeyMap, type GladiatorPose } from './expedition-path';
import { clearOfLabel, creatureMode, fightCreatureAlpha, type LabelBox } from './expedition-creatures';
import { ZOOM_STEP, clampView, panBy, stepZoom, zoomAround, type ViewState } from './camera';
import { mapScreenBounds, worldToScreen, type Point, type Rect } from './iso';
import { drawSlices, hidesActor, type PlacedImage } from './depth';
import { lightingAt } from './lighting';

type Phaser = typeof PhaserNS;
type Sprite = PhaserNS.GameObjects.Sprite;
type Image = PhaserNS.GameObjects.Image;
type Container = PhaserNS.GameObjects.Container;
type Text = PhaserNS.GameObjects.Text;

export type ExpeditionEnvironment = 'woodland' | 'outpost' | 'mountain';
/** How the gladiator is drawn outside fights: gladiator layers in draw order and the player's tints. */
export type GladiatorLook = { key: string; name: string; layers: string[]; tint: { skin: number; cloth: number; hair: number } };

export type ExpeditionSceneDeps = {
  manifest: AssetManifest;
  atlasData: Record<string, unknown>;
  assetBase: string;
  environment: ExpeditionEnvironment;
  /** The stage state at the display clock, read every frame. */
  state: () => ExpeditionSceneState | null;
  look: GladiatorLook;
  bridge: SceneBridge;
  reducedMotion?: boolean;
  onReady: () => void;
  onError: (reason: 'assets' | 'error', message: string) => void;
  /** Called with true when the expedition is back at camp and the gladiator leaves the scene, and with false if a later state undoes that. */
  onReturned?: (returned: boolean) => void;
};

export type ExpeditionDebugState = {
  ready: boolean;
  disposed: boolean;
  failed: boolean;
  reducedMotion: boolean;
  environment: ExpeditionEnvironment;
  displayNowMs: number | null;
  phase: string | null;
  following: boolean;
  /** The expedition is back at camp and the gladiator leaves (or has left) the scene. */
  returned: boolean;
  camera: { centerX: number; centerY: number; zoom: number; worldView: Rect; bounds: Rect };
  gladiator: { x: number; y: number; action: string; animation: string; frames: string[]; layers: string[]; tint: GladiatorLook['tint']; facing: Direction;
    depth: number; screenX: number; screenY: number; scaleX: number; visible: boolean; alpha: number; labelVisible: boolean; walking: boolean;
    /** The name over the gladiator: `x` its centre, `y` its bottom edge. */
    labelBox: LabelBox } | null;
  creature: { id: string; creatureId: string; x: number; y: number; frame: string; depth: number; alpha: number; scaleX: number; visible: boolean } | null;
  /** The idle sprites of the encounters' creatures waiting (or staying) at their spots, one per encounter, in order. */
  waiting: { encounter: number; creatureId: string; x: number; y: number; frame: string; visible: boolean; depth: number; scaleX: number;
    /** The creature's name over its head, shown and hidden with its idle sprite. */
    label: { text: string; x: number; y: number; visible: boolean; width: number; height: number } }[];
  battle: { battleId: string; positionMs: number } | null;
  effects: { effect: string; frameName: string; target: 0 | 1; x: number; y: number; visible: boolean }[];
  labels: { text: string; x: number; y: number }[];
  faded: string[];
};
export type ExpeditionPropDebug = { id: string; frame: string; x: number; y: number; occludes: boolean; alpha: number; slices: { left: number; width: number; depth: number }[] };

export type ExpeditionSceneHandle = {
  setReducedMotion(reduced: boolean): void;
  setLook(look: GladiatorLook): void;
  /** Removes the scene's bridge listeners. Idempotent; also runs when the game destroys the scene. */
  dispose(): void;
  debug(): ExpeditionDebugState;
  props(): ExpeditionPropDebug[];
};

const BG = 0x1f3326;
/** Opening and reset zoom: one actor fills more of the view than in the busy camp. */
const DEFAULT_ZOOM = ZOOM_STEP ** 2;
const FADED_ALPHA = 0.45;
/** A waiting creature's depth offset: the fight draws its right-hand fighter at rest at `y + (10 + 1) / 100` (battle-stage). */
const WAITING_DEPTH = 0.11;
/** Waiting creatures breathe out of step: each encounter's idle loop is offset by this much per encounter. */
const WAITING_STAGGER_MS = 370;
/** The name over an actor, the gladiator's or a waiting creature's: one style, so the two cannot drift apart. */
const NAME_LABEL_STYLE: PhaserNS.Types.GameObjects.Text.TextStyle = { fontFamily: 'monospace', fontSize: '10px', color: '#f4e8cb', stroke: '#1a1423', strokeThickness: 3 };
const NAME_LABEL_DEPTH = 2_000_002;
/** A creature's name sits this far above the top of its art. */
const NAME_LABEL_GAP = 2;
/** Back at camp, the gladiator fades out of the scene over this long (at once with reduced motion). */
const HERO_LEAVE_MS = 1500;
const WHEEL_STEP = 100;
const WHEEL_LINE = 40;
const WHEEL_IDLE_MS = 250;
const DRAG_THRESHOLD = 6;
const LABEL_COLORS: Record<LabelPose['kind'], string> = { damage: '#ffffff', critical: '#ffe48f', guard: '#8edcf4', miss: '#d4d4d8' };
/** Damage labels rise from just above the gladiator's name label (46 px over the feet), never over it. */
const LABEL_LIFT = 14;

type PropGroup = Omit<PlacedImage, 'slices'> & {
  id: string; frame: string; x: number; y: number; occludes: boolean; images: Image[];
  slices: { x0: number; x1: number; depth: number; left: number; width: number }[];
};
type BattleView = { battleId: string; plan: StagePlan; controller: ReplayController };
/** An encounter's creature idling at its spot; one sprite per encounter, built once and only shown or hidden. */
type Waiter = { encounter: number; creatureId: string; sprite: Sprite; anim: AnimationDef; index: number;
  /** Its name, and where that sits over the creature's head (a fitted height, not the gladiator's 46 px). */
  label: Text; labelY: number };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** Fills `box` from a name label, with `y` as its bottom edge. */
const boxOf = (box: LabelBox, label: Text, y: number) => { box.x = label.x; box.y = y; box.width = label.width; box.height = label.height; };
/** True when a pixel in the row of RGBA bytes starting at `from` is not fully transparent. */
const rowOpaque = (rgba: Uint8ClampedArray, from: number, width: number) => {
  for (let x = 0; x < width; x += 1) if (rgba[from + x * 4 + 3] > 0) return true;
  return false;
};

export function createExpeditionScene(P: Phaser, deps: ExpeditionSceneDeps): { scene: PhaserNS.Scene; handle: ExpeditionSceneHandle } {
  const { manifest } = deps;
  const found = manifest.maps.find(m => m.id === deps.environment);
  if (!found?.expedition) throw new Error(`No expedition map for ${deps.environment}`);
  const map: MapData = found;
  const journey = journeyMap(map);
  const tileBounds = mapScreenBounds(map.width, map.height);
  const bounds: Rect = { x: tileBounds.x, y: tileBounds.y - 96, width: tileBounds.width, height: tileBounds.height + 96 };
  const gladiator = manifest.actors.gladiator;
  const speed = gladiator.walk.tilesPerSecond;

  let ready = false;
  let disposed = false;
  let failed = false;
  let reducedMotion = !!deps.reducedMotion;
  let following = true;
  let look = deps.look;
  let view: ViewState = { centerX: 0, centerY: tileBounds.height / 2, zoom: DEFAULT_ZOOM, viewWidth: 800, viewHeight: 600 };
  let groundChunks: { rt: PhaserNS.GameObjects.RenderTexture; left: number; top: number; tiles: { frame: string; left: number; top: number }[] }[] = [];
  const propGroups: PropGroup[] = [];
  const faded = new Set<PropGroup>();
  const alphaMasks = new Map<string, { width: number; alpha: Uint8Array }>();
  const animatedProps: { image: Image; anim: AnimationDef; index: number }[] = [];
  const lights: { image: Image; seed: number }[] = [];
  let overlay: PhaserNS.GameObjects.Rectangle | null = null;
  let hero: { container: Container; layers: { id: string; sprite: Sprite }[]; label: Text } | null = null;
  let creature: { container: Container; sprite: Sprite; creatureId: string } | null = null;
  const waiters: Waiter[] = [];
  /** Two boxes reused every frame to compare a creature's name with the gladiator's. */
  const mine: LabelBox = { x: 0, y: 0, width: 0, height: 0 };
  const theirs: LabelBox = { x: 0, y: 0, width: 0, height: 0 };
  const effectPool: Sprite[] = [];
  const effectInfo: { effect: string; frameName: string; target: 0 | 1 }[] = [];
  const labelPool: Text[] = [];
  const labelInfo: { text: string }[] = [];
  let battleView: BattleView | null = null;
  let last: { state: ExpeditionSceneState | null; pose: GladiatorPose | null; animation: string; frames: string[]; flip: boolean; creatureAlpha: number; positionMs: number | null; returned: boolean } =
    { state: null, pose: null, animation: '', frames: [], flip: false, creatureAlpha: 0, positionMs: null, returned: false };

  class ExpeditionScene extends P.Scene {
    constructor() { super({ key: 'expedition' }); }

    init() {
      // Game.destroy emits DESTROY (never SHUTDOWN); the host also calls dispose() directly.
      this.events.once(P.Scenes.Events.DESTROY, dispose);
      // Render textures come back empty after a WebGL context restore; repaint the baked ground.
      const repaint = () => this.paintGround();
      this.renderer.on(P.Renderer.Events.RESTORE_WEBGL, repaint);
      this.events.once(P.Scenes.Events.DESTROY, () => this.renderer.off(P.Renderer.Events.RESTORE_WEBGL, repaint));
    }

    preload() {
      const keys = new Set([gladiator.atlas, 'creatures', 'effects', map.tilesAtlas, map.propsAtlas]);
      for (const key of keys) {
        const def = manifest.atlases[key];
        this.load.atlas(key, `${deps.assetBase}${def.image}`, deps.atlasData[def.data] as object);
      }
      this.load.on(P.Loader.Events.FILE_LOAD_ERROR, (file: PhaserNS.Loader.File) => this.fail('assets', `could not load ${file.key}`));
    }

    create() {
      if (failed) return;
      try {
        this.cameras.main.setBackgroundColor(BG);
        this.buildGround();
        this.buildProps();
        this.buildLights();
        overlay = this.add.rectangle(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, bounds.width + 8000, bounds.height + 8000, 0xffffff, 0).setDepth(2_000_000);
        this.buildHero();
        this.buildWaiters();
        this.setupInput();
        this.scale.on(P.Scale.Events.RESIZE, () => this.syncCamera());
        const start = worldToScreen(journey.points.start.x + 0.5, journey.points.start.y + 0.5);
        view = { ...view, centerX: start.x, centerY: start.y - 24 };
        this.syncCamera();
        ready = true;
        this.tick(true);
        deps.onReady();
      } catch (error) {
        this.fail('error', errorText(error));
      }
    }

    fail(reason: 'assets' | 'error', message: string) {
      if (failed) return;
      failed = true;
      deps.onError(reason, message);
    }

    /** Ground tiles never change, so they are baked into four render textures. */
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
          // Wide props draw as slices so an actor in front of any face draws over it (src/game/depth.ts).
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

    buildHero() {
      const layers = look.layers.map(id => {
        const sprite = this.add.sprite(0, 0, gladiator.atlas, `${id}/idle/se/0`);
        const key = gladiator.layers.find(l => l.id === id)?.tint;
        if (key) sprite.setTint(look.tint[key]);
        return { id, sprite };
      });
      const container = this.add.container(0, 0, layers.map(l => l.sprite));
      const label = this.nameLabel(look.name);
      if (hero) { hero.container.destroy(); hero.label.destroy(); }
      hero = { container, layers, label };
      last = { ...last, animation: '', frames: [] };
    }

    nameLabel(text: string) {
      return this.add.text(0, 0, text, NAME_LABEL_STYLE).setOrigin(0.5, 1).setDepth(NAME_LABEL_DEPTH).setResolution(2);
    }

    /** How far above its feet the creature's idle art reaches (its highest opaque pixel over the loop), in art pixels. */
    creatureReach(atlas: string, anim: AnimationDef) {
      const frames = manifest.atlases[atlas].frames;
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      let reach = 0;
      for (const name of anim.frames) {
        const frame = this.textures.getFrame(atlas, name);
        canvas.width = frame.cutWidth;
        canvas.height = frame.cutHeight;
        ctx.drawImage(frame.source.image as CanvasImageSource, frame.cutX, frame.cutY, frame.cutWidth, frame.cutHeight, 0, 0, frame.cutWidth, frame.cutHeight);
        const rgba = ctx.getImageData(0, 0, frame.cutWidth, frame.cutHeight).data;
        let top = 0;
        while (top < frame.cutHeight && !rowOpaque(rgba, top * frame.cutWidth * 4, frame.cutWidth)) top += 1;
        if (top < frame.cutHeight) reach = Math.max(reach, frames[name].anchorY - top);
      }
      return reach;
    }

    /** One idle sprite and name per encounter, at the spot where its fight puts the creature (the right-hand fighter, mirrored). */
    buildWaiters() {
      journey.encounters.forEach((spot, i) => {
        const art = manifest.actors.creatures.find(c => c.id === spot.creature);
        const key = art?.animations.idle?.se;
        const anim = key ? manifest.animations[key] : undefined;
        if (!art || !anim) return;
        const feet = worldToScreen(spot.enemy.x + 0.5, spot.enemy.y + 0.5);
        const left = spot.enemyFacing === 'sw' || spot.enemyFacing === 'nw';
        const sprite = this.add.sprite(feet.x, feet.y, art.atlas, anim.frames[0]).setScale(left ? -1 : 1, 1).setDepth(feet.y + WAITING_DEPTH).setVisible(false);
        const labelY = feet.y - this.creatureReach(art.atlas, anim) - NAME_LABEL_GAP;
        const label = this.nameLabel(art.name).setPosition(feet.x, labelY).setVisible(false);
        waiters.push({ encounter: i + 1, creatureId: art.id, sprite, anim, index: 0, label, labelY });
      });
    }

    /** Shows each creature that waits or stays at its spot, idling; the fight sprite draws every other one. */
    updateWaiters(state: ExpeditionSceneState | null, now: number) {
      for (const w of waiters) {
        const mode = state ? creatureMode(state, w.encounter) : 'gone';
        const show = mode === 'waiting' || mode === 'stays';
        if (w.sprite.visible !== show) { w.sprite.setVisible(show); w.label.setVisible(show); }
        if (!show) continue;
        const index = reducedMotion ? 0 : frameIndex(w.anim, now + w.encounter * WAITING_STAGGER_MS);
        if (index !== w.index) { w.index = index; w.sprite.setFrame(w.anim.frames[index]); }
      }
    }

    /**
     * Keeps each shown creature's name over its head, and clear of the gladiator's name: where the two would overlap
     * (a long name at a spot beside a tall creature) the creature's name moves up over the gladiator's.
     */
    placeWaiterLabels() {
      const own = hero?.label;
      for (const w of waiters) {
        if (!w.label.visible) continue;
        let y = w.labelY;
        if (own?.visible) {
          boxOf(mine, w.label, y);
          boxOf(theirs, own, own.y);
          y = clearOfLabel(mine, theirs);
        }
        if (w.label.y !== y) w.label.setY(y);
      }
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
        if (p1?.isDown && p2?.isDown) {
          const distance = P.Math.Distance.Between(p1.x, p1.y, p2.x, p2.y);
          if (!pinch || pinch.distance < 1) { pinch = { distance, zoom: view.zoom }; return; }
          const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
          view = zoomAround(view, (pinch.zoom * (distance / pinch.distance)) / view.zoom, mid, bounds);
          this.syncCamera();
          return;
        }
        pinch = null;
        if (!pointer.isDown) return;
        // A press with a little jitter is a click, not a drag, and keeps the follow going.
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

    syncCamera() {
      const cam = this.cameras.main;
      view = clampView({ ...view, viewWidth: cam.width, viewHeight: cam.height }, bounds);
      cam.setZoom(view.zoom);
      cam.centerOn(view.centerX, view.centerY);
    }

    update() {
      // A hidden tab draws nothing (Phaser keeps its loop running when only the visibility state says
      // hidden); the first frame back reads the current display time, so nothing catches up.
      if (!ready || failed || disposed || document.visibilityState === 'hidden') return;
      try {
        this.tick(false);
      } catch (error) {
        this.fail('error', errorText(error));
      }
    }

    tick(snap: boolean) {
      const state = deps.state();
      last.state = state;
      const now = state?.displayNowMs ?? 0;
      this.drawLighting(now);
      for (const a of animatedProps) {
        const index = reducedMotion ? 0 : frameIndex(a.anim, now);
        if (index !== a.index) { a.index = index; a.image.setFrame(a.anim.frames[index]); }
      }
      this.updateWaiters(state, now);
      const route = state?.route ?? null;
      const pose = route ? gladiatorPose(journey, route, speed) : null;
      last.pose = pose;
      // Back at camp: the gladiator leaves the scene where it waited or rested, fading out.
      const returned = route?.then === 'leave';
      const presence = !route ? 0 : !returned ? 1 : reducedMotion ? 0 : Math.max(0, 1 - route.walkedMs / HERO_LEAVE_MS);
      if (returned !== last.returned) { last.returned = returned; deps.onReturned?.(returned); }
      if (!hero) return;
      hero.container.setVisible(!!pose && presence > 0).setAlpha(presence);
      hero.label.setVisible(!!pose && presence > 0).setAlpha(presence);
      const battle = state?.battle ?? null;
      const fighting = !!pose && pose.action === 'fight' && !!battle && route?.from === `encounter-${battle.encounter}`;
      const staged = battle ? this.stageBattle(battle, fighting) : this.clearBattle();
      if (pose) {
        const feet = worldToScreen(pose.x, pose.y);
        if (staged && fighting) {
          const f = staged.fighters[0];
          const name = manifest.animations[f.animation].frames[f.frame];
          this.setHeroFrames(f.animation, hero.layers.map(l => name.replace(/^body\//, `${l.id}/`)), f.flip);
          hero.container.setPosition(f.x + staged.shake.x, f.y + staged.shake.y).setDepth(f.y + f.depth / 100);
        } else {
          const action = pose.action === 'fight' ? 'idle' : pose.action;
          const dirs = gladiator.animations[action] ?? gladiator.animations.idle;
          const back = pose.facing === 'ne' || pose.facing === 'nw';
          const key = back && dirs.ne ? dirs.ne : dirs.se;
          const anim = manifest.animations[key];
          const name = anim.frames[frameIndex(anim, now)];
          this.setHeroFrames(key, hero.layers.map(l => name.replace(/^body\//, `${l.id}/`)), pose.facing === 'sw' || pose.facing === 'nw');
          hero.container.setPosition(feet.x, feet.y).setDepth(feet.y);
        }
        hero.label.setText(look.name).setPosition(hero.container.x, feet.y - 46);
        if (following) this.follow(feet, snap);
      }
      this.placeWaiterLabels();
      // Props fade only for a gladiator still in the scene.
      this.updateOccluders(pose && presence > 0 ? worldToScreen(pose.x, pose.y) : null);
    }

    setHeroFrames(animation: string, frames: string[], flip: boolean) {
      if (!hero) return;
      if (frames.join('|') !== last.frames.join('|')) hero.layers.forEach((l, i) => l.sprite.setFrame(frames[i]));
      if (flip !== last.flip || hero.container.scaleX !== (flip ? -1 : 1)) hero.container.setScale(flip ? -1 : 1, 1);
      last = { ...last, animation, frames, flip };
    }

    /** No battle is revealed (the display time went back before it): nothing of a fight stays drawn. */
    clearBattle() {
      if (!battleView) return null;
      battleView = null;
      creature?.container.destroy();
      creature = null;
      for (const sprite of effectPool) if (sprite.visible) sprite.setVisible(false);
      for (const text of labelPool) if (text.visible) text.setVisible(false);
      effectInfo.length = 0;
      labelInfo.length = 0;
      last.positionMs = null;
      last.creatureAlpha = 0;
      return null;
    }

    /** Stages the latest revealed battle at its encounter spot; after the result poses a beaten creature fades and a winner idles. */
    stageBattle(battle: NonNullable<ExpeditionSceneState['battle']>, fighting: boolean) {
      if (!battleView || battleView.battleId !== battle.log.battleId) {
        battleView = { battleId: battle.log.battleId, plan: planStage(battle.log, manifest), controller: createReplayController(battle.log) };
        creature?.container.destroy();
        creature = null;
      }
      const spot = journey.encounters[battle.encounter - 1];
      const { plan, controller } = battleView;
      controller.seek(battle.elapsedMs);
      last.positionMs = controller.positionMs;
      const feet = [worldToScreen(spot.gladiator.x + 0.5, spot.gladiator.y + 0.5), worldToScreen(spot.enemy.x + 0.5, spot.enemy.y + 0.5)];
      const layout: StageLayout = { width: 0, height: 0, scale: 1, backdropX: 0, backdropY: 0, feet: [feet[0], feet[1]] };
      const frame = stageAt(plan, controller.positionMs, layout, { reducedMotion });
      const shake = reducedMotion ? { x: 0, y: 0 } : frame.shake;
      // The creature: drawn while the fight and its result poses play. Then a beaten one fades out, and one that won
      // is handed to its idle sprite (updateWaiters), which stands where the fight sprite did.
      const after = battle.elapsedMs - battle.log.durationMs - REPLAY_OUTRO_MS;
      const alpha = fightCreatureAlpha(battle, reducedMotion);
      const look1 = plan.looks[1];
      if (!creature && look1.kind === 'creature') {
        const sprite = this.add.sprite(0, 0, look1.atlas, frame.fighters[1].frames[0]);
        creature = { container: this.add.container(0, 0, [sprite]), sprite, creatureId: look1.creatureId ?? '' };
      }
      if (creature) {
        const f = frame.fighters[1];
        if (creature.sprite.frame.name !== f.frames[0]) creature.sprite.setFrame(f.frames[0]);
        creature.container.setPosition(f.x + shake.x, f.y + shake.y).setScale(f.flip ? -1 : 1, 1).setDepth(f.y + f.depth / 100).setAlpha(alpha).setVisible(alpha > 0);
      }
      last.creatureAlpha = alpha;
      // Effects and damage labels only while the gladiator is at the fight.
      const effects = fighting && after <= 0 ? frame.effects : [];
      effects.forEach((e, k) => {
        const sprite = effectPool[k] ?? (effectPool[k] = this.add.sprite(0, 0, 'effects', e.frameName).setDepth(1_500_000));
        sprite.setFrame(e.frameName).setPosition(e.x + shake.x, e.y + shake.y).setFlipX(e.flip).setVisible(true);
        effectInfo[k] = { effect: e.effect, frameName: e.frameName, target: e.target };
      });
      for (let k = effects.length; k < effectPool.length; k += 1) if (effectPool[k].visible) effectPool[k].setVisible(false);
      effectInfo.length = effects.length;
      const labels = fighting ? frame.labels : [];
      labels.forEach((l, k) => {
        const text = labelPool[k] ?? (labelPool[k] = this.add.text(0, 0, '', { fontFamily: 'monospace', fontStyle: 'bold', fontSize: '10px', stroke: '#1a1423', strokeThickness: 3 })
          .setOrigin(0.5, 1).setResolution(2).setDepth(1_500_001));
        if (text.text !== l.text) text.setText(l.text);
        text.setColor(LABEL_COLORS[l.kind]).setPosition(l.x, l.y - LABEL_LIFT).setAlpha(l.alpha).setVisible(true);
        labelInfo[k] = { text: l.text };
      });
      for (let k = labels.length; k < labelPool.length; k += 1) if (labelPool[k].visible) labelPool[k].setVisible(false);
      labelInfo.length = labels.length;
      return { ...frame, shake };
    }

    follow(feet: Point, snap: boolean) {
      const k = snap || reducedMotion ? 1 : 0.12;
      const centerX = view.centerX + (feet.x - view.centerX) * k;
      const centerY = view.centerY + (feet.y - 24 - view.centerY) * k;
      if (Math.abs(centerX - view.centerX) > 0.01 || Math.abs(centerY - view.centerY) > 0.01) {
        view = clampView({ ...view, centerX, centerY }, bounds);
        this.syncCamera();
      }
    }

    drawLighting(now: number) {
      const light = lightingAt(now);
      if (overlay && (overlay.fillColor !== light.overlayColor || overlay.fillAlpha !== light.overlayAlpha)) overlay.setFillStyle(light.overlayColor, light.overlayAlpha);
      const torch = Math.min(1, 0.25 + 0.55 * light.torchIntensity);
      for (const l of lights) l.image.setAlpha(reducedMotion ? torch : torch * (0.88 + 0.12 * Math.sin(now / 170 + l.seed)));
    }

    /** Fade whole props whose opaque pixels hide the gladiator; only faded ones are restored. */
    updateOccluders(feet: Point | null) {
      const hiding = new Set<PropGroup>();
      if (feet) {
        for (const g of propGroups) {
          if (!g.occludes || feet.x < g.left - 8 || feet.x >= g.left + g.width + 8 || feet.y - 40 >= g.top + g.height || feet.y <= g.top) continue;
          const mask = this.alphaMask(g.frame);
          if (hidesActor(g, (x, y) => mask.alpha[y * mask.width + x], feet)) hiding.add(g);
        }
      }
      for (const g of faded) if (!hiding.has(g)) { for (const image of g.images) image.setAlpha(1); faded.delete(g); }
      for (const g of hiding) if (!faded.has(g)) { for (const image of g.images) image.setAlpha(FADED_ALPHA); faded.add(g); }
    }

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
  }

  const scene = new ExpeditionScene();
  const live = () => ready && !disposed && !failed;

  /** Dragging ends the follow; tell the UI so its Follow toggle stays truthful. */
  function stopFollowing() {
    if (!following) return;
    following = false;
    deps.bridge.emit('follow-character', { gladiatorId: null });
  }

  // Bridge listeners belong to this scene instance and are removed by dispose().
  const unsubscribe: (() => void)[] = [
    deps.bridge.on('camera-zoom', ({ direction }) => {
      if (!live()) return;
      const centre = { x: view.viewWidth / 2, y: view.viewHeight / 2 };
      scene.zoomTo(direction === 'reset' ? DEFAULT_ZOOM : stepZoom(view.zoom, direction === 'in' ? 1 : -1), centre);
    }),
    deps.bridge.on('camera-pan', ({ dx, dy }) => {
      if (!live()) return;
      stopFollowing();
      view = panBy(view, dx, dy, bounds);
      scene.syncCamera();
    }),
    // The Follow toggle: any gladiator id follows the one gladiator in this scene; null frees the camera.
    deps.bridge.on('follow-character', ({ gladiatorId }) => {
      if (!disposed) following = gladiatorId !== null;
    }),
  ];

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const off of unsubscribe.splice(0)) off();
  }

  const handle: ExpeditionSceneHandle = {
    setReducedMotion(reduced) { reducedMotion = reduced; },
    setLook(next) {
      const changed = next.layers.join('+') !== look.layers.join('+') || next.name !== look.name
        || next.tint.skin !== look.tint.skin || next.tint.cloth !== look.tint.cloth || next.tint.hair !== look.tint.hair;
      look = next;
      if (changed && live()) scene.buildHero();
    },
    dispose,
    debug() {
      const cam = live() ? scene.cameras.main : undefined;
      const pose = last.pose;
      return {
        ready, disposed, failed, reducedMotion, environment: deps.environment,
        displayNowMs: last.state?.displayNowMs ?? null,
        phase: last.state?.phase ?? null,
        following,
        returned: last.returned,
        camera: cam
          ? { centerX: cam.midPoint.x, centerY: cam.midPoint.y, zoom: cam.zoom, worldView: { x: cam.worldView.x, y: cam.worldView.y, width: cam.worldView.width, height: cam.worldView.height }, bounds }
          : { centerX: 0, centerY: 0, zoom: 1, worldView: { x: 0, y: 0, width: 0, height: 0 }, bounds },
        gladiator: hero && pose ? {
          x: pose.x, y: pose.y, action: pose.action, animation: last.animation, frames: [...last.frames], layers: hero.layers.map(l => l.id), tint: { ...look.tint },
          facing: pose.facing, depth: hero.container.depth, screenX: hero.container.x, screenY: hero.container.y, scaleX: hero.container.scaleX,
          visible: hero.container.visible, alpha: hero.container.alpha, labelVisible: hero.label.visible, walking: pose.walking,
          labelBox: { x: hero.label.x, y: hero.label.y, width: hero.label.width, height: hero.label.height },
        } : null,
        creature: creature && battleView ? {
          id: battleView.plan.log.participants[1].id, creatureId: creature.creatureId,
          x: creature.container.x, y: creature.container.y, frame: String(creature.sprite.frame.name), depth: creature.container.depth,
          alpha: creature.container.alpha, scaleX: creature.container.scaleX, visible: creature.container.visible,
        } : null,
        waiting: waiters.map(w => ({ encounter: w.encounter, creatureId: w.creatureId, x: w.sprite.x, y: w.sprite.y, frame: String(w.sprite.frame.name), visible: w.sprite.visible, depth: w.sprite.depth, scaleX: w.sprite.scaleX,
          label: { text: w.label.text, x: w.label.x, y: w.label.y, visible: w.label.visible, width: w.label.width, height: w.label.height } })),
        battle: battleView && last.positionMs !== null ? { battleId: battleView.battleId, positionMs: last.positionMs } : null,
        effects: effectInfo.map((e, k) => ({ ...e, x: effectPool[k].x, y: effectPool[k].y, visible: effectPool[k].visible })),
        labels: labelInfo.map((l, k) => ({ ...l, x: labelPool[k].x, y: labelPool[k].y })),
        faded: [...faded].map(g => g.id),
      };
    },
    props() {
      return propGroups.map(g => ({
        id: g.id, frame: g.frame, x: g.x, y: g.y, occludes: g.occludes, alpha: g.images[0].alpha,
        slices: g.slices.map((s, i) => ({ left: s.left, width: s.width, depth: g.images[i].depth })),
      }));
    },
  };
  return { scene, handle };
}
