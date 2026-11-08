export const BOT_KITS = [
  ['tullia', 'Tullia', 12, 'guardian', 'defensive', 'guard', [10, 0, 18, 7, 3], 38, 58,
    ['sword:10:common', 'round-shield:10:common', 'iron-helmet:10:common', 'light-armor:10:common', 'light-boots:10:common'], 84, 39, 115, 'silver'],
  ['grit', 'Grit', 7, 'berserker', 'offensive', 'striker', [13, 2, 7, 0, 3], 25, 38,
    ['axe:5:common', null, 'leather-hood:5:common', 'light-armor:5:common', 'light-boots:5:common'], 46.28, 23, 100, 'bronze'],
  ['ash', 'Cinder', 7, 'duelist', 'balanced', 'skirmisher', [5, 9, 2, 0, 9], 25, 38,
    ['sword:5:common', null, 'leather-hood:5:common', 'light-armor:5:common', 'light-boots:5:common'], 48, 23, 100, 'bronze'],
  ['rufus', 'Rufus', 4, 'guardian', 'defensive', 'guard', [4, 0, 7, 2, 1], 14, 26,
    ['sword:1:common', 'round-shield:1:common', 'iron-helmet:1:common', 'light-armor:1:common', 'light-boots:1:common'], 42, 14, 104, 'bronze'],
  ['pip', 'Pip', 3, 'duelist', 'balanced', 'skirmisher', [3, 5, 1, 0, 5], 14, 22,
    ['sword:1:common', null, 'leather-hood:1:common', 'light-armor:1:common', 'light-boots:1:common'], 32, 11, 100, 'bronze'],
] as const;

export const BOT_ITEM_SLOTS = ['weapon', 'offHand', 'head', 'body', 'feet'] as const;
export const BOT_KEYS = BOT_KITS.map(kit => kit[0]);
export const BOT_CATALOG_ORACLE = Object.fromEntries(BOT_KITS.map(
  ([key, name, level, classId, stance, role, [strength, agility, vitality, endurance, precision], earnedPoints, ,
    [weapon, offHand, head, body, feet], peakStrength, leagueIndex, staminaMaximum, league]) =>
    [key, { key, name, level, classId, stance, role, allocation: { strength, agility, vitality, endurance, precision },
      equipment: { weapon, offHand, head, body, feet }, earnedPoints, peakStrength, leagueIndex, staminaMaximum, league }],
));

// Independent literal weekdays, Monday through Sunday. Each cell lists the two Bronze Arena candidates.
const eveningPairs = [
  ['grit rufus', 'rufus ash', 'ash pip', 'pip grit'],
  ['rufus ash', 'ash pip', 'pip grit', 'grit rufus'],
  ['ash pip', 'pip grit', 'grit rufus', 'rufus ash'],
  ['pip grit', 'grit rufus', 'rufus ash', 'ash pip'],
  ['grit rufus', 'rufus ash', 'ash pip', 'pip grit'],
  ['rufus ash', 'ash pip', 'pip grit', 'grit rufus'],
  ['ash pip', 'pip grit', 'grit rufus', 'rufus ash'],
];
export const BOT_ROUTINE_ORACLE = Object.fromEntries(BOT_KEYS.map(key => [key, eveningPairs.flatMap(day => [
  'off-duty', 'off-duty', 'off-duty', 'off-duty', 'off-duty', 'off-duty',
  ...day.flatMap(pair => ['rest', 'on-call', key === 'tullia' || pair.split(' ').includes(key) ? 'arena' : 'training']),
])]));
