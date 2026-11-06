import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OwnerState } from '@contracts/reads';
import { TITLES_V1 } from '@domain/titles';
import { LATER_TITLES, pickerCounts, pickerGroups, wornStatus } from '@/features/titles/title-picker';
import { WEAR_REFUSED, keepsWearAttempt, shownWornTitle, wearAttemptFor, type WornAnswer } from '@/features/titles/title-wear';
import { TitleButton } from '@/features/titles/TitlePicker';
import { keepsAttempt } from '@/features/character/look-change';
import { ownerFixture } from '../fixtures/domain';
import { withAsterTitles } from '../fixtures/titles';

// Patch 1.7 Task 10: the pure rules behind the Title button and "Choose your title" (spec "My gladiator: the Title button", "The picker",
// "Progress"): which titles each view lists and how far a locked one is, the words after a wear, which operation id a wear uses, and which
// worn title the button shows while owner reads and a wear answer cross (Review Focus 5).

/** The fixture owner: Aster, 8 titles earned, wearing Founder, at `level`. */
const aster = (level = 1): OwnerState => {
  const owner = withAsterTitles(structuredClone(ownerFixture));
  return { ...owner, progression: { ...owner.progression, level } };
};
const names = (rows: readonly { name: string }[]) => rows.map(row => row.name);

describe('the picker', () => {
  it('counts the earned titles and the 31 that exist', () => {
    expect(pickerCounts(aster())).toEqual({ earned: 8, all: 31 });
    expect(pickerCounts({ titles: [] })).toEqual({ earned: 0, all: 31 });
    expect(TITLES_V1).toHaveLength(31);
  });

  it('lists the earned titles by family, in the families\' order, leaving out empty families', () => {
    const groups = pickerGroups(aster(), 'earned');
    expect(groups.map(g => [g.family, names(g.rows)])).toEqual([
      ['Special', ['Founder']],
      ['Expeditions', ['Wanderer']],
      ['Training', ['Tiro']],
      ['Arena', ['Bloodied']],
      ['Tournaments', ['Finalist']],
      ['Gear collection', ['Collector', 'Rare Find']],
      ['Wealth', ['Moneyed']],
    ]);
    // An earned row has its rule and no progress.
    expect(groups[0].rows[0]).toEqual({ id: 'founder', name: 'Founder', rule: 'Made in Season 1', earned: true, progress: null, share: 1 });
    expect(groups.flatMap(g => g.rows).every(row => row.earned && row.progress === null)).toBe(true);
  });

  it('lists all 31 in All, a locked one with its progress', () => {
    const groups = pickerGroups(aster(6), 'all');
    expect(groups.map(g => g.family)).toEqual(['Special', 'Expeditions', 'Training', 'Arena', 'Tournaments', 'Seasons', 'Gear collection', 'Wealth']);
    const rows = groups.flatMap(g => g.rows);
    expect(rows.map(r => r.id)).toEqual(TITLES_V1.map(t => t.id));
    const row = (id: string) => rows.find(r => r.id === id)!;
    expect(row('pathfinder')).toEqual({ id: 'pathfinder', name: 'Pathfinder', rule: '50 expeditions won', earned: false, progress: '34 of 50', share: 0.68 });
    expect(row('troll-slayer').progress).toBe('Opens at level 10');
    expect(row('raiders-bane').progress).toBe('13 of 25');
    expect(row('patrician')).toMatchObject({ earned: false, progress: '1,240 of 4,000', share: 0.31 });
    expect(row('old-guard').progress).toBe('21 of 100 days');
    expect(row('invictus').progress).toBe('Best run 3 of 5');
    expect(row('bannerman').progress).toBe('Renown shop · 50 renown');
    expect(row('wanderer')).toMatchObject({ earned: true, progress: null });
    // Below the Outpost's level with no win there, Raider's Bane says when it opens.
    expect(pickerGroups({ ...aster(4), titleProgress: {} }, 'all').flatMap(g => g.rows).find(r => r.id === 'raiders-bane')!.progress).toBe('Opens at level 5');
  });

  // Task 4 carry: owner_state.titleProgress leaves out the counters a gladiator has never moved; each reads 0.
  it('reads an absent counter as 0', () => {
    const rows = pickerGroups({ ...aster(), titleProgress: {} }, 'all').flatMap(g => g.rows);
    expect(rows.find(r => r.id === 'pathfinder')).toMatchObject({ progress: '0 of 50', share: 0 });
    expect(rows.find(r => r.id === 'croesus')).toMatchObject({ progress: '0 of 12,000', share: 0 });
  });

  // Review Focus 1: an id this client does not know (a newer server's, or junk) is shown nowhere and never throws.
  it('ignores a held title this client does not know', () => {
    const owner = aster();
    owner.titles = [...owner.titles, { id: 'dungeoneer', earnedAtMs: 1, activityId: null, source: 'history', detail: null },
      { id: 'founder', earnedAtMs: 2, activityId: null, source: 'joined', detail: null }];
    expect(pickerCounts(owner)).toEqual({ earned: 8, all: 31 });
    expect(pickerGroups(owner, 'earned').flatMap(g => g.rows)).toHaveLength(8);
    expect(pickerGroups(owner, 'all').flatMap(g => g.rows).some(r => r.id === 'dungeoneer')).toBe(false);
  });

  it('says the eight titles that arrive later', () => {
    expect(LATER_TITLES).toBe('8 more arrive later: 4 with party dungeons, 2 in the Deep, Outfitter with the new gear, and Legend-Bearer if a Legendary rarity ever comes.');
  });
});

describe('wearing a title', () => {
  it('says what is worn now', () => {
    expect(wornStatus(null)).toBe('You now wear no title.');
    expect(wornStatus('wanderer')).toBe('You now wear Wanderer.');
    expect(wornStatus('lion')).toBe('You now wear Lion of the Arena.');
    expect(wornStatus('junk')).toBe('You now wear no title.');
    expect(WEAR_REFUSED).toBe('That title could not be worn. Try again.');
  });

  it('keeps one operation id for the same title and starts another for a different one', () => {
    let made = 0;
    const newId = () => `id-${++made}`;
    const first = wearAttemptFor(null, 'wanderer', newId);
    expect(first).toEqual({ titleId: 'wanderer', command: { kind: 'wear-title', operationId: 'id-1', titleId: 'wanderer' } });
    // A retry of the same title (an answer that left the outcome open) is the same command: the server replays its receipt.
    expect(wearAttemptFor(first, 'wanderer', newId)).toBe(first);
    expect(made).toBe(1);
    // Another title under the used id would be a conflict on the server: it gets a new id. No title is a title too.
    const none = wearAttemptFor(first, null, newId);
    expect(none).toEqual({ titleId: null, command: { kind: 'wear-title', operationId: 'id-2', titleId: null } });
    expect(wearAttemptFor(none, null, newId)).toBe(none);
    expect(wearAttemptFor(none, 'tiro', newId).command.operationId).toBe('id-3');
  });

  // Ruling R1: the look change's rule, shared, not a copy.
  it('retries the same command only after an answer that left the outcome open, as the look change does', () => {
    for (const code of ['processing', 'unavailable', 'rate-limited']) expect(keepsWearAttempt(code), code).toBe(true);
    for (const code of ['invalid', 'conflict', 'not-found', 'unauthenticated']) expect(keepsWearAttempt(code), code).toBe(false);
    expect(keepsWearAttempt).toBe(keepsAttempt);
  });
});

// Review Focus 5 (AGENTS.md async state): owner reads are numbered as they start; a wear answer holds the button's title until a read that
// started after the answer lands. A read that started before it (a stale one) never puts the old title back.
describe('the worn title the button shows', () => {
  const owner = { gladiatorId: ownerFixture.gladiatorId, wornTitle: 'founder' };
  const answer = (titleId: string | null, afterRead: number, gladiatorId = ownerFixture.gladiatorId): WornAnswer => ({ gladiatorId, titleId, afterRead });

  it('is the owner read\'s with no answer', () => {
    expect(shownWornTitle(owner, 3, null)).toBe('founder');
    expect(shownWornTitle({ ...owner, wornTitle: null }, 3, null)).toBeNull();
  });

  it('is the answer\'s until a read that started after it lands', () => {
    // The answer came when reads 1 to 5 had started: read 5 (started before) still shows the answer, not its Founder.
    expect(shownWornTitle(owner, 5, answer('wanderer', 5))).toBe('wanderer');
    expect(shownWornTitle(owner, 4, answer(null, 5))).toBeNull();
    // Read 6 started after the answer: it is the server's word now, whatever it says (another device may have changed it since).
    expect(shownWornTitle({ ...owner, wornTitle: 'wanderer' }, 6, answer('wanderer', 5))).toBe('wanderer');
    expect(shownWornTitle({ ...owner, wornTitle: 'tiro' }, 6, answer('wanderer', 5))).toBe('tiro');
  });

  it('keeps the answer when a background read lands before it', () => {
    // Sent while read 5 was shown; a background read (6) lands before the answer with the old title; then the answer arrives (reads 1-6
    // started), then the refresh read (7) that started after it.
    expect(shownWornTitle(owner, 6, null)).toBe('founder');
    expect(shownWornTitle(owner, 6, answer('wanderer', 6))).toBe('wanderer');
    expect(shownWornTitle({ ...owner, wornTitle: 'wanderer' }, 7, answer('wanderer', 6))).toBe('wanderer');
  });

  it('belongs to the gladiator that wore it', () => {
    expect(shownWornTitle({ gladiatorId: 'another', wornTitle: null }, 1, answer('wanderer', 5))).toBeNull();
  });
});

describe('the Title button', () => {
  const render = (wornTitle: string | null) => renderToStaticMarkup(createElement(TitleButton, { wornTitle, onOpen: () => undefined }));

  it('names the worn title, or No title', () => {
    expect(render('founder')).toContain('aria-label="Title: Founder. Choose your title"');
    expect(render('founder')).toMatch(/>TITLE<.*>›<.*>Founder</);
    expect(render(null)).toContain('aria-label="Title: No title. Choose your title"');
    expect(render(null)).toContain('>No title<');
  });

  // Review Focus 1, and D2: the button shows the plain name ("Champion"), never throws on an unknown id.
  it('shows No title for an id this client does not know, and the plain name for Champion', () => {
    for (const junk of ['dungeoneer', '', 'FOUNDER']) expect(render(junk), junk).toContain('aria-label="Title: No title. Choose your title"');
    expect(render('champion')).toContain('aria-label="Title: Champion. Choose your title"');
  });
});
