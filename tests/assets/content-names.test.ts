import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { auditFiles, contentName, isVersionOf } from '../../assets/source/tools/content-names.mjs';

// Final review F1 (2026-10-26): atlas images are named by their content, and `build-assets.mjs --check` refuses anything it
// would not write, a stale content-addressed image or an atlas image at an old unhashed path included.
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe('content-addressed atlas image names', () => {
  it('adds the first 10 hex digits of the sha256 of the bytes before .png', () => {
    const bytes = Buffer.from('pixels');
    expect(contentName('actors/gladiators.png', bytes)).toBe(`actors/gladiators.${sha(bytes).slice(0, 10)}.png`);
    expect(contentName('actors/gladiators.png', Buffer.from('other'))).not.toBe(contentName('actors/gladiators.png', bytes));
  });

  it("knows an image's content-addressed versions, of any bytes, and nothing else", () => {
    expect(isVersionOf('actors/gladiators.png', 'actors/gladiators.0123456789.png')).toBe(true);
    expect(isVersionOf('actors/gladiators.png', 'actors/gladiators.png')).toBe(false);
    expect(isVersionOf('actors/gladiators.png', 'actors/gladiators.json')).toBe(false);
    expect(isVersionOf('actors/gladiators.png', 'actors/gladiators.012345678.png')).toBe(false);
    expect(isVersionOf('actors/gladiators.png', 'actors/gladiators.0123456789a.png')).toBe(false);
    expect(isVersionOf('actors/gladiators.png', 'actors/gladiatorsx0123456789.png')).toBe(false);
    expect(isVersionOf('actors/gladiators.png', 'actors/npcs.0123456789.png')).toBe(false);
    expect(isVersionOf('actors/gladiators.png', 'camp/gladiators.0123456789.png')).toBe(false);
  });
});

describe('the --check audit', () => {
  const current = Buffer.from('current');
  const image = contentName('actors/gladiators.png', current);
  const disk = (files: Record<string, Buffer>) => ({ present: Object.keys(files), read: (file: string) => files[file] ?? null });
  const base = {
    outputs: new Map([[image, current], ['actors/gladiators.json', Buffer.from('{}')]]),
    allowed: ['gallery.html'],
  };
  const good = { [image]: current, 'actors/gladiators.json': Buffer.from('{}'), 'gallery.html': Buffer.from('<p>') };

  it('passes when every output is identical and nothing else is present', () => {
    expect(auditFiles({ ...base, ...disk(good) })).toEqual([]);
  });

  it('refuses a stale content-addressed image as an orphan', () => {
    const stale = contentName('actors/gladiators.png', Buffer.from('last release'));
    expect(auditFiles({ ...base, ...disk({ ...good, [stale]: Buffer.from('last release') }) })).toEqual([{ file: stale, problem: 'orphan' }]);
  });

  it('refuses a changed or missing output', () => {
    expect(auditFiles({ ...base, ...disk({ ...good, 'actors/gladiators.json': Buffer.from('[]') }) })).toEqual([{ file: 'actors/gladiators.json', problem: 'stale' }]);
    const { [image]: _gone, ...withoutImage } = good;
    expect(auditFiles({ ...base, ...disk(withoutImage) })).toEqual([{ file: image, problem: 'missing' }]);
  });

  it('refuses an atlas image left at its old unhashed path as an orphan', () => {
    expect(auditFiles({ ...base, ...disk({ ...good, 'actors/gladiators.png': Buffer.from('old') }) })).toEqual([{ file: 'actors/gladiators.png', problem: 'orphan' }]);
  });
});
