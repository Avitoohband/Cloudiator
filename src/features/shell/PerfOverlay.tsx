'use client';

// The opt-in frame-rate overlay (`?perf=1`, plan Decision 2): how a production build is measured on a phone (Task 24). It
// is off by default: without the flag the page renders nothing of it and samples nothing. From the moment it mounts it
// reads the intervals between animation frames, and once a second shows the current rate (frames in the last second)
// and, since it mounted, the mean and 5th-percentile rates and the share of frames over 16.7 ms and 33.3 ms (`frameStats`,
// the FPS harness's own definitions), with the WebGL renderer. A hidden tab's gap is not counted. It is a manual popover,
// raised again above each modal dialog that opens (a scene, the creation dialog), so a run measures the scenes too; it
// takes no pointer and no keyboard, and screen readers skip it.
import { useEffect, useRef, useState } from 'react';
import { frameStats, type FrameStats } from '../../lib/frame-stats';
import styles from './shell.module.css';

/** At most this many intervals are kept (about 55 minutes at 60 fps). */
const MAX_FRAMES = 200_000;
type Shown = { current: number; stats: FrameStats; renderer: string };

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

export function PerfOverlay() {
  const box = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<Shown | null>(null);

  useEffect(() => {
    const intervals: number[] = [];
    const recent: number[] = [];
    let last: number | null = null;
    let request = 0;
    const frame = (t: number) => {
      if (last !== null && intervals.length < MAX_FRAMES) intervals.push(t - last);
      last = t;
      recent.push(t);
      while (recent.length && t - recent[0] > 1000) recent.shift();
      request = requestAnimationFrame(frame);
    };
    // A hidden tab draws no frames: the gap until it is visible again is not a slow frame.
    const visibility = () => { if (document.visibilityState === 'hidden') { last = null; recent.length = 0; } };
    document.addEventListener('visibilitychange', visibility);
    request = requestAnimationFrame(frame);
    const renderer = webglRenderer();
    const timer = window.setInterval(() => setShown({ current: recent.length, stats: frameStats(intervals), renderer }), 1000);
    return () => { cancelAnimationFrame(request); window.clearInterval(timer); document.removeEventListener('visibilitychange', visibility); };
  }, []);

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

  const stats = shown?.stats;
  return (
    <div ref={box} popover="manual" className={styles.perf} data-perf-overlay="" aria-hidden="true">
      {shown && stats ? <>
        <p>{shown.current} fps · mean {stats.meanFps.toFixed(1)} · p5 {stats.p5Fps.toFixed(1)}</p>
        <p>&gt;16.7 ms {percent(stats.over16)}% · &gt;33.3 ms {percent(stats.over33)}% · {stats.frames} frames</p>
        <p className={styles.perfRenderer}>{shown.renderer}</p>
      </> : <p>Measuring frames…</p>}
    </div>
  );
}
