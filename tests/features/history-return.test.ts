import { describe, expect, it } from 'vitest';
import { clearHistoryRow, landingStep, rememberHistoryRow, takeHistoryRow } from '@/features/character/history-return';

describe('the History row a replay was opened from (Task 32)', () => {
  it('is taken once, by the same gladiator and chip', () => {
    rememberHistoryRow('g1', 'arena', 'e7');
    expect(takeHistoryRow('g1', 'arena')).toBe('e7');
    expect(takeHistoryRow('g1', 'arena')).toBeNull();
  });

  it('is forgotten by the History that made it, and only by that one (Codex review, finding 7)', () => {
    const mine = {}, other = {};
    rememberHistoryRow('g1', 'arena', 'e7', mine);
    clearHistoryRow(other);
    expect(takeHistoryRow('g1', 'arena')).toBe('e7');
    rememberHistoryRow('g1', 'arena', 'e7', mine);
    clearHistoryRow(mine);
    expect(takeHistoryRow('g1', 'arena')).toBeNull();
  });

  it('is forgotten when another gladiator or another chip opens first', () => {
    rememberHistoryRow('g1', 'arena', 'e7');
    expect(takeHistoryRow('g2', 'arena')).toBeNull();
    expect(takeHistoryRow('g1', 'arena')).toBeNull();
    rememberHistoryRow('g1', 'arena', 'e7');
    expect(takeHistoryRow('g1', 'tournament')).toBeNull();
    expect(takeHistoryRow('g1', 'arena')).toBeNull();
  });
});

describe('where the landing goes next', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `e${i}`);
  const state = (over: Partial<Parameters<typeof landingStep>[1]> = {}) => ({ kind: 'arena', ids: ids(20), hasMore: true, failed: false, size: 6, ...over });
  const landing = (entryId: string, kind = 'arena') => ({ kind, entryId });

  it('jumps to a row on a whole page read', () => {
    expect(landingStep(landing('e5'), state())).toEqual({ step: 'jump', index: 5 });
    expect(landingStep(landing('e17'), state())).toEqual({ step: 'jump', index: 17 });
  });

  it('reads on while the row is on the partly read last page or not read yet', () => {
    expect(landingStep(landing('e19'), state())).toEqual({ step: 'read' });
    expect(landingStep(landing('e40'), state())).toEqual({ step: 'read' });
  });

  it('treats a row on a partly read first page as loaded (a Show choice of 25 or 50)', () => {
    expect(landingStep(landing('e3'), state({ ids: ids(20), size: 25 }))).toEqual({ step: 'jump', index: 3 });
  });

  it('jumps to any row once the list has ended, and is done when the row is not there', () => {
    expect(landingStep(landing('e22'), state({ ids: ids(23), hasMore: false }))).toEqual({ step: 'jump', index: 22 });
    expect(landingStep(landing('missing'), state({ hasMore: false }))).toEqual({ step: 'done' });
  });

  it('says so after a failed read, and is done when the chip is not the one it belongs to', () => {
    expect(landingStep(landing('e40'), state({ failed: true }))).toEqual({ step: 'failed' });
    expect(landingStep(landing('e5', 'arena'), state({ kind: 'tournament' }))).toEqual({ step: 'done' });
  });
});
