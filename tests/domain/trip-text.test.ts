import { describe, expect, it } from 'vitest';
import type { RevealedTimeline } from '@contracts/events';
import { EXPEDITION_FIXTURE_TIMELINES as T } from '../fixtures/expeditions';
import { renderExpeditionStage } from '@/game/expedition-stage';
import { slotTimeText } from '@/features/schedule/slot-time';
import { campBanner, campPhase, tripMarks } from '@/features/character/trip-text';

// Patch A Task 9 (spec "The live view", "The whole-trip replay"): the named marks under the live view's 0-80 strip, and the words
// of the camp chapters (the phase text under the scene and the banner over it). The times are slot times against the view's
// display time, in the form the clock setting asks for, so the expected ones come from the same formatter.

const MIN = 60_000;
const startOf = (t: RevealedTimeline) => t.stages[0].startedAtMs;
const start = startOf(T.woodland);
const at = (minute: number, extraMs = 0) => renderExpeditionStage(T.woodland, start + minute * MIN + extraMs);
const outpostAt = (minute: number) => renderExpeditionStage(T.outpost, startOf(T.outpost) + minute * MIN);
const expiredAt = (minute: number) => renderExpeditionStage(T.expired, startOf(T.expired) + minute * MIN);
/** A minute of the Woodland trip as its marks write it, against the display time at minute 30. */
const now = start + 30 * MIN;
const t = (minute: number) => slotTimeText(start + minute * MIN, now, '12');
const end = start + 160 * MIN;

describe('the named marks of the live view', () => {
  it('names the marks of a running trip', () => {   // Woodland at minute 30
    expect(tripMarks(at(30), start, '12').map(m => m.text)).toEqual([`Left camp · ${t(0)}`, '▶ Fight 1 · won', `Fight 2 · ${t(40)}`, `Fight 3 · ${t(60)}`, `Back in camp · ${t(80)}`]);
  });

  it('names a fight in progress, a lost one, those not fought and one without a replay', () => {
    expect(tripMarks(at(40, 1_000), start, '12')[2].text).toBe('Fight 2 · now');
    expect(tripMarks(outpostAt(65), startOf(T.outpost), '12').map(m => m.text).slice(1, 4)).toEqual(['▶ Fight 1 · won', '▶ Fight 2 · lost', 'Fight 3 · not fought']);
    expect(tripMarks(expiredAt(90), startOf(T.expired), '12')[1]).toMatchObject({ text: 'Fight 1 · won', replay: false });
  });

  it('says which marks open the replay at their fight, in the clock the setting asks for', () => {
    const marks = tripMarks(at(30), start, '24');
    expect(marks.map(m => ({ id: m.id, fight: m.fight, replay: m.replay }))).toEqual([
      { id: 'leaving', fight: null, replay: false }, { id: 'fight-1', fight: 1, replay: true }, { id: 'fight-2', fight: 2, replay: false },
      { id: 'fight-3', fight: 3, replay: false }, { id: 'back', fight: null, replay: false },
    ]);
    expect(marks[0].text).toBe(`Left camp · ${slotTimeText(start, now, '24')}`);
    // A lost fight with a kept log opens its replay; a fight in progress does not, and its outcome is not told.
    expect(tripMarks(outpostAt(65), startOf(T.outpost), '12')[2]).toMatchObject({ fight: 2, replay: true });
    expect(tripMarks(at(40, 1_000), start, '12')[2]).toMatchObject({ fight: 2, replay: false });
    expect(JSON.stringify(tripMarks(at(40, 1_000), start, '12'))).not.toMatch(/Fight 2 · (won|lost)/);
  });
});

describe('the camp chapters in words', () => {
  it('says the camp chapters', () => {
    expect(campPhase('leaving', 'Woodland Path', null, null)).toEqual({ title: 'Leaving camp', detail: 'Through the gate and onto the Woodland Path.' });
    expect(campPhase('back', 'Woodland Path', 'success', null).detail).toBe('Home through the gate with the loot.');
    expect(campPhase('back', 'Ruined Outpost', 'failure', null).detail).toBe('Home through the gate, with all gear kept.');
    expect(campPhase('resting', 'Woodland Path', 'success', 30)).toEqual({ title: 'Resting in camp', detail: 'Sleeps through the next slot. Stamina refills to full when it ends: +30.' });
    expect(campPhase('resting', 'Woodland Path', 'success', null).detail).toBe('Sleeps through the next slot.');
    expect(campBanner('resting', end, end, '12', 104, false)).toBe(`Resting until ${slotTimeText(end, end, '12')} · stamina refills to 104`);
    expect(campBanner('resting', end, end, '12', 104, true)).toBe('Resting · stamina to 104');
    expect(campBanner('resting', end, end, '12', null, true)).toBe('Resting');
    expect(campBanner('leaving', end, end, '12', null, false)).toBe('Leaving camp');
  });

  it('names the gate and the rest for everyone else, in the clock the setting asks for', () => {
    expect(campPhase('back', 'Woodland Path', null, null)).toEqual({ title: 'Back in camp', detail: 'Home through the gate with the loot.' });
    expect(campBanner('back', end, end, '12', null, false)).toBe('Back in camp');
    expect(campBanner('back', end, end, '12', 104, true)).toBe('Back in camp');
    expect(campBanner('resting', end, end, '12', null, false)).toBe(`Resting until ${slotTimeText(end, end, '12')}`);
    expect(campBanner('resting', end, end, '24', null, false)).toBe(`Resting until ${slotTimeText(end, end, '24')}`);
    // A rest end that cannot be shown leaves the time out rather than making one up.
    expect(campBanner('resting', Number.NaN, end, '12', null, false)).toBe('Resting');
  });
});
