// The close-up battle replay scene. Phaser is injected (loaded lazily in the browser) so this module
// stays importable during the static build. Each frame it reads the replay position and draws
// `stageAt`, which derives every pose, effect and label from the authoritative log. The scene keeps
// no clock of its own, so pausing, seeking and both speeds always match the textual log.
import type * as PhaserNS from 'phaser';
import type { BattleLog } from '@contracts/events';
import type { Appearance } from '@domain/appearance';
import type { AssetManifest, CloseupTheme } from './assets';
import { backdropFor, planStage, stageAt, stageLayout, type FighterPose, type LabelPose, type StageLayout } from './battle-stage';

type Phaser = typeof PhaserNS;
type Sprite = PhaserNS.GameObjects.Sprite;
type Text = PhaserNS.GameObjects.Text;

export type BattleSceneDeps = {
  manifest: AssetManifest;
  atlasData: Record<string, unknown>;
  assetBase: string;
  log: BattleLog;
  /**
   * The looks the replay settled on (`loadLooks`), by gladiator id; one that is absent or null is the legacy look. The fighters
   * are built once from them in `create()` and never re-skinned: the host mounts the scene only after they have settled.
   */
  looks?: ReadonlyMap<string, Appearance | null>;
  /** Replay position in log milliseconds (the replay controller's clock). */
  position: () => number;
  reducedMotion?: boolean;
  onReady: () => void;
  onError: (reason: 'assets' | 'error', message: string) => void;
};

export type BattleDebugState = {
  ready: boolean;
  disposed: boolean;
  failed: boolean;
  reducedMotion: boolean;
  backdrop: CloseupTheme;
  positionMs: number;
  view: { width: number; height: number };
  layout: StageLayout;
  fighters: { id: string; name: string; kind: string; atlas: string; action: string; animation: string; frame: number; frames: string[];
    x: number; y: number; scaleX: number; scaleY: number; depth: number; layers: { id: string; tint: number | null }[] }[];
  effects: { sequence: number; effect: string; frameName: string; target: 0 | 1; x: number; y: number; flip: boolean; scale: number; visible: boolean }[];
  labels: { text: string; target: 0 | 1; x: number; y: number; alpha: number }[];
  shake: { x: number; y: number };
  flash: number;
};

export type BattleSceneHandle = {
  setReducedMotion(reduced: boolean): void;
  /** Stops drawing. Idempotent; also runs when the game destroys the scene. */
  dispose(): void;
  debug(): BattleDebugState;
};

const LABEL_STYLE: Record<LabelPose['kind'], { color: string; size: number }> = {
  damage: { color: '#ffffff', size: 18 },
  critical: { color: '#ffe48f', size: 22 },
  guard: { color: '#8edcf4', size: 18 },
  miss: { color: '#d4d4d8', size: 16 },
};
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createBattleScene(P: Phaser, deps: BattleSceneDeps): { scene: PhaserNS.Scene; handle: BattleSceneHandle } {
  const { manifest, log } = deps;
  const plan = planStage(log, manifest, deps.looks);
  const theme = backdropFor(log, manifest);
  const closeups = manifest.closeups;
  let ready = false;
  let disposed = false;
  let failed = false;
  let reducedMotion = !!deps.reducedMotion;
  let layout: StageLayout = stageLayout(manifest, 960, 372);
  let lastPosition = 0;
  let backdrop: PhaserNS.GameObjects.Image | null = null;
  let flashRect: PhaserNS.GameObjects.Rectangle | null = null;
  const shadows: PhaserNS.GameObjects.Ellipse[] = [];
  const fighters: { container: PhaserNS.GameObjects.Container; sprites: Sprite[]; pose: FighterPose | null }[] = [];
  const effectPool: Sprite[] = [];
  const effectInfo: { sequence: number; effect: string; frameName: string; target: 0 | 1 }[] = [];
  const labelPool: Text[] = [];
  const labelInfo: { text: string; target: 0 | 1 }[] = [];
  let shake = { x: 0, y: 0 };
  let flash = 0;

  class BattleScene extends P.Scene {
    constructor() { super({ key: 'battle' }); }

    init() {
      // Game.destroy emits DESTROY (never SHUTDOWN); the host also calls dispose() directly.
      this.events.once(P.Scenes.Events.DESTROY, dispose);
    }

    preload() {
      const keys = new Set([closeups.atlas, 'effects', ...plan.looks.map(l => l.atlas)]);
      for (const key of keys) {
        const def = manifest.atlases[key];
        this.load.atlas(key, `${deps.assetBase}${def.image}`, deps.atlasData[def.data] as object);
      }
      this.load.on(P.Loader.Events.FILE_LOAD_ERROR, (file: PhaserNS.Loader.File) => this.fail('assets', `could not load ${file.key}`));
    }

    create() {
      if (failed) return;
      try {
        this.cameras.main.setBackgroundColor('#1a1423');
        backdrop = this.add.image(0, 0, closeups.atlas, closeups.backdrops[theme]).setOrigin(0, 0).setScale(closeups.scale).setDepth(0);
        for (let i = 0; i < 2; i += 1) {
          shadows.push(this.add.ellipse(0, 0, 26 * closeups.scale, 6 * closeups.scale, 0x2e2433, 0.35).setDepth(1));
          const look = plan.looks[i];
          const sprites = look.layers.map(layer => {
            const first = manifest.animations[look.animations.idle].frames[0];
            const sprite = this.add.sprite(0, 0, look.atlas, look.kind === 'creature' ? first : first.replace(/^body\//, `${layer.id}/`));
            if (layer.tint !== null) sprite.setTint(layer.tint);
            return sprite;
          });
          fighters.push({ container: this.add.container(0, 0, sprites), sprites, pose: null });
        }
        flashRect = this.add.rectangle(0, 0, 10, 10, 0xffffff, 0).setOrigin(0, 0).setDepth(50);
        this.scale.on(P.Scale.Events.RESIZE, () => this.relayout());
        this.relayout();
        ready = true;
        this.draw(deps.position());
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

    relayout() {
      const cam = this.cameras.main;
      layout = stageLayout(manifest, cam.width, cam.height);
      backdrop?.setPosition(layout.backdropX, layout.backdropY);
      flashRect?.setSize(cam.width, cam.height);
      layout.feet.forEach((f, i) => shadows[i]?.setPosition(f.x, f.y));
    }

    update() {
      if (!ready || failed || disposed) return;
      try {
        this.draw(deps.position());
      } catch (error) {
        this.fail('error', errorText(error));
      }
    }

    draw(position: number) {
      lastPosition = position;
      const frame = stageAt(plan, position, layout, { reducedMotion });
      shake = frame.shake;
      flash = frame.flash;
      frame.fighters.forEach((pose, i) => {
        const view = fighters[i];
        if (view.pose?.animation !== pose.animation || view.pose.frame !== pose.frame) view.sprites.forEach((s, k) => s.setFrame(pose.frames[k]));
        // Shake moves the fighters, never the backdrop, so no edge of the stage ever shows.
        view.container.setPosition(pose.x + shake.x, pose.y + shake.y).setScale(pose.flip ? -closeups.scale : closeups.scale, closeups.scale).setDepth(pose.depth);
        view.pose = pose;
      });
      frame.effects.forEach((e, k) => {
        const sprite = effectPool[k] ?? (effectPool[k] = this.add.sprite(0, 0, 'effects', e.frameName).setScale(closeups.scale).setDepth(30));
        sprite.setFrame(e.frameName).setPosition(e.x + shake.x, e.y + shake.y).setFlipX(e.flip).setVisible(true);
        effectInfo[k] = { sequence: e.sequence, effect: e.effect, frameName: e.frameName, target: e.target };
      });
      for (let k = frame.effects.length; k < effectPool.length; k += 1) if (effectPool[k].visible) effectPool[k].setVisible(false);
      effectInfo.length = frame.effects.length;
      frame.labels.forEach((l, k) => {
        const text = labelPool[k] ?? (labelPool[k] = this.add.text(0, 0, '', { fontFamily: 'monospace', fontStyle: 'bold', stroke: '#1a1423', strokeThickness: 5 })
          .setOrigin(0.5, 1).setResolution(2).setDepth(40));
        const style = LABEL_STYLE[l.kind];
        if (text.text !== l.text) text.setText(l.text);
        text.setColor(style.color).setFontSize(style.size).setPosition(l.x, l.y).setAlpha(l.alpha).setVisible(true);
        labelInfo[k] = { text: l.text, target: l.target };
      });
      for (let k = frame.labels.length; k < labelPool.length; k += 1) if (labelPool[k].visible) labelPool[k].setVisible(false);
      labelInfo.length = frame.labels.length;
      flashRect?.setFillStyle(0xffffff, flash);
    }
  }

  const scene = new BattleScene();

  function dispose() {
    disposed = true;
  }

  const handle: BattleSceneHandle = {
    setReducedMotion(reduced) { reducedMotion = reduced; },
    dispose,
    debug() {
      const live = ready && !disposed && !failed;
      const cam = live ? scene.cameras.main : null;
      return {
        ready, disposed, failed, reducedMotion, backdrop: theme, positionMs: lastPosition,
        view: { width: cam?.width ?? 0, height: cam?.height ?? 0 },
        layout,
        fighters: fighters.map((f, i) => ({
          id: log.participants[i].id, name: log.participants[i].name, kind: plan.looks[i].kind, atlas: plan.looks[i].atlas,
          action: f.pose?.action ?? 'idle', animation: f.pose?.animation ?? '', frame: f.pose?.frame ?? 0, frames: f.pose?.frames ?? [],
          x: f.container.x, y: f.container.y, scaleX: f.container.scaleX, scaleY: f.container.scaleY, depth: f.container.depth,
          layers: plan.looks[i].layers.map(l => ({ ...l })),
        })),
        effects: effectInfo.map((e, k) => ({ ...e, x: effectPool[k].x, y: effectPool[k].y, flip: effectPool[k].flipX, scale: effectPool[k].scaleX, visible: effectPool[k].visible })),
        labels: labelInfo.map((l, k) => ({ ...l, x: labelPool[k].x, y: labelPool[k].y, alpha: labelPool[k].alpha })),
        shake: { ...shake },
        flash,
      };
    },
  };
  return { scene, handle };
}
