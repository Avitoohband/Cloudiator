// The map under an isometric scene's actors, and the camera over it, shared by the expedition scene and the whole-trip replay's camp
// scene (Patch A Task 10: moved from src/game/expedition-scene.ts, unchanged in behaviour). It follows the camp's conventions
// (src/game/camp-scene.ts): the ground baked into four render textures, the props drawn in depth slices (src/game/depth.ts) with
// the buildings whose opaque pixels hide the followed actor faded, the torches' glow and the light of the time of day
// (src/game/lighting.ts) over everything. The camera follows the actor until a drag or a pan frees it, zooms with the wheel, a
// pinch and the viewport's buttons, and answers the scene bridge only while its scene is awake (one Phaser game holds both scenes,
// and only one of them runs at a time).
import type * as PhaserNS from 'phaser';
import type { AnimationDef, AssetManifest, MapData } from './assets';
import type { SceneBridge } from './bridge';
import { frameIndex } from './battle-stage';
import { clampView, panBy, stepZoom, zoomAround, type ViewState } from './camera';
import { mapScreenBounds, worldToScreen, type Point, type Rect } from './iso';
import { drawSlices, hidesActor, type PlacedImage } from './depth';
import { lightingAt } from './lighting';

type Phaser = typeof PhaserNS;
type Image = PhaserNS.GameObjects.Image;

/** The name over an actor, the same in every map scene: one style, so the gladiator's and a creature's cannot drift apart. */
export const NAME_LABEL_STYLE: PhaserNS.Types.GameObjects.Text.TextStyle = { fontFamily: 'monospace', fontSize: '10px', color: '#f4e8cb', stroke: '#1a1423', strokeThickness: 3 };
export const NAME_LABEL_DEPTH = 2_000_002;

const FADED_ALPHA = 0.45;
const WHEEL_STEP = 100;
const WHEEL_LINE = 40;
const WHEEL_IDLE_MS = 250;
const DRAG_THRESHOLD = 6;

export type MapPropDebug = { id: string; frame: string; x: number; y: number; occludes: boolean; alpha: number; slices: { left: number; width: number; depth: number }[] };

type PropGroup = Omit<PlacedImage, 'slices'> & {
  id: string; frame: string; x: number; y: number; occludes: boolean; images: Image[];
  slices: { x0: number; x1: number; depth: number; left: number; width: number }[];
};

export type MapLayer = {
  /** Paints the baked ground again (render textures come back empty after a WebGL context restore). */
  paint(): void;
  /** The light at display time `now` (steady torches with reduced motion) and the props' own loops (still with reduced motion). */
  update(now: number, reducedMotion: boolean): void;
  /** Fades whole props whose opaque pixels hide an actor whose feet are at `feet` (null: nobody to hide); only faded ones are restored. */
  occlude(feet: Point | null): void;
  /** The ids of the props faded now. */
  faded(): string[];
  props(): MapPropDebug[];
};

/** Builds the map into `scene` (call it from the scene's create()): the ground, the props, the lights and the light's overlay. */
export function createMapLayer(P: Phaser, scene: PhaserNS.Scene, manifest: AssetManifest, map: MapData): MapLayer {
  const tileBounds = mapScreenBounds(map.width, map.height);
  const bounds: Rect = { x: tileBounds.x, y: tileBounds.y - 96, width: tileBounds.width, height: tileBounds.height + 96 };
  let groundChunks: { rt: PhaserNS.GameObjects.RenderTexture; left: number; top: number; tiles: { frame: string; left: number; top: number }[] }[] = [];
  const propGroups: PropGroup[] = [];
  const faded = new Set<PropGroup>();
  const alphaMasks = new Map<string, { width: number; alpha: Uint8Array }>();
  const animatedProps: { image: Image; anim: AnimationDef; index: number }[] = [];
  const lights: { image: Image; seed: number }[] = [];

  /** Ground tiles never change, so they are baked into four render textures. */
  function buildGround() {
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
      const rt = scene.add.renderTexture(left, top, chunkW, chunkH).setOrigin(0, 0).setDepth(-10_000_000);
      const inside = tiles.filter(t => t.left < left + chunkW && t.left + t.w > left && t.top < top + chunkH && t.top + t.h > top);
      groundChunks.push({ rt, left, top, tiles: inside });
    }
    paint();
  }

  function paint() {
    for (const { rt, left, top, tiles } of groundChunks) {
      rt.clear();
      for (const t of tiles) rt.stamp(map.tilesAtlas, t.frame, t.left - left, t.top - top, { originX: 0, originY: 0 });
      rt.render();
    }
  }

  function buildProps() {
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
        const image = scene.add.image(s.x, s.y, map.propsAtlas, p.frame).setDepth(s.y + slice.depthOffset);
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

  function buildLights() {
    const size = 128;
    if (!scene.textures.exists('glow')) {
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const g = canvas.getContext('2d')!;
      const grad = g.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2);
      grad.addColorStop(0, 'rgba(255,214,120,0.9)');
      grad.addColorStop(0.45, 'rgba(255,160,60,0.35)');
      grad.addColorStop(1, 'rgba(255,140,40,0)');
      g.fillStyle = grad; g.fillRect(0, 0, size, size);
      scene.textures.addCanvas('glow', canvas);
    }
    map.lights.forEach((l, i) => {
      const s = worldToScreen(l.x, l.y);
      const image = scene.add.image(s.x, s.y - 24, 'glow').setBlendMode(P.BlendModes.ADD).setDepth(2_000_001);
      const base = (l.radius * 32) / size;
      image.setScale(base * 2, base);
      lights.push({ image, seed: i * 1.7 });
    });
  }

  function alphaMask(frameName: string) {
    let mask = alphaMasks.get(frameName);
    if (mask) return mask;
    const frame = scene.textures.getFrame(map.propsAtlas, frameName);
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

  buildGround();
  buildProps();
  buildLights();
  const overlay = scene.add.rectangle(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, bounds.width + 8000, bounds.height + 8000, 0xffffff, 0).setDepth(2_000_000);

  return {
    paint,
    update(now, reducedMotion) {
      const light = lightingAt(now);
      if (overlay.fillColor !== light.overlayColor || overlay.fillAlpha !== light.overlayAlpha) overlay.setFillStyle(light.overlayColor, light.overlayAlpha);
      const torch = Math.min(1, 0.25 + 0.55 * light.torchIntensity);
      for (const l of lights) l.image.setAlpha(reducedMotion ? torch : torch * (0.88 + 0.12 * Math.sin(now / 170 + l.seed)));
      for (const a of animatedProps) {
        const index = reducedMotion ? 0 : frameIndex(a.anim, now);
        if (index !== a.index) { a.index = index; a.image.setFrame(a.anim.frames[index]); }
      }
    },
    occlude(feet) {
      const hiding = new Set<PropGroup>();
      if (feet) {
        for (const g of propGroups) {
          if (!g.occludes || feet.x < g.left - 8 || feet.x >= g.left + g.width + 8 || feet.y - 40 >= g.top + g.height || feet.y <= g.top) continue;
          const mask = alphaMask(g.frame);
          if (hidesActor(g, (x, y) => mask.alpha[y * mask.width + x], feet)) hiding.add(g);
        }
      }
      for (const g of faded) if (!hiding.has(g)) { for (const image of g.images) image.setAlpha(1); faded.delete(g); }
      for (const g of hiding) if (!faded.has(g)) { for (const image of g.images) image.setAlpha(FADED_ALPHA); faded.add(g); }
    },
    faded: () => [...faded].map(g => g.id),
    props: () => propGroups.map(g => ({
      id: g.id, frame: g.frame, x: g.x, y: g.y, occludes: g.occludes, alpha: g.images[0].alpha,
      slices: g.slices.map((s, i) => ({ left: s.left, width: s.width, depth: g.images[i].depth })),
    })),
  };
}

export type MapCamera = {
  /** The world rectangle the camera keeps inside: the map's diamond, with room above for the tallest props. */
  readonly bounds: Rect;
  /** The view now (its centre, zoom and size). */
  view(): ViewState;
  /** Whether the camera follows the actor (until a drag or a pan, or the Follow toggle). */
  following(): boolean;
  /** Attaches the camera to the scene (call it from create()): the pointer and the wheel, resizes, and the opening view centred on `at`. */
  start(at: Point): void;
  zoomTo(zoom: number, anchor: Point): void;
  /** Moves a following camera toward an actor's feet: at once when `snap` (or with reduced motion), else a little each frame. */
  follow(feet: Point, snap: boolean): void;
  /** Removes the bridge listeners. Idempotent. */
  dispose(): void;
};

/**
 * The camera over a map scene. `zoom` is the opening and reset zoom; `following` whether it starts following (default true: a
 * scene added later starts as the viewport's Follow toggle stands). `live()` says the scene is drawn (ready, not failed or
 * disposed); the bridge's zoom and pan act only then and while the scene is awake, and the Follow toggle's state is kept always.
 */
export function createMapCamera(P: Phaser, scene: PhaserNS.Scene, options: {
  map: MapData; zoom: number; bridge?: SceneBridge; following?: boolean; reducedMotion(): boolean; live(): boolean;
}): MapCamera {
  const { bridge } = options;
  const tileBounds = mapScreenBounds(options.map.width, options.map.height);
  const bounds: Rect = { x: tileBounds.x, y: tileBounds.y - 96, width: tileBounds.width, height: tileBounds.height + 96 };
  let view: ViewState = { centerX: 0, centerY: tileBounds.height / 2, zoom: options.zoom, viewWidth: 800, viewHeight: 600 };
  let following = options.following ?? true;
  let disposed = false;
  const awake = () => options.live() && scene.sys.isActive();

  function sync() {
    const cam = scene.cameras.main;
    view = clampView({ ...view, viewWidth: cam.width, viewHeight: cam.height }, bounds);
    cam.setZoom(view.zoom);
    cam.centerOn(view.centerX, view.centerY);
  }
  function zoomTo(zoom: number, anchor: Point) {
    view = zoomAround(view, zoom / view.zoom, anchor, bounds);
    sync();
  }
  /** Dragging ends the follow; tell the UI so its Follow toggle stays truthful. */
  function stopFollowing() {
    if (!following) return;
    following = false;
    bridge?.emit('follow-character', { gladiatorId: null });
  }

  function attachInput() {
    const input = scene.input;
    if (!input.pointer2) input.addPointer(1);
    let pinch: { distance: number; zoom: number } | null = null;
    let wheel = 0;
    let lastWheelAt = -Infinity;
    let dragging = false;
    input.on(P.Input.Events.POINTER_DOWN, () => { dragging = false; });
    input.on(P.Input.Events.POINTER_MOVE, (pointer: PhaserNS.Input.Pointer) => {
      const p1 = input.pointer1;
      const p2 = input.pointer2;
      if (p1?.isDown && p2?.isDown) {
        const distance = P.Math.Distance.Between(p1.x, p1.y, p2.x, p2.y);
        if (!pinch || pinch.distance < 1) { pinch = { distance, zoom: view.zoom }; return; }
        const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
        view = zoomAround(view, (pinch.zoom * (distance / pinch.distance)) / view.zoom, mid, bounds);
        sync();
        return;
      }
      pinch = null;
      if (!pointer.isDown) return;
      // A press with a little jitter is a click, not a drag, and keeps the follow going.
      if (!dragging && P.Math.Distance.Between(pointer.downX, pointer.downY, pointer.x, pointer.y) <= DRAG_THRESHOLD) return;
      dragging = true;
      stopFollowing();
      view = panBy(view, pointer.x - pointer.prevPosition.x, pointer.y - pointer.prevPosition.y, bounds);
      sync();
    });
    input.on(P.Input.Events.POINTER_UP, () => { pinch = null; dragging = false; });
    input.on(P.Input.Events.POINTER_WHEEL, (pointer: PhaserNS.Input.Pointer, _over: unknown, _dx: number, dy: number) => {
      if (!dy) return; // horizontal scroll never zooms
      const at = performance.now();
      if (Math.sign(dy) !== Math.sign(wheel) || at - lastWheelAt > WHEEL_IDLE_MS) wheel = 0;
      lastWheelAt = at;
      const mode = (pointer.event as WheelEvent | undefined)?.deltaMode ?? 0;
      wheel += dy * (mode === 1 ? WHEEL_LINE : mode === 2 ? WHEEL_STEP * 3 : 1);
      const steps = Math.trunc(wheel / WHEEL_STEP);
      if (!steps) return;
      wheel -= steps * WHEEL_STEP;
      zoomTo(stepZoom(view.zoom, -Math.sign(steps) * Math.min(3, Math.abs(steps))), { x: pointer.x, y: pointer.y });
    });
  }

  // Bridge listeners belong to this scene instance and are removed by dispose().
  const unsubscribe: (() => void)[] = bridge ? [
    bridge.on('camera-zoom', ({ direction }) => {
      if (!awake()) return;
      const centre = { x: view.viewWidth / 2, y: view.viewHeight / 2 };
      zoomTo(direction === 'reset' ? options.zoom : stepZoom(view.zoom, direction === 'in' ? 1 : -1), centre);
    }),
    bridge.on('camera-pan', ({ dx, dy }) => {
      if (!awake()) return;
      stopFollowing();
      view = panBy(view, dx, dy, bounds);
      sync();
    }),
    // The Follow toggle: any gladiator id follows the one gladiator in this scene; null frees the camera.
    bridge.on('follow-character', ({ gladiatorId }) => {
      if (!disposed) following = gladiatorId !== null;
    }),
  ] : [];

  return {
    bounds,
    view: () => view,
    following: () => following,
    start(at) {
      attachInput();
      scene.scale.on(P.Scale.Events.RESIZE, () => sync());
      view = { ...view, centerX: at.x, centerY: at.y - 24 };
      sync();
    },
    zoomTo,
    follow(feet, snap) {
      const k = snap || options.reducedMotion() ? 1 : 0.12;
      const centerX = view.centerX + (feet.x - view.centerX) * k;
      const centerY = view.centerY + (feet.y - 24 - view.centerY) * k;
      if (Math.abs(centerX - view.centerX) > 0.01 || Math.abs(centerY - view.centerY) > 0.01) {
        view = clampView({ ...view, centerX, centerY }, bounds);
        sync();
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const off of unsubscribe.splice(0)) off();
    },
  };
}
