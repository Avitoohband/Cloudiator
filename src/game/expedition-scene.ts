// The followable expedition scene. Phaser is injected (loaded lazily in the browser) so this module
// stays importable during the static build. Every frame it reads the stage state for the display clock
// (src/game/expedition-stage.ts) and only draws it: the gladiator walks the map route, searches, waits,
// fights a revealed encounter (its battle log, seeked with the replay controller and staged by
// battle-stage) or rests at the safe point; once the expedition is back at camp it leaves the scene.
// Each encounter's creature waits idling at its spot, named like the gladiator, until its fight
// (src/game/expedition-creatures.ts): a creature the gladiator beat fades after the fight, one that won stays
// idling at its spot.
// It never reveals a stage, simulates a fight or settles anything. The map and the camera are the shared map layer
// (src/game/map-layer.ts, Patch A Task 10): baked ground, depth-sliced props (src/game/depth.ts) and buildings that fade while
// their opaque pixels hide the gladiator. A hidden tab draws nothing; on return the scene shows the current display time
// directly. In the whole-trip replay the same Phaser game also holds the camp's scene (src/game/trip-camp-scene.ts): this scene
// sleeps while the camp's bookends play, and its bridge zoom and pan wait until it wakes.
import type * as PhaserNS from 'phaser';
import type { AnimationDef, AssetManifest, Direction, MapData } from './assets';
import type { SceneBridge } from './bridge';
import type { ExpeditionSceneState } from './expedition-stage';
import { REPLAY_OUTRO_MS, createReplayController, type ReplayController } from './replay';
import { frameIndex, planStage, stageAt, type LabelPose, type StageLayout, type StagePlan } from './battle-stage';
import { gladiatorPose, journeyMap, type GladiatorPose } from './expedition-path';
import { clearOfLabel, creatureMode, fightCreatureAlpha, type LabelBox } from './expedition-creatures';
import { ZOOM_STEP } from './camera';
import { worldToScreen, type Rect } from './iso';
import { NAME_LABEL_DEPTH, NAME_LABEL_STYLE, createMapCamera, createMapLayer, type MapCamera, type MapLayer, type MapPropDebug } from './map-layer';

type Phaser = typeof PhaserNS;
type Sprite = PhaserNS.GameObjects.Sprite;
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
  /**
   * Read every frame: whether a search steps around its spot (default true). The whole-trip replay passes false: at its speed
   * the steps would strobe, so the search holds on the spot, turning only (Patch A Task 9).
   */
  wander?: () => boolean;
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
export type ExpeditionPropDebug = MapPropDebug;

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
/** A waiting creature's depth offset: the fight draws its right-hand fighter at rest at `y + (10 + 1) / 100` (battle-stage). */
const WAITING_DEPTH = 0.11;
/** Waiting creatures breathe out of step: each encounter's idle loop is offset by this much per encounter. */
const WAITING_STAGGER_MS = 370;
/** A creature's name sits this far above the top of its art. */
const NAME_LABEL_GAP = 2;
/** Back at camp, the gladiator fades out of the scene over this long (at once with reduced motion). */
const HERO_LEAVE_MS = 1500;
const LABEL_COLORS: Record<LabelPose['kind'], string> = { damage: '#ffffff', critical: '#ffe48f', guard: '#8edcf4', miss: '#d4d4d8' };
/** Damage labels rise from just above the gladiator's name label (46 px over the feet), never over it. */
const LABEL_LIFT = 14;

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
  const gladiator = manifest.actors.gladiator;
  const speed = gladiator.walk.tilesPerSecond;

  let ready = false;
  let disposed = false;
  let failed = false;
  let reducedMotion = !!deps.reducedMotion;
  let look = deps.look;
  let layer: MapLayer | null = null;
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
      const repaint = () => layer?.paint();
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
        layer = createMapLayer(P, this, manifest, map);
        this.buildHero();
        this.buildWaiters();
        camera.start(worldToScreen(journey.points.start.x + 0.5, journey.points.start.y + 0.5));
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
      layer?.update(now, reducedMotion);
      this.updateWaiters(state, now);
      const route = state?.route ?? null;
      // Reduced motion keeps a search on the spot: no steps for the camera to snap to; so does the whole-trip replay.
      const pose = route ? gladiatorPose(journey, route, speed, { wander: !reducedMotion && deps.wander?.() !== false }) : null;
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
          // The search cycle times its own crouch and look (expedition-path SEARCH_PATTERN); other loops run on the clock.
          const name = anim.frames[frameIndex(anim, pose.animMs ?? now)];
          this.setHeroFrames(key, hero.layers.map(l => name.replace(/^body\//, `${l.id}/`)), pose.facing === 'sw' || pose.facing === 'nw');
          hero.container.setPosition(feet.x, feet.y).setDepth(feet.y);
        }
        hero.label.setText(look.name).setPosition(hero.container.x, feet.y - 46);
        // While searching, a following camera holds on the search spot instead of swaying with every step.
        if (camera.following()) camera.follow(pose.follow ? worldToScreen(pose.follow.x, pose.follow.y) : feet, snap);
      }
      this.placeWaiterLabels();
      // Props fade only for a gladiator still in the scene.
      layer?.occlude(pose && presence > 0 ? worldToScreen(pose.x, pose.y) : null);
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
  }

  const scene = new ExpeditionScene();
  const live = () => ready && !disposed && !failed;
  // The camera's bridge listeners belong to this scene instance and are removed by dispose().
  const camera: MapCamera = createMapCamera(P, scene, { map, zoom: DEFAULT_ZOOM, bridge: deps.bridge, reducedMotion: () => reducedMotion, live });

  function dispose() {
    if (disposed) return;
    disposed = true;
    camera.dispose();
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
        following: camera.following(),
        returned: last.returned,
        camera: cam
          ? { centerX: cam.midPoint.x, centerY: cam.midPoint.y, zoom: cam.zoom, worldView: { x: cam.worldView.x, y: cam.worldView.y, width: cam.worldView.width, height: cam.worldView.height }, bounds: camera.bounds }
          : { centerX: 0, centerY: 0, zoom: 1, worldView: { x: 0, y: 0, width: 0, height: 0 }, bounds: camera.bounds },
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
        faded: layer?.faded() ?? [],
      };
    },
    props: () => layer?.props() ?? [],
  };
  return { scene, handle };
}
