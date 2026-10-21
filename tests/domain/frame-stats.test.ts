import { describe, expect, it } from 'vitest';

// Task 23.4 (Decision 9): one definition of the frame-rate numbers, shared by the `?perf=1` overlay and the FPS harness.
describe('frame statistics', () => {
  it('reports the mean and 5th-percentile frame rate and the share of frames over 16.7 ms and 33.3 ms', async () => {
    const { FRAME_JITTER_MS, frameStats } = await import('@/lib/frame-stats');
    expect(FRAME_JITTER_MS).toBe(1);
    // 95 frames at 60 Hz, three a little late, one dropped (two vsyncs) and one long (three vsyncs).
    const intervals = [...Array(92).fill(16.67), 16.8, 17.5, 17.6, 33.33, 50];
    const stats = frameStats(intervals);
    expect(stats.frames).toBe(97);
    expect(stats.meanFps).toBeCloseTo(97_000 / intervals.reduce((a, b) => a + b, 0), 6);
    // The 5th-percentile rate is the rate of the 95th-percentile interval (nearest rank: the 93rd of 97 sorted values).
    expect(stats.p5Fps).toBeCloseTo(1000 / 16.8, 6);
    // Timer jitter (rAF timestamps are coarsened, and vsync drifts) is not a slow frame: only 33.33 and 50 are over.
    expect(stats.over16).toBeCloseTo(2 / 97, 9);
    expect(stats.over33).toBeCloseTo(1 / 97, 9);
  });

  it('counts a frame as over a budget only beyond the jitter allowance', async () => {
    const { frameStats } = await import('@/lib/frame-stats');
    expect(frameStats([16.7, 17.7, 17.71, 34.3, 34.31])).toMatchObject({ frames: 5, over16: 3 / 5, over33: 1 / 5 });
  });

  it('reports nothing for no frames and ignores intervals that are not finite and positive', async () => {
    const { frameStats } = await import('@/lib/frame-stats');
    expect(frameStats([])).toEqual({ frames: 0, meanFps: 0, p5Fps: 0, over16: 0, over33: 0 });
    expect(frameStats([Number.NaN, -1, 0, Infinity, 20])).toEqual({ frames: 1, meanFps: 50, p5Fps: 50, over16: 1, over33: 0 });
  });
});

// Task 24.1b (plan Decision 11, 23.4 M3): the overlay keeps a 1 ms histogram (constant work per frame, bounded memory)
// instead of sorting every interval each second. Its numbers are `frameStats`'s own definitions: the same frame count,
// mean and over-budget shares, and a 5th-percentile rate whose interval is within one 1 ms bucket of the sorted one.
/** A seeded generator (mulberry32), so a failure names a reproducible set. */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Asserts a histogram's numbers against the sort-based `frameStats` of `intervals`. */
async function expectMatchesSort(binned: import('@/lib/frame-stats').FrameStats, intervals: readonly number[], label: string) {
  const { frameStats } = await import('@/lib/frame-stats');
  const sorted = frameStats(intervals);
  expect(binned.frames, label).toBe(sorted.frames);
  expect(binned.over16, label).toBe(sorted.over16);
  expect(binned.over33, label).toBe(sorted.over33);
  if (sorted.frames === 0) {
    expect(binned, label).toEqual(sorted);
    return;
  }
  expect(binned.meanFps, label).toBeCloseTo(sorted.meanFps, 6);
  // The 95th-percentile interval is within one 1 ms bucket of the sorted (nearest-rank) one.
  expect(Math.abs(1000 / binned.p5Fps - 1000 / sorted.p5Fps), label).toBeLessThan(1);
}

describe('the frame histogram', () => {
  async function binnedStats(intervals: readonly number[]) {
    const { FrameHistogram } = await import('@/lib/frame-stats');
    const histogram = new FrameHistogram();
    for (const ms of intervals) histogram.add(ms);
    return histogram.stats();
  }

  it('matches the sorted statistics on random interval sets', async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const random = seeded(seed);
      const size = 1 + Math.floor(random() * 5_000);
      // Mostly vsync-like frames with jitter, some dropped frames, and a few long stalls.
      const intervals = Array.from({ length: size }, () => {
        const roll = random();
        if (roll < 0.8) return 16.67 + (random() - 0.5) * 2;
        if (roll < 0.95) return 33.33 + random() * 4;
        return 50 + random() * 1_500;
      });
      await expectMatchesSort(await binnedStats(intervals), intervals, `seed ${seed}, ${size} intervals`);
    }
  });

  it('matches the sorted statistics on adversarial interval sets', async () => {
    const edges = Array.from({ length: 60 }, (_, i) => i + 1);
    const sets: Record<string, number[]> = {
      'one frame': [16.67],
      'bucket edges': edges,
      'just under bucket edges': edges.map(ms => ms - 1e-9),
      'the budgets with their jitter exactly': [17.7, 17.7, 34.3, 34.3, 16.7, 33.3],
      'just over the budgets with their jitter': [17.700001, 34.300001, 17.7, 34.3],
      'one bucket holding both sides of the 95th percentile': [...Array(94).fill(17.01), ...Array(6).fill(17.99)],
      'nearest-rank boundaries (19 frames)': Array.from({ length: 19 }, (_, i) => 10 + i),
      'nearest-rank boundaries (20 frames)': Array.from({ length: 20 }, (_, i) => 10 + i),
      'nearest-rank boundaries (21 frames)': Array.from({ length: 21 }, (_, i) => 10 + i),
      'tiny intervals': [0.0001, 0.001, 0.5, 0.999],
      'a long stall below the 95th percentile': [...Array(99).fill(16.67), 60_000],
      'not finite and positive are ignored': [Number.NaN, -1, 0, Infinity, -Infinity, 20, 21],
      'nothing valid': [Number.NaN, 0, -5],
      'all equal': Array(1_000).fill(16.6),
      'descending': Array.from({ length: 500 }, (_, i) => 500 - i * 0.97),
    };
    for (const [label, intervals] of Object.entries(sets)) await expectMatchesSort(await binnedStats(intervals), intervals, label);
  });

  it('counts an interval of 2 s or more in one top bucket, read as at most 0.5 fps', async () => {
    const { HISTOGRAM_RANGE_MS } = await import('@/lib/frame-stats');
    expect(HISTOGRAM_RANGE_MS).toBe(2_000);
    const stats = await binnedStats([2_500, 5_000, 9_000]);
    expect(stats).toMatchObject({ frames: 3, over16: 1, over33: 1 });
    expect(stats.meanFps).toBeCloseTo(3_000 / 16_500, 9);
    expect(stats.p5Fps).toBeLessThanOrEqual(0.5);
  });

  it('matches the sorted statistics of what remains after intervals are removed, and clears', async () => {
    const { FrameHistogram } = await import('@/lib/frame-stats');
    const random = seeded(7);
    const intervals = Array.from({ length: 2_000 }, () => 5 + random() * 60);
    const histogram = new FrameHistogram();
    for (const ms of intervals) histogram.add(ms);
    for (const ms of intervals.slice(0, 1_500)) histogram.remove(ms);
    await expectMatchesSort(histogram.stats(), intervals.slice(1_500), 'after removals');
    histogram.clear();
    expect(histogram.stats()).toEqual({ frames: 0, meanFps: 0, p5Fps: 0, over16: 0, over33: 0 });
  });
});

describe('the frame meter', () => {
  /** Frames every `ms` after `from`, `count` of them; returns the last timestamp. */
  function run(meter: { frame(t: number): void }, from: number, ms: number, count: number) {
    let t = from;
    for (let i = 0; i < count; i++) { t += ms; meter.frame(t); }
    return t;
  }

  it('measures a phase from its start: a phase reset clears its counts', async () => {
    const { FrameMeter } = await import('@/lib/frame-stats');
    const meter = new FrameMeter();
    meter.frame(0);
    let t = run(meter, 0, 50, 100);
    expect(meter.phase().frames).toBe(100);
    expect(meter.phase().meanFps).toBeCloseTo(20, 6);
    meter.resetPhase();
    expect(meter.phase()).toEqual({ frames: 0, meanFps: 0, p5Fps: 0, over16: 0, over33: 0 });
    t = run(meter, t, 16, 30);
    // The new phase holds only its own frames; the 50 ms frames before the reset are gone from it.
    expect(meter.phase()).toMatchObject({ frames: 30, over16: 0, over33: 0 });
    expect(meter.phase().meanFps).toBeCloseTo(62.5, 6);
  });

  it('keeps a rolling 10-second line that drops older frames', async () => {
    const { FrameMeter, ROLLING_WINDOW_MS } = await import('@/lib/frame-stats');
    expect(ROLLING_WINDOW_MS).toBe(10_000);
    const meter = new FrameMeter();
    meter.frame(0);
    // 10 s of 50 ms frames, then 12 s of 16 ms frames: the window holds only the last 10 s, all 16 ms.
    let t = run(meter, 0, 50, 200);
    expect(meter.rolling()).toMatchObject({ frames: 200, over33: 1 });
    t = run(meter, t, 16, 750);
    expect(t).toBe(22_000);
    expect(meter.rolling()).toMatchObject({ frames: 625, over16: 0, over33: 0 });
    expect(meter.rolling().meanFps).toBeCloseTo(62.5, 6);
    // The phase (never reset here) still holds every frame.
    expect(meter.phase().frames).toBe(950);
    expect(meter.phase().over33).toBeCloseTo(200 / 950, 9);
  });

  it('counts the frames of the last second, and does not count a hidden tab gap as a frame interval', async () => {
    const { FrameMeter } = await import('@/lib/frame-stats');
    const meter = new FrameMeter();
    meter.frame(0);
    const t = run(meter, 0, 20, 100);
    expect(meter.current()).toBe(50);
    meter.gap();
    meter.frame(t + 30_000);
    // The first frame after the gap has no interval; the frames of 30 s ago are out of the last second and the window.
    expect(meter.current()).toBe(1);
    expect(meter.phase().frames).toBe(100);
    expect(meter.rolling().frames).toBe(0);
    meter.frame(t + 30_020);
    expect(meter.rolling()).toMatchObject({ frames: 1, meanFps: 50 });
  });

  it('keeps a bounded window: past its capacity the oldest frames leave it first', async () => {
    const { FrameMeter } = await import('@/lib/frame-stats');
    const meter = new FrameMeter({ capacity: 100 });
    meter.frame(0);
    run(meter, 0, 1, 99);
    run(meter, 99, 2, 50);
    // 100 entries at most: the 50 2 ms intervals and the latest 50 of the 1 ms ones.
    expect(meter.rolling().frames).toBe(100);
    expect(meter.rolling().meanFps).toBeCloseTo(100_000 / 150, 6);
    expect(meter.phase().frames).toBe(149);
  });
});
