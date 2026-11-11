// Patch 1.9, Task 11: talking camp NPCs. Each of the 14 NPC rounds has the four lines Avi approved (2026-11-11, in the
// order he approved them); a click shows the NPC's next line, cycling; the bubble holds for 4 to 6 s (longer lines longer)
// and sits over the NPC's head, inside the view.
import { describe, expect, it } from 'vitest';
import { NPC_ROUTINES } from '@/game/npcs';
import { NPC_LINES, TALK_FADE_MS, TalkLines, placeTalkBubble, talkHoldMs } from '@/game/npc-talk';

describe('the NPC lines', () => {
  it('give every NPC round four lines, 56 in all, each under 70 characters', () => {
    expect(Object.keys(NPC_LINES).sort()).toEqual(NPC_ROUTINES.map(r => r.npcId).sort());
    const all = Object.values(NPC_LINES).flat();
    expect(all).toHaveLength(56);
    for (const [id, lines] of Object.entries(NPC_LINES)) {
      expect(lines, id).toHaveLength(4);
      for (const line of lines) expect(line.length, line).toBeLessThan(70);
    }
    expect(new Set(all).size).toBe(56);
  });

  it('are the approved words, in order', () => {
    expect(NPC_LINES.trainer).toEqual([
      'I am Cassius. In this yard you call me Doctore.',
      'Sweat in the yard so you bleed less in the Arena.',
      "Two trainings a day. Try a third and you'll nap on the dummy.",
      "Train four hundred times and you'll earn my title. Then we spar.",
    ]);
    expect(NPC_LINES.smith[0]).toBe("Name's Brutus. Every blade in this camp came off my anvil.");
    expect(NPC_LINES.armorer[3]).toBe('A helmet that fits beats two that look good. Try it on.');
    expect(NPC_LINES.guard[0]).toBe('Gate Guard. I see everyone who walks in. Welcome, by the way.');
    expect(NPC_LINES['guard-south'][0]).toBe('South post. I guard the torch, and the torch guards me.');
    expect(NPC_LINES['patrol-north'][2]).toBe('I know every tree past the fence by name. Mostly Pine.');
    expect(NPC_LINES.herald[1]).toBe('Hear ye! The Arena fights in the evening. Bring your best!');
    expect(NPC_LINES.forester[3]).toBe("Big plans for these clearings, I hear. I'll keep them tidy.");
  });
});

describe('talking to an NPC', () => {
  it('starts each NPC on its first line and moves on one line per click, cycling through the four', () => {
    const talk = new TalkLines();
    expect([0, 1, 2, 3, 4, 5].map(() => talk.next('trainer'))).toEqual([0, 1, 2, 3, 0, 1]);
  });

  it('keeps each NPC\'s own place: another NPC in between does not move it', () => {
    const talk = new TalkLines();
    expect(talk.next('smith')).toBe(0);
    expect(talk.next('armorer')).toBe(0);
    expect(talk.next('armorer')).toBe(1);
    expect(talk.next('smith')).toBe(1);
    // The two Gate Guards are two NPCs.
    expect(talk.next('guard')).toBe(0);
    expect(talk.next('guard-south')).toBe(0);
  });

  it('holds a line 4 to 6 s, longer lines longer, then fades in 0.4 s', () => {
    expect(TALK_FADE_MS).toBe(400);
    const all = Object.values(NPC_LINES).flat();
    for (const line of all) {
      expect(talkHoldMs(line), line).toBeGreaterThanOrEqual(4000);
      expect(talkHoldMs(line), line).toBeLessThanOrEqual(6000);
    }
    expect(talkHoldMs('Short and sweet.')).toBe(4000);
    expect(talkHoldMs(NPC_LINES.smith[3])).toBeGreaterThan(talkHoldMs(NPC_LINES['patrol-north'][3]));
    expect(talkHoldMs('one '.repeat(40))).toBe(6000);
  });
});

describe('where the bubble sits', () => {
  const view = { width: 1280, height: 800 };
  const margin = { top: 60, left: 8, right: 8, bottom: 8 };
  const size = { width: 200, height: 60 };

  it('centres over the head, its tail at the NPC, 8 px clear of the name or head', () => {
    const at = placeTalkBubble({ x: 400, top: 300, feet: 350 }, size, view, margin);
    expect(at).toEqual({ left: 300, top: 300 - 8 - 60, below: false, tail: 93 });
  });

  it('stays inside the view at the sides, the tail still pointing at the NPC', () => {
    const left = placeTalkBubble({ x: 20, top: 300, feet: 350 }, size, view, margin);
    expect(left.left).toBe(8);
    expect(left.tail).toBe(6);
    const right = placeTalkBubble({ x: 1275, top: 300, feet: 350 }, size, view, margin);
    expect(right.left).toBe(1280 - 8 - 200);
    expect(right.tail).toBe(200 - 20);
  });

  it('goes under the feet when there is no room above, clear of the top bar', () => {
    const at = placeTalkBubble({ x: 400, top: 100, feet: 150 }, size, view, margin);
    expect(at).toMatchObject({ top: 160, below: true });
  });

  it('keeps clear of a pinned rail at the left or right edge, the tail still at the NPC where it can', () => {
    const leftRail = placeTalkBubble({ x: 40, top: 300, feet: 350 }, size, view, { ...margin, left: 72 });
    expect(leftRail.left).toBe(72);
    expect(leftRail.tail).toBe(6);
    const near = placeTalkBubble({ x: 200, top: 300, feet: 350 }, size, view, { ...margin, left: 72 });
    expect(near).toMatchObject({ left: 100, tail: 93 });
    const rightRail = placeTalkBubble({ x: 1250, top: 300, feet: 350 }, size, view, { ...margin, right: 72 });
    expect(rightRail.left).toBe(1280 - 72 - 200);
  });

  it('rests above a bottom menu bar when the NPC stands behind it', () => {
    const at = placeTalkBubble({ x: 400, top: 760, feet: 790 }, size, view, { ...margin, bottom: 72 });
    expect(at.top + size.height).toBe(800 - 72);
    expect(at.below).toBe(false);
    // Clear of the bar, nothing moves.
    expect(placeTalkBubble({ x: 400, top: 500, feet: 550 }, size, view, { ...margin, bottom: 72 }).top).toBe(500 - 8 - 60);
  });
});
