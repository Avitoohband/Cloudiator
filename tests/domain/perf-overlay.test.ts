import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Task 24.1b (plan Decision 11, 23.4 M3): the `?perf=1` overlay measures per phase (reset at camp-ready and at each scene
// open or close) beside a rolling 10-second line, and its renderer line wraps instead of being cut short.
const RENDERER = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Laptop GPU (0x000024DC) Direct3D11 vs_5_0 ps_5_0, D3D11)';
const stats = (frames: number, fps: number) => ({ frames, meanFps: fps, p5Fps: fps - 2, over16: 0.012, over33: 0.003 });
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

describe('the frame overlay phases', () => {
  it('starts a new phase when the camp gets ready and at each scene open or close', async () => {
    const { perfPhaseOf } = await import('@/features/shell/PerfOverlay');
    const loading = perfPhaseOf('loading', null);
    const camp = perfPhaseOf('ready', null);
    const replay = perfPhaseOf('ready', { kind: 'replay', activityId: 'a1' });
    const stage = perfPhaseOf('ready', { kind: 'replay', activityId: 'a1', stageId: 's2' });
    const other = perfPhaseOf('ready', { kind: 'replay', activityId: 'a2' });
    const expedition = perfPhaseOf('ready', { kind: 'expedition', activityId: 'e1' });
    expect([loading.label, camp.label, replay.label, expedition.label]).toEqual(['loading', 'camp', 'replay', 'expedition']);
    expect(perfPhaseOf('unavailable', null).label).toBe('camp unavailable');
    // Every change is a new phase key; the same view keeps its key.
    const keys = [loading, camp, replay, stage, other, expedition, perfPhaseOf('unavailable', null)].map(p => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(perfPhaseOf('ready', { kind: 'replay', activityId: 'a1' }).key).toBe(replay.key);
    // A scene opened by a link before the camp is ready: the camp getting ready under it starts a new phase too.
    expect(perfPhaseOf('loading', { kind: 'replay', activityId: 'a1' }).key).not.toBe(replay.key);
  });
});

describe('the frame overlay readout', () => {
  it('shows the phase, its numbers, the rolling 10-second line and the whole renderer string', async () => {
    const { PerfReadout } = await import('@/features/shell/PerfOverlay');
    const html = renderToStaticMarkup(createElement(PerfReadout, {
      shown: { phase: 'replay', seconds: 12.4, current: 59, stats: stats(731, 59.94), rolling: stats(600, 60.01), renderer: RENDERER },
    }));
    const shown = text(html);
    expect(shown).toContain('replay · 12 s · 59 fps');
    expect(shown).toContain('mean 59.9 · p5 57.9 · 731 frames');
    expect(shown).toContain('>16.7 ms 1.2% · >33.3 ms 0.3%');
    expect(shown).toContain('10 s: mean 60.0 · p5 58.0 · >33.3 ms 0.3%');
    // The renderer line is never shortened in the markup.
    expect(shown).toContain(RENDERER);
    expect(renderToStaticMarkup(createElement(PerfReadout, { shown: null }))).toContain('Measuring frames…');
  });

  it('wraps the renderer line instead of cutting it short', () => {
    const css = readFileSync('src/features/shell/shell.module.css', 'utf8');
    const rule = (selector: string) => new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)?.[2] ?? '';
    // `.perf p` keeps each number line on one line, so the renderer's rule must outrank it (two classes).
    const renderer = rule('.perf .perfRenderer');
    expect(renderer).toMatch(/white-space:\s*normal/);
    expect(renderer).toMatch(/overflow-wrap:\s*anywhere/);
    expect(css).not.toMatch(/text-overflow:\s*ellipsis/);
    expect(rule('.perfRenderer')).toBe('');
  });
});
