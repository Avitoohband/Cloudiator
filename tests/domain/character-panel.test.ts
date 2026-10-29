import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OwnerState } from '@contracts/reads';
import type { GameGateway } from '@/lib/api/gateway';
import { createDisplayClock } from '@/game/display-clock';
import { CharacterPanel } from '@/features/character/CharacterPanel';
import { slotTimeText } from '@/features/schedule/slot-time';
import { ownerFixture } from '../fixtures/domain';
import { pinDeviceClock } from '../fixtures/clock';

const SLOT_MS = 4_800_000;
const SLOT = 373_248;
const noop = () => {};
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, '\'').replace(/\s+/g, ' ');

/** The My gladiator panel of a player at display time `nowMs` (the shared clock held there). */
function panel(owner: OwnerState, nowMs: number, slotIndex = SLOT, resting = false, fixture = true) {
  const clock = createDisplayClock();
  clock.freeze(nowMs);
  return renderToStaticMarkup(createElement(CharacterPanel, {
    viewer: 'player', session: { status: 'signed-in', userId: 'account', expiresAtMs: null }, owner, ownerError: null, slotIndex, clock,
    gateway: {} as GameGateway, fixture, previewFailed: false, refreshOwner: async () => {}, onCreate: noop, resting,
  }));
}

/** The activity line exactly: the panel's status paragraph holding `line` and nothing else. */
const statusLine = (line: string) => new RegExp(`role="status"[^>]*>${line.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}<`);

describe('My gladiator', () => {
  // Patch A, item 7: the device's clock setting is pinned to 12-hour (the form these tests were written in).
  beforeEach(() => { pinDeviceClock('12'); });
  afterEach(() => { vi.restoreAllMocks(); });

  // Task 24.0b (Avi, 2026-10-20): the activity's end is shown as every slot time is (`slotTimeText` against the display time
  // the panel is at, Task 23.10), never in the fixed two-digit form (`04:20 AM`).
  it('ends the activity line with its end time in the short slot-time style', () => {
    const nowMs = SLOT * SLOT_MS + 40 * 60_000;
    const owner: OwnerState = { ...structuredClone(ownerFixture), processedSlotIndex: SLOT };
    const end = owner.currentActivity!.endsAtMs;
    expect(panel(owner, nowMs)).toMatch(statusLine(`In progress · ends ${slotTimeText(end, nowMs, '12')}`));
    // A later day says which: here the short weekday (two days ahead), where the fixed form gave the time alone.
    const later = nowMs + 2 * 86_400_000;
    const scheduled: OwnerState = { ...owner, currentActivity: { ...owner.currentActivity!, startsAtMs: nowMs + 60_000, endsAtMs: later } };
    expect(panel(scheduled, nowMs)).toMatch(statusLine(`Scheduled · ends ${slotTimeText(later, nowMs, '12')}`));
    expect(slotTimeText(later, nowMs, '12')).toMatch(/^\p{L}+ /u);
  });

  it('writes the end and the resting time in the 24-hour form when the clock setting asks for it', () => {
    pinDeviceClock('24');
    const nowMs = SLOT * SLOT_MS + 40 * 60_000;
    const owner: OwnerState = { ...structuredClone(ownerFixture), processedSlotIndex: SLOT };
    const end = owner.currentActivity!.endsAtMs;
    expect(slotTimeText(end, nowMs, '24')).toMatch(/^\d{2}:\d{2}$/);
    expect(panel(owner, nowMs)).toMatch(statusLine(`In progress · ends ${slotTimeText(end, nowMs, '24')}`));
    const resting: OwnerState = { ...structuredClone(ownerFixture), currentActivity: null, processedSlotIndex: SLOT, restingUntilSlot: SLOT + 1 };
    expect(panel(resting, nowMs)).toMatch(statusLine(`Resting at home: back on your schedule at ${slotTimeText((SLOT + 1) * SLOT_MS, nowMs, '24')}`));
    expect(text(panel(resting, nowMs))).not.toMatch(/\d\s?[AP]M\b/);
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
    const line = `Resting at home: back on your schedule at ${slotTimeText(boundary, nowMs, '12')}`;
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

  // Patch A item 6: while a Rest runs, the activity box says what it will give back when its slot ends.
  describe('the running Rest', () => {
    const nowMs = SLOT * SLOT_MS + 40 * 60_000;
    const resting = (stamina: number, label = 'Resting in camp'): OwnerState => {
      const owner = structuredClone(ownerFixture);
      return { ...owner, processedSlotIndex: SLOT, stamina: { current: stamina, maximum: 104 }, currentActivity: { ...owner.currentActivity!, kind: 'rest', label } };
    };
    const line = (html: string) => /data-testid="rest-gain"[^>]*>(.*?)<\/p>/.exec(html)?.[1].replace(/<[^>]+>/g, '');

    it('says what the running Rest will give', () => {
      expect(line(panel(resting(74), nowMs))).toBe('Stamina refills to 104 when it ends: +30');
      // The gain is the one thing in the line that is emphasised (the approved mockup's bold "+30").
      expect(panel(resting(74), nowMs)).toContain('<b>+30</b>');
      // A training owner renders no such line.
      expect(line(panel({ ...resting(74), currentActivity: { ...resting(74).currentActivity!, kind: 'training' } }, nowMs))).toBeUndefined();
      expect(text(panel(structuredClone(ownerFixture), nowMs))).not.toContain('Stamina refills');
    });

    it('says a full Rest adds nothing', () => {
      expect(line(panel(resting(104), nowMs))).toBe('Stamina is already full (104): this rest adds nothing');
    });

    it('says it too for the Rest a skipped activity became', () => {
      expect(line(panel(resting(12, 'Resting (not enough stamina)'), nowMs))).toBe('Stamina refills to 104 when it ends: +92');
    });

    it('gives no number while a pending build takes effect when the Rest ends', () => {
      const owner = resting(74);
      const build = { build: owner.currentBuild, effectiveSlotIndex: SLOT + 1, reservedMoney: 0, reservedItemIds: [], operationId: 'pending-op' };
      expect(line(panel({ ...owner, pendingBuild: build }, nowMs))).toBe('Stamina refills to full when it ends.');
      expect(line(panel({ ...owner, pendingBuild: { ...build, effectiveSlotIndex: SLOT + 2 } }, nowMs))).toBe('Stamina refills to 104 when it ends: +30');
    });

    it('says nothing about a Rest that is not running: scheduled, over, or at home with no activity', () => {
      const owner = resting(74), activity = owner.currentActivity!;
      // Scheduled: it has not started.
      expect(line(panel({ ...owner, currentActivity: { ...activity, startsAtMs: nowMs + 60_000, endsAtMs: nowMs + SLOT_MS } }, nowMs))).toBeUndefined();
      // Over: its slot has ended and its results are settled (completed), or still being settled (processing results).
      const later = (SLOT + 1) * SLOT_MS + 60_000;
      expect(line(panel({ ...owner, processedSlotIndex: SLOT + 1, currentActivity: { ...activity, status: 'completed' } }, later))).toBeUndefined();
      expect(line(panel(owner, later))).toBeUndefined();
      // Resting at home with no activity (Task 23.8) is not a Rest activity.
      expect(line(panel({ ...owner, currentActivity: null, restingUntilSlot: SLOT + 1 }, nowMs))).toBeUndefined();
    });
  });

  // Patch A item 4: between the class line and the activity box, a card names the class's bonuses and its suggested split.
  describe('the class card', () => {
    const nowMs = SLOT * SLOT_MS + 40 * 60_000;
    /** Where each of `parts` first appears after the one before it: -1 when one is missing, so a wrong order fails too. */
    const inOrder = (haystack: string, parts: string[]) => {
      let from = 0;
      return parts.map(part => { const at = haystack.indexOf(part, from); if (at >= 0) from = at + part.length; return at; });
    };

    /** The chips of the card itself (the build planner below it shows the same ones beside "Class: …"). */
    const chips = (html: string) => [...html.split('class="planning-form"')[0].matchAll(/data-testid="class-bonus"[^>]*>([^<]*)</g)].map(match => match[1]);

    it('shows the class bonuses and the suggested split under the class line', () => {
      const html = panel(structuredClone(ownerFixture), nowMs, SLOT, false, false); // a Guardian, as a player sees it (not the fixture preview)
      const words = text(html);
      const at = inOrder(words, ['Guardian · Level 1', 'GUARDIAN BONUSES', 'Vitality +5%', 'Endurance +5%',
        'From points and gear alike: more health and more stamina.', 'SUGGESTED SPLIT · OF EVERY 10 POINTS', 'Vitality 5', 'Strength 2', 'Endurance 2',
        'Precision 1', 'Agility 0', 'SUGGESTED SPLIT · OF EVERY 10', 'Vitality 5 · Strength 2 · Endurance 2 · Precision 1', 'CURRENT ACTIVITY']);
      expect(at.every(position => position >= 0), `positions ${at}`).toBe(true);
      // The bars' numbers, in order (largest share first, ties in attribute order, zeros kept), each in its own element.
      const numbers = [...html.matchAll(/data-testid="split-points"[^>]*>(\d+)</g)].map(match => Number(match[1]));
      expect(numbers).toEqual([5, 2, 2, 1, 0]);
      expect(chips(html)).toEqual(['Vitality +5%', 'Endurance +5%']);
      // The phone's one line leaves the zero out, and says nothing of Agility.
      expect(/Vitality <b>5<\/b> · Strength <b>2<\/b> · Endurance <b>2<\/b> · Precision <b>1<\/b>/.test(html)).toBe(true);
      expect(words).not.toContain('Agility 0 ·');
    });

    it('names the card after the class, and takes the chips and the meaning from it', () => {
      const duelist = structuredClone(ownerFixture);
      duelist.currentBuild = { ...duelist.currentBuild, classId: 'duelist' };
      const words = text(panel(duelist, nowMs, SLOT, false, false));
      expect(inOrder(words, ['DUELIST BONUSES', 'Agility +5%', 'Precision +5%', 'From points and gear alike: faster, and hits more often.',
        'Agility 4', 'Precision 4', 'Strength 2', 'Vitality 0', 'Endurance 0', 'Agility 4 · Precision 4 · Strength 2', 'CURRENT ACTIVITY']).every(position => position >= 0)).toBe(true);
      const berserker = structuredClone(ownerFixture);
      berserker.currentBuild = { ...berserker.currentBuild, classId: 'berserker' };
      const strong = text(panel(berserker, nowMs, SLOT, false, false));
      expect(strong).toContain('BERSERKER BONUSES Strength +10%');
      expect(chips(panel(berserker, nowMs, SLOT, false, false))).toEqual(['Strength +10%']);
      expect(strong).toContain('From points and gear alike: every hit lands harder.');
      // Not a visitor's or a stranger's view: the card is the owner's panel, so a panel with no gladiator has none.
      const joining = renderToStaticMarkup(createElement(CharacterPanel, {
        viewer: 'visitor', session: { status: 'signed-out', userId: null, expiresAtMs: null }, owner: null, ownerError: null, slotIndex: null, clock: createDisplayClock(),
        gateway: {} as GameGateway, fixture: false, previewFailed: false, refreshOwner: async () => {}, onCreate: noop,
      }));
      expect(text(joining)).not.toContain('BONUSES');
    });

    it('shows the card in the fixture preview too, above its sample activity', () => {
      expect(inOrder(text(panel(structuredClone(ownerFixture), nowMs)), ['GUARDIAN BONUSES', 'Vitality +5%', 'SAMPLE ACTIVITY']).every(position => position >= 0)).toBe(true);
    });

    it('shows the card while the last loaded details are kept after a failed refresh', () => {
      const clock = createDisplayClock();
      clock.freeze(nowMs);
      const html = renderToStaticMarkup(createElement(CharacterPanel, {
        viewer: 'player', session: { status: 'signed-in', userId: 'account', expiresAtMs: null }, owner: structuredClone(ownerFixture), ownerError: 'unavailable',
        slotIndex: SLOT, clock, gateway: {} as GameGateway, fixture: false, previewFailed: false, refreshOwner: async () => {}, onCreate: noop,
      }));
      expect(inOrder(text(html), ['could not be refreshed', 'GUARDIAN BONUSES', 'CURRENT ACTIVITY']).every(position => position >= 0)).toBe(true);
    });
  });

  // Patch A item 4, "Plan a build": the same chips beside the class, and the Suggested button only while points are left.
  describe('the build planner', () => {
    const nowMs = SLOT * SLOT_MS + 40 * 60_000;
    const planner = (earned: number) => {
      const owner = structuredClone(ownerFixture);
      owner.progression = { ...owner.progression, earnedAttributePoints: earned };
      const clock = createDisplayClock();
      clock.freeze(nowMs);
      return renderToStaticMarkup(createElement(CharacterPanel, {
        viewer: 'player', session: { status: 'signed-in', userId: 'account', expiresAtMs: null }, owner, ownerError: null, slotIndex: SLOT, clock,
        gateway: {} as GameGateway, fixture: false, previewFailed: false, refreshOwner: async () => {}, onCreate: noop,
      }));
    };

    it('puts the class bonuses beside the class, and offers Suggested while points are left', () => {
      const html = planner(13);
      const form = html.slice(html.indexOf('class="planning-form"'));
      expect(text(form)).toMatch(/Class: Guardian\s+Vitality \+5%\s+Endurance \+5%/);
      expect(text(form)).toContain('3 of 13 left Suggested for Guardian');
      expect(form).toMatch(/<button[^>]*type="button"[^>]*>Suggested for Guardian<\/button>/);
    });

    it('has no Suggested button with no points left', () => {
      const html = planner(10);
      expect(text(html)).toContain('All 10 spent');
      expect(text(html)).not.toContain('Suggested for');
    });
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
