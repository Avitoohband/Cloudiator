// Patch 1.9, Task 11: talking camp NPCs (Avi approved the mockup and the 56 lines, 2026-11-11). A click on an NPC shows its
// next line in a pixel speech bubble over its head: its name, the line and four dots for which of its four lines it is. The
// next click shows the next line, cycling; each NPC keeps its own place. One bubble at a time; it follows the NPC as it walks
// its round and fades after 4 to 6 s (longer lines stay longer), on a click elsewhere or on Escape. The lines are fixed text,
// the same for everyone: nothing is read or saved, and talking never affects progress.

/** Each NPC round's four lines (`npcId` of src/game/npcs.ts), as approved. The two Gate Guards have their own. */
export const NPC_LINES: Readonly<Record<string, readonly [string, string, string, string]>> = {
  smith: [
    "Name's Brutus. Every blade in this camp came off my anvil.",
    'Livia makes the armor. I make the reason you need it.',
    'A good sword is like a good friend: sharp, loyal, oiled weekly.',
    'Bring me your salvage. Even a bent nail dreams of being a sword.',
  ],
  armorer: [
    "I'm Livia. Brutus makes holes; I make sure they're not in you.",
    'Heavy armor saves your skin and eats your stamina. Choose well.',
    'Every dent tells a story. Please, bring me shorter stories.',
    'A helmet that fits beats two that look good. Try it on.',
  ],
  trainer: [
    'I am Cassius. In this yard you call me Doctore.',
    'Sweat in the yard so you bleed less in the Arena.',
    "Two trainings a day. Try a third and you'll nap on the dummy.",
    "Train four hundred times and you'll earn my title. Then we spar.",
  ],
  cook: [
    "They call me Old Marta. I've stirred this pot since before you.",
    "Stew again? It's a different stew. Mostly.",
    'Eat, rest, then fight. Never the other way round.',
    'Sister Iona patches you up. I fill you up. Same job, really.',
  ],
  healer: [
    "I'm Sister Iona. Bring me your bruises, not your excuses.",
    'Rest is medicine too, and the cheapest kind in camp.',
    "Marta's stew heals more than my salves. Don't tell her.",
    'Everyone limps on their first day. Even Doctore did.',
  ],
  guard: [
    'Gate Guard. I see everyone who walks in. Welcome, by the way.',
    'New faces every day. I try to remember them all.',
    'My round goes behind the tower. Best shade in the whole camp.',
    'Quiet day. I like quiet days. Quiet days have no trolls.',
  ],
  'guard-south': [
    'South post. I guard the torch, and the torch guards me.',
    'Off on an expedition? Wave on your way out. I always wave back.',
    "I've counted the planks in this gate. Twice. Still thirty-one.",
    'Come home with your shield or come home limping. Just come home.',
  ],
  lookout: [
    'Tower lookout. From up there you all look like brave ants.',
    'On a clear day I can see all the way to the Mountain Pass.',
    "Nothing to report. That's the best report there is.",
    'The stairs are my real enemy. I beat them every single shift.',
  ],
  'patrol-north': [
    'North wall patrol. End to end, then back again. All day long.',
    'At dusk I take a torch and join the night watch. Same boots.',
    'I know every tree past the fence by name. Mostly Pine.',
    "Sore feet, open eyes. That's the whole job.",
  ],
  'patrol-south': [
    'South wall patrol. The kitchen side. Best-smelling wall in camp.',
    'When the torches light, I keep the wolves on the other side.',
    'Marta saves me a bowl at the end of my round. Best part.',
    'If you hear a twig snap, that was me. Probably.',
  ],
  'water-carrier': [
    "I'm Petra. Every drop you drank today came from my buckets.",
    'Well, training yard, gate, and back. My buckets never rest.',
    "Thirsty gladiators swing slow. So really, I'm your coach.",
    'Splash me and I splash back. Fair warning.',
  ],
  herald: [
    'Felix, herald of the camp! My voice reaches the far wall.',
    'Hear ye! The Arena fights in the evening. Bring your best!',
    'I announce winners loudly and losers kindly. House rule.',
    'Tournament days are my favorite. So many names to shout!',
  ],
  porter: [
    'Quintus, porter. If it came through the gate, I carried it.',
    'Crates for the stalls, sacks for the kitchen. Then more crates.',
    "My shoulders are stronger than half the Arena. Don't tell them.",
    'This crate? Swords for Brutus. Or soup for Marta. One of those.',
  ],
  forester: [
    "I'm Silva. I tend the woods in all four corners of the camp.",
    'I only cut what the forest can spare. The trees and I agree.',
    'My axe is for wood only. Training dummies, stay nervous.',
    "Big plans for these clearings, I hear. I'll keep them tidy.",
  ],
};

/** The bubble's fade-out once its time is up (the CSS transition is as long). */
export const TALK_FADE_MS = 400;
/** The tail under the bubble, from its bottom edge to the name or head it points at (CSS px). */
export const TALK_TAIL_PX = 8;

/** How long a line stays before it fades: 2 s plus 0.3 s a word, 4 to 6 s. */
export function talkHoldMs(line: string): number {
  const words = line.trim().split(/\s+/).filter(Boolean).length;
  return Math.min(6000, Math.max(4000, 2000 + 300 * words));
}

/** Which line each NPC says next: its first on the first click, then one further per click, cycling. */
export class TalkLines {
  private readonly said = new Map<string, number>();

  /** The index of `npcId`'s next line, and moves its place on. */
  next(npcId: string): number {
    const count = (NPC_LINES[npcId]?.length ?? 4) || 4;
    const index = ((this.said.get(npcId) ?? -1) + 1) % count;
    this.said.set(npcId, index);
    return index;
  }
}

/** Where the NPC is drawn, in the view's CSS px: its x, the top of its name (or head) and its feet. */
export type TalkAnchor = { x: number; top: number; feet: number };
export type TalkPlace = { left: number; top: number; below: boolean; tail: number };

/** How far the bubble keeps from each edge of the view (CSS px): the bar along the top, a pinned menu rail at a side or the bottom. */
export type TalkMargin = { top: number; left: number; right: number; bottom: number };

/**
 * The bubble's top-left corner: centred over the name or head with its tail pointing at the NPC, kept inside the view's
 * margins at the sides; under the feet when it would reach into the top margin, and never into the bottom one (it rests
 * above a bottom menu bar). `tail` is the tail's left edge inside the bubble.
 */
export function placeTalkBubble(anchor: TalkAnchor, size: { width: number; height: number }, view: { width: number; height: number },
  margin: TalkMargin): TalkPlace {
  const left = Math.max(margin.left, Math.min(anchor.x - size.width / 2, view.width - margin.right - size.width));
  let top = anchor.top - TALK_TAIL_PX - size.height;
  let below = false;
  if (top < margin.top) { top = anchor.feet + 10; below = true; }
  top = Math.max(margin.top, Math.min(top, view.height - margin.bottom - size.height));
  const tail = Math.max(6, Math.min(anchor.x - left - 7, size.width - 20));
  return { left, top, below, tail };
}
