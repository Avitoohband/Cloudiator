# Cloudiator roadmap

Updated 2026-11-11. Production is **1.8.1**. Patches 1.9 to 1.11 follow Avi's 2026-11-11 decisions. The later items are grouped by area. They have no assigned patch number unless stated.

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
| 1.8 | Live | Party dungeons, hired fighters and the Ludus Nimbus bot team, live viewing, dungeon replays, and four dungeon titles. |
| 1.8.1 | Live | Clearer attack speed label and help for gladiator stats and attributes. |
| 1.9 | In progress, not released (client only) | Game Info with Wiki and Future Updates, a square pixel-art inventory, shops as an icon grid, search and sort, stacked duplicates with Sell quantity, equip from My gladiator, a gold laurel renown icon, XP bar, stat help, Mark as read, menu pin, name and title toggles, and talking NPCs. |
| 1.10 | Planned (economy and balance, server) | Salvage, buy back, daily login reward, stamina and health potions, much harder dungeon bosses, and the forge. |
| 1.11 | Planned (content) | Expeditions at levels 15, 20, 25 and 30, dungeons at 17, 22 and 27, gear tiers 15-30, and much more content. |

Release details and dates are in the [changelog](CHANGELOG.md).

## Patch 1.8 details

- **1.8 — Party dungeons.** Wolf Den at level 3, Raider Stronghold at 7, and Troll Hall at 12. Up to three fighters enter for the afternoon, face three rooms and a boss, and keep the rewards from the won fights they entered even if they lose to the boss. Dungeon entry costs 40 base stamina. Avi approved v2 room and boss payouts and a 30% boss chest gear chance.
- **1.8 — Ludus Nimbus.** Five named fighters marked BOT. Human players take dungeon seats first, then eligible bots, then hired fighters. Bots enter unranked Arena and stay out of tournaments.
- **1.8 — Watch and collect.** Watch a dungeon live, replay the whole run or individual fights, and see personal rewards in Results and Notifications. Earn Den Breaker, Warlord’s End, Kingslayer, and Dungeoneer.
- **1.8 — Review and trailer.** Clickable UI review on real app screenshots, then implementation and release checks. Make the grandiose trailer-style patch video before shipping. [Dungeon plan](superpowers/plans/2026-10-29-party-dungeons.md) and [design](superpowers/specs/2026-10-29-party-dungeons-design.md).

## Patch 1.9 details (in progress, not released; client only)

Avi's decisions of 2026-11-11. Nothing here needs a server change. Mockups were approved by Avi except where noted.

- **Wiki list.** Wiki topics are one short scrolling list.
- **Shops as an icon grid.** Each shop is a grid of icons that uses the inventory's detail card. The Arena banner shows in the Renown view under All or Armor.
- **Search and sort** in Inventory and Shops.
- **Menu pin and position.** Pin the menu to the left, right or bottom. It is saved in this browser and applies on desktop.
- **Equip from My gladiator.** Choose a replacement straight from the Worn equipment slots.
- **Gold laurel.** A new renown icon, also used in the corner chip (laurel A, gold, chosen by Avi).
- **Stacked duplicates.** Identical unreserved items show as one tile with a count. This is display only: each item is still its own slot. Wear and Discard work one at a time. Sell has a quantity and a Max button, and sends one sell command per item. The My gladiator picker stacks too. Every tile shows its level, and worn, listed and queued items keep their own tiles with tags.
- **Mark as read.** A tick on each message and Mark all for messages, and Mark all for notifications. Opening the Notifications tab still marks them seen, and the button clears the dots.
- **XP bar.** It sits under Stamina, with a thin XP line in the corner chip. It shows whether your next expedition can level you up (a ghost segment and "up to" or "can" wording; the scheduled next expedition, else the best available one).
- **Stat and attribute help.** New Attributes and Stats blocks in My gladiator with hover, focus or tap help in the profile card's words.
- **Name and title toggles.** Always-on names and titles over gladiators in the camp. Mockup pending approval, planned for 1.9.
- **Talking NPCs.** Click an NPC for a line about themselves. Mockup pending approval, planned for 1.9.
- Plan: [Wiki list, menu and shop grid](superpowers/plans/2026-11-11-wiki-menu-and-shop-grid.md). Wiki text to change when 1.9 ships: [wiki-1.9-pending](game-info/wiki-1.9-pending.md).

## Patch 1.10 details (planned; economy and balance, server)

Avi's decisions of 2026-11-11. Needs its own spec, migration and mockups.

- **Salvage items.** Turn unused gear into salvage, including account-bound renown gear. The yield is 1 salvage at level 1, 2 at level 5 and 3 at level 10; uncommon gives +1 and rare +2.
- **Buy back.** Buy back your last 10 sold items until the next game day, for the price you sold them at.
- **Daily login reward.** A 7-day streak. Days 1 to 6 pay 10, 10, 15, 15, 20 and 20 gold. Day 7 pays 1 salvage and 2 renown, then it repeats. A missed day restarts at day 1. A Claim button on a Daily reward card works once per game day.
- **Potions.** Stamina potions give +30 stamina, at most 2 per game day. Health potions get a setting: the gladiator drinks them automatically in fights, or you drink them manually. Avi's wording was unclear, so confirm this in the 1.10 spec.
- **Harder dungeon bosses.** Tune boss health and damage by offline simulation until a matched full party at the dungeon's level wins about 1 time in 4. Rooms stay unchanged.
- **The forge.** Upgrade weapons with salvage (see the forge line under Combat, gear, and progression).

## Patch 1.11 details (planned; content)

Avi's decisions of 2026-11-11. Needs its own design and mockups.

- Expeditions at levels 15, 20, 25 and 30.
- Dungeons at levels 17, 22 and 27, plus The Deep at 15 (see Expeditions, roles, and strategy).
- Gear tiers for levels 15 to 30.
- "A lot more content", with the exact list settled in the design.

## Later patches and ideas

### Inventory, equipment, and menus

- **1.9, in development.** Square inventory grid with recognizable pixel-art items. My gladiator shows stats and weight for worn and replacement gear on hover, focus, or tap.
- Reuse item icons in shops as a future follow-up.
- Wider menus with adjustable desktop widths and small previous/next arrows between named sections. Keep the controls usable on phones. Let players pin the menu and choose its screen edge, saved per device.
- Split character creation into Look, Class, and Attributes steps with Back and Next.
- Show the quantity already owned beside shop and market items. Design when a purchase can be undone.
- Add renown skins and dyes for clothing and weapons, plus an appearance-change option in the menu.

### Combat, gear, and progression

- Cap character level at **20** and the total base attribute budget across all five stats at **100**. Add gear and class bonuses above that budget. Give each existing character one free optional attribute respec with the cap patch. Plan an in-game message with class and attribute guidance and a companion video. The current v2 Training formula would allow 90 at level 20, so the path to the cap and treatment of existing characters need design.
- Add weapons, armor, attribute requirements, stat bonuses, and set effects. Compare item weights, load and overload, and the relative power of bonuses across complete builds. Give two-handed weapons a useful advantage over one-handed weapon plus shield builds.
- **Planned for 1.10 with salvaging.** Upgrade weapons at a forge with salvage and materials such as copper, bronze, iron, gold, and platinum from expeditions and other agreed sources. Design ranks, recipes, and trading.
- The **Wiki** tab explains all game systems, including stats, class bonuses, stamina, Rest, Training, and combat. Show hit, dodge, critical chance, and critical damage from the active combat rules. It will link to two planned YouTube videos once they are produced. The in-game editor and draft-only MCP workflow are built for 1.9. The player-facing content is in review.
- The **Future Updates** tab shows players the plan for future patches. Include patch numbers when decided and give unassigned ideas a place if needed.
- Add elemental damage and resistance for PvE. Compare PvE sets and role builds with PvP matchups before deciding which bonuses apply in the Arena.
- Explore difficult quests that improve class bonuses, and future classes including a summoner with spirits or animal spirits.
- Design a play rule for High Ground. Avi asked to close Founder eligibility after 1.7. The live rule uses the Season 1 cutoff, and the intended replacement cutoff still needs a decision.

### Expeditions, roles, and strategy

- The XP progress bar and next-expedition level-up hint are in 1.9. Still to do: show the XP each expedition pays.
- Add higher expeditions around levels 12 and 18 with higher upgrade materials. Expeditions at levels 15, 20, 25 and 30 are planned for 1.11. Explore especially hard level-15 and level-20 party expeditions.
- Design distinct PvE builds and party roles, with a separate way for roles to earn levels.
- Add **The Deep**, a weekly solo delve from level 15 after party dungeons. Explore separate endgame runs that last a full game day or longer, with several stages, mini-bosses, a final boss, and larger prizes.
- Explore PvE followers that help in expeditions or dungeons, guilds, and tradable raid items. Health and stamina potions are planned for 1.10 and raids are described below. Cosmetic paid pets are a separate feature.
- Plan several days ahead and repeat multi-day rotations for Training, Rest, and other activities.

### Raids and the season pass

- **Raids.** Avi wants raids included: gladiators go together, with solo and guild versions ("we will see about it"). Details are open. They come after the 1.11 levels, and the guild version needs guilds first.
- **Season pass (after real-money payments go live).** 4-week seasons at about $4.99 (a placeholder price). Everyone gets a free daily-reward track. A paid track has cosmetics, and Avi said "maybe also potions". **Open question:** the approved cosmetic payments spec allows cosmetics with zero gameplay bonuses only, and paid potions would be a gameplay effect, so this needs Avi's decision before design. Not a decision yet.

### Camp, social, and events

- **Friends — Standalone after 1.6, number open.** Friends list and friend requests.
- **Dungeon parties — Future, number open.** Invite chosen teammates for a specific dungeon run and see planned dungeon choices
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
