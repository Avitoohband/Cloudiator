import type { PatchEntry } from '../../src/lib/patch.ts';

/**
 * The patches M26 seeds (supabase/sql/19-patches.sql), newest first, as `readPatches` reads them from a replayed local database: no
 * patch note is linked there (production links notes 1-4 by their titles). The titles and features are docs/CHANGELOG.md's released
 * sections word for word (tests/domain/patch.test.ts compares them).
 */
export const SEED_PATCHES: readonly PatchEntry[] = [
  { number: '1.3.1', sortKey: 1_003_001, title: 'Phone attribute points', releasedAtMs: 1793295600000, messageId: null, features: [
    'Each attribute has +1 and +5 buttons when you create a gladiator or plan a build, on their own line on a phone.',
    'Tap a points number and type: what you type replaces it. A number above what you have left is corrected when you leave the box, and the game says why.',
    'The build step has no minus: points in a build that has taken effect are permanent. A gray Respec button says it is coming later as a paid option.',
  ] },
  { number: '1.3', sortKey: 1_003_000, title: 'Messages, gold, fixed builds and bigger beds', releasedAtMs: 1793263477000, messageId: null, features: [
    'Messages: a button beside your name, with a count, where patch notes and news from the game arrive.',
    'Notifications: what your training, expeditions, Arena fights and tournaments earned, with XP, level-ups, gear and gold.',
    "Change your gladiator's look from the look patch note, free and as often as you like for now.",
    'Money is now called gold everywhere. Your amount is unchanged.',
    'When you level up, the build shows how many points are left. Saved points and your class are fixed; your stance can still change.',
    'The beds in the camp are bigger, so a gladiator fits on one. Punchy asked for it.',
  ] },
  { number: '1.2.1', sortKey: 1_002_001, title: 'Clearer busy buttons', releasedAtMs: 1793115007000, messageId: null, features: [
    'While a build, market, inventory or shop button sends its command, it dims and keeps the keyboard focus, and pressing it again does nothing.',
  ] },
  { number: '1.2', sortKey: 1_002_000, title: "Choose your gladiator's look", releasedAtMs: 1793095651000, messageId: null, features: [
    'Choose a look when you create a gladiator: a male or female body; short, long, ponytail or bald hair; skin, hair and clothes colours; a Random look and a live preview.',
    'Every gladiator is drawn in its own look in the camp, on expeditions and in replays. Gladiators made before keep the original look.',
    'A build the server refuses says why and reloads your gear, and the schedule drops an old saved note when the day changes in the background.',
  ] },
  { number: '1.1', sortKey: 1_001_000, title: 'Evening Arena, waiting monsters, clearer menus', releasedAtMs: 1793006949000, messageId: null, features: [
    'Arena runs in the evening part of the day only. Wednesday and Saturday tournaments start in the evening too, at 18:40 UTC.',
    'Plan the whole day and save it once. The schedule says which part is running now.',
    'Market sales pay a fee of at least 1 gold, and the lowest price is 2 gold.',
    "Character creation says how many points are left and each attribute's cap.",
    'My gladiator shows the gear you wear, and the inventory swaps it with Wear. A shield comes back when a one-handed weapon replaces a two-handed one.',
    'On an expedition, each monster waits at its spot, named over its head, until its fight.',
  ] },
  { number: '1.0', sortKey: 1_000_000, title: 'Public launch', releasedAtMs: 1792920000000, messageId: null, features: [
    'Sign in with Google and create one gladiator: a name, a class (Berserker, Guardian or Duelist) and starting attribute points.',
    'A shared camp where every gladiator lives out its day, with a camera you can move, on a desktop or a phone. Visitors can watch without signing in.',
    'A day of three 80-minute parts (morning, afternoon and evening) that repeats until you change it: Training, Expedition, Arena or Rest.',
    'Stamina: each activity spends it, a Rest refills it, and a part you cannot afford becomes a Rest.',
    'Training earns attribute points for your build: five attributes, a fighting stance and gear in five slots.',
    'Expeditions to the Woodland Path, the Ruined Outpost and the Mountain Pass earn XP, levels, gold and gear. Watch a trip live and replay its fights.',
    'Automatic Arena fights in strength leagues, with a rating, renown and a replay of every bout.',
    'Tournaments on Wednesdays and Saturdays, and four-week seasons with prestige awards.',
    'Shops, a player market at fixed prices, and an inventory.',
    "Results, the Gladiators list and every gladiator's profile.",
  ] },
];

/**
 * Patch 1.4 as the preview and the browser tests show it: an illustrative row (1.4 is recorded at its release, with its CHANGELOG.md
 * section as it stands then), dated 30 Oct 2026 at noon UTC.
 */
export const PATCH_1_4: PatchEntry = { number: '1.4', sortKey: 1_004_000, title: 'Watch your expedition, class bonuses and a clock setting',
  releasedAtMs: Date.UTC(2026, 9, 30, 12), messageId: null, features: [
    'Watch your expedition: while your gladiator is away, a button at the bottom of the camp shows where it is and opens the live view.',
    'My gladiator shows your class\'s bonuses and its suggested split of points.',
    'Clock: choose a 12-hour or 24-hour clock in the menu under your name. Every time in the game follows it on this device.',
    'Patch numbers: the menu under your name shows the patch you are playing, each patch note shows its number, and Patch history lists what every patch added.',
  ] };

/** The list with each named patch linked to its note (`{ '1.3': 3 }`), as production links notes 1-4 to 1.1, 1.2, 1.3 and 1.3.1. */
export const linkNotes = (patches: readonly PatchEntry[], notes: Readonly<Record<string, number>>): PatchEntry[] =>
  patches.map(p => ({ ...p, features: [...p.features], messageId: Object.hasOwn(notes, p.number) ? notes[p.number] : p.messageId }));
