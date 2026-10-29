// The camp's own map in the whole-trip replay's camp chapters (Patch A Task 10, spec "Item 3 + Task 10", "Camp bookends"):
// "Leaving camp" and "Back in camp" at the gate, and "Resting" on a bed of the rest zone. It draws only the map and the one
// gladiator, where src/game/trip-vignette.ts puts it at the chapter's elapsed time (`vignette()`, read every frame): no other
// actor, no clock of its own. It lives in the expedition viewport's Phaser game beside the expedition scene (src/game/
// ExpeditionViewport.tsx), which adds it when the replay starts (its atlases load then) and runs one of the two at a time, so the
// replay never opens a second WebGL context. The map and the camera are the expedition's (src/game/map-layer.ts): the light of the
// chapter's time of day (the vignette's `displayMs`), props that fade while they hide the gladiator, the viewport's zoom, pan and
// Follow controls. Each chapter opens with the camera on the gladiator, Follow or not (the gate and the beds are about 29 tiles
// apart); after that, only a following camera moves with it.
// With reduced motion there is no fade at the gate and the props and torches hold still; the walks are still shown.
import type * as PhaserNS from 'phaser';
import type { AssetManifest, MapData } from './assets';
import type { SceneBridge } from './bridge';
import type { GladiatorLook } from './expedition-scene';
import type { TripVignette } from './trip-replay';
import { frameIndex } from './battle-stage';
import { ZOOM_STEP } from './camera';
import { worldToScreen } from './iso';
import { NAME_LABEL_DEPTH, NAME_LABEL_STYLE, createMapCamera, createMapLayer, type MapCamera, type MapLayer } from './map-layer';
import { vignettePose, type VignettePose } from './trip-vignette';

type Phaser = typeof PhaserNS;
type Sprite = PhaserNS.GameObjects.Sprite;
type Container = PhaserNS.GameObjects.Container;
type Text = PhaserNS.GameObjects.Text;

/** The camp scene's key in the viewport's game. */
export const TRIP_CAMP_SCENE = 'trip-camp';

export type TripCampDebug = {
  /** Drawn and able to draw (its art loaded, never failed). */
  ready: boolean;
  /** The camp chapter drawn last frame (null: none, the scene draws no gladiator). */
  kind: TripVignette['kind'] | null;
  gladiator: { x: number; y: number; action: string; alpha: number; layers: string[] } | null;
  /** The camera: whether it follows the gladiator (the viewport's Follow toggle), its zoom, and the world rectangle it shows. */
  following: boolean;
  zoom: number;
  worldView: { x: number; y: number; width: number; height: number };
};
export type TripCampHandle = {
  setLook(look: GladiatorLook): void;
  setReducedMotion(reduced: boolean): void;
  /** Removes the scene's bridge listeners. Idempotent; also runs when the game destroys the scene. */
  dispose(): void;
  /** Drawn and able to draw, as `debug().ready`, without building the debug state (the viewport asks every frame). */
  ready(): boolean;
  debug(): TripCampDebug;
};
export type TripCampSceneDeps = {
  manifest: AssetManifest;
  atlasData: Record<string, unknown>;
  assetBase: string;
  /** The camp chapter at the replay clock, read every frame (null outside the camp chapters). */
  vignette: () => TripVignette | null;
  look: GladiatorLook;
  reducedMotion: boolean;
  /** The viewport's camera controls and Follow toggle; without it the camera only follows the gladiator. */
  bridge?: SceneBridge;
  /** Whether the camera starts following the gladiator: the viewport's Follow toggle when the scene is added (default true). */
  following?: boolean;
};

const BG = 0x1c3f24;
/** As the expedition scene: one actor fills more of the view than in the busy camp. */
const DEFAULT_ZOOM = ZOOM_STEP ** 2;
/** The name sits this far over the gladiator's feet, as in the expedition scene. */
const NAME_LIFT = 46;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createTripCampScene(P: Phaser, deps: TripCampSceneDeps): { scene: PhaserNS.Scene; handle: TripCampHandle } {
  const { manifest } = deps;
  const found = manifest.maps.find(m => m.id === 'camp');
  if (!found) throw new Error('No camp map');
  const map: MapData = found;
  const gladiator = manifest.actors.gladiator;
  const speed = gladiator.walk.tilesPerSecond;
  const gate = map.zones.flatMap(z => z.stations).find(s => s.kind === 'gate') ?? map.spawn;

  let ready = false;
  let disposed = false;
  let failed = false;
  let reducedMotion = deps.reducedMotion;
  let look = deps.look;
  let layer: MapLayer | null = null;
  let hero: { container: Container; layers: { id: string; sprite: Sprite }[]; label: Text } | null = null;
  /**
   * What the last frame drew; `snap` puts the camera on the gladiator at once (a new chapter, or the scene woke); `lightMs` is the
   * time the map was last lit at (the chapter's display time, on by its elapsed time).
   */
  let last: { kind: TripVignette['kind'] | null; pose: VignettePose | null; frames: string; flip: boolean; snap: boolean; lightMs: number } =
    { kind: null, pose: null, frames: '', flip: false, snap: true, lightMs: Number.NaN };

  class TripCampScene extends P.Scene {
    constructor() { super({ key: TRIP_CAMP_SCENE }); }

    init() {
      // Game.destroy emits DESTROY (never SHUTDOWN); the host also calls dispose() directly.
      this.events.once(P.Scenes.Events.DESTROY, dispose);
      // Render textures come back empty after a WebGL context restore; repaint the baked ground.
      const repaint = () => layer?.paint();
      this.renderer.on(P.Renderer.Events.RESTORE_WEBGL, repaint);
      this.events.once(P.Scenes.Events.DESTROY, () => this.renderer.off(P.Renderer.Events.RESTORE_WEBGL, repaint));
      // Back from sleep (the expedition ran in between): the camera goes straight to the gladiator.
      this.events.on(P.Scenes.Events.WAKE, () => { last.snap = true; });
    }

    preload() {
      // The gladiators' atlas is the expedition scene's already (one texture manager per game); the camp's own load now.
      for (const key of new Set([gladiator.atlas, map.tilesAtlas, map.propsAtlas])) {
        if (this.textures.exists(key)) continue;
        const def = manifest.atlases[key];
        this.load.atlas(key, `${deps.assetBase}${def.image}`, deps.atlasData[def.data] as object);
      }
      this.load.on(P.Loader.Events.FILE_LOAD_ERROR, (file: PhaserNS.Loader.File) => this.fail(`could not load ${file.key}`));
    }

    create() {
      if (failed) return;
      try {
        this.cameras.main.setBackgroundColor(BG);
        layer = createMapLayer(P, this, manifest, map);
        this.buildHero();
        camera.start(worldToScreen(gate.x + 0.5, gate.y + 0.5));
        ready = true;
        this.tick();
      } catch (error) {
        this.fail(errorText(error));
      }
    }

    /** A camp scene that cannot draw is never shown: the expedition scene keeps drawing the trail's start or end instead. */
    fail(message: string) {
      if (failed) return;
      failed = true;
      if (process.env.NODE_ENV !== 'production') console.warn(`trip camp scene: the camp's bookends are not drawn (${message})`);
    }

    buildHero() {
      const layers = look.layers.map(id => {
        const sprite = this.add.sprite(0, 0, gladiator.atlas, `${id}/idle/se/0`);
        const key = gladiator.layers.find(l => l.id === id)?.tint;
        if (key) sprite.setTint(look.tint[key]);
        return { id, sprite };
      });
      const container = this.add.container(0, 0, layers.map(l => l.sprite)).setVisible(false);
      const label = this.add.text(0, 0, look.name, NAME_LABEL_STYLE).setOrigin(0.5, 1).setDepth(NAME_LABEL_DEPTH).setResolution(2).setVisible(false);
      if (hero) { hero.container.destroy(); hero.label.destroy(); }
      hero = { container, layers, label };
      last = { ...last, frames: '', flip: false };
    }

    update() {
      // A hidden tab draws nothing; the first frame back reads the replay clock directly.
      if (!ready || failed || disposed || document.visibilityState === 'hidden') return;
      try {
        this.tick();
      } catch (error) {
        this.fail(errorText(error));
      }
    }

    tick() {
      const vignette = deps.vignette();
      // The light of the chapter's time of day; the torches and the props' loops run on with the chapter (and hold when paused).
      if (vignette) last.lightMs = vignette.displayMs + vignette.elapsedMs;
      if (Number.isFinite(last.lightMs)) layer?.update(last.lightMs, reducedMotion);
      const snap = last.snap || vignette?.kind !== last.kind;
      last.kind = vignette?.kind ?? null;
      const pose = vignette ? vignettePose(map, vignette, look.key, speed, { fades: !reducedMotion }) : null;
      last.pose = pose;
      if (!hero) return;
      const shown = !!pose && pose.alpha > 0;
      hero.container.setVisible(shown).setAlpha(pose?.alpha ?? 0);
      hero.label.setVisible(shown).setAlpha(pose?.alpha ?? 0);
      if (vignette && pose) {
        const feet = worldToScreen(pose.x, pose.y);
        const dirs = gladiator.animations[pose.action] ?? gladiator.animations.idle;
        const back = pose.facing === 'ne' || pose.facing === 'nw';
        const anim = manifest.animations[back && dirs.ne ? dirs.ne : dirs.se];
        // The loops run on the chapter's own time, so a paused replay holds its frame.
        const name = anim.frames[frameIndex(anim, vignette.elapsedMs)];
        const frames = hero.layers.map(l => name.replace(/^body\//, `${l.id}/`));
        const flip = pose.facing === 'sw' || pose.facing === 'nw';
        if (frames.join('|') !== last.frames) { hero.layers.forEach((l, i) => l.sprite.setFrame(frames[i])); last.frames = frames.join('|'); }
        if (flip !== last.flip || hero.container.scaleX !== (flip ? -1 : 1)) { hero.container.setScale(flip ? -1 : 1, 1); last.flip = flip; }
        hero.container.setPosition(feet.x, feet.y).setDepth(feet.y);
        hero.label.setText(look.name).setPosition(feet.x, feet.y - NAME_LIFT);
        // A new chapter (or a wake) opens on the gladiator, Follow or not; then only a following camera keeps up.
        if (snap || camera.following()) camera.follow(feet, snap);
        last.snap = false;
      }
      // Props fade only for a gladiator in view.
      layer?.occlude(pose && shown ? worldToScreen(pose.x, pose.y) : null);
    }
  }

  const scene = new TripCampScene();
  const live = () => ready && !disposed && !failed;
  // The camera's bridge listeners belong to this scene instance and are removed by dispose().
  const camera: MapCamera = createMapCamera(P, scene, {
    map, zoom: DEFAULT_ZOOM, bridge: deps.bridge, following: deps.following, reducedMotion: () => reducedMotion, live,
  });

  function dispose() {
    if (disposed) return;
    disposed = true;
    camera.dispose();
  }
  /** The world rectangle the camera shows (empty before the scene is drawn). */
  function worldView() {
    const view = live() ? scene.cameras.main.worldView : null;
    return view ? { x: view.x, y: view.y, width: view.width, height: view.height } : { x: 0, y: 0, width: 0, height: 0 };
  }

  const handle: TripCampHandle = {
    setReducedMotion(reduced) { reducedMotion = reduced; },
    setLook(next) {
      const changed = next.layers.join('+') !== look.layers.join('+') || next.name !== look.name || next.key !== look.key
        || next.tint.skin !== look.tint.skin || next.tint.cloth !== look.tint.cloth || next.tint.hair !== look.tint.hair;
      look = next;
      if (changed && live()) scene.buildHero();
    },
    dispose,
    ready: live,
    debug() {
      const pose = last.pose;
      return {
        ready: live(),
        kind: last.kind,
        gladiator: hero && pose
          ? { x: pose.x, y: pose.y, action: pose.action, alpha: hero.container.alpha, layers: hero.layers.map(l => l.id) }
          : null,
        following: camera.following(),
        zoom: camera.view().zoom,
        worldView: worldView(),
      };
    },
  };
  return { scene, handle };
}
