'use client';

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { PartyAttack, PartyBattleLog, RevealedStage } from '@contracts/events';
import type { Appearance } from '@domain/appearance';
import { loadAssetManifest, type FrameRect } from '../../game/assets';
import { fighterLook, frameIndex, IMPACT_FRAME, type CombatAction } from '../../game/battle-stage';
import { groupPartyReplay, reducePartyReplay, type PartyReplayFrame } from '../../game/party-replay';
import { planPartyStage } from '../../game/party-stage';
import { REPLAY_SPEEDS } from '../../game/replay';
import { clockText } from '../../game/trip-replay';
import { prefersReducedMotion } from '../../game/webgl';
import type { GameGateway } from '../../lib/api/gateway';
import { BotTag } from '../character/BotTag';
import { ReplayBar } from '../replay/ReplayBar';
import styles from './PartyReplay.module.css';

type PartyReplayOptions = { title?: string; headingLevel?: 1 | 2; appearances?: ReadonlyMap<string, Appearance | null> };
type PartySpeed = 'normal' | 'double';
type PartyReplayViewProps = PartyReplayOptions & {
  log: PartyBattleLog; positionMs: number; playing: boolean; speed: PartySpeed;
  onToggle(): void; onSeek(ms: number): void; onSpeed(): void; onRestart(): void; onSkip(): void;
};
type Viewport = { width: number; height: number };
type FightRef = NonNullable<RevealedStage['fight']>;
type FightGateway = Pick<GameGateway, 'dungeonFight'>;
const REACTION_MS = 440;
const SWEEP_MS = 620;
const MAJOR_TINT = 0xffbd94;

function subscribeMotion(onChange: () => void) {
  const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  query?.addEventListener('change', onChange);
  return () => query?.removeEventListener('change', onChange);
}

function loadImage(path: string): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = `/assets/${path}`;
  });
}

/** The same multiply tint as the Arena sprite layers, cropped before tinting the atlas frame. */
function tintFrame(image: HTMLImageElement, frame: FrameRect, tint: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = frame.w;
  canvas.height = frame.h;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(image, frame.x, frame.y, frame.w, frame.h, 0, 0, frame.w, frame.h);
  const pixels = context.getImageData(0, 0, frame.w, frame.h);
  const red = (tint >> 16) & 255;
  const green = (tint >> 8) & 255;
  const blue = tint & 255;
  for (let i = 0; i < pixels.data.length; i += 4) {
    pixels.data[i] *= red / 255;
    pixels.data[i + 1] *= green / 255;
    pixels.data[i + 2] *= blue / 255;
  }
  context.putImageData(pixels, 0, 0);
  return canvas;
}

function recentAttacks(log: PartyBattleLog, frame: PartyReplayFrame) {
  const groups = groupPartyReplay(log);
  const attacks: PartyAttack[] = [];
  for (let i = frame.groupIndex; i >= 0 && frame.throughMs - groups[i].elapsedMs < SWEEP_MS; i -= 1) {
    for (const event of groups[i].events) if (event.kind === 'attack') attacks.push(event);
  }
  return attacks;
}

function PartyStage({ log, frame, attacks, sweep, appearances }: {
  log: PartyBattleLog; frame: PartyReplayFrame; attacks: readonly PartyAttack[]; sweep: boolean; appearances?: PartyReplayOptions['appearances'];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [viewport, setViewport] = useState<Viewport>({ width: 0, height: 0 });
  const [images, setImages] = useState<ReadonlyMap<string, HTMLImageElement>>(new Map());
  const tinted = useRef(new Map<string, HTMLCanvasElement>());
  const reduced = useSyncExternalStore(subscribeMotion, prefersReducedMotion, () => false);
  const manifest = useMemo(loadAssetManifest, []);
  const looks = useMemo(() => log.participants.map(unit => fighterLook(
    unit.role === 'hireling' ? { ...unit, id: `npc:${unit.id}` } : unit, manifest, appearances,
  )), [log, manifest, appearances]);
  const assets = useMemo(() => [...new Set([manifest.closeups.atlas, ...looks.map(look => look.atlas)])], [manifest, looks]);
  const layout = useMemo(() => planPartyStage(log, viewport), [log, viewport]);
  const theme = looks.find(look => look.home)?.home ?? 'woodland';

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      setViewport(previous => previous.width === width && previous.height === height ? previous : { width, height });
    };
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = assets.map(async key => [key, await loadImage(manifest.atlases[key].image)] as const);
    void Promise.all(load).then(entries => {
      if (!cancelled) setImages(new Map(entries.filter((entry): entry is readonly [string, HTMLImageElement] => entry[1] !== null)));
    });
    return () => { cancelled = true; };
  }, [assets, manifest]);

  useEffect(() => {
    const context = canvasRef.current?.getContext('2d');
    const { width, height } = viewport;
    if (!context || !width || !height) return;
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, width, height);
    const backdrop = manifest.atlases[manifest.closeups.atlas].frames[manifest.closeups.backdrops[theme]];
    const backdropImage = images.get(manifest.closeups.atlas);
    if (backdropImage) {
      const scale = Math.ceil(Math.max(width / backdrop.w, height / backdrop.h));
      const w = backdrop.w * scale;
      const h = backdrop.h * scale;
      context.drawImage(backdropImage, backdrop.x, backdrop.y, backdrop.w, backdrop.h,
        Math.round((width - w) / 2), Math.round((height - h) / 2), w, h);
    }

    const order = layout.units.map((unit, index) => ({ unit, index })).sort((a, b) => a.unit.y - b.unit.y);
    for (const { unit, index } of order) {
      const look = looks[index];
      const source = images.get(look.atlas);
      if (!source) continue;
      const participant = log.participants[index];
      const action = attacks.find(event => frame.throughMs - event.elapsedMs < REACTION_MS
        && (event.attackerId === unit.id || event.defenderId === unit.id));
      const attacking = action?.attackerId === unit.id;
      const fallen = frame.hp[index] === 0;
      const pose: CombatAction = fallen ? 'defeat'
        : frame.result?.winnerSide === participant.side ? 'victory'
          : !action ? 'idle' : attacking ? 'attack' : action.evade ? 'evade' : action.defend ? 'defend' : 'hit';
      const animation = manifest.animations[look.animations[pose]];
      const offset = attacking ? animation.durationsMs.slice(0, IMPACT_FRAME).reduce((total, ms) => total + ms, 0) : 0;
      const tick = action ? frame.throughMs - action.elapsedMs + offset : frame.throughMs + index * 130;
      const step = fallen ? animation.frames.length - 1 : frameIndex(animation, reduced ? offset : tick);
      const name = animation.frames[step];
      context.save();
      context.translate(unit.x, unit.y);
      context.scale(unit.facing === 'left' ? -unit.scale : unit.scale, unit.scale);
      for (const layer of look.layers) {
        const layerName = layer.id ? name.replace(/^body\//, `${layer.id}/`) : name;
        const rect = manifest.atlases[look.atlas].frames[layerName];
        if (!rect) continue;
        const tint = participant.role === 'major' ? MAJOR_TINT : layer.tint;
        if (tint === null) {
          context.drawImage(source, rect.x, rect.y, rect.w, rect.h, -rect.anchorX, -rect.anchorY, rect.w, rect.h);
        } else {
          const key = `${look.atlas}:${layerName}:${tint}`;
          let image = tinted.current.get(key);
          if (!image) {
            image = tintFrame(source, rect, tint);
            tinted.current.set(key, image);
          }
          context.drawImage(image, -rect.anchorX, -rect.anchorY);
        }
      }
      context.restore();
    }
  }, [attacks, frame, images, layout, log, looks, manifest, reduced, theme, viewport]);

  return <div className={styles.stage}>
    <canvas ref={canvasRef} width={viewport.width} height={viewport.height} aria-hidden="true" />
    {sweep && <>
      <svg className={styles.sweep} viewBox="0 0 300 136" preserveAspectRatio="none" aria-hidden="true">
        <path d="M290 26Q195 -14 40 69" />
        <path d="M280 39Q172 15 14 116" />
        <path d="M254 55Q162 62 70 127" />
      </svg>
      <span className={styles.stageTag}>Sweep · simultaneous hits</span>
    </>}
  </div>;
}

function HealthCards({ log, frame, side }: { log: PartyBattleLog; frame: PartyReplayFrame; side: 0 | 1 }) {
  const label = side === 0 ? 'Party health' : 'Enemy health';
  return <ul className={styles.healthCards} aria-label={label} data-side={side}>
    {log.participants.map((unit, index) => {
      if (unit.side !== side) return null;
      const hp = frame.hp[index];
      const max = frame.maxHp[index];
      return <li key={unit.id} className={styles.healthCard} data-fallen={hp === 0 || undefined}>
        <div className={styles.fighterName}>
          <span>{unit.name}</span>
          {(unit.role === 'bot' || unit.botTeam === 'ludus-nimbus') && <BotTag />}
          {unit.role === 'hireling' && <span className={styles.hired}>Hired</span>}
        </div>
        <div className={styles.meter} role="meter" aria-label={`${unit.name} health`} aria-valuemin={0} aria-valuemax={max} aria-valuenow={hp}>
          <span style={{ width: `${hp / max * 100}%` }} />
        </div>
        <span className={styles.hp}>{hp} / {max} HP</span>
      </li>;
    })}
  </ul>;
}

export function PartyReplayView({ log, positionMs, playing, speed, onToggle, onSeek, onSpeed, onRestart, onSkip,
  title, headingLevel = 1, appearances }: PartyReplayViewProps) {
  const titleId = useId();
  const Heading = headingLevel === 2 ? 'h2' : 'h1';
  const frame = reducePartyReplay(log, positionMs);
  const attacks = recentAttacks(log, frame);
  const sweep = attacks.some(event => event.sweep && (!frame.finished || event.elapsedMs === frame.throughMs));
  const major = log.participants.find(unit => unit.role === 'major');
  const knockedOut = log.participants.filter((unit, i) => unit.side === 0 && frame.hp[i] === 0);
  const result = frame.result;
  return <section className={styles.replay} aria-labelledby={titleId}>
    <header className={styles.heading}>
      <div><p>Dungeon fight replay</p><Heading id={titleId}>{title ?? major?.name ?? 'Room fight'}</Heading></div>
      <span className={styles.badge}>Replay</span>
    </header>
    <PartyStage log={log} frame={frame} attacks={attacks} sweep={sweep} appearances={appearances} />
    <div className={styles.hud}>
      <HealthCards log={log} frame={frame} side={0} />
      <HealthCards log={log} frame={frame} side={1} />
      <ReplayBar label="Party replay controls" play={{ playing, onToggle }}
        track={<input className={styles.range} type="range" min={0} max={log.durationMs} step={1}
          aria-label="Replay position" aria-valuetext={`${clockText(frame.throughMs)} of ${clockText(log.durationMs)}`}
          value={Math.round(frame.throughMs)} onChange={event => onSeek(event.currentTarget.valueAsNumber)} />}
        time={`${clockText(frame.throughMs)} / ${clockText(log.durationMs)}`}
        tail={<span className={styles.actions}>
          <button type="button" aria-label={`Speed ${REPLAY_SPEEDS[speed]}×`} onClick={onSpeed}>{REPLAY_SPEEDS[speed]}×</button>
          <button type="button" aria-label="Restart" onClick={onRestart}>Restart</button>
          <button type="button" aria-label="Skip to the result" onClick={onSkip}>Skip</button>
        </span>} />
      <div role="status" className={styles.result}>
        {result && <>
          <strong>{result.winnerSide === 0 ? 'Party victory' : 'Party defeat'}</strong>
          {result.tieBreakReason && <span>{result.tieBreakReason === 'simultaneous-defeat' ? 'Both sides fell together' : 'Both sides had equal health shares'}. The tie-break decided the fight.</span>}
          {result.victoryReason === 'health-fraction' && <span>Time ran out. The side with the greater health share won.</span>}
          {knockedOut.map(unit => <span key={unit.id}>{unit.name} knocked out</span>)}
        </>}
      </div>
    </div>
  </section>;
}

function PartyReplay({ log, ...options }: PartyReplayOptions & { log: PartyBattleLog }) {
  const [positionMs, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<PartySpeed>('normal');
  const position = useRef(0);
  const seek = (ms: number) => {
    setPlaying(false);
    position.current = ms;
    setPosition(ms);
  };

  useEffect(() => {
    if (!playing) return;
    let request: number;
    let previous: number | undefined;
    const tick = (now: number) => {
      const elapsed = previous === undefined ? 0 : Math.min(100, now - previous);
      previous = now;
      position.current = Math.min(log.durationMs, position.current + elapsed * REPLAY_SPEEDS[speed]);
      setPosition(position.current);
      if (position.current < log.durationMs) request = requestAnimationFrame(tick);
      else setPlaying(false);
    };
    request = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(request);
  }, [log.durationMs, playing, speed]);

  return <PartyReplayView {...options} log={log} positionMs={positionMs} playing={playing} speed={speed}
    onToggle={() => {
      if (!playing && position.current >= log.durationMs) seek(0);
      setPlaying(!playing);
    }}
    onSeek={seek} onSpeed={() => setSpeed(current => current === 'normal' ? 'double' : 'normal')}
    onRestart={() => seek(0)} onSkip={() => seek(log.durationMs)} />;
}

type FightRead = { gateway: FightGateway; attempt: number; log: PartyBattleLog | null };

function LoadPartyFight({ gateway, fight: { runId, ordinal }, title, ...options }: PartyReplayOptions & { gateway: FightGateway; fight: FightRef }) {
  const [attempt, setAttempt] = useState(0);
  const [read, setRead] = useState<FightRead | null>(null);
  const focus = useRef<HTMLDivElement>(null);
  const current = read?.gateway === gateway && read.attempt === attempt ? read : null;
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(async () => {
      if (cancelled) return;
      let log: PartyBattleLog | null;
      try { log = await gateway.dungeonFight(runId, ordinal); }
      catch { log = null; }
      if (!cancelled) setRead({ gateway, attempt, log });
    });
    return () => { cancelled = true; };
  }, [attempt, gateway, ordinal, runId]);

  return <div ref={focus} tabIndex={-1}>
    {current?.log ? <PartyReplay log={current.log} title={title ?? (ordinal < 4 ? `Room ${ordinal}` : undefined)} {...options} />
      : current ? <div className={styles.message}>
        <p role="status">Fight replay unavailable. The fight may still be unrevealed or no longer kept.</p>
        <button type="button" className={styles.button} onClick={() => {
          focus.current?.focus({ preventScroll: true });
          setAttempt(value => value + 1);
        }}>Try again</button>
      </div> : <p className={styles.message} role="status">Loading the fight replay…</p>}
  </div>;
}

/** Loads one validated fight reference. The enclosing scene owns Back, Escape and opener focus restoration. */
export function PartyFightReplay({ gateway, fight, onBack, backLabel = 'Back', ...options }: PartyReplayOptions & {
  gateway: FightGateway; fight: FightRef; onBack?: () => void; backLabel?: string;
}) {
  return <div className={styles.shell}>
    {onBack && <button type="button" className={styles.button} onClick={onBack}>{backLabel}</button>}
    <LoadPartyFight key={`${fight.runId}:${fight.ordinal}`} gateway={gateway} fight={fight} {...options} />
  </div>;
}
