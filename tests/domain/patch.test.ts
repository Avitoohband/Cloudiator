import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PATCH, isBehind, noticeFor, noticeText, patchSortKey, playingLine } from '../../src/lib/patch';
import { parseChangelog } from '../../scripts/changelog.mjs';
import { PATCH_1_4, SEED_PATCHES } from '../fixtures/patches';

// Patch numbers and the changelog (Patch A spec, last section; Task 11b). The build's own patch, the server's ordering of patch
// numbers (the generated sort_key of public.patches), when an open game is behind the server, the reload notice's words and when
// it shows, and docs/CHANGELOG.md read as the list of patches the server records word for word.
describe('patch numbers', () => {
  it('orders patch numbers as the server does', () => {
    expect(patchSortKey('1.0')).toBe(1_000_000);
    expect(patchSortKey('1.2.1')).toBe(1_002_001);
    expect(patchSortKey('1.10')).toBe(1_010_000);
    for (const bad of ['1', '1.3.0', '01.2', '1.2.3.4', 'v1.4', '', '1.1000']) expect(patchSortKey(bad)).toBeNull();
  });

  it('is behind only when the server has a later patch', () => {
    expect(isBehind('1.5', '1.4')).toBe(true);
    expect(isBehind('1.4.1', '1.4')).toBe(true);
    for (const latest of ['1.4', '1.3.1', null, 'junk']) expect(isBehind(latest, '1.4')).toBe(false);
  });

  it('announces a newer patch once, and waits under a scene or a dialog', () => {
    expect(noticeFor({ latest: '1.5', build: '1.4', blocked: false, later: null })).toBe('1.5');
    expect(noticeFor({ latest: '1.5', build: '1.4', blocked: true, later: null })).toBeNull();
    expect(noticeFor({ latest: '1.5', build: '1.4', blocked: false, later: '1.5' })).toBeNull();
    expect(noticeFor({ latest: '1.6', build: '1.4', blocked: false, later: '1.5' })).toBe('1.6');
    expect(noticeText('1.5', false)).toEqual(['A new patch is out', ' — reload to play Patch 1.5.']);
    expect(noticeText('1.5', true)).toEqual(['Patch 1.5 is out', '']);
    expect(playingLine('1.4', '1.4')).toBe('You are playing Patch 1.4');
    expect(playingLine('1.4', '1.5')).toBe('You are playing Patch 1.4 · Patch 1.5 is out');
  });

  it('reads the changelog sections', () => {
    const text = '# T\n\n## Videos\n\n- not a patch\n\n## 1.4 — Next (in progress, not yet released)\n\n### Built\n\n- A.\n\n'
      + '### Planned\n\n- B.\n\n## 1.3.1 — Phone attribute points (2026-10-29)\n\n- One.\n';
    expect(parseChangelog(text)).toEqual([
      { number: '1.4', title: 'Next', date: null, features: ['A.', 'B.'], planned: true },
      { number: '1.3.1', title: 'Phone attribute points', date: '2026-10-29', features: ['One.'], planned: false }]);
  });

  it('builds the patch CHANGELOG.md names first, and the changelog is well formed', () => {
    const sections = parseChangelog(readFileSync('docs/CHANGELOG.md', 'utf8'));
    expect(sections[0].number).toBe(PATCH);
    const keys = sections.map(s => patchSortKey(s.number)!);
    expect(keys.every(Number.isInteger)).toBe(true);
    expect(keys).toEqual([...keys].sort((a, b) => b - a));
    expect(sections.map(s => s.number).slice(-6)).toEqual(['1.3.1', '1.3', '1.2.1', '1.2', '1.1', '1.0']);
    for (const s of sections.slice(1)) { expect(s.date).toMatch(/^\d{4}-\d{2}-\d{2}$/); expect(s.planned).toBe(false); }
    for (const s of sections) {
      expect(s.title.length).toBeLessThanOrEqual(80);
      expect(s.features.length).toBeGreaterThan(0);
      expect(s.features.length).toBeLessThanOrEqual(20);
      for (const f of s.features) { expect(f.length).toBeLessThanOrEqual(240); expect(f).not.toMatch(/[`*_[\]]/); }
    }
  });

  it('keeps the preview\'s seed patches word for word as CHANGELOG.md\'s released sections up to 1.3.1, on their release days', () => {
    // M26 seeds the patches released before it (1.0 to 1.3.1); a later patch is recorded at its own release, so a dated 1.4 section (the
    // release finalizes it) is not compared with the seed.
    const seeded = parseChangelog(readFileSync('docs/CHANGELOG.md', 'utf8'))
      .filter(s => !s.planned && patchSortKey(s.number)! <= patchSortKey('1.3.1')!);
    expect(SEED_PATCHES.map(p => ({ number: p.number, title: p.title, date: new Date(p.releasedAtMs).toISOString().slice(0, 10), features: p.features, planned: false })))
      .toEqual(seeded);
    for (const p of [PATCH_1_4, ...SEED_PATCHES]) expect(p.sortKey, p.number).toBe(patchSortKey(p.number));
    expect(PATCH_1_4.number).toBe(PATCH);
  });
});
