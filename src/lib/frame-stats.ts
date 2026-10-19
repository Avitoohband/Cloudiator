// Frame-rate numbers (Task 23.4, plan Decision 9), one definition for the `?perf=1` overlay and the FPS harness: from the
// intervals between successive animation frames, the mean frame rate, the 5th-percentile frame rate (the rate of the
// 95th-percentile interval, nearest rank) and the share of frames over the 60 fps (16.7 ms) and 30 fps (33.3 ms) budgets.

/**
 * A frame counts as over a budget only when its interval exceeds it by more than this: rAF timestamps are coarsened (to
 * 0.1 ms in Chrome) and vsync drifts a little, so a 60 Hz frame can measure 16.8 ms without being late. A late frame on a
 * 60 Hz display lasts at least two vsyncs (33.3 ms); on a 144 Hz one, three (20.8 ms).
 */
export const FRAME_JITTER_MS = 1;
export const FRAME_BUDGET_60_MS = 16.7;
export const FRAME_BUDGET_30_MS = 33.3;

export type FrameStats = {
  /** Frames measured (intervals between successive frames). */
  frames: number;
  meanFps: number;
  /** The frame rate that 95% of frames meet or beat. */
  p5Fps: number;
  /** Shares (0–1) of frames over 16.7 ms and over 33.3 ms, beyond the jitter allowance. */
  over16: number;
  over33: number;
};

/** The statistics of `intervalsMs`; intervals that are not finite and positive are ignored. */
export function frameStats(intervalsMs: readonly number[]): FrameStats {
  const intervals = intervalsMs.filter(ms => Number.isFinite(ms) && ms > 0);
  const frames = intervals.length;
  if (frames === 0) return { frames: 0, meanFps: 0, p5Fps: 0, over16: 0, over33: 0 };
  const total = intervals.reduce((sum, ms) => sum + ms, 0);
  const sorted = [...intervals].sort((a, b) => a - b);
  const p95 = sorted[Math.max(0, Math.ceil(0.95 * frames) - 1)];
  const over = (budget: number) => intervals.filter(ms => ms > budget + FRAME_JITTER_MS).length / frames;
  return { frames, meanFps: (1000 * frames) / total, p5Fps: 1000 / p95, over16: over(FRAME_BUDGET_60_MS), over33: over(FRAME_BUDGET_30_MS) };
}
