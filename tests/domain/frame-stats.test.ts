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
