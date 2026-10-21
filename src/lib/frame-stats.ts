// Frame-rate numbers (Task 23.4, plan Decision 9), one definition for the `?perf=1` overlay and the FPS harness: from the
// intervals between successive animation frames, the mean frame rate, the 5th-percentile frame rate (the rate of the
// 95th-percentile interval, nearest rank) and the share of frames over the 60 fps (16.7 ms) and 30 fps (33.3 ms) budgets.
// The overlay reads the same numbers from a constant-time histogram per phase and over a rolling 10 s (`FrameMeter`).

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

/** The histogram's 1 ms buckets cover intervals below this; every longer interval shares one top bucket. */
export const HISTOGRAM_RANGE_MS = 2_000;
const over60 = (ms: number) => ms > FRAME_BUDGET_60_MS + FRAME_JITTER_MS;
const over30 = (ms: number) => ms > FRAME_BUDGET_30_MS + FRAME_JITTER_MS;
const valid = (ms: number) => Number.isFinite(ms) && ms > 0;

/**
 * `frameStats` in constant time per frame and bounded memory (Task 24.1b, plan Decision 11): intervals are counted in
 * 1 ms buckets, with each bucket's sum. The frame count, the mean and the over-budget shares are exact (each interval is
 * tested against the budgets as it is added); the 95th-percentile interval is the mean of the bucket holding the
 * nearest-rank interval, so it is within 1 ms of `frameStats`'s while that interval is under 2 s (a 5th-percentile rate
 * above 0.5 fps). Above that, the top bucket's mean is shown: at most 0.5 fps. Intervals that are not finite and positive
 * are ignored, as `frameStats` ignores them.
 */
export class FrameHistogram {
  private readonly counts = new Uint32Array(HISTOGRAM_RANGE_MS + 1);
  private readonly sums = new Float64Array(HISTOGRAM_RANGE_MS + 1);
  private frames = 0;
  private total = 0;
  private over16 = 0;
  private over33 = 0;

  private static bucket(ms: number) { return Math.min(Math.floor(ms), HISTOGRAM_RANGE_MS); }

  add(ms: number): void {
    if (!valid(ms)) return;
    const b = FrameHistogram.bucket(ms);
    this.counts[b]++;
    this.sums[b] += ms;
    this.frames++;
    this.total += ms;
    if (over60(ms)) this.over16++;
    if (over30(ms)) this.over33++;
  }

  /** Takes out an interval added before (the rolling window's oldest frame). */
  remove(ms: number): void {
    if (!valid(ms)) return;
    const b = FrameHistogram.bucket(ms);
    if (this.counts[b] === 0) return;
    this.counts[b]--;
    // An empty bucket or histogram starts from zero again, so float sums do not drift over a long run.
    this.sums[b] = this.counts[b] === 0 ? 0 : this.sums[b] - ms;
    this.frames--;
    this.total = this.frames === 0 ? 0 : this.total - ms;
    if (over60(ms)) this.over16--;
    if (over30(ms)) this.over33--;
  }

  clear(): void {
    this.counts.fill(0);
    this.sums.fill(0);
    this.frames = this.total = this.over16 = this.over33 = 0;
  }

  stats(): FrameStats {
    const frames = this.frames;
    if (frames === 0) return { frames: 0, meanFps: 0, p5Fps: 0, over16: 0, over33: 0 };
    // The same nearest rank as `frameStats`: the bucket holding the sorted interval at this index.
    const index = Math.max(0, Math.ceil(0.95 * frames) - 1);
    let seen = 0;
    let b = 0;
    for (; b < this.counts.length; b++) {
      seen += this.counts[b];
      if (seen > index) break;
    }
    const p95 = this.sums[b] / this.counts[b];
    return { frames, meanFps: (1000 * frames) / this.total, p5Fps: 1000 / p95, over16: this.over16 / frames, over33: this.over33 / frames };
  }
}

/** The rolling line's span: the frames of the last 10 seconds. */
export const ROLLING_WINDOW_MS = 10_000;

/**
 * The `?perf=1` overlay's frame meter (Task 24.1b, plan Decision 11): every animation frame's timestamp goes in, in
 * constant time. It keeps a phase histogram (cleared by `resetPhase`, at camp-ready and at each scene open or close), a
 * rolling histogram of the frames whose intervals ended in the last 10 s, and the frames of the last second. The window is
 * a ring of at most `capacity` frames (5,000 by default: 10 s at 500 Hz); past it, the oldest frames leave first.
 */
export class FrameMeter {
  private readonly phaseHistogram = new FrameHistogram();
  private readonly rollingHistogram = new FrameHistogram();
  private readonly windowMs: number;
  private readonly times: Float64Array;
  private readonly intervals: Float64Array;
  private head = 0;
  private size = 0;
  private last: number | null = null;

  constructor({ windowMs = ROLLING_WINDOW_MS, capacity = 5_000 }: { windowMs?: number; capacity?: number } = {}) {
    this.windowMs = windowMs;
    this.times = new Float64Array(capacity);
    this.intervals = new Float64Array(capacity);
  }

  /** An animation frame at timestamp `t` (ms). Its interval is the time since the last frame, unless a gap came between. */
  frame(t: number): void {
    const interval = this.last === null ? Number.NaN : t - this.last;
    this.last = t;
    this.phaseHistogram.add(interval);
    this.rollingHistogram.add(interval);
    const capacity = this.times.length;
    if (this.size === capacity) this.dropOldest();
    const at = (this.head + this.size) % capacity;
    this.times[at] = t;
    this.intervals[at] = interval;
    this.size++;
    // Every frame leaves the window once its interval ended 10 s or more before this one.
    while (this.size > 0 && t - this.times[this.head] >= this.windowMs) this.dropOldest();
  }

  /** A hidden tab draws no frames: the time until the next frame is not a frame interval. */
  gap(): void { this.last = null; }

  /** A new phase (the camp ready, a scene opened or closed): its numbers start from nothing. */
  resetPhase(): void { this.phaseHistogram.clear(); }

  phase(): FrameStats { return this.phaseHistogram.stats(); }
  rolling(): FrameStats { return this.rollingHistogram.stats(); }

  /** The frames drawn in the last second up to the latest frame. */
  current(): number {
    if (this.size === 0) return 0;
    const capacity = this.times.length;
    const latest = this.times[(this.head + this.size - 1) % capacity];
    let count = 0;
    for (let i = this.size - 1; i >= 0 && latest - this.times[(this.head + i) % capacity] < 1000; i--) count++;
    return count;
  }

  private dropOldest() {
    this.rollingHistogram.remove(this.intervals[this.head]);
    this.head = (this.head + 1) % this.times.length;
    this.size--;
  }
}
