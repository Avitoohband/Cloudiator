# Cloudiator roadmap

Updated 2026-11-07. Production is **1.7.1**. **1.8** is the next patch in planning. The later items are grouped by area. They have no assigned patch number unless stated.

## Patch overview

| Patch | Status | Player changes |
| --- | --- | --- |
| 1.0 | Live | Shared pixel-art camp, Google sign-in, repeating schedules, expeditions, Arena, tournaments, shops and player marketplace. |
| 1.1 | Live | Evening Arena, save the whole day at once, clearer creation and gear controls, and monsters visible before fights. |
| 1.2 / 1.2.1 | Live | Character appearance customization, clearer build errors, and protection against double submissions. |
| 1.3 / 1.3.1 | Live | Messages and reward notifications, a free look change, the gold naming change, bigger beds, and easier attribute entry on phones. |
| 1.4 | Live | Live expedition tracking and whole-trip replays, richer profiles, new arrival banners, build suggestions, clock settings, and patch history. |
| 1.5 | Live | My Bouts, replay speed and controls, spoiler-free playback, Next Bout, and replay links from camp, Arena, and Notifications. |
| 1.5.1 | Live | More guards, torch-carrying night patrols, and four new camp NPCs. |
| 1.6 | Live | Lower expedition rewards and gear drop rates, salvage at 4 gold, prizes by league, free entry to qualifying tournaments, and profile banners. A third actual Training in one game day becomes Rest, with a warning before saving. The one-time gold switch went live after notice and approval, reducing spendable gold to about a quarter while preserving held fees. |
| 1.7 | Live | 31 wearable titles, including Founder. Past achievements count, and players can see their title progress and equip a title. |
| 1.7.1 | Live | Hand-given Game Master and High Ground titles, visible in the picker for holders. |
| 1.8 | In planning | Party dungeons, hired fighters and the Ludus Nimbus bot team, live viewing, dungeon replays, and four dungeon titles. |

Release details and dates are in the [changelog](CHANGELOG.md).

## Next release

- **1.8 — Party dungeons.** Wolf Den at level 3, Raider Stronghold at 7, and Troll Hall at 12. Up to three fighters enter for the afternoon, face three rooms and a boss, and keep the rewards from the won fights they entered even if they lose to the boss. Dungeon entry costs 40 base stamina. Avi approved v2 room and boss payouts and a 30% boss chest gear chance.
- **1.8 — Ludus Nimbus.** Five named fighters marked BOT. Human players take dungeon seats first, then eligible bots, then hired fighters. Bots enter unranked Arena and stay out of tournaments.
- **1.8 — Watch and collect.** Watch a dungeon live, replay the whole run or individual fights, and see personal rewards in Results and Notifications. Earn Den Breaker, Warlord’s End, Kingslayer, and Dungeoneer.
- **1.8 — Review and trailer.** Clickable UI review on real app screenshots, then implementation and release checks. Make the grandiose trailer-style patch video before shipping. [Dungeon plan](superpowers/plans/2026-10-29-party-dungeons.md) and [design](superpowers/specs/2026-10-29-party-dungeons-design.md).

## Later patches and ideas

### Inventory, equipment, and menus

- Square inventory grid with recognizable pixel-art item icons for swords, spears, shields, armor, and other gear. Reuse item icons in shops and show worn gear in equipment slots.
- Show item attributes while hovering over a weapon or armor in My Gladiator, including while switching gear. Design equivalent keyboard focus and mobile tap behavior, and show item weight and load impact.
- Wider menus with adjustable desktop widths and small previous/next arrows between named sections. Keep the controls usable on phones. Let players pin the menu and choose its screen edge, saved per device.
- Split character creation into Look, Class, and Attributes steps with Back and Next.
- Show the quantity already owned beside shop and market items. Design when a purchase can be undone.
- Add renown skins and dyes for clothing and weapons, plus an appearance-change option in the menu.

### Combat, gear, and progression

- Cap character level at **20** and the total base attribute budget across all five stats at **100**. Add gear and class bonuses above that budget. Give each existing character one free optional attribute respec with the cap patch. Plan an in-game message with class and attribute guidance and a companion video. The current v2 Training formula would allow 90 at level 20, so the path to the cap and treatment of existing characters need design.
- Add weapons, armor, attribute requirements, stat bonuses, and set effects. Compare item weights, load and overload, and the relative power of bonuses across complete builds. Give two-handed weapons a useful advantage over one-handed weapon plus shield builds.
- Upgrade weapons at a forge with salvage and materials such as copper, bronze, iron, gold, and platinum from expeditions and other agreed sources. Design ranks, recipes, and trading.
- Show hit, dodge, critical chance, and critical damage from the actual combat rules. Explain stats, class bonuses, stamina, Rest, Training, and combat in an in-game guide with explainer and patch-video links.
- Add elemental damage and resistance for PvE. Compare PvE sets and role builds with PvP matchups before deciding which bonuses apply in the Arena.
- Explore difficult quests that improve class bonuses, and future classes including a summoner with spirits or animal spirits.
- Design a play rule for High Ground. Avi asked to close Founder eligibility after 1.7. The live rule uses the Season 1 cutoff, and the intended replacement cutoff still needs a decision.

### Expeditions, roles, and strategy

- Show the XP progress bar and the XP each expedition pays.
- Add higher expeditions around levels 12, 15, 18, and 20 with higher upgrade materials. Explore especially hard level-15 and level-20 party expeditions.
- Design distinct PvE builds and party roles, with a separate way for roles to earn levels.
- Add **The Deep**, a weekly solo delve from level 15 after party dungeons. Explore separate endgame runs that last a full game day or longer, with several stages, mini-bosses, a final boss, and larger prizes.
- Explore PvE followers that help in expeditions or dungeons, health and stamina potions, guilds, raids, and tradable raid items. Cosmetic paid pets are a separate feature.
- Plan several days ahead and repeat multi-day rotations for Training, Rest, and other activities.

### Camp, social, and events

- **Friends — Standalone after 1.6, number open.** Friends list and friend requests.
- **Dungeon parties — After 1.8 (M32).** Invite chosen teammates for a specific dungeon run and see planned dungeon choices
  within the party. Eligible players who accept stay together for that run. Players without a party still group automatically.
  Saving a lineup for reuse is open.
- Expand the camp after 1.8. Reserve plots for future facilities, add housing, decorations and achievements, and add more NPCs and guards. Include the Champ, a former Arena champion, and clickable or tappable NPC detail cards.
- Add pettable cats, dogs, rabbits, and birds. The first paid release is planned to offer a one-time Supporter Banner and an optional cosmetic pet follower. Both are account-bound cosmetics. Founder remains a separate title. [PayPal sandbox plan](superpowers/plans/2026-11-08-cosmetic-payments-paypal-sandbox.md).
- Add paid weapon and armor dyes and skins after the first cosmetic shop release. These change equipment appearance only.
- Run timed events and seasonal camp themes such as Halloween and Christmas. Explore a world tournament with a statue for the winner.
- Add a small group of townsfolk behind the Arena spectators every evening, with a different arrangement each game day. [Evening Arena crowd preview plan](superpowers/specs/2026-11-08-evening-arena-crowd-design.md).
- Add live Arena and tournament spectating with text commentary. Check the feasibility of a 24/7 YouTube stream.
- Add music and sound effects with independent volume and mute controls, remembered per device.
- Add in-game player support with request categories and triage.

## Planning sources

- The [original ideas log](superpowers/specs/2026-10-29-next-patch-ideas.md) contains the earlier requests. Later entries were preserved on `claude/task-24` at `2d9d5c3` and `codex/future-patch-ideas-20261102` at `39c153b`. This roadmap brings them together by topic and includes the 2026-11-07 requests.
- The [feature index](FEATURES.md) tracks player features, and the [handoff](implementation/HANDOFF.md) records implementation and release status.
