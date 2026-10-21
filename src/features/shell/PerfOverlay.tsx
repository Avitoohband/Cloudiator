'use client';

// The opt-in frame-rate overlay (`?perf=1`, plan Decision 2): how a production build is measured on a phone (Task 24). It
// is off by default: without the flag the page renders nothing of it and samples nothing. It reads the intervals between
// animation frames into a constant-time frame meter (Task 24.1b, Decision 11) and once a second shows the current phase
// (the camp, or the scene that is open) with its age and the current rate (frames in the last second); the phase's mean
// and 5th-percentile rates, frame count and share of frames over 16.7 ms and 33.3 ms (`frameStats`'s definitions, the FPS
// harness's own); the same over the last 10 seconds; and the WebGL renderer, wrapped onto as many lines as it needs. A
// phase starts when the camp gets ready and at each scene open or close. A hidden tab's gap is not counted. It is a manual
// popover, raised again above each modal dialog that opens (a scene, the creation dialog), so a run measures the scenes
// too; it takes no pointer and no keyboard, and screen readers skip it.
import { useEffect, useRef, useState } from 'react';
import { FrameMeter, type FrameStats } from '../../lib/frame-stats';
import type { SceneAddress } from './scene-url';
import styles from './shell.module.css';

export type PerfShown = { phase: string; seconds: number; current: number; stats: FrameStats; rolling: FrameStats; renderer: string };

/**
 * The measurement phase of the camp shell: its label, and a key that changes when the camp gets ready (or fails) and at
 * each scene open or close (another scene, or another stage of a replay, is a new phase).
 */
export function perfPhaseOf(campStatus: 'loading' | 'ready' | 'unavailable', scene: SceneAddress | null): { label: string; key: string } {
  const camp = campStatus === 'ready' ? 'camp' : campStatus === 'unavailable' ? 'camp unavailable' : 'loading';
  if (!scene) return { label: camp, key: campStatus };
  const stage = scene.kind === 'replay' && scene.activityId !== null ? scene.stageId ?? '' : '';
  return { label: scene.kind, key: `${campStatus}|${scene.kind}|${scene.activityId ?? ''}|${stage}` };
}

/** The WebGL renderer string (unmasked where the browser allows), from a probe context released at once. */
function webglRenderer(): string {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return 'no WebGL';
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  } catch {
    return 'unknown renderer';
  }
}

const percent = (share: number) => (share * 100).toFixed(1);
const fps = (rate: number) => rate.toFixed(1);

/** The overlay's lines: the phase, its numbers, the last 10 seconds, and the renderer (which wraps, never cut short). */
export function PerfReadout({ shown }: { shown: PerfShown | null }) {
  if (!shown) return <p>Measuring frames…</p>;
  const { stats, rolling } = shown;
  return <>
    <p>{shown.phase} · {Math.floor(shown.seconds)} s · {shown.current} fps</p>
    <p>mean {fps(stats.meanFps)} · p5 {fps(stats.p5Fps)} · {stats.frames} frames</p>
    <p>&gt;16.7 ms {percent(stats.over16)}% · &gt;33.3 ms {percent(stats.over33)}%</p>
    <p>10 s: mean {fps(rolling.meanFps)} · p5 {fps(rolling.p5Fps)} · &gt;33.3 ms {percent(rolling.over33)}%</p>
    <p className={styles.perfRenderer}>{shown.renderer}</p>
  </>;
}

export function PerfOverlay({ phase = 'camp', phaseKey = phase }: {
  /** The current phase's label (`perfPhaseOf`). */
  phase?: string;
  /** Changes when a new phase starts: the phase's numbers start again from nothing. */
  phaseKey?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [meter] = useState(() => new FrameMeter());
  const current = useRef({ label: phase, startedAt: 0 });
  const [shown, setShown] = useState<PerfShown | null>(null);

  useEffect(() => {
    let request = 0;
    const frame = (t: number) => {
      meter.frame(t);
      request = requestAnimationFrame(frame);
    };
    // A hidden tab draws no frames: the gap until it is visible again is not a slow frame.
    const visibility = () => { if (document.visibilityState === 'hidden') meter.gap(); };
    document.addEventListener('visibilitychange', visibility);
    request = requestAnimationFrame(frame);
    const renderer = webglRenderer();
    const timer = window.setInterval(() => setShown({
      phase: current.current.label, seconds: (performance.now() - current.current.startedAt) / 1000,
      current: meter.current(), stats: meter.phase(), rolling: meter.rolling(), renderer,
    }), 1000);
    return () => { cancelAnimationFrame(request); window.clearInterval(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [meter]);

  // A new phase (the camp ready, a scene opened or closed): its numbers start from its first frame.
  useEffect(() => {
    meter.resetPhase();
    current.current = { label: phase, startedAt: performance.now() };
  }, [meter, phase, phaseKey]);

  useEffect(() => {
    const element = box.current;
    if (!element || typeof element.showPopover !== 'function') return;
    const raise = () => {
      try {
        if (element.matches(':popover-open')) element.hidePopover();
        element.showPopover();
      } catch { /* a browser without popovers keeps it in the page, under a modal dialog */ }
    };
    raise();
    const observer = new MutationObserver(records => {
      if (records.some(r => r.target instanceof HTMLDialogElement && r.target.open)) raise();
    });
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
    return () => {
      observer.disconnect();
      try { element.hidePopover(); } catch { /* already hidden */ }
    };
  }, []);

  return (
    <div ref={box} popover="manual" className={styles.perf} data-perf-overlay="" aria-hidden="true">
      <PerfReadout shown={shown} />
    </div>
  );
}
