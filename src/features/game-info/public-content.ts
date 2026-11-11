export const wikiTopics = [
  { id: 'schedule', title: 'Daily schedule', text: 'Plan an activity for morning, afternoon and evening. Your schedule repeats until you change it.' },
  { id: 'stamina', title: 'Stamina and Rest', text: 'Activities use stamina, and Rest restores it. An overloaded gladiator uses more stamina, so check your equipment before you go.' },
  { id: 'training', title: 'Training', text: 'Training earns attribute points up to your level’s Training cap. Schedule up to two training sessions per game day. A third becomes Rest.' },
  { id: 'combat', title: 'Combat', text: 'Precision helps you hit, while the defender’s Agility makes them harder to hit. Precision also increases the chance that a landed attack deals critical damage.' },
  { id: 'attributes', title: 'Attributes', text: 'Strength raises damage. Agility helps you attack faster and avoid hits. Vitality raises health. Endurance improves stamina and gear capacity. Precision improves hit and critical chance.' },
  { id: 'arena', title: 'Arena', text: 'Schedule Arena in the evening. Rated bouts can change your rating and earn renown. NPC and Ludus Nimbus bouts are unranked.' },
  { id: 'dungeons', title: 'Dungeons', text: 'Enter in the afternoon with up to three fighters. Wolf Den opens first, followed by Raider Stronghold and Troll Hall. You keep the rewards from fights your party wins while you take part.' },
] as const;

export const futureUpdates = [
  { title: 'Dungeon party invitations', text: 'Invite chosen teammates for a specific dungeon run.' },
  { title: 'Friends', text: 'Send friend requests and keep a friends list.' },
  { title: 'Inventory item art', text: 'Recognize swords, armor and other gear by their pixel art in a grid.' },
  { title: 'Seasonal camp themes', text: 'Look for timed events and seasonal decorations around camp.' },
] as const;
