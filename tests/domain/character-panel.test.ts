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
function panel(owner: OwnerState, nowMs: number, slotIndex = SLOT) {
  const clock = createDisplayClock();
  clock.freeze(nowMs);
  return renderToStaticMarkup(createElement(CharacterPanel, {
    viewer: 'player', session: { status: 'signed-in', userId: 'account', expiresAtMs: null }, owner, ownerError: null, slotIndex, clock,
    gateway: {} as GameGateway, fixture: true, previewFailed: false, refreshOwner: async () => {}, onCreate: noop,
  }));
}

describe('My gladiator', () => {
  // Task 23.9 (Task 23.8's OwnerState.restingUntilSlot): the owner's activity line while the gladiator rests at home.
  it('shows the owner "Resting at home: back on your schedule at {time}" until that boundary', () => {
    const owner: OwnerState = { ...structuredClone(ownerFixture), currentActivity: null, processedSlotIndex: SLOT, restingUntilSlot: SLOT + 1 };
    const boundary = (SLOT + 1) * SLOT_MS;
    const line = `Resting at home: back on your schedule at ${slotTimeText(boundary)}`;
    const resting = panel(owner, SLOT * SLOT_MS + 40 * 60_000);
    expect(text(resting)).toContain(line);
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
});
