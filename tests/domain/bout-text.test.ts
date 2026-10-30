import { describe, expect, it } from 'vitest';
import type { MyBout } from '@/lib/api/reads';
import { boutRow, dayGroups, emptyText, ratingText, unwatchedCount } from '@/features/bouts/bout-text';

// Arena replays Task 4 (spec 1): the words of My bouts' rows, day groups, count and empty states. Zones are named in each call.
const NOW = Date.UTC(2026, 9, 10, 4, 0);
const AT = Date.UTC(2026, 9, 10, 3, 0);
const DAY = 86_400_000;

/** An Arena victory fought at 03:00 UTC on Sat 10 Oct, +10 renown, rating +14, its replay kept, against Varro. */
function bout(over: Partial<MyBout> = {}): MyBout {
  return { activityId: 'a', kind: 'arena', slotIndex: 373_247, foughtAtMs: AT, settledAtMs: AT + 20 * 60_000, result: 'victory', renown: 10, ratingDelta: 14,
    replayExpiry: { state: 'available', expiresAtMs: AT + 20 * 60_000 + 7 * DAY }, opponent: { name: 'Varro', npc: false }, tieBreak: false, round: null, ...over };
}

describe('a My bouts row', () => {
  it('writes a kept bout as the mockup does', () => {
    expect(boutRow(bout(), NOW, '12', 'UTC')).toEqual({ kept: true, badge: { letter: 'W', name: 'Won' }, name: 'vs Varro', tag: null,
      sub: { wide: 'Arena · 3:00\xA0AM · +10 renown · Rating +14', narrow: '3:00\xA0AM · +10 renown · Rating +14' },
      action: '▶ Watch', label: 'Watch: vs Varro, Sat 10 Oct, 3:00\xA0AM' });
    expect(boutRow(bout(), NOW, '24', 'UTC').sub.wide).toBe('Arena · 03:00 · +10 renown · Rating +14');
  });

  it('says a loss, a tie-break, an NPC and leaves out zero parts', () => {
    expect(boutRow(bout({ result: 'defeat', renown: 2, ratingDelta: -13, tieBreak: true, opponent: { name: 'Cassia', npc: false } }), NOW, '12', 'UTC'))
      .toMatchObject({ badge: { letter: 'L', name: 'Lost' }, sub: { wide: 'Arena · 3:00\xA0AM · lost on a tie-break · +2 renown · Rating −13' } });
    expect(boutRow(bout({ tieBreak: true }), NOW, '12', 'UTC').sub.wide).toContain('· won on a tie-break ·');
    expect(boutRow(bout({ opponent: { name: 'Iron Warden', npc: true }, renown: 3, ratingDelta: null }), NOW, '12', 'UTC'))
      .toMatchObject({ name: 'vs Iron Warden', tag: 'NPC', sub: { wide: 'Arena · 3:00\xA0AM · +3 renown' } });
    expect(boutRow(bout({ renown: 0, ratingDelta: 0 }), NOW, '12', 'UTC').sub.wide).toBe('Arena · 3:00\xA0AM');
  });

  it('starts a tournament row with its round', () => {
    expect(boutRow(bout({ kind: 'tournament', round: 'Final', renown: 60, ratingDelta: 16 }), NOW, '12', 'UTC'))
      .toMatchObject({ tag: 'TOURNAMENT', sub: { wide: 'Final · 3:00\xA0AM · +60 renown · Rating +16', narrow: 'Final · 3:00\xA0AM · +60 renown · Rating +16' } });
    expect(boutRow(bout({ kind: 'tournament', round: null }), NOW, '12', 'UTC').sub.narrow).toBe('3:00\xA0AM · +10 renown · Rating +14');
    expect(boutRow(bout({ kind: 'tournament', round: null }), NOW, '12', 'UTC').sub.wide).toBe('Tournament · 3:00\xA0AM · +10 renown · Rating +14');
  });

  it('dims a bout whose replay is gone, by the server’s time, and names no opponent', () => {
    const gone = boutRow(bout({ replayExpiry: { state: 'expired' } }), NOW, '12', 'UTC');
    expect(gone).toMatchObject({ kept: false, name: 'Arena bout', tag: null, action: 'Result', badge: { letter: 'W', name: 'Won' },
      sub: { wide: '3:00\xA0AM · replay no longer kept', narrow: '3:00\xA0AM · replay no longer kept' }, label: 'Result: Arena bout, Sat 10 Oct, 3:00\xA0AM' });
    const at = bout({ replayExpiry: { state: 'available', expiresAtMs: NOW } });
    expect(boutRow(at, NOW - 1, '12', 'UTC').kept).toBe(true);
    expect(boutRow(at, NOW, '12', 'UTC').kept).toBe(false);
    expect(boutRow(bout(), null, '12', 'UTC').action).toBeNull();
    expect(boutRow(bout({ opponent: null }), NOW, '12', 'UTC').name).toBe('Arena bout');
    // Task 2 carry: the read named the opponent while the replay was kept; once the display clock passes the expiry the row no longer
    // names them, nor says a tie-break, an NPC or a tournament tag, though its summary still says `available`.
    const lapsed = boutRow(bout({ replayExpiry: { state: 'available', expiresAtMs: NOW }, tieBreak: true, opponent: { name: 'Iron Warden', npc: true } }), NOW, '12', 'UTC');
    expect(lapsed).toMatchObject({ kept: false, name: 'Arena bout', tag: null, action: 'Result', sub: { wide: '3:00\xA0AM · replay no longer kept' } });
    expect(JSON.stringify(lapsed)).not.toMatch(/Iron Warden|tie-break/);
    expect(boutRow(bout({ kind: 'tournament', round: 'Final', replayExpiry: { state: 'expired' } }), NOW, '12', 'UTC'))
      .toMatchObject({ name: 'Tournament bout', tag: null, sub: { wide: '3:00\xA0AM · replay no longer kept' }, label: 'Result: Tournament bout, Sat 10 Oct, 3:00\xA0AM' });
    // A kept tournament bout whose run could not be read: the generic name, still watchable, with no tag repeating it.
    expect(boutRow(bout({ kind: 'tournament', opponent: null }), NOW, '12', 'UTC')).toMatchObject({ name: 'Tournament bout', tag: null, action: '▶ Watch' });
  });

  it('writes a rating change with a real minus sign', () => {
    expect([ratingText(14), ratingText(-13), ratingText(1)]).toEqual(['Rating +14', 'Rating −13', 'Rating +1']);
  });
});

describe('the My bouts list', () => {
  it('groups by day, today first', () => {
    expect(dayGroups([bout(), bout({ activityId: 'b', foughtAtMs: Date.UTC(2026, 9, 10, 1) }), bout({ activityId: 'c', foughtAtMs: Date.UTC(2026, 9, 9, 23) })], NOW, 'UTC')
      .map(g => [g.label, g.bouts.length])).toEqual([['TODAY · SAT 10 OCT', 2], ['FRI 9 OCT', 1]]);
    // The viewer's own zone decides the day: 23:00 UTC on Fri is already Sat in UTC+3.
    expect(dayGroups([bout({ foughtAtMs: Date.UTC(2026, 9, 9, 23) })], NOW, 'Etc/GMT-3').map(g => g.label)).toEqual(['TODAY · SAT 10 OCT']);
    // Without the server's time no day is called today.
    expect(dayGroups([bout()], Number.NaN, 'UTC').map(g => g.label)).toEqual(['SAT 10 OCT']);
    expect(dayGroups([], NOW, 'UTC')).toEqual([]);
  });

  it('counts the kept bouts not watched, and says an empty list', () => {
    expect(unwatchedCount([bout(), bout({ activityId: 'b' }), bout({ activityId: 'c', replayExpiry: { state: 'expired' } })], new Set(['b']), NOW)).toBe(1);
    expect(unwatchedCount([bout({ replayExpiry: { state: 'available', expiresAtMs: NOW } })], new Set(), NOW)).toBe(0);
    expect([emptyText('all'), emptyText('won'), emptyText('lost')]).toEqual(['No bouts yet. Your Arena and tournament bouts show here with their replays.',
      'No won bouts yet.', 'No lost bouts yet.']);
  });
});
