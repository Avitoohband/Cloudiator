import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OwnerState } from '@contracts/reads';
import type { GameGateway } from '@/lib/api/gateway';
import { createDisplayClock } from '@/game/display-clock';
import { CharacterPanel } from '@/features/character/CharacterPanel';
import { slotTimeText } from '@/features/schedule/slot-time';
import { ownerFixture } from '../fixtures/domain';

const SLOT_MS = 4_800_000;
const SLOT = 373_248;
const noop = () => {};
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, '\'').replace(/\s+/g, ' ');

/** The My gladiator panel of a player at display time `nowMs` (the shared clock held there). */
function panel(owner: OwnerState, nowMs: number, slotIndex = SLOT, resting = false) {
  const clock = createDisplayClock();
  clock.freeze(nowMs);
  return renderToStaticMarkup(createElement(CharacterPanel, {
    viewer: 'player', session: { status: 'signed-in', userId: 'account', expiresAtMs: null }, owner, ownerError: null, slotIndex, clock,
    gateway: {} as GameGateway, fixture: true, previewFailed: false, refreshOwner: async () => {}, onCreate: noop, resting,
  }));
}

/** The activity line exactly: the panel's status paragraph holding `line` and nothing else. */
const statusLine = (line: string) => new RegExp(`role="status"[^>]*>${line.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}<`);

describe('My gladiator', () => {
  // Task 24.0b (Avi, 2026-10-20): the activity's end is shown as every slot time is (`slotTimeText` against the display time
  // the panel is at, Task 23.10), never in the fixed two-digit form (`04:20 AM`).
  it('ends the activity line with its end time in the short slot-time style', () => {
    const nowMs = SLOT * SLOT_MS + 40 * 60_000;
    const owner: OwnerState = { ...structuredClone(ownerFixture), processedSlotIndex: SLOT };
    const end = owner.currentActivity!.endsAtMs;
    expect(panel(owner, nowMs)).toMatch(statusLine(`In progress · ends ${slotTimeText(end, nowMs)}`));
    // A later day says which: here the short weekday (two days ahead), where the fixed form gave the time alone.
    const later = nowMs + 2 * 86_400_000;
    const scheduled: OwnerState = { ...owner, currentActivity: { ...owner.currentActivity!, startsAtMs: nowMs + 60_000, endsAtMs: later } };
    expect(panel(scheduled, nowMs)).toMatch(statusLine(`Scheduled · ends ${slotTimeText(later, nowMs)}`));
    expect(slotTimeText(later, nowMs)).toMatch(/^\p{L}+ /u);
  });

  // An end that cannot be shown (`slotTimeText` gives '' for a value that is not a finite number) leaves the suffix out,
  // never "· ends " with nothing after it, and never a throw during render.
  it('leaves "· ends" out when the end time cannot be shown', () => {
    const nowMs = SLOT * SLOT_MS + 40 * 60_000;
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const owner: OwnerState = { ...structuredClone(ownerFixture), processedSlotIndex: SLOT };
      owner.currentActivity = { ...owner.currentActivity!, endsAtMs: bad };
      const html = panel(owner, nowMs);
      expect(html, `end ${bad}`).toMatch(statusLine('In progress'));
      expect(text(html), `end ${bad}`).not.toContain('ends');
    }
  });

  // Task 23.9 (Task 23.8's OwnerState.restingUntilSlot): the owner's activity line while the gladiator rests at home.
  it('shows the owner "Resting at home: back on your schedule at {time}" until that boundary', () => {
    const owner: OwnerState = { ...structuredClone(ownerFixture), currentActivity: null, processedSlotIndex: SLOT, restingUntilSlot: SLOT + 1 };
    const boundary = (SLOT + 1) * SLOT_MS;
    // {time} is shown against the display time the panel is at (Task 23.10).
    const nowMs = SLOT * SLOT_MS + 40 * 60_000;
    const line = `Resting at home: back on your schedule at ${slotTimeText(boundary, nowMs)}`;
    const resting = panel(owner, nowMs);
    expect(text(resting)).toContain(text(line)); // (`text` reads the time's no-break space as an ordinary one)
    // It is the activity line itself (a status), and nothing says the gladiator has an activity.
    expect(resting).toMatch(new RegExp(`role="status"[^>]*>${line.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}<`));
    expect(text(resting)).not.toMatch(/In progress|Scheduled|ends /);
    // At the boundary its schedule applies again.
    const back = panel(owner, boundary);
    expect(text(back)).not.toContain('Resting at home');
    expect(text(back)).toContain('Preparing your next activity');
    // A gladiator that is not resting reads as before.
    expect(text(panel(structuredClone(ownerFixture), SLOT * SLOT_MS + 40 * 60_000))).not.toContain('Resting at home');
  });

  // Fix round 1 (review Minor 1): resting in the world before the presence is answered.
  it('shows "Resting at home." while its gladiator rests and its return is not known yet', () => {
    const owner: OwnerState = { ...structuredClone(ownerFixture), currentActivity: null, processedSlotIndex: SLOT, restingUntilSlot: null };
    const waiting = panel(owner, SLOT * SLOT_MS + 40 * 60_000, SLOT, true);
    expect(waiting).toMatch(/role="status"[^>]*>Resting at home\.</);
    expect(text(waiting)).not.toContain('Preparing your next activity');
    // The same owner state with the gladiator not resting in the world: its next activity is being prepared.
    expect(text(panel(owner, SLOT * SLOT_MS + 40 * 60_000))).toContain('Preparing your next activity');
  });
});
