import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Patch A, item 7: one clock for every time of day. A time of day is written by `src/lib/time-format.ts` (the shape follows
// the device's clock setting, `src/lib/clock-setting.ts`) and nowhere else: a second formatter would show the other
// format on that screen. Durations are not times of day and stay outside the guard.
const ALLOWED = new Set(['src/lib/time-format.ts', 'src/lib/clock-setting.ts']);
const ROOT = process.cwd();

/** Every line of every .ts/.tsx file under `directory` (relative to the repository root), as [file, line], less comment lines. */
function codeLines(directory: string): [string, string][] {
  const lines: [string, string][] = [];
  for (const entry of readdirSync(join(ROOT, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) { lines.push(...codeLines(path)); continue; }
    if (!/\.tsx?$/.test(entry.name)) continue;
    for (const line of readFileSync(join(ROOT, path), 'utf8').split(/\r?\n/)) {
      const start = line.trim();
      if (start.startsWith('//') || start.startsWith('*') || start.startsWith('/*')) continue;
      lines.push([relative(ROOT, join(ROOT, path)).replaceAll('\\', '/'), line]);
    }
  }
  return lines;
}

describe('one clock', () => {
  it('reads the source it guards', () => {
    expect(codeLines('src').length).toBeGreaterThan(1000);
    expect(codeLines('src').some(([file]) => file === 'src/lib/time-format.ts')).toBe(true);
  });

  it('formats every time of day in src through the shared formatter', () => {
    expect(codeLines('src').filter(([file, line]) => !ALLOWED.has(file) && /hourCycle|hour12|\bhour\s*:/.test(line))).toEqual([]);
  });

  it('writes no fixed UTC clock time in src', () => {
    expect(codeLines('src').filter(([, line]) => /\b\d{2}:\d{2} UTC\b/.test(line))).toEqual([]);
  });
});
