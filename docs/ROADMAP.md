# Cloudiator roadmap

Updated 2026-11-12. Production is **1.8.1**. The payments patch is **2.0**, the full release (Avi, 2026-11-12; it was 1.10, and 1.11 is now 2.1). Patches 1.9 to 2.1 follow Avi's 2026-11-11 decisions and his 2026-11-12 list. Avi asked that 1.9 take everything that can ship in it, and that 2.0 be a big patch that also brings real-money payments; on 2026-11-12 he asked for recommendations instead of questions, so items marked *recommended* are Claude's calls, open to his change. The later items are grouped by area. They have no assigned patch number unless stated.

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
| 1.9 | In progress, not released (client, plus one small migration M33 for Wiki guide links) | Game Info with Wiki and Future Updates, a square pixel-art inventory, shops as an icon grid, search and sort, stacked duplicates with Sell quantity, equip from My gladiator, a gold laurel renown icon, XP bar, stat help, Mark as read, a Settings menu with menu pin and position and name and title settings, talking NPCs, and sleeping on beds. Added 2026-11-12, not built yet: a video guide on each Wiki topic, practice fights (a dummy you set up, or a spar with a copy of any gladiator), critical damage and Arena armour shown, and gladiators sleeping without armour. Moved in from the next patch (Avi, 2026-11-12): a Feedback button and Buy back. |
| 2.0 | Planned: the full release, from open beta to open (payments and balance) | After a security pass, a penetration test and scaling prep (see below). Real-money payments (card and Google Pay checkout) and everything paid: Supporter Banner, pet follower, bag slots, dyes and skins; combat and economy balance (critical hits, two-handed weapons, renown weapons), salvage and the forge, daily login reward, stamina and health potions, level-12 drop-only gear, much harder dungeon bosses, and three Arena bouts an evening with varied opponents. |
| 2.1 | Planned (content) | Expeditions at levels 15, 20, 25 and 30, dungeons at 17, 22 and 27, gear tiers 15-30, and much more content. |

Release details and dates are in the [changelog](CHANGELOG.md).

## Patch 1.8 details

- **1.8 — Party dungeons.** Wolf Den at level 3, Raider Stronghold at 7, and Troll Hall at 12. Up to three fighters enter for the afternoon, face three rooms and a boss, and keep the rewards from the won fights they entered even if they lose to the boss. Dungeon entry costs 40 base stamina. Avi approved v2 room and boss payouts and a 30% boss chest gear chance.
- **1.8 — Ludus Nimbus.** Five named fighters marked BOT. Human players take dungeon seats first, then eligible bots, then hired fighters. Bots enter unranked Arena and stay out of tournaments.
- **1.8 — Watch and collect.** Watch a dungeon live, replay the whole run or individual fights, and see personal rewards in Results and Notifications. Earn Den Breaker, Warlord’s End, Kingslayer, and Dungeoneer.
- **1.8 — Review and trailer.** Clickable UI review on real app screenshots, then implementation and release checks. Make the grandiose trailer-style patch video before shipping. [Dungeon plan](superpowers/plans/2026-10-29-party-dungeons.md) and [design](superpowers/specs/2026-10-29-party-dungeons-design.md).

## Patch 1.9 details (in progress, not released)

Avi's decisions of 2026-11-11. The built items need no server change; the Wiki video guides added on 2026-11-12 need one small migration (M33). Mockups were approved by Avi except where noted.

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
- **Settings menu.** A ⚙ Settings panel holds the menu pin and position (Left, Bottom, Right) and the name and title settings.
- **Names and titles.** In Settings: Off, When zoomed in, or Always, with Tidy for overlapping names. Off hides them entirely.
- **Talking NPCs.** Click an NPC for one of 56 approved lines about themselves. The Weaponsmith's and Armorer's stalls open their shops.
- **Sleeping on beds.** Resting gladiators lie straight on the bed with an eye cover and a floating ZzZ (reviewed 2026-11-12; the eye cover was redrawn as a clear light-blue band that shows on every skin tone; Avi kept light blue on 2026-11-12).
- **Added 2026-11-12 (Avi's list; not built yet; UI mockups first):**
  - **Video guides in the Wiki.** Each Wiki topic shows its own guide as a card: a frame from the video, ▶, "Watch the guide · 1:12" and "YouTube ↗" (variant B of the 2026-11-12 mockup, approved by Avi on 2026-11-12). Topics with a guide get ▶ in the list; the others say "Video guide coming soon". Needs **M33**: the live M32 allows only two links for the whole Wiki, so M33 lets each Wiki entry carry one YouTube link, and the Wiki editor gets that field. Seven guides (W01-W07) are public on YouTube since 2026-11-12 (Indigo Labs): Daily schedule, Stamina and Rest, Training, Combat, Attributes, Arena and Dungeons; their links go into the Wiki draft with M33, and the other seven topics show "Video guide coming soon".
  - **Practice fights.** Fight a training dummy with stats you choose, or spar a copy of any gladiator from their profile card, to test a build. Free: no stamina, no schedule slot, no rating, not saved. It runs the real combat rules in the browser (the shared combat engine) and plays in the replay viewer. Spars with a real player who accepts an invitation come later, with Friends.
  - **Critical damage shown.** My gladiator and the Wiki say a critical hit deals 50% more damage (rules: x1.5), next to the critical chance (5% + 0.3% per Precision, at most 40%).
  - **Armour block checked.** The block share is min(2% per armour point, 70%), the same formula in combat and on the profile card (checked by reading the code, 2026-11-12). Gap found: in the Arena, renown armour counts 10% more, but the card shows only the expedition figure; 1.9 shows the Arena figure too.
  - **Sleeping without armour.** Gladiators asleep in bed are drawn without their armour (Claude's reading of "Rest no armor?"; client art only).
  - **Balance checks for 2.0.** Offline simulations of critical chance, two-handed against one-handed with a shield, and renown weapons against gold weapons. 1.9 changes no numbers; the results set the 2.0 balance.
- **Moved in from the next patch (Avi, 2026-11-12: "anything non related payments and balance, should be in").** Not built yet. Mockups approved by Avi on 2026-11-12 (`.superpowers/design/2026-11-12-feedback-buyback/`): Send feedback in Messages (team answers arrive as "Team reply" messages), the owner's Feedback tab in Game Info, and Buy back as a Shops filter.
  - **Feedback from the game.** A Feedback button sends a bug report or idea with a category; the team reads and answers them (ideas 30 and 39, player support with triage). Claude can suggest answers through the Game Info MCP; only Avi sends them (approve or edit in the Feedback tab).
  - **Buy back.** Buy back your last 10 sold items until the next game day, for the price you sold them at.
- **No 1.9.1 (Avi, 2026-11-12).** The review leftovers planned as 1.9.1 (phone tap scrolls the item card into view, the inventory Retry after a refused command, notification focus, card placement on mid-size windows and other small fixes) are built inside 1.9 (Task 21, 2026-11-12), because 1.9 is not released yet. Plan: [1.9 additions](superpowers/plans/2026-11-12-1.9-additions.md), Task 21.
- Plan: [Wiki list, menu and shop grid](superpowers/plans/2026-11-11-wiki-menu-and-shop-grid.md). Wiki text to change when 1.9 ships: [wiki-1.9-pending](game-info/wiki-1.9-pending.md).

## Before 2.0: security pass, penetration test and scaling (planned)

Avi, 2026-11-12: "add also to do before next patch (after 1.9), security measures, pt testing and all derives from those". It runs after 1.9 ships and before 2.0 work starts, because 2.0 brings real money. Scope is Claude's recommendation, open to Avi's change:

- **Threat model.** What an attacker could want: accounts (Google sign-in), gold, renown and items, the Arena and rankings, the Game Info editor and its MCP bridge, Edge functions and scheduled jobs, and from 2.0 payments.
- **Security review.** Database row security and grants (the access audit exists), each Edge function's sign-in check and input checks, rate limits and abuse (command floods, repeated operations, races on buying, selling and equipping), security headers and CSP, secrets and keys, dependency vulnerabilities (needs a network check, with Avi's go), and logs without personal data.
- **Penetration test.** An authorized test we run ourselves against an OWASP checklist (WSTG, ASVS level 2): on the local stack and a test copy first; production only with Avi's go for each step and within Supabase's and Google's testing rules. It covers sign-in and sessions, reaching other players' gladiators, mail or items, editor and title privileges, injection, clickjacking, replayed commands, races in the economy, Edge function fuzzing, and error messages that leak details.
- **What follows from it.** Fix findings by severity (no critical or high finding open when 2.0 starts), a regression test for each fix, a re-test, and a report in `docs/security/` (threat model, test results, fixes). Standing measures: dependency and secret scanning in the release gate, monitoring and alerts, a backup and restore drill, an incident runbook, and a privacy review (Israel's Privacy Protection Law and the GDPR for EU players, including how long data is kept).
- **Scaling for the open release.** Avi, 2026-11-12: consider paying for Cloudflare and Supabase plans to support many new players. *Recommended*: a load test on a test copy first (players at once, Edge function and database limits), then choose plans from its numbers; each purchase needs Avi's go.
- **Payments ready by design.** Checkout on the provider's own page (no card data on our servers), signed webhooks, one-time operation ids, prices set by the server, and refund and chargeback handling.

## Patch 2.0 details (planned; the full release: payments and balance)

Avi's decisions of 2026-11-11, and on 2026-11-12 "next patch should be a big one, implementing payment as well". On 2026-11-12 Avi named it 2.0, the release from open beta to open, and set its theme: payments, including everything paid (dyes, skins, pets and the like), and balance. Items that are neither moved into 1.9. Needs its own spec, migrations and mockups.

- **Real-money payments.** Avi asked for Stripe and Google Pay. Card and Google Pay checkout. **Provider check first**: the 2026-11-08 payments design found Stripe does not onboard Israeli sellers directly. *Recommended*: confirm Stripe for Avi's seller account at the start of 2.0; if it cannot onboard him, use PayPal (its sandbox plan is ready) or a merchant of record such as Xsolla, with Google Pay where that provider offers it. The first items stay the approved Supporter Banner and pet follower.
- **Bag slots for real money or coupons** (Claude reads "bad slots" as bag slots). *Recommended*: extra bag slots are sold as convenience and can also be bought with renown, so free players are not locked out; coupons are redeem codes for gifts and promotions. This changes the approved payments rule from "cosmetics only" to "no combat power": update the payments design in the 2.0 spec.
- **Drop-only gear above level 10.** Avi, 2026-11-12: items that cannot be bought in the store, above level 10 (12, 15 and more), with new armours and new weapons. Shops keep selling levels 1, 5 and 10 only; every tier above 10 is never sold. 2.0 adds a level 12 tier that drops only from dungeon boss chests (Troll Hall is level 12), including new kinds of weapons and armour with their own looks. *Recommended*: a new catalog version (catalog v1 stays for existing items), new art for the new kinds, and the exact list in the 2.0 design with mockups first. Level 15 and higher tiers arrive with the 2.1 content where they drop.
- **Combat balance** from the 1.9 simulations: lower critical chance, a way to raise critical damage (a gear bonus or Precision), a real edge for two-handed weapons over one-handed with a shield, and renown weapons checked against gold ones.

- **Salvage items.** Turn unused gear into salvage, including account-bound renown gear. The yield is 1 salvage at level 1, 2 at level 5 and 3 at level 10; uncommon gives +1 and rare +2.
- **Daily login reward.** A 7-day streak. Days 1 to 6 pay 10, 10, 15, 15, 20 and 20 gold. Day 7 pays 1 salvage and 2 renown, then it repeats. A missed day restarts at day 1. A Claim button on a Daily reward card works once per game day.
- **Potions.** Stamina potions give +30 stamina, at most 2 per game day. Health potions, *recommended*: in a fight the gladiator drinks one automatically when health falls below a share you set (your first battle-plan setting), and between fights you can drink one yourself.
- **Harder dungeon bosses.** Tune boss health and damage by offline simulation until a matched full party at the dungeon's level wins about 1 time in 4. Rooms stay unchanged.
- **Arena evenings.** Each entry gets 3 bouts in an evening, never the same opponent twice in an evening; NPC or bot fill-ins when there are not enough players. Opponents: variety first, preferring opponents you have not fought in the last 3 days while strength stays within today's 2x limit, then nearest strength. Rewards are split so a full evening pays about 1.5x what one bout pays today, with a smaller rating change per bout. Today: one bout per entry, nearest-strength pairing, then fewest pairings in the last 18 slots (`supabase/functions/_shared/domain/arena.ts`).
- **The forge.** Upgrade weapons with salvage (see the forge line under Combat, gear, and progression).

## Patch 2.1 details (planned; content)

Avi's decisions of 2026-11-11. Needs its own design and mockups.

- Expeditions at levels 15, 20, 25 and 30.
- Dungeons at levels 17, 22 and 27, plus The Deep at 15 (see Expeditions, roles, and strategy).
- Drop-only gear tiers for levels 15 to 30 (Avi, 2026-11-12: never sold in shops), with more new weapons and armour. They drop from The Deep, the new expeditions and the new dungeons.
- "A lot more content", with the exact list settled in the design.

## Later patches and ideas

### Inventory, equipment, and menus

- **1.9, in development.** Square inventory grid with recognizable pixel-art items. My gladiator shows stats and weight for worn and replacement gear on hover, focus, or tap.
- Reuse item icons in shops as a future follow-up.
- Wider menus with adjustable desktop widths and small previous/next arrows between named sections. Keep the controls usable on phones. Pinning the menu and choosing its screen edge are in 1.9.
- Split character creation into Look, Class, and Attributes steps with Back and Next.
- Show the quantity already owned beside shop and market items. Design when a purchase can be undone.
- Renown skins and dyes for clothing and weapons, plus an appearance-change option in the menu: with the 2.0 cosmetics (Avi, 2026-11-12: everything paid or cosmetic goes with payments).

### Combat, gear, and progression

- Cap character level at **20** and the total base attribute budget across all five stats at **100**. Add gear and class bonuses above that budget. Give each existing character one free optional attribute respec with the cap patch. Plan an in-game message with class and attribute guidance and a companion video. The current v2 Training formula would allow 90 at level 20, so the path to the cap and treatment of existing characters need design.
- Add weapons, armor, attribute requirements, stat bonuses, and set effects. Compare item weights, load and overload, and the relative power of bonuses across complete builds. Give two-handed weapons a useful advantage over one-handed weapon plus shield builds.
- **Planned for 2.0 with salvaging.** Upgrade weapons at a forge with salvage and materials such as copper, bronze, iron, gold, and platinum from expeditions and other agreed sources. Design ranks, recipes, and trading.
- The **Wiki** tab explains all game systems, including stats, class bonuses, stamina, Rest, Training, and combat. Show hit, dodge, critical chance, and critical damage from the active combat rules. Each topic gets its own YouTube guide (1.9, needs M33; seven of fourteen are made). The in-game editor and draft-only MCP workflow are built for 1.9. The player-facing content is in review.
- The **Future Updates** tab shows players the plan for future patches. Include patch numbers when decided and give unassigned ideas a place if needed.
- Add elemental damage and resistance for PvE. Compare PvE sets and role builds with PvP matchups before deciding which bonuses apply in the Arena.
- Explore difficult quests that improve class bonuses, and future classes including a summoner with spirits or animal spirits.
- Design a play rule for High Ground. Avi asked to close Founder eligibility after 1.7. The live rule uses the Season 1 cutoff, and the intended replacement cutoff still needs a decision.

### Expeditions, roles, and strategy

- The XP progress bar and next-expedition level-up hint are in 1.9. Still to do: show the XP each expedition pays.
- Add higher expeditions around levels 12 and 18 with higher upgrade materials. Expeditions at levels 15, 20, 25 and 30 are planned for 2.1. Explore especially hard level-15 and level-20 party expeditions.
- Design distinct PvE builds and party roles, with a separate way for roles to earn levels. Avi's roles (2026-11-12): tank, summoner, buffer and ADC (ranged damage), each with its own builds and abilities.
- **More strategy, less luck in fights** (Avi, 2026-11-12: battles should not be only RNG; players should affect them by strategy). *Recommended*: a battle plan set before the fight (stance, when to drink a potion, target choice and more), starting with the 2.0 potion setting; a design pass decides how far players can act during a fight.
- Add **The Deep**, a weekly solo delve from level 15 after party dungeons. Explore separate endgame runs that last a full game day or longer, with several stages, mini-bosses, a final boss, and larger prizes.
- Explore PvE followers that help in expeditions or dungeons, guilds, and tradable raid items. Health and stamina potions are planned for 2.0 and raids are described below. Cosmetic paid pets are a separate feature.
- Plan several days ahead and repeat multi-day rotations for Training, Rest, and other activities.

### Raids and the season pass

- **Raids.** Avi wants raids included: gladiators go together, with solo and guild versions ("we will see about it"). Details are open. They come after the 2.1 levels, and the guild version needs guilds first.
- **Season pass (after 2.0's payments have run for a while).** 4-week seasons at about $4.99 (a placeholder price). Everyone gets a free daily-reward track. A paid track has cosmetics, and Avi said "maybe also potions". *Recommended* (2026-11-12): potions only on the free track, so the paid track stays without gameplay effect. The approved payments rule allows no gameplay effect for money, so paid potions would break it; Avi can still choose otherwise.

### Camp, social, and events

- **Friends — Standalone after 1.6, number open.** Friends list and friend requests. With Friends: invite a chosen player to a spar, free of stamina and slots (1.9 already offers a spar with a copy of any gladiator).
- **Homes and trophies** (Avi, 2026-11-12). Anyone can build a home, show trophies there and host friends as guests. Builds on housing and achievements (idea 43) and needs Friends first.
- **Dungeon parties — Future, number open.** Invite chosen teammates for a specific dungeon run and see planned dungeon choices
  within the party. Eligible players who accept stay together for that run. Players without a party still group automatically.
  Saving a lineup for reuse is open.
- Expand the camp after 1.8. Reserve plots for future facilities, add housing, decorations and achievements, and add more NPCs and guards. Include the Champ, a former Arena champion, and clickable or tappable NPC detail cards.
- Add pettable cats, dogs, rabbits, and birds. The first paid release is planned to offer a one-time Supporter Banner and an optional cosmetic pet follower. Both are account-bound cosmetics. Founder remains a separate title. [PayPal sandbox plan](superpowers/plans/2026-11-08-cosmetic-payments-paypal-sandbox.md).
- Paid weapon and armor dyes and skins: in 2.0 with the first cosmetic shop (Avi, 2026-11-12). These change equipment appearance only.
- Run timed events and seasonal camp themes such as Halloween and Christmas. Explore a world tournament with a statue for the winner.
- Add a small group of townsfolk behind the Arena spectators every evening, with a different arrangement each game day. [Evening Arena crowd preview plan](superpowers/specs/2026-11-08-evening-arena-crowd-design.md).
- Add live Arena and tournament spectating with text commentary. Check the feasibility of a 24/7 YouTube stream.
- Add music and sound effects with independent volume and mute controls, remembered per device.
- Add in-game player support with request categories and triage.

## Planning sources

- The [original ideas log](superpowers/specs/2026-10-29-next-patch-ideas.md) contains the earlier requests. Later entries were preserved on `claude/task-24` at `2d9d5c3` and `codex/future-patch-ideas-20261102` at `39c153b`. This roadmap brings them together by topic and includes the 2026-11-07 requests.
- The [feature index](FEATURES.md) tracks player features, and the [handoff](implementation/HANDOFF.md) records implementation and release status.
